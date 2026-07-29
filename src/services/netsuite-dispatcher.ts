// NetSuite outbound dispatcher (D11 / endpoint #14).
//
// When `FEATURE_NETSUITE_DISPATCH_ENABLED=true`, the real OAuth 1.0a/TBA
// pipeline is used: per-organization credentials are read from the
// `organization` row, the request is signed with HMAC-SHA256 and POSTed to
// the standard NetSuite invoice record (`/record/v1/invoice`).
//
// v24: we now emit a STANDARD NetSuite invoice (not a custom staging record).
// The call sites keep building a canonical Numaris Billing payload; this dispatcher
// translates it into the standard `/record/v1/invoice` body. Account-specific
// bits (subsidiary, entity/item reference mode, currency internal ids) come
// from `organization.netsuite_config` and are meant to be tuned against the
// target account (start in a sandbox) by reading the real NetSuite errors.
//
// When the flag is off, the dispatcher short-circuits: it records the
// payload in memory and returns a synthetic `accepted` response. Tests can
// rely on this mode without any NetSuite credentials.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Organization } from '@prisma/client';

export type DispatchPayload = Record<string, unknown>;

// Config específica de la cuenta NetSuite, guardada en organization.netsuite_config.
type NetSuiteConfig = {
  // Internal id de la subsidiaria (obligatorio en cuentas OneWorld). Si se
  // omite, no se envía el campo (cuentas single-subsidiary no lo requieren).
  subsidiaryId?: string;
  // Cómo referenciar al customer y a los items en NetSuite:
  //   'internal' → el valor ya ES el internal id de NetSuite.
  //   'external' → el valor es el external id; se referencia como 'eid:<valor>'.
  // Default entity = 'internal' con fallback a external (usa netsuite_internal_id
  // si existe, si no el eid del external_id). Default item = 'external'.
  entityRefMode?: 'internal' | 'external';
  itemRefMode?: 'internal' | 'external';
  // Mapa moneda ISO → internal id de la moneda en NetSuite. Ej: { "MXN": "1" }.
  // Si falta, se manda { refName: <ISO> } como fallback.
  currencyRef?: Record<string, string>;
  // Internal ids opcionales de department / location / class por si la cuenta
  // los exige a nivel transacción.
  department?: string;
  location?: string;
  // Id del custom transaction body field (tipo Long Text) donde se escribe el
  // anexo de unidades en texto legible (ej. "custbody_numaris_units_annex").
  // La plantilla Advanced PDF de la factura lo puede renderizar para que el
  // cliente vea a qué unidades corresponden los cargos. Vacío = no se envía.
  annexFieldId?: string;
};

// Shape (parcial) del payload canónico que arman los call sites.
type CanonicalInvoice = {
  external_id?: string;
  numaris_invoice_id?: string;
  issued_at?: string;
  currency?: string;
  customer?: {
    external_id?: string;
    netsuite_internal_id?: string | null;
    netsuite_entity_handle?: string;
  };
  billing_period?: { from?: string | null; to?: string | null };
  // v25: segmentación contable de la razón social (internal ids). Tiene
  // precedencia sobre los defaults de organization.netsuite_config.
  segmentation?: {
    location?: string | null;
    department?: string | null;
    class?: string | null;
  };
  lines?: Array<{
    fee_id?: string;
    kind?: string;
    description?: string | null;
    units?: string;
    unit_amount_cents?: number;
    amount_cents?: number;
    netsuite_item_code?: string | null;
  }>;
  units_annex?: Array<{
    external_id?: string;
    label?: string | null;
    fees?: Array<{ kind?: string; amount_cents?: number }>;
  }>;
  metadata?: Record<string, unknown>;
};

export type DispatchResult = {
  status: 'accepted' | 'failed';
  netsuiteInternalId?: string;
  externalId: string;
  receivedAt: string;
  estimatedEmissionAt?: string;
  error?: string;
};

export interface NetSuiteDispatcher {
  dispatch(org: Organization, payload: DispatchPayload, kind: 'invoice' | 'credit_note'): Promise<DispatchResult>;
}

// Mock dispatcher used when the feature flag is off or for tests.
export class FakeNetSuiteDispatcher implements NetSuiteDispatcher {
  public readonly calls: Array<{ orgId: string; kind: string; payload: DispatchPayload }> = [];

  async dispatch(
    org: Organization,
    payload: DispatchPayload,
    kind: 'invoice' | 'credit_note',
  ): Promise<DispatchResult> {
    this.calls.push({ orgId: org.id, kind, payload });
    const externalId = String(payload.external_id ?? '');
    return {
      status: 'accepted',
      netsuiteInternalId: `rec-${randomBytes(4).toString('hex')}`,
      externalId,
      receivedAt: new Date().toISOString(),
      estimatedEmissionAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }
}

// Real dispatcher signing OAuth 1.0a with HMAC-SHA256 (TBA).
export class RealNetSuiteDispatcher implements NetSuiteDispatcher {
  async dispatch(
    org: Organization,
    payload: DispatchPayload,
    kind: 'invoice' | 'credit_note',
  ): Promise<DispatchResult> {
    const externalId = String(payload.external_id ?? '');
    const receivedAt = new Date().toISOString();

    const requiredFields: Array<keyof Organization> = [
      'netsuiteAccountId',
      'netsuiteConsumerKey',
      'netsuiteConsumerSecret',
      'netsuiteTokenKey',
      'netsuiteTokenSecret',
      'netsuiteRestBase',
    ];
    for (const key of requiredFields) {
      if (!org[key]) {
        return { status: 'failed', externalId, receivedAt, error: `missing_credential:${key}` };
      }
    }

    // v24: credit notes todavía no migran a creditmemo estándar. Fallar claro
    // en lugar de POSTear a un endpoint incorrecto.
    if (kind === 'credit_note') {
      return { status: 'failed', externalId, receivedAt, error: 'credit_note_standard_dispatch_pending' };
    }

    const config = (org.netsuiteConfig ?? {}) as NetSuiteConfig;
    let record: Record<string, unknown>;
    try {
      record = buildStandardInvoice(payload as CanonicalInvoice, config);
    } catch (err) {
      return { status: 'failed', externalId, receivedAt, error: err instanceof Error ? err.message : String(err) };
    }

    const url = `${normalizeRestBase(org.netsuiteRestBase!)}/services/rest/record/v1/invoice`;
    const body = JSON.stringify(record);
    const auth = buildOauthHeader({
      method: 'POST',
      url,
      consumerKey: org.netsuiteConsumerKey!,
      consumerSecret: org.netsuiteConsumerSecret!,
      tokenKey: org.netsuiteTokenKey!,
      tokenSecret: org.netsuiteTokenSecret!,
      realm: org.netsuiteAccountId!,
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body,
      });
      const text = await response.text();
      if (!response.ok) {
        return { status: 'failed', externalId, receivedAt, error: `http_${response.status}:${text.slice(0, 400)}` };
      }
      // La creación de un record estándar responde 204 con el internal id en
      // el header Location (.../invoice/<id>). Algunos setups devuelven JSON.
      const location = response.headers.get('location') ?? '';
      const idFromLocation = location.split('/').filter(Boolean).pop();
      const parsed = safeJson(text);
      const netsuiteInternalId = (typeof parsed?.id === 'string' && parsed.id)
        || (typeof parsed?.netsuite_internal_id === 'string' && parsed.netsuite_internal_id)
        || (idFromLocation && /^\d+$/.test(idFromLocation) ? idFromLocation : undefined)
        || undefined;
      return { status: 'accepted', netsuiteInternalId, externalId, receivedAt };
    } catch (err) {
      return { status: 'failed', externalId, receivedAt, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// Traduce el payload canónico de Numaris Billing a un body de invoice estándar de
// NetSuite (`POST /record/v1/invoice`). Envía montos NETOS por línea; NetSuite
// aplica impuestos según la configuración fiscal del customer/item.
//
// Referencias (entity, item, currency, subsidiary) dependen de la cuenta
// específica; se resuelven con organization.netsuite_config. Este mapeo es el
// punto que se afina contra el sandbox leyendo los errores reales de NetSuite.
export function buildStandardInvoice(
  payload: CanonicalInvoice,
  config: NetSuiteConfig,
): Record<string, unknown> {
  const lines = payload.lines ?? [];
  if (lines.length === 0) {
    throw new Error('no_invoice_lines');
  }

  // entity: usa el handle que ya trae el payload (internal id si existe, si no
  // eid:<external_id>). En modo 'external' forzamos siempre el external id.
  const customer = payload.customer ?? {};
  let entityId: string | undefined;
  if (config.entityRefMode === 'external') {
    if (!customer.external_id) throw new Error('missing_customer_external_id');
    entityId = `eid:${customer.external_id}`;
  } else {
    entityId = customer.netsuite_entity_handle
      || (customer.netsuite_internal_id ?? undefined)
      || (customer.external_id ? `eid:${customer.external_id}` : undefined);
  }
  if (!entityId) throw new Error('missing_entity_reference');

  const itemMode = config.itemRefMode ?? 'external';
  const itemLines = lines.map((ln) => {
    const code = ln.netsuite_item_code;
    if (!code) throw new Error(`missing_item_code:${ln.fee_id ?? ln.kind ?? '?'}`);
    const itemId = itemMode === 'internal' ? code : `eid:${code}`;
    const quantity = ln.units !== undefined ? Number(ln.units) : 1;
    const rate = (ln.unit_amount_cents ?? 0) / 100;
    const amount = (ln.amount_cents ?? 0) / 100;
    return {
      item: { id: itemId },
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
      rate,
      amount,
      description: ln.description ?? undefined,
    };
  });

  const record: Record<string, unknown> = {
    // externalId liga la factura NetSuite con la de Numaris Billing (idempotencia +
    // lookup). Si se reintenta con el mismo externalId, NetSuite lo rechaza en
    // vez de duplicar.
    externalId: payload.external_id,
    entity: { id: entityId },
    item: { items: itemLines },
  };

  // tranDate = fecha (sin hora) de emisión.
  if (payload.issued_at) record.tranDate = payload.issued_at.slice(0, 10);

  // currency: internal id si está mapeado, si no refName (ISO) como fallback.
  if (payload.currency) {
    const mapped = config.currencyRef?.[payload.currency];
    record.currency = mapped ? { id: mapped } : { refName: payload.currency };
  }

  if (config.subsidiaryId) record.subsidiary = { id: config.subsidiaryId };
  // Segmentación: lo de la razón social manda; la config global es fallback.
  const seg = payload.segmentation ?? {};
  const department = seg.department ?? config.department;
  const location = seg.location ?? config.location;
  if (department) record.department = { id: department };
  if (location) record.location = { id: location };
  if (seg.class) record.class = { id: seg.class };

  const memoParts = ['Numaris Billing'];
  if (payload.numaris_invoice_id) memoParts.push(payload.numaris_invoice_id);
  const period = payload.billing_period;
  if (period?.from && period?.to) memoParts.push(`${String(period.from).slice(0, 10)}..${String(period.to).slice(0, 10)}`);
  record.memo = memoParts.join(' · ');

  if (config.annexFieldId && payload.units_annex && payload.units_annex.length > 0) {
    record[config.annexFieldId] = renderUnitsAnnexText(payload);
  }

  return record;
}

// Anexo de unidades en texto legible para el custom body field de la factura
// en NetSuite (y de ahí a la plantilla PDF que ve el cliente). Montos NETOS —
// los impuestos del CFDI los agrega NetSuite sobre las líneas, no sobre el
// anexo, que es informativo.
const ANNEX_KIND_LABELS: Record<string, string> = {
  monthly: 'Renta mensual',
  setup: 'Instalación',
  removal: 'Baja',
  one_off: 'Paquete prepago',
  service_addon: 'Add-on de plan',
  customer_addon: 'Add-on de cliente',
  catalog_event: 'Evento',
};

export function renderUnitsAnnexText(payload: CanonicalInvoice): string {
  const currency = payload.currency ?? '';
  const money = (cents: number): string =>
    `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`;
  const period = payload.billing_period;
  const header = period?.from && period?.to
    ? `ANEXO DE UNIDADES · Periodo ${String(period.from).slice(0, 10)} a ${String(period.to).slice(0, 10)}`
    : 'ANEXO DE UNIDADES';
  const lines = (payload.units_annex ?? []).map((u) => {
    const name = u.label ? `${u.label} (${u.external_id ?? '?'})` : (u.external_id ?? '?');
    const fees = (u.fees ?? [])
      .map((f) => `${ANNEX_KIND_LABELS[f.kind ?? ''] ?? f.kind ?? 'Cargo'} ${money(f.amount_cents ?? 0)}`)
      .join(' + ');
    return `• ${name}: ${fees || 'sin cargos'}`;
  });
  const total = (payload.units_annex ?? [])
    .flatMap((u) => u.fees ?? [])
    .reduce((acc, f) => acc + (f.amount_cents ?? 0), 0);
  return [
    header,
    `${lines.length} unidad${lines.length === 1 ? '' : 'es'} · Neto ${money(total)} (impuestos por separado)`,
    '',
    ...lines,
  ].join('\n');
}

// Una diagonal final en la REST base produce URLs con `//` — la firma OAuth
// se calcula sobre esa URL pero NetSuite la valida contra la ruta
// normalizada, y el resultado es un 401 INVALID_LOGIN indistinguible de
// llaves malas. Se normaliza aquí Y al guardar en el admin.
export function normalizeRestBase(restBase: string): string {
  return restBase.trim().replace(/\/+$/, '');
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Pre-flight: valida credenciales TBA sin crear nada. Firma un GET autenticado
// de solo lectura (`/record/v1/invoice?limit=1`) y reporta el resultado. Sirve
// para confirmar account id + REST base + llaves + firma antes de generar una
// factura. Independiente del feature flag de dispatch.
export async function testNetSuiteConnection(
  org: Organization,
): Promise<{ ok: boolean; detail: string }> {
  const required: Array<keyof Organization> = [
    'netsuiteAccountId', 'netsuiteConsumerKey', 'netsuiteConsumerSecret',
    'netsuiteTokenKey', 'netsuiteTokenSecret', 'netsuiteRestBase',
  ];
  for (const key of required) {
    if (!org[key]) return { ok: false, detail: `Falta credencial: ${key}` };
  }

  // El account id ES el subdominio de la REST base (sandbox: 123456_SB1 ↔
  // 123456-sb1). Si no cuadran, NetSuite autentica contra la cuenta del
  // realm — las llaves de otra cuenta "funcionan" pero los records se crean
  // ALLÁ, invisibles en la cuenta a la que apunta la URL. Mejor frenar aquí.
  const subdomainMatch = /^https?:\/\/([a-z0-9_-]+)\.suitetalk/i.exec(org.netsuiteRestBase!);
  if (subdomainMatch) {
    const normalize = (s: string): string => s.toLowerCase().replace(/_/g, '-');
    const fromUrl = normalize(subdomainMatch[1]!);
    const fromRealm = normalize(org.netsuiteAccountId!);
    if (fromUrl !== fromRealm) {
      return {
        ok: false,
        detail: `El account id (realm) "${org.netsuiteAccountId}" no corresponde al subdominio de la REST base ("${subdomainMatch[1]}"). Deben ser la misma cuenta — y las llaves TBA deben haberse creado en ella.`,
      };
    }
  }

  const url = `${normalizeRestBase(org.netsuiteRestBase!)}/services/rest/record/v1/invoice?limit=1`;
  const auth = buildOauthHeader({
    method: 'GET',
    url,
    consumerKey: org.netsuiteConsumerKey!,
    consumerSecret: org.netsuiteConsumerSecret!,
    tokenKey: org.netsuiteTokenKey!,
    tokenSecret: org.netsuiteTokenSecret!,
    realm: org.netsuiteAccountId!,
  });

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: auth },
    });
    if (response.ok) {
      return { ok: true, detail: `Conexión OK (HTTP ${response.status}). Las credenciales funcionan.` };
    }
    const text = (await response.text()).slice(0, 400);
    let hint = '';
    if (response.status === 401 || response.status === 403) {
      hint = ' — revisa consumer/token key+secret y el account id (realm).';
    } else if (response.status === 404) {
      hint = ' — revisa la REST base URL.';
    }
    return { ok: false, detail: `HTTP ${response.status}${hint} · ${text}` };
  } catch (err) {
    return { ok: false, detail: `No se pudo conectar: ${err instanceof Error ? err.message : String(err)} — revisa la REST base URL.` };
  }
}

// OAuth 1.0a HMAC-SHA256 signature (TBA). Implementation per RFC 5849 + the
// NetSuite Token-Based Authentication guide.
function buildOauthHeader(args: {
  method: string;
  url: string;
  consumerKey: string;
  consumerSecret: string;
  tokenKey: string;
  tokenSecret: string;
  realm: string;
}): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: args.consumerKey,
    oauth_token: args.tokenKey,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  };

  const baseUrl = args.url.split('?')[0]!;
  const queryString = args.url.split('?')[1] ?? '';
  const queryParams = parseQuery(queryString);
  const all: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(oauthParams)) all.push([k, v]);
  for (const [k, vs] of Object.entries(queryParams)) for (const v of vs) all.push([k, v]);
  all.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const paramString = all.map(([k, v]) => `${percent(k)}=${percent(v)}`).join('&');
  const baseString = `${args.method.toUpperCase()}&${percent(baseUrl)}&${percent(paramString)}`;
  const signingKey = `${percent(args.consumerSecret)}&${percent(args.tokenSecret)}`;
  const signature = createHmac('sha256', signingKey).update(baseString).digest('base64');
  oauthParams.oauth_signature = signature;

  // NetSuite exige el account id (realm) en MAYÚSCULAS. Un realm en minúsculas
  // provoca 401 INVALID_LOGIN_ATTEMPT aunque las llaves sean correctas. El
  // account id es dígitos + sufijo tipo _SB1, así que forzar mayúsculas es
  // seguro y es lo que NetSuite espera.
  const realm = args.realm.toUpperCase();
  const header = `OAuth realm="${realm}", ` + Object.entries(oauthParams)
    .map(([k, v]) => `${percent(k)}="${percent(v)}"`)
    .join(', ');
  return header;
}

function percent(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function parseQuery(qs: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!qs) return out;
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const [rawKey, rawValue = ''] = pair.split('=');
    const key = decodeURIComponent(rawKey ?? '');
    const value = decodeURIComponent(rawValue);
    (out[key] ??= []).push(value);
  }
  return out;
}

// Used only by tests to build a deterministic hash for snapshot comparisons.
export function hashPayload(payload: DispatchPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
