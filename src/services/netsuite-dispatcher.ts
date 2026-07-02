// NetSuite outbound dispatcher (D11 / endpoint #14).
//
// When `FEATURE_NETSUITE_DISPATCH_ENABLED=true`, the real OAuth 1.0a/TBA
// pipeline is used: per-organization credentials are read from the
// `organization` row, the request is signed with HMAC-SHA256 and POSTed to
// the standard NetSuite invoice record (`/record/v1/invoice`).
//
// v24: we now emit a STANDARD NetSuite invoice (not a custom staging record).
// The call sites keep building a canonical mini-Lago payload; this dispatcher
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
};

// Shape (parcial) del payload canónico que arman los call sites.
type CanonicalInvoice = {
  external_id?: string;
  minilago_invoice_id?: string;
  issued_at?: string;
  currency?: string;
  customer?: {
    external_id?: string;
    netsuite_internal_id?: string | null;
    netsuite_entity_handle?: string;
  };
  billing_period?: { from?: string | null; to?: string | null };
  lines?: Array<{
    fee_id?: string;
    kind?: string;
    description?: string | null;
    units?: string;
    unit_amount_cents?: number;
    amount_cents?: number;
    netsuite_item_code?: string | null;
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

    const url = `${org.netsuiteRestBase}/services/rest/record/v1/invoice`;
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

// Traduce el payload canónico de mini-Lago a un body de invoice estándar de
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
    // externalId liga la factura NetSuite con la de mini-Lago (idempotencia +
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
  if (config.department) record.department = { id: config.department };
  if (config.location) record.location = { id: config.location };

  const memoParts = ['Numaris Billing'];
  if (payload.minilago_invoice_id) memoParts.push(payload.minilago_invoice_id);
  const period = payload.billing_period;
  if (period?.from && period?.to) memoParts.push(`${String(period.from).slice(0, 10)}..${String(period.to).slice(0, 10)}`);
  record.memo = memoParts.join(' · ');

  return record;
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
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

  const header = `OAuth realm="${args.realm}", ` + Object.entries(oauthParams)
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
