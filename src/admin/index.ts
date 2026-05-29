// Admin back-office routes (mounted at /admin/*).
//
// Server-rendered with template literals (no build step). Protected by
// HTTP Basic Auth: ADMIN_USER + ADMIN_PASSWORD env vars.
//
// Sections:
//   - Dashboard with counts + seed Numaris + hard reset.
//   - Customers (list, detail with services / invoices / CNs).
//   - Services (list, detail with units / invoices, terminate action).
//   - Units (list filtered by service, terminate / re-activate).
//   - Events (audit stream).
//   - Invoices (list, detail with fees+units_annex, void, simulate folio).
//   - Credit notes (list, detail, simulate folio).
//   - Taxes (list + create).
//   - Settings (display timezone + cookie).

import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import basicAuth from '@fastify/basic-auth';
import { DateTime } from 'luxon';
import formbody from '@fastify/formbody';
import type { Organization, PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import type { AppConfig } from '../config.js';
import type { NetSuiteDispatcher } from '../services/netsuite-dispatcher.js';
import { seedNumaris } from './seed.js';
import { resetOrganizationData } from '../services/reset.js';
import { billingPeriodFor } from '../services/billing-engine.js';
import { buildSignatureHeader } from '../services/hmac.js';
import { isValidIanaTimezone } from '../services/tz.js';
import { adminContextStorage } from './context.js';
import {
  INPUT_CLASS,
  INPUT_CLASS_MONO,
  badge,
  btn,
  card,
  code,
  escapeHtml,
  fmtDate,
  fmtDateOnly,
  fmtMoney,
  formField,
  formSection,
  kv,
  layout,
  pageHeader,
  pageTitle,
  panel,
  postButton,
  primaryButton,
  secondaryLink,
  statusBadge,
  table,
} from './views.js';
import { computeDashboardMetrics, renderDashboardBody } from './dashboard.js';
import { isCustomerTab, renderCustomerDetail, renderNewCustomerForm, type CustomerTab } from './customer-detail.js';
import { renderServiceNewForm } from './service-form.js';
import { isServiceTab, renderServiceDetail, type ServiceTab } from './service-detail.js';

type Deps = {
  config: AppConfig;
  prisma: PrismaClient;
  dispatcher: NetSuiteDispatcher;
  callbackBaseUrl: string;
};

// <input type="datetime-local"> envía "YYYY-MM-DDTHH:mm" (a veces con
// segundos). Lo interpretamos como UTC para que coincida con la etiqueta
// "(UTC)" de los forms.
function toUtcIso(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return trimmed;
  if (trimmed.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(trimmed)) return trimmed;
  return /T\d{2}:\d{2}:\d{2}/.test(trimmed) ? `${trimmed}Z` : `${trimmed}:00Z`;
}

// Para campos donde la UI etiqueta el datetime-local con la tz de
// preferencia del admin (no UTC), convierte la entrada local a UTC ISO
// usando esa tz. Si la tz es inválida, cae a comportamiento UTC.
function dtLocalInTzToUtcIso(raw: string, tz: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return trimmed;
  if (trimmed.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(trimmed)) return trimmed;
  const dt = DateTime.fromISO(trimmed, { zone: tz });
  if (!dt.isValid) return toUtcIso(raw);
  return dt.toUTC().toISO() ?? toUtcIso(raw);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

async function getOrg(prisma: PrismaClient): Promise<Organization | null> {
  return prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
}

function setFlash(reply: FastifyReply, kind: 'success' | 'error', message: string): void {
  reply.setCookie('flash', `${kind}:${message}`, {
    path: '/admin',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 5,
  });
}

function readFlash(request: FastifyRequest, reply: FastifyReply): { kind: 'success' | 'error'; message: string } | null {
  const raw = (request as unknown as { cookies: Record<string, string | undefined> }).cookies?.flash;
  if (!raw) return null;
  reply.clearCookie('flash', { path: '/admin' });
  const [kind, ...rest] = raw.split(':');
  if (kind !== 'success' && kind !== 'error') return null;
  return { kind, message: rest.join(':') };
}

function counter(label: string, value: string | number, href?: string): string {
  const inner = `<div class="text-xs uppercase text-gray-500 tracking-wider">${escapeHtml(label)}</div>
    <div class="text-2xl font-semibold mt-1">${escapeHtml(value)}</div>`;
  if (href) {
    return `<a href="${href}" class="block bg-white border rounded p-4 hover:shadow">${inner}</a>`;
  }
  return `<div class="bg-white border rounded p-4">${inner}</div>`;
}

export async function registerAdmin(app: FastifyInstance, deps: Deps): Promise<void> {
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    await app.register(formbody);
  }
  const { default: fastifyCookie } = await import('@fastify/cookie');
  await app.register(fastifyCookie);

  const authMode = deps.config.adminAuthMode;

  // v16: si ADMIN_AUTH_MODE=google, registra el flow de Google OAuth.
  let googleConfigured = false;
  if (authMode === 'google') {
    const { registerGoogleAuth } = await import('./auth-google.js');
    if (deps.config.googleOauthClientId && deps.config.googleOauthClientSecret && deps.config.sessionSecret) {
      await registerGoogleAuth(app, {
        clientId: deps.config.googleOauthClientId,
        clientSecret: deps.config.googleOauthClientSecret,
        publicBaseUrl: deps.callbackBaseUrl,
        allowedDomain: deps.config.adminAllowedEmailDomain,
        sessionSecret: deps.config.sessionSecret,
      });
      googleConfigured = true;
    } else {
      app.log.warn('ADMIN_AUTH_MODE=google requires GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET y SESSION_SECRET. Cayendo a basic auth como fallback de emergencia.');
    }
  }

  // Basic auth se mantiene como break-glass — si Google está configurado, basic
  // queda inactivo pero el plugin sigue registrado para no romper otras partes.
  const adminUser = process.env.ADMIN_USER ?? 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin';
  await app.register(basicAuth, {
    validate: async (username, password) => {
      const userOk = timingSafeStringEqual(username, adminUser);
      const passOk = timingSafeStringEqual(password, adminPassword);
      if (!userOk || !passOk) throw new Error('invalid credentials');
    },
    authenticate: { realm: 'Numaris Billing admin' },
  });

  const sessionSecret = deps.config.sessionSecret ?? '';

  app.addHook('preHandler', async (request, reply) => {
    const url = request.url;
    // Rutas de auth (login/callback/logout) — no protegidas, son el propio flow.
    if (url.startsWith('/admin/auth/')) return;
    // No-admin → siempre pasa.
    if (!url.startsWith('/admin')) return;

    // Admin → requiere auth.
    if (googleConfigured && authMode === 'google') {
      const { getGoogleSession } = await import('./auth-google.js');
      const session = getGoogleSession(request, sessionSecret);
      if (!session) {
        const target = encodeURIComponent(url);
        reply.redirect(`/admin/auth/login?next=${target}`);
        return reply;
      }
      // Decora request con la sesión para que los handlers puedan leerla.
      (request as unknown as Record<string, unknown>).googleSession = session;
      // Y la propaga al AsyncLocalStorage para que `layout()` la pueda renderizar
      // en la sidebar sin tener que recibirla como argumento.
      const store = adminContextStorage.getStore();
      if (store) store.user = { email: session.email, name: session.name, picture: session.picture };
      return;
    }

    // Basic auth fallback.
    await new Promise<void>((resolve, reject) => {
      app.basicAuth(request, reply, (err: Error | null | undefined) => err ? reject(err) : resolve());
    });
  });

  const { prisma } = deps;

  // Cached org timezone for the AsyncLocalStorage context (the hook must
  // run sync — no `await` before `enterWith`).
  let cachedOrgTz = 'UTC';
  void (async () => {
    const org = await getOrg(prisma);
    if (org) cachedOrgTz = org.timezone;
  })();
  setInterval(async () => {
    const org = await getOrg(prisma);
    if (org) cachedOrgTz = org.timezone;
  }, 60_000).unref();

  app.addHook('onRequest', (request, _reply, done) => {
    if (!request.url.startsWith('/admin')) return done();
    const cookies = (request as unknown as { cookies?: Record<string, string | undefined> }).cookies ?? {};
    let tz = cookies.admin_display_tz;
    if (!tz || !isValidIanaTimezone(tz)) tz = cachedOrgTz;
    const techMode = cookies.admin_tech_mode === 'on';
    adminContextStorage.enterWith({
      displayTz: tz,
      user: null,
      techMode,
      currentUrl: request.url,
    });
    done();
  });

  // ------------------------------------------------------------------
  // Dashboard.
  // ------------------------------------------------------------------
  // Presentación HTML pública (sin auth) para que se pueda compartir vía
  // link en Slack u otros canales — los .html como attachment se muestran
  // como código y no son útiles. El handler vive en el módulo admin por
  // proximidad con el archivo, pero la ruta no empieza con /admin así que
  // el preHandler de basicAuth la deja pasar. Cache en memoria 5 min.
  let presentacionCache: { content: string; loadedAt: number } | null = null;
  app.get('/presentacion.html', async (_request, reply) => {
    const ttlMs = 5 * 60 * 1000;
    if (!presentacionCache || Date.now() - presentacionCache.loadedAt > ttlMs) {
      try {
        const filePath = resolvePath(process.cwd(), 'docs/presentations/finanzas-motor-billing.html');
        const content = await readFile(filePath, 'utf-8');
        presentacionCache = { content, loadedAt: Date.now() };
      } catch (err) {
        reply.status(500).type('text/plain').send(`No se pudo cargar la presentación: ${err instanceof Error ? err.message : 'unknown'}`);
        return;
      }
    }
    reply.type('text/html; charset=utf-8').send(presentacionCache.content);
  });

  app.get('/admin', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) {
      reply.type('text/html').send(layout({
        title: 'Setup',
        body: card('Setup', '<p>No hay organización. Arranca el server con <code>npm run dev</code>.</p>'),
        orgSlug: '—',
      }));
      return;
    }
    const flash = readFlash(request, reply);

    const metrics = await computeDashboardMetrics(prisma, org);

    // Acciones de operación — sólo visibles en modo técnico ya que son
    // herramientas de devs/seed/reset, no de uso operativo diario.
    const seedAction = postButton('/admin/seed', 'Seed Numaris (demo)', 'primary');
    const resetForm = `
      <details class="mt-2">
        <summary class="cursor-pointer text-sm text-red-700 font-medium">Hard reset (borrar TODA la data de esta org)</summary>
        <form method="post" action="/admin/reset" class="mt-3 space-y-2 p-3 border border-red-200 rounded bg-red-50">
          <p class="text-sm text-gray-700">Borra customers, services, units, events, invoices y CNs para <b>${escapeHtml(org.slug)}</b>. Org y API key se preservan. No se puede deshacer.</p>
          <label class="block">
            <span class="text-xs text-gray-700">Escribe <code class="font-mono">${escapeHtml(org.slug)}</code> para confirmar:</span>
            <input required name="confirm" autocomplete="off" class="mt-1 block w-full rounded border-red-300 shadow-sm font-mono text-sm">
          </label>
          <button type="submit" class="px-3 py-1.5 rounded text-sm font-medium bg-red-600 text-white hover:bg-red-700">Reset definitivo</button>
        </form>
      </details>
    `;
    const techBlock = adminContextStorage.getStore()?.techMode
      ? card('Herramientas técnicas', `
        <div class="space-y-3 text-sm">
          <div>${seedAction}</div>
          ${kv([
            ['ID', `<code>${escapeHtml(org.id)}</code>`],
            ['API key', `<code>${escapeHtml(org.apiKey)}</code>`],
          ])}
          ${resetForm}
        </div>
      `)
      : '';

    reply.type('text/html').send(layout({
      title: 'Dashboard',
      active: '/admin',
      orgSlug: org.slug,
      flash,
      body: renderDashboardBody({
        metrics,
        org,
        dispatchFlagOn: deps.config.featureNetsuiteDispatchEnabled,
      }) + techBlock,
    }));
  });

  app.post('/admin/seed', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const result = await seedNumaris(prisma, org);
    setFlash(reply, 'success', `Seed listo · customer=${result.customer_external_id} service=${result.service_code} units+=${result.units_created}`);
    reply.redirect('/admin');
  });

  app.post('/admin/reset', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const body = (request.body ?? {}) as { confirm?: string };
    if (body.confirm !== org.slug) {
      setFlash(reply, 'error', `Confirmación incorrecta. Esperaba "${org.slug}".`);
      return reply.redirect('/admin');
    }
    const summary = await resetOrganizationData(prisma, org.id);
    const cleared = Object.entries(summary.cleared).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(', ');
    setFlash(reply, 'success', `Reset completo. Borrado: ${cleared || 'nada (ya estaba vacío)'}`);
    reply.redirect('/admin');
  });

  // ------------------------------------------------------------------
  // Customers.
  // ------------------------------------------------------------------
  app.get('/admin/customers', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const customers = await prisma.customer.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { services: { where: { status: 'active' } } } } },
    });
    const flash = readFlash(request, reply);
    const newButton = btn('/admin/customers/new', '+ Nuevo cliente', 'primary');
    reply.type('text/html').send(layout({
      title: 'Clientes', active: '/admin/customers', orgSlug: org.slug, flash,
      body: pageHeader('Clientes', newButton) + table({
        rows: customers,
        empty: '<div>Sin clientes todavía. <a href="/admin/customers/new" class="text-indigo-700 hover:underline">Crear el primero</a> o usa la API.</div>',
        rowHref: (c) => `/admin/customers/${c.externalId}`,
        columns: [
          { label: 'Nombre', render: (c) => escapeHtml(c.name) },
          { label: 'Estado', render: (c) => {
            if (c.status === 'pending') return badge('programado', 'blue');
            if (c.status === 'terminated') return badge('terminado', 'gray');
            if (c._count.services === 0) return badge('sin plan', 'yellow');
            return badge('activo', 'green');
          } },
          { label: 'Currency', render: (c) => escapeHtml(c.currency) },
          { label: 'País', render: (c) => escapeHtml(c.country ?? '—') },
          { label: 'Timezone', render: (c) => escapeHtml(c.timezone ?? '—') },
          { label: 'Creado', render: (c) => fmtDate(c.createdAt) },
        ],
      }),
    }));
  });

  // Form de alta de cliente. En la práctica los clientes llegan por API
  // (Numaris u otra plataforma externa), pero el form es útil para casos
  // manuales, demos y pruebas. El POST reutiliza el endpoint API vía
  // app.inject() — así no duplicamos la lógica de validación / counter /
  // currentBillingPeriod, y los cambios al endpoint API se propagan
  // automáticamente al admin.
  app.get('/admin/customers/new', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: 'Nuevo cliente',
      active: '/admin/customers',
      orgSlug: org.slug,
      flash,
      body: renderNewCustomerForm({}, { displayTz: adminContextStorage.getStore()?.displayTz ?? org.timezone, orgTimezone: org.timezone }),
    }));
  });

  app.post('/admin/customers/new', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const form = (request.body ?? {}) as Record<string, string | undefined>;

    // Transformar el form (todos los campos llegan como string) al payload
    // del API. Sólo incluimos campos con valor — así los `undefined` dejan
    // que el API aplique sus defaults sin enviar `null` y disparar
    // validaciones innecesarias.
    const get = (k: string): string | undefined => {
      const v = form[k];
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    };
    const num = (k: string): number | undefined => {
      const v = get(k);
      return v === undefined ? undefined : Number(v);
    };
    const customerPayload: Record<string, unknown> = {};
    const externalId = get('external_id');
    if (externalId) customerPayload.external_id = externalId;
    const name = get('name');
    if (name) customerPayload.name = name;
    const currency = get('currency');
    if (currency) customerPayload.currency = currency.toUpperCase();
    const subAt = get('subscription_at');
    if (subAt) {
      const displayTz = adminContextStorage.getStore()?.displayTz ?? org.timezone;
      customerPayload.subscription_at = dtLocalInTzToUtcIso(subAt, displayTz);
    }
    const periodMonths = num('billing_period_months');
    if (periodMonths) customerPayload.billing_period_months = periodMonths;
    const anchorDay = num('billing_anchor_day');
    if (anchorDay) customerPayload.billing_anchor_day = anchorDay;
    const anchorMonth = num('billing_anchor_month');
    if (anchorMonth) customerPayload.billing_anchor_month = anchorMonth;
    const trigger = get('nonrecurring_trigger');
    if (trigger) customerPayload.nonrecurring_trigger = trigger;
    const cycleMode = get('cycle_invoice_mode');
    if (cycleMode) customerPayload.cycle_invoice_mode = cycleMode;
    const tz = get('timezone');
    if (tz) customerPayload.timezone = tz;
    const country = get('country');
    if (country) customerPayload.country = country.toUpperCase();

    // El endpoint /api/v1/customers hace upsert por external_id; desde la
    // UI eso confunde — si el operador escribe un id que ya existe quiere
    // saberlo, no actualizar al cliente silenciosamente. Validación previa
    // para reportar conflicto explícito.
    if (typeof customerPayload.external_id === 'string') {
      const dup = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId: customerPayload.external_id } },
        select: { name: true, externalId: true },
      });
      if (dup) {
        const msg = `Ya existe un cliente con identificador "${dup.externalId}" (${dup.name}). Elige otro identificador o edita el existente.`;
        reply.status(409).type('text/html').send(layout({
          title: 'Nuevo cliente',
          active: '/admin/customers',
          orgSlug: org.slug,
          flash: { kind: 'error', message: msg },
          body: renderNewCustomerForm(form, { displayTz: adminContextStorage.getStore()?.displayTz ?? org.timezone, orgTimezone: org.timezone }),
        }));
        return;
      }
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: {
        authorization: `Bearer ${org.apiKey}`,
        'content-type': 'application/json',
      },
      payload: { customer: customerPayload },
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      const result = response.json() as { customer: { external_id: string; name: string } };
      setFlash(reply, 'success', `Cliente "${result.customer.name}" creado.`);
      return reply.redirect(`/admin/customers/${result.customer.external_id}`);
    }

    // Error: re-renderizar el form con los valores capturados y el
    // mensaje del API (validación o conflict).
    type ApiError = { error_details?: Record<string, string[]>; code?: string; error?: string };
    let parsed: ApiError = {};
    try {
      parsed = response.json() as ApiError;
    } catch {
      // body no era JSON (raro pero defensivo)
    }
    let errorMsg = 'No se pudo crear el cliente.';
    if (parsed.error_details && Object.keys(parsed.error_details).length > 0) {
      errorMsg = Object.entries(parsed.error_details)
        .map(([k, v]) => `${k}: ${v.join(', ')}`)
        .join(' · ');
    } else if (parsed.code) {
      errorMsg = parsed.code;
    } else if (parsed.error) {
      errorMsg = parsed.error;
    }
    reply.status(response.statusCode).type('text/html').send(layout({
      title: 'Nuevo cliente',
      active: '/admin/customers',
      orgSlug: org.slug,
      flash: { kind: 'error', message: errorMsg },
      body: renderNewCustomerForm(form, { displayTz: adminContextStorage.getStore()?.displayTz ?? org.timezone, orgTimezone: org.timezone }),
    }));
  });



  app.get('/admin/customers/:externalId', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { externalId } = request.params as { externalId: string };
    const query = request.query as { tab?: string };
    const tab: CustomerTab = isCustomerTab(query.tab) ? query.tab : 'resumen';

    const customer = await prisma.customer.findUnique({
      where: { organizationId_externalId: { organizationId: org.id, externalId } },
      include: {
        organization: true,
        services: {
          orderBy: { createdAt: 'desc' },
          include: {
            units: { orderBy: [{ activeTo: 'asc' }, { activeFrom: 'desc' }] },
          },
        },
        addOns: { orderBy: [{ activeFrom: 'desc' }, { code: 'asc' }] },
        invoices: { orderBy: { createdAt: 'desc' } },
        creditNotes: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!customer) {
      reply.status(404).type('text/html').send(layout({
        title: 'Not Found', orgSlug: org.slug,
        body: pageHeader('Customer no existe') + btn('/admin/customers', '← back'),
      }));
      return;
    }

    // Eventos del customer — los cargamos sólo si el tab activo es 'eventos'
    // para no penalizar el resto de pestañas. Si la lista del customer
    // crece, agregamos paginación aquí.
    const events = tab === 'eventos'
      ? await prisma.eventLog.findMany({
          where: {
            organizationId: org.id,
            service: { customerId: customer.id },
          },
          orderBy: { timestamp: 'desc' },
          take: 200,
        })
      : [];

    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: `${customer.name} · Cliente`,
      active: '/admin/customers',
      orgSlug: org.slug,
      flash,
      body: renderCustomerDetail({ customer, events, tab, org }),
    }));
  });


  // ------------------------------------------------------------------
  // Services.
  // ------------------------------------------------------------------
  app.get('/admin/services', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const services = await prisma.service.findMany({
      where: { organizationId: org.id },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        customer: { select: { externalId: true, name: true } },
        _count: { select: { units: { where: { activeTo: null } } } },
      },
    });
    const flash = readFlash(request, reply);

    const activeCount = services.filter((s) => s.status === 'active').length;
    const terminatedCount = services.length - activeCount;

    const renderMoney = (cents: number, currency: string): string =>
      cents === 0
        ? '<span class="ink-faint">—</span>'
        : `<span class="font-mono-pro num">${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span> <span class="text-[10px] uppercase ink-faint">${escapeHtml(currency)}</span>`;

    const tableBody = services.length === 0
      ? `<div class="surface-card p-12 text-center" style="border-radius: 6px;">
          <div class="ink-soft text-sm">Sin planes todavía. <a href="/admin/services/new" class="hover:underline" style="color: var(--accent-deep);">Crea el primero</a> o usa la API.</div>
        </div>`
      : table({
          rows: services,
          empty: 'Sin planes',
          rowHref: (s) => `/admin/services/${s.code}`,
          columns: [
            { label: 'Plan', render: (s) => `<div class="font-medium ink">${escapeHtml(s.name)}</div><code class="font-mono-pro text-[11px] ink-faint">${escapeHtml(s.code)}</code>` },
            { label: 'Cliente', render: (s) => `<span class="ink-soft">${escapeHtml(s.customer.name)}</span>` },
            { label: 'Status', render: (s) => statusBadge(s.status) },
            { label: 'Modelo', render: (s) => s.pricingModel === 'one_off'
              ? '<span class="pill pill-info">Pago único</span>'
              : '<span class="pill pill-success">Recurrente</span>' },
            { label: 'Renta /u', render: (s) => renderMoney(s.monthlyUnitAmountCents, s.currency) },
            { label: 'Setup /u', render: (s) => renderMoney(s.setupUnitAmountCents, s.currency) },
            { label: 'Baja /u', render: (s) => renderMoney(s.removalUnitAmountCents, s.currency) },
            { label: 'Unidades', render: (s) => `<span class="font-mono-pro num">${s._count.units}</span>` },
          ],
        });

    const header = `
      <header class="mb-8 flex items-end justify-between gap-6 flex-wrap">
        <div class="max-w-3xl">
          <div class="text-[10px] uppercase tracking-[0.18em] font-medium mb-3" style="color: var(--accent);">Catálogo</div>
          <h1 class="font-display text-[2.25rem] leading-[1.1] font-medium ink tracking-tight">Planes</h1>
          <p class="text-[15px] ink-soft mt-3 leading-relaxed max-w-2xl">
            ${activeCount} activo${activeCount === 1 ? '' : 's'}${terminatedCount > 0 ? ` · ${terminatedCount} terminado${terminatedCount === 1 ? '' : 's'}` : ''}.
            Un plan define cómo se cobra un servicio (renta, setup, baja, mensualidades prepagadas) y a qué item de NetSuite se mapea cada línea.
          </p>
        </div>
        <div class="flex items-center gap-2 shrink-0 pb-1">
          <a href="/admin/services/new" class="btn-primary inline-flex items-center justify-center">+ Nuevo plan</a>
        </div>
      </header>
    `;

    reply.type('text/html').send(layout({
      title: 'Planes', active: '/admin/services', orgSlug: org.slug, flash,
      body: header + tableBody,
    }));
  });

  app.get('/admin/services/new', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const q = request.query as { customer?: string };
    const customers = await prisma.customer.findMany({
      where: { organizationId: org.id, status: { not: 'terminated' } },
      orderBy: { name: 'asc' },
      select: { externalId: true, name: true, currency: true },
    });
    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: 'Nuevo plan', active: '/admin/services', orgSlug: org.slug, flash,
      body: renderServiceNewForm({
        customers,
        selectedCustomerExternalId: q.customer,
      }),
    }));
  });

  app.post('/admin/services', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const body = request.body as Record<string, string>;

    // El form rediseñado captura montos en pesos (decimales). El motor
    // persiste y procesa en centavos enteros — convertimos aquí.
    // Math.round es seguro contra el clásico 45.50 * 100 = 4549.99...
    const pesosToCents = (raw: string | undefined): number => {
      if (!raw || raw.trim() === '') return 0;
      const n = Number(raw);
      if (Number.isNaN(n) || n < 0) return 0;
      return Math.round(n * 100);
    };

    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: { authorization: `Bearer ${org.apiKey}`, 'content-type': 'application/json' },
      payload: {
        service: {
          code: body.code,
          customer_external_id: body.customer_external_id,
          name: body.name,
          description: body.description || undefined,
          // currency se hereda del customer en el API (no la pasamos para
          // forzar el default a través de payload.currency ?? customer.currency).
          pricing_model: body.pricing_model || 'recurring',
          monthly_unit_amount_cents: pesosToCents(body.monthly_unit_amount),
          setup_unit_amount_cents: pesosToCents(body.setup_unit_amount),
          removal_unit_amount_cents: pesosToCents(body.removal_unit_amount),
          setup_billing_mode: body.setup_billing_mode || 'next_cycle',
          removal_billing_mode: body.removal_billing_mode || 'next_cycle',
          prepaid_months_default: body.prepaid_months_default ? Number(body.prepaid_months_default) : undefined,
          netsuite_monthly_item_code: body.netsuite_monthly_item_code || null,
          netsuite_setup_item_code: body.netsuite_setup_item_code || null,
          netsuite_removal_item_code: body.netsuite_removal_item_code || null,
        },
      },
    });
    if (result.statusCode !== 200) {
      setFlash(reply, 'error', `Rechazado: ${result.body.slice(0, 240)}`);
      return reply.redirect('/admin/services/new');
    }
    setFlash(reply, 'success', `Plan "${body.code}" creado.`);
    reply.redirect(`/admin/services/${body.code}`);
  });

  app.get('/admin/services/:code', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { code: svcCode } = request.params as { code: string };
    const query = request.query as { tab?: string };
    const tab: ServiceTab = isServiceTab(query.tab) ? query.tab : 'resumen';
    const service = await prisma.service.findUnique({
      where: { organizationId_code: { organizationId: org.id, code: svcCode } },
      include: {
        customer: true,
        units: { orderBy: [{ activeTo: 'asc' }, { activeFrom: 'desc' }] },
        addOns: { orderBy: [{ activeFrom: 'desc' }] },
      },
    });
    if (!service) {
      reply.status(404).type('text/html').send(layout({
        title: 'Not Found', orgSlug: org.slug,
        body: pageHeader('Plan no existe') + btn('/admin/services', '← back'),
      }));
      return;
    }
    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: `${service.name} · Plan`,
      active: '/admin/services',
      orgSlug: org.slug,
      flash,
      body: renderServiceDetail({ service, tab }),
    }));
    return;
  });

  app.post('/admin/services/:code/add-ons', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { code: svcCode } = request.params as { code: string };
    const body = request.body as Record<string, string>;
    const result = await app.inject({
      method: 'POST',
      url: `/api/v1/services/${encodeURIComponent(svcCode)}/add-ons`,
      headers: { authorization: `Bearer ${org.apiKey}`, 'content-type': 'application/json' },
      payload: {
        service_add_on: {
          code: body.code,
          name: body.name,
          description: (body.description as string) || undefined,
          amount_cents: Number(body.amount_cents),
          netsuite_item_code: body.netsuite_item_code || null,
        },
      },
    });
    if (result.statusCode !== 200) setFlash(reply, 'error', `Rechazado: ${result.body.slice(0, 240)}`);
    else setFlash(reply, 'success', `Add-on "${body.code}" creado`);
    reply.redirect(`/admin/services/${svcCode}`);
  });

  app.post('/admin/service-add-ons/:id/terminate', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { id } = request.params as { id: string };
    const addOn = await prisma.serviceAddOn.findFirst({
      where: { id, service: { organizationId: org.id } },
      include: { service: true },
    });
    if (!addOn) {
      setFlash(reply, 'error', 'service_add_on no encontrado');
      return reply.redirect('/admin/services');
    }
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/service-add-ons/${id}`,
      headers: { authorization: `Bearer ${org.apiKey}` },
    });
    setFlash(reply, 'success', `Add-on ${addOn.code} terminado`);
    reply.redirect(`/admin/services/${addOn.service.code}`);
  });

  // GET /admin/customers/:external_id/preview — vista previa (dry-run) de la
  // cycle invoice. No persiste nada. Acepta query params para iterar:
  //   ?period_from=YYYY-MM-DDTHH:mm&period_to=...&now=YYYY-MM-DDTHH:mm
  // Default: usa el ciclo vigente del customer y "ahora" real.
  app.get('/admin/customers/:externalId/preview', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { externalId } = request.params as { externalId: string };
    const q = request.query as { period_from?: string; period_to?: string; now?: string };

    const customer = await prisma.customer.findUnique({
      where: { organizationId_externalId: { organizationId: org.id, externalId } },
    });
    if (!customer) {
      reply.status(404).type('text/html').send(layout({
        title: 'Not Found', orgSlug: org.slug,
        body: pageHeader('Customer no existe') + btn('/admin/customers', '← back'),
      }));
      return;
    }

    // Defaults útiles para el form: pinta el periodo CANÓNICO que el preview
    // sin override calcularía (billingPeriodFor → anclado a startOf-day en la
    // tz del customer). Si usáramos customer.currentBillingPeriodStartedAt
    // crudo, el form mostraría el subscription_at mid-day y "Recalcular"
    // sin cambios produciría un periodo distinto al de la carga inicial.
    const dt = (d: Date | null | undefined): string => {
      if (!d) return '';
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mi = String(d.getUTCMinutes()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
    };
    const realNow = new Date();
    const tz = customer.timezone ?? org.timezone ?? 'UTC';
    const canonical = billingPeriodFor(customer, tz, realNow);
    const defaultFrom: Date | null = canonical.start;
    const defaultTo: Date | null = canonical.end;

    // Llama al endpoint de preview vía app.inject para reusar la lógica.
    const payload: Record<string, string> = { customer_external_id: externalId };
    if (q.period_from) payload.period_from = toUtcIso(q.period_from);
    if (q.period_to) payload.period_to = toUtcIso(q.period_to);
    if (q.now) payload.now = toUtcIso(q.now);

    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/invoices/preview',
      headers: { authorization: `Bearer ${org.apiKey}`, 'content-type': 'application/json' },
      payload: { invoice: payload },
    });

    let body: string;
    if (result.statusCode !== 200) {
      body = `<div class="bg-red-50 border border-red-300 rounded p-4 text-red-900 text-sm"><strong>Preview falló (${result.statusCode}):</strong> <pre class="mt-2 whitespace-pre-wrap">${escapeHtml(result.body)}</pre></div>`;
    } else {
      const preview = (result.json() as { preview: {
        period: { from: string; to: string; days_in_period: number };
        reference_now: string;
        fees: Array<{ kind: string; description: string; units: string; unit_amount_cents: number; amount_cents: number; netsuite_item_code: string | null }>;
        fees_amount_cents: number;
        units_annex: unknown;
        netsuite_payload: unknown;
      } }).preview;

      const totalsBox = `
        <div class="grid grid-cols-3 gap-3 mb-4 text-sm">
          <div class="bg-white border rounded p-3"><div class="text-xs text-gray-500 uppercase">Periodo</div><div class="font-mono">${escapeHtml(fmtDateOnly(preview.period.from))} → ${escapeHtml(fmtDateOnly(preview.period.to))}</div><div class="text-xs text-gray-500 mt-1">${preview.period.days_in_period} días</div></div>
          <div class="bg-white border rounded p-3"><div class="text-xs text-gray-500 uppercase">Reference "now"</div><div class="font-mono">${escapeHtml(fmtDate(preview.reference_now))}</div></div>
          <div class="bg-indigo-50 border border-indigo-300 rounded p-3"><div class="text-xs text-indigo-700 uppercase">Total a NetSuite (sin IVA)</div><div class="font-mono text-lg">${escapeHtml(fmtMoney(preview.fees_amount_cents, customer.currency))}</div></div>
        </div>
      `;

      const feesTable = table({
        rows: preview.fees,
        empty: 'No hay fees — el ciclo no generaría invoice',
        columns: [
          { label: 'Kind', render: (f) => badge(f.kind, f.kind === 'monthly' ? 'blue' : f.kind === 'setup' ? 'yellow' : f.kind === 'one_off' ? 'green' : 'gray') },
          { label: 'Descripción', render: (f) => escapeHtml(f.description) },
          { label: 'NS item', render: (f) => f.netsuite_item_code
            ? `<code class="text-xs">${escapeHtml(f.netsuite_item_code)}</code>`
            : '<span class="text-red-600 text-xs font-medium" title="línea sin item_code — NetSuite probablemente rechace">⚠ falta</span>' },
          { label: 'Units', render: (f) => `<code>${escapeHtml(f.units)}</code>` },
          { label: 'Precio /u', render: (f) => fmtMoney(f.unit_amount_cents, customer.currency) },
          { label: 'Importe', render: (f) => `<strong>${escapeHtml(fmtMoney(f.amount_cents, customer.currency))}</strong>` },
        ],
      });

      body = totalsBox + feesTable
        + '<details class="mt-6"><summary class="cursor-pointer text-indigo-700 font-medium">units_annex (anexo de unidades)</summary>'
        + code(preview.units_annex) + '</details>'
        + '<details class="mt-3" open><summary class="cursor-pointer text-indigo-700 font-medium">Payload completo que se enviaría a NetSuite</summary>'
        + code(preview.netsuite_payload) + '</details>';
    }

    const form = `
      <form method="get" action="/admin/customers/${escapeHtml(externalId)}/preview" class="bg-white border rounded p-4 mb-6">
        <p class="text-xs text-gray-500 mb-3">Dry-run: NO crea invoice, NO marca units como facturadas, NO envía a NetSuite. Re-ejecuta cuantas veces quieras.</p>
        <div class="grid grid-cols-3 gap-3">
          <label class="block text-sm"><span class="text-gray-700">Periodo desde (UTC)</span>
            <input type="datetime-local" name="period_from" value="${escapeHtml(q.period_from ?? dt(defaultFrom))}" class="mt-1 block w-full rounded border-gray-300 text-sm">
          </label>
          <label class="block text-sm"><span class="text-gray-700">Periodo hasta (UTC)</span>
            <input type="datetime-local" name="period_to" value="${escapeHtml(q.period_to ?? dt(defaultTo))}" class="mt-1 block w-full rounded border-gray-300 text-sm">
          </label>
          <label class="block text-sm"><span class="text-gray-700">Simular "hoy" (UTC, opcional)</span>
            <input type="datetime-local" name="now" value="${escapeHtml(q.now ?? '')}" placeholder="${dt(realNow)}" class="mt-1 block w-full rounded border-gray-300 text-sm">
          </label>
        </div>
        <div class="mt-3 flex gap-2">
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded text-sm">Recalcular preview</button>
          <a href="/admin/customers/${escapeHtml(externalId)}/preview" class="px-4 py-2 bg-white border rounded text-sm text-gray-700">Reset a defaults</a>
          <a href="/admin/customers/${escapeHtml(externalId)}" class="ml-auto px-4 py-2 bg-white border rounded text-sm text-gray-700">← Back to customer</a>
        </div>
      </form>
    `;

    reply.type('text/html').send(layout({
      title: `Preview · ${customer.externalId}`, active: '/admin/customers', orgSlug: org.slug,
      body: pageHeader(`Vista previa: ${customer.name}`, btn(`/admin/customers/${customer.externalId}`, '← back'))
        + form + body,
    }));
  });

  // POST /admin/customers/:external_id/invoice → calcula la factura del periodo.
  // v12: edita soft fields del customer (form admin → API PATCH).
  app.post('/admin/customers/:externalId/edit', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { externalId } = request.params as { externalId: string };
    const body = request.body as Record<string, string>;
    const payload: Record<string, unknown> = {};
    // Solo mandar campos que vinieron con valor (los vacíos del form los
    // tratamos como "no cambiar"). Para limpiar a null, mejor usar el API
    // directo — el admin form mantiene el valor previo.
    if (body.name !== undefined) payload.name = body.name;
    if (body.email !== undefined) payload.email = body.email || null;
    if (body.phone !== undefined) payload.phone = body.phone || null;
    if (body.tax_identification_number !== undefined) payload.tax_identification_number = body.tax_identification_number || null;
    if (body.address_line1 !== undefined) payload.address_line1 = body.address_line1 || null;
    if (body.address_line2 !== undefined) payload.address_line2 = body.address_line2 || null;
    if (body.city !== undefined) payload.city = body.city || null;
    if (body.state !== undefined) payload.state = body.state || null;
    if (body.zipcode !== undefined) payload.zipcode = body.zipcode || null;
    if (body.country !== undefined) payload.country = body.country ? body.country.toUpperCase() : null;
    if (body.timezone !== undefined) payload.timezone = body.timezone || null;
    if (body.currency !== undefined) payload.currency = body.currency ? body.currency.toUpperCase() : undefined;
    if (body.netsuite_internal_id !== undefined) payload.netsuite_internal_id = body.netsuite_internal_id || null;
    const result = await app.inject({
      method: 'PATCH',
      url: `/api/v1/customers/${encodeURIComponent(externalId)}`,
      headers: { authorization: `Bearer ${org.apiKey}`, 'content-type': 'application/json' },
      payload: { customer: payload },
    });
    if (result.statusCode !== 200) setFlash(reply, 'error', `Rechazado: ${result.body.slice(0, 240)}`);
    else setFlash(reply, 'success', 'Datos del cliente actualizados.');
    reply.redirect(`/admin/customers/${externalId}`);
  });

  // v11: edita el calendario de facturación del customer (form admin → API).
  app.post('/admin/customers/:externalId/billing-schedule', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { externalId } = request.params as { externalId: string };
    const body = request.body as Record<string, string>;
    const payload: Record<string, unknown> = {};
    if (body.subscription_at) {
      const displayTz = adminContextStorage.getStore()?.displayTz ?? org.timezone;
      payload.subscription_at = dtLocalInTzToUtcIso(body.subscription_at, displayTz);
    }
    if (body.billing_anchor_day) payload.billing_anchor_day = Number(body.billing_anchor_day);
    if (body.billing_period_months) payload.billing_period_months = Number(body.billing_period_months);
    // billing_anchor_month: string vacío → null (limpia override); número → set.
    if (body.billing_anchor_month !== undefined) {
      payload.billing_anchor_month = body.billing_anchor_month === '' ? null : Number(body.billing_anchor_month);
    }
    if (body.nonrecurring_trigger) payload.nonrecurring_trigger = body.nonrecurring_trigger;
    if (body.cycle_invoice_mode) payload.cycle_invoice_mode = body.cycle_invoice_mode;
    const result = await app.inject({
      method: 'PATCH',
      url: `/api/v1/customers/${encodeURIComponent(externalId)}/billing-schedule`,
      headers: { authorization: `Bearer ${org.apiKey}`, 'content-type': 'application/json' },
      payload: { billing_schedule: payload },
    });
    if (result.statusCode !== 200) setFlash(reply, 'error', `Rechazado: ${result.body.slice(0, 240)}`);
    else setFlash(reply, 'success', 'Calendario de facturación actualizado.');
    reply.redirect(`/admin/customers/${externalId}`);
  });

  app.post('/admin/customers/:externalId/invoice', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { externalId } = request.params as { externalId: string };
    const idemKey = `admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: { authorization: `Bearer ${org.apiKey}`, 'content-type': 'application/json', 'idempotency-key': idemKey },
      payload: { invoice: { customer_external_id: externalId, metadata: { idempotency_key: idemKey } } },
    });
    if (result.statusCode !== 200) {
      setFlash(reply, 'error', `Rechazado: ${result.body.slice(0, 240)}`);
      return reply.redirect(`/admin/customers/${externalId}`);
    }
    const invoiceId = (result.json() as { invoice: { id: string } }).invoice.id;
    setFlash(reply, 'success', 'Factura creada.');
    reply.redirect(`/admin/invoices/${invoiceId}`);
  });

  // POST /admin/customers/:external_id/add-ons (customer-level flat add-on)
  app.post('/admin/customers/:externalId/add-ons', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { externalId } = request.params as { externalId: string };
    const body = request.body as Record<string, string>;
    const result = await app.inject({
      method: 'POST',
      url: `/api/v1/customers/${encodeURIComponent(externalId)}/add-ons`,
      headers: { authorization: `Bearer ${org.apiKey}`, 'content-type': 'application/json' },
      payload: {
        customer_add_on: {
          code: body.code,
          name: body.name,
          description: (body.description as string) || undefined,
          amount_cents: Number(body.amount_cents),
          netsuite_item_code: body.netsuite_item_code || null,
        },
      },
    });
    if (result.statusCode !== 200) setFlash(reply, 'error', `Rechazado: ${result.body.slice(0, 240)}`);
    else setFlash(reply, 'success', `Customer add-on "${body.code}" creado`);
    reply.redirect(`/admin/customers/${externalId}`);
  });

  app.post('/admin/customer-add-ons/:id/terminate', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { id } = request.params as { id: string };
    const addOn = await prisma.customerAddOn.findFirst({
      where: { id, customer: { organizationId: org.id } },
      include: { customer: true },
    });
    if (!addOn) {
      setFlash(reply, 'error', 'customer_add_on no encontrado');
      return reply.redirect('/admin/customers');
    }
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/customer-add-ons/${id}`,
      headers: { authorization: `Bearer ${org.apiKey}` },
    });
    setFlash(reply, 'success', `Customer add-on ${addOn.code} terminado`);
    reply.redirect(`/admin/customers/${addOn.customer.externalId}`);
  });

  // v8: crear unit (form admin → POST /api/v1/units).
  app.post('/admin/services/:code/units', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { code: svcCode } = request.params as { code: string };
    const body = request.body as Record<string, string>;
    const payload: Record<string, unknown> = {
      service_code: svcCode,
      external_id: body.external_id,
      active_from: toUtcIso(body.active_from ?? ''),
    };
    if (body.label) payload.label = body.label;
    if (body.billing_starts_at) payload.billing_starts_at = toUtcIso(body.billing_starts_at);
    if (body.prepaid_months) payload.prepaid_months = Number(body.prepaid_months);
    if (body.setup_already_billed === '1') payload.setup_already_billed = true;
    if (body.one_off_already_billed === '1') payload.one_off_already_billed = true;
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/units',
      headers: { authorization: `Bearer ${org.apiKey}`, 'content-type': 'application/json' },
      payload: { unit: payload },
    });
    if (result.statusCode !== 200) setFlash(reply, 'error', result.body.slice(0, 240));
    else setFlash(reply, 'success', `Unit ${body.external_id} creada.`);
    reply.redirect(`/admin/services/${svcCode}`);
  });

  // v8: pantalla simple para editar una unit (label, billing_starts_at, active_to).
  app.get('/admin/units/:id/edit', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { id } = request.params as { id: string };
    const unit = await prisma.unit.findFirst({
      where: { id, service: { organizationId: org.id } },
      include: { service: true },
    });
    if (!unit) {
      reply.status(404).type('text/html').send(layout({
        title: 'Not Found', orgSlug: org.slug,
        body: pageHeader('Unit no existe') + btn('/admin/units', '← back'),
      }));
      return;
    }
    const dt = (d: Date | null | undefined): string => {
      if (!d) return '';
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mi = String(d.getUTCMinutes()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
    };
    const flash = readFlash(request, reply);
    const meta = (unit.metadata as Record<string, unknown> | null) ?? {};
    const migratedTo = meta.migrated_to as { service_code?: string; at?: string } | undefined;
    const migratedFrom = meta.migrated_from as { service_code?: string; at?: string } | undefined;
    const info = kv([
      ['Service', `<a class="text-indigo-700 underline" href="/admin/services/${escapeHtml(unit.service.code)}">${escapeHtml(unit.service.code)}</a>`],
      ['External ID', `<code>${escapeHtml(unit.externalId)}</code>`],
      ['Active from', fmtDate(unit.activeFrom)],
      ['Billing starts at', unit.billingStartsAt ? `<span class="text-amber-700">${escapeHtml(fmtDate(unit.billingStartsAt))}</span>` : '<span class="text-gray-400">— (usa active_from)</span>'],
      ['Active to', fmtDate(unit.activeTo)],
      // Mostramos solo el gate relevante al pricing_model. Para recurring sin
      // setup, indicamos "n/a" para no confundir con el gate de one_off.
      ...(unit.service.pricingModel === 'one_off'
        ? [['One-off facturada', unit.oneoffBilledAt ? badge('billed', 'green') : badge('pendiente', 'yellow')] as [string, string]]
        : unit.service.setupUnitAmountCents === 0
          ? [['Setup', '<span class="text-gray-400 text-xs">n/a (service sin setup)</span>'] as [string, string]]
          : [['Setup billed', unit.setupBilledAt ? badge('billed', 'green') : badge('pendiente', 'yellow')] as [string, string]]),
      ...(migratedFrom ? [['Migrada desde', `${escapeHtml(migratedFrom.service_code ?? '?')} (${escapeHtml(migratedFrom.at ? fmtDate(new Date(migratedFrom.at)) : '?')})`] as [string, string]] : []),
      ...(migratedTo ? [['Migrada hacia', `<span class="text-amber-700">${escapeHtml(migratedTo.service_code ?? '?')} (${escapeHtml(migratedTo.at ? fmtDate(new Date(migratedTo.at)) : '?')})</span>`] as [string, string]] : []),
    ]);
    const form = `
      <form method="post" action="/admin/units/${unit.id}/edit" class="space-y-3 max-w-2xl">
        <p class="text-xs text-gray-500">Campos editables. <code>billing_starts_at</code> vacío = limpia override y usa <code>active_from</code>.</p>
        <label class="block"><span class="text-sm text-gray-700">Label</span>
          <input name="label" value="${escapeHtml(unit.label ?? '')}" class="mt-1 block w-full rounded border-gray-300 text-sm">
        </label>
        <label class="block"><span class="text-sm text-gray-700">Billing starts at (UTC)</span>
          <input type="datetime-local" name="billing_starts_at" value="${escapeHtml(dt(unit.billingStartsAt))}" class="mt-1 block w-full rounded border-gray-300 text-sm">
        </label>
        <div class="flex gap-2">
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded text-sm">Guardar</button>
          <a href="/admin/services/${escapeHtml(unit.service.code)}" class="px-4 py-2 bg-white border rounded text-sm text-gray-700">Cancelar</a>
        </div>
      </form>
    `;

    // Migración: solo si la unit está activa y no ha sido migrada antes.
    const canMigrate = unit.activeTo === null && !migratedTo;
    let migrateBlock = '';
    if (canMigrate) {
      // Candidate services: mismo customer, mismo pricing_model, distinto al actual, activos.
      const candidates = await prisma.service.findMany({
        where: {
          customerId: unit.service.customerId,
          pricingModel: unit.service.pricingModel,
          status: 'active',
          id: { not: unit.serviceId },
        },
        orderBy: { code: 'asc' },
      });
      if (candidates.length === 0) {
        migrateBlock = '<p class="text-sm text-gray-500">No hay otros services activos del mismo customer y pricing model (<code>' + escapeHtml(unit.service.pricingModel) + '</code>) a los que migrar.</p>';
      } else {
        // Default migration_at sugerido: mañana 00:00 UTC.
        const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const defaultAt = `${tomorrow.getUTCFullYear()}-${String(tomorrow.getUTCMonth() + 1).padStart(2, '0')}-${String(tomorrow.getUTCDate()).padStart(2, '0')}T00:00`;
        const opts = candidates.map((s) => `<option value="${escapeHtml(s.code)}">${escapeHtml(s.code)} — ${escapeHtml(s.name)} (${fmtMoney(s.monthlyUnitAmountCents, s.currency)}/u/mes)</option>`).join('');
        migrateBlock = `
          <form method="post" action="/admin/units/${unit.id}/migrate" class="space-y-3 max-w-2xl"
            onsubmit="return confirm('La unit ${escapeHtml(unit.externalId)} se cerrará en el plan actual y se creará en el nuevo plan a la fecha indicada. ¿Continuar?')">
            <p class="text-xs text-gray-500">Migra esta unit a otro plan del mismo customer. Política: solo a futuro, mismo pricing model, sin cobrar setup del plan nuevo (a menos que marques la casilla).</p>
            <label class="block"><span class="text-sm text-gray-700">Plan destino</span>
              <select required name="to_service_code" class="mt-1 block w-full rounded border-gray-300 text-sm">
                <option value="">— elegir —</option>
                ${opts}
              </select>
            </label>
            <label class="block"><span class="text-sm text-gray-700">Migration at (UTC, debe ser futuro)</span>
              <input required type="datetime-local" name="migration_at" value="${defaultAt}" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Nuevo label (opcional)</span>
              <input name="new_label" placeholder="${escapeHtml(unit.label ?? '')}" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
            <label class="inline-flex items-center text-sm">
              <input type="checkbox" name="charge_new_setup" value="1" class="rounded border-gray-300">
              <span class="ml-2 text-gray-700">Cobrar setup del plan nuevo (default: no)</span>
            </label>
            <div class="flex gap-2">
              <button type="submit" class="px-4 py-2 bg-amber-600 text-white rounded text-sm hover:bg-amber-700">Migrar de plan</button>
            </div>
          </form>
        `;
      }
    } else if (migratedTo) {
      migrateBlock = `<p class="text-sm text-amber-700">Esta unit ya fue migrada hacia <code>${escapeHtml(migratedTo.service_code ?? '?')}</code> el ${escapeHtml(migratedTo.at ? fmtDate(new Date(migratedTo.at)) : '?')}.</p>`;
    } else {
      migrateBlock = '<p class="text-sm text-gray-500">La unit está terminada — no puede migrarse.</p>';
    }

    reply.type('text/html').send(layout({
      title: `Unit · ${unit.externalId}`, active: '/admin/units', orgSlug: org.slug, flash,
      body: pageHeader(`Editar unit: ${unit.externalId}`, btn(`/admin/services/${unit.service.code}`, '← back'))
        + card('Info', info)
        + card('Editar', form)
        + card('Migrar a otro plan', migrateBlock),
    }));
  });

  app.post('/admin/units/:id/edit', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, string>;
    const unit = await prisma.unit.findFirst({ where: { id, service: { organizationId: org.id } }, include: { service: true } });
    if (!unit) return reply.redirect('/admin/units');
    const patch: Record<string, unknown> = {};
    patch.label = body.label ?? '';
    // Vacío → null (limpia el override).
    patch.billing_starts_at = body.billing_starts_at ? toUtcIso(body.billing_starts_at) : null;
    const result = await app.inject({
      method: 'PATCH',
      url: `/api/v1/units/${id}`,
      headers: { authorization: `Bearer ${org.apiKey}`, 'content-type': 'application/json' },
      payload: { unit: patch },
    });
    if (result.statusCode !== 200) setFlash(reply, 'error', result.body.slice(0, 240));
    else setFlash(reply, 'success', `Unit ${unit.externalId} actualizada.`);
    reply.redirect(`/admin/services/${unit.service.code}`);
  });

  // v8: migración de plan (admin → API).
  app.post('/admin/units/:id/migrate', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, string>;
    const unit = await prisma.unit.findFirst({ where: { id, service: { organizationId: org.id } }, include: { service: true } });
    if (!unit) return reply.redirect('/admin/units');
    const payload: Record<string, unknown> = {
      to_service_code: body.to_service_code,
      migration_at: toUtcIso(body.migration_at ?? ''),
      charge_new_setup: body.charge_new_setup === '1',
    };
    if (body.new_label) payload.new_label = body.new_label;
    const result = await app.inject({
      method: 'POST',
      url: `/api/v1/units/${id}/migrate`,
      headers: { authorization: `Bearer ${org.apiKey}`, 'content-type': 'application/json' },
      payload: { migration: payload },
    });
    if (result.statusCode !== 200) {
      setFlash(reply, 'error', `Migración rechazada: ${result.body.slice(0, 240)}`);
      return reply.redirect(`/admin/units/${id}/edit`);
    }
    const { new_unit } = result.json() as { new_unit: { id: string; service_id: string } };
    setFlash(reply, 'success', `Unit ${unit.externalId} migrada a ${body.to_service_code}. Nueva unit: ${new_unit.id}`);
    reply.redirect(`/admin/units/${new_unit.id}/edit`);
  });

  app.post('/admin/services/:code/terminate', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { code: svcCode } = request.params as { code: string };
    const result = await app.inject({
      method: 'POST',
      url: `/api/v1/services/${encodeURIComponent(svcCode)}/terminate`,
      headers: { authorization: `Bearer ${org.apiKey}` },
    });
    if (result.statusCode !== 200) setFlash(reply, 'error', result.body.slice(0, 240));
    else setFlash(reply, 'success', `Service ${svcCode} terminado.`);
    reply.redirect(`/admin/services/${svcCode}`);
  });

  // v7: programar cambio de precio (form HTML → API JSON).
  app.post('/admin/services/:code/price', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { code: svcCode } = request.params as { code: string };
    const body = request.body as Record<string, string>;
    const effectiveFromIso = toUtcIso(body.effective_from ?? '');
    const result = await app.inject({
      method: 'PUT',
      url: `/api/v1/services/${encodeURIComponent(svcCode)}/price`,
      headers: { authorization: `Bearer ${org.apiKey}`, 'content-type': 'application/json' },
      payload: {
        price: {
          monthly_unit_amount_cents: Number(body.monthly_unit_amount_cents ?? 0),
          setup_unit_amount_cents: Number(body.setup_unit_amount_cents ?? 0),
          effective_from: effectiveFromIso,
        },
      },
    });
    if (result.statusCode !== 200) setFlash(reply, 'error', result.body.slice(0, 240));
    else setFlash(reply, 'success', `Cambio de precio programado para ${svcCode}.`);
    reply.redirect(`/admin/services/${svcCode}`);
  });

  app.post('/admin/services/:code/pending-price/cancel', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { code: svcCode } = request.params as { code: string };
    const result = await app.inject({
      method: 'DELETE',
      url: `/api/v1/services/${encodeURIComponent(svcCode)}/pending-price`,
      headers: { authorization: `Bearer ${org.apiKey}` },
    });
    if (result.statusCode !== 200) setFlash(reply, 'error', result.body.slice(0, 240));
    else setFlash(reply, 'success', `Cambio de precio programado cancelado.`);
    reply.redirect(`/admin/services/${svcCode}`);
  });

  // v9: actualizar códigos NetSuite del service.
  app.post('/admin/services/:code/netsuite-codes', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { code: svcCode } = request.params as { code: string };
    const body = request.body as Record<string, string>;
    // Solo enviamos los campos que el form expone (según pricingModel).
    const payload: Record<string, unknown> = {
      netsuite_setup_item_code: body.netsuite_setup_item_code ?? '',
    };
    if (body.netsuite_monthly_item_code !== undefined) {
      payload.netsuite_monthly_item_code = body.netsuite_monthly_item_code;
    }
    const result = await app.inject({
      method: 'PATCH',
      url: `/api/v1/services/${encodeURIComponent(svcCode)}`,
      headers: { authorization: `Bearer ${org.apiKey}`, 'content-type': 'application/json' },
      payload: { service: payload },
    });
    if (result.statusCode !== 200) setFlash(reply, 'error', result.body.slice(0, 240));
    else setFlash(reply, 'success', `Códigos NetSuite actualizados.`);
    reply.redirect(`/admin/services/${svcCode}`);
  });

  // ------------------------------------------------------------------
  // Units (read-only list + actions).
  // ------------------------------------------------------------------
  app.get('/admin/units', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const q = request.query as { service?: string; status?: 'active' | 'terminated' };
    const where: import('@prisma/client').Prisma.UnitWhereInput = { service: { organizationId: org.id } };
    if (q.service) where.service = { organizationId: org.id, code: q.service };
    if (q.status === 'active') where.activeTo = null;
    if (q.status === 'terminated') where.activeTo = { not: null };
    const units = await prisma.unit.findMany({
      where, orderBy: [{ activeFrom: 'desc' }],
      include: { service: true },
    });
    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: 'Units', active: '/admin/units', orgSlug: org.slug, flash,
      body: pageHeader('Units') + table({
        rows: units,
        empty: 'Sin units',
        columns: [
          { label: 'External ID', render: (u) => `<code>${escapeHtml(u.externalId)}</code>` },
          { label: 'Label', render: (u) => escapeHtml(u.label ?? '—') },
          { label: 'Service', render: (u) => `<a class="text-indigo-700 underline" href="/admin/services/${escapeHtml(u.service.code)}">${escapeHtml(u.service.code)}</a>` },
          { label: 'Status', render: (u) => statusBadge(u.activeTo === null ? 'active' : 'terminated') },
          { label: 'Active from', render: (u) => fmtDate(u.activeFrom) },
          { label: 'Billing starts', render: (u) => u.billingStartsAt ? `<span class="text-amber-700">${escapeHtml(fmtDate(u.billingStartsAt))}</span>` : '<span class="text-gray-400">—</span>' },
          { label: 'Active to', render: (u) => fmtDate(u.activeTo) },
          // Gate de facturación inicial: para recurring miramos setupBilledAt,
          // para one_off miramos oneoffBilledAt. Son campos distintos y el
          // motor solo marca el que corresponde al pricing_model del service.
          { label: 'Facturada', render: (u) => {
            const isOneOff = u.service.pricingModel === 'one_off';
            const billedAt = isOneOff ? u.oneoffBilledAt : u.setupBilledAt;
            // Para recurring sin setup_unit_amount_cents, setupBilledAt
            // siempre será null pero "facturada" no aplica como concepto;
            // mostramos "n/a" en gris.
            if (!isOneOff && u.service.setupUnitAmountCents === 0) {
              return '<span class="text-gray-400 text-xs">n/a (sin setup)</span>';
            }
            const label = isOneOff ? 'one_off' : 'setup';
            return billedAt
              ? badge(`${label}: billed`, 'green')
              : badge(`${label}: pendiente`, 'yellow');
          } },
          { label: '', render: (u) => `<a class="text-indigo-700 underline text-xs" href="/admin/units/${u.id}/edit">editar</a>` },
        ],
      }),
    }));
  });

  // ------------------------------------------------------------------
  // Events.
  // ------------------------------------------------------------------
  app.get('/admin/events', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const q = request.query as { service?: string };
    const where: import('@prisma/client').Prisma.EventLogWhereInput = { organizationId: org.id };
    if (q.service) {
      const svc = await prisma.service.findUnique({ where: { organizationId_code: { organizationId: org.id, code: q.service } } });
      if (svc) where.serviceId = svc.id;
    }
    const events = await prisma.eventLog.findMany({ where, orderBy: { timestamp: 'desc' }, take: 200, include: { service: true } });
    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: 'Events', active: '/admin/events', orgSlug: org.slug, flash,
      body: pageHeader('Events (últimos 200)') + table({
        rows: events,
        empty: 'Sin eventos',
        columns: [
          { label: 'Transaction ID', render: (e) => `<code class="text-xs">${escapeHtml(e.transactionId)}</code>` },
          { label: 'Service', render: (e) => `<a class="text-indigo-700 underline" href="/admin/services/${escapeHtml(e.service.code)}">${escapeHtml(e.service.code)}</a>` },
          { label: 'Operation', render: (e) => `${badge(e.operationType, e.operationType === 'remove' ? 'red' : 'green')} ${escapeHtml(e.unitExternalId)}${e.unitLabel ? ` <span class="text-gray-500 text-xs">(${escapeHtml(e.unitLabel)})</span>` : ''}` },
          { label: 'Kind', render: (e) => e.kind ? badge(e.kind, 'gray') : '—' },
          { label: 'Timestamp', render: (e) => fmtDate(e.timestamp) },
        ],
      }),
    }));
  });

  // ------------------------------------------------------------------
  // Invoices.
  // ------------------------------------------------------------------
  app.get('/admin/invoices', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const invoices = await prisma.invoice.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: 'desc' },
      include: { customer: { select: { externalId: true, name: true } } },
    });
    const flash = readFlash(request, reply);

    const totalNet = invoices
      .filter((i) => i.status !== 'voided')
      .reduce((sum, i) => sum + i.feesAmountCents, 0);
    const totalCurrency = invoices[0]?.currency ?? 'MXN';
    const failedCount = invoices.filter((i) => i.externalDispatchStatus === 'failed').length;

    const renderMoney = (cents: number, currency: string): string =>
      `<span class="font-mono-pro num">${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span> <span class="text-[10px] uppercase ink-faint">${escapeHtml(currency)}</span>`;

    const header = `
      <header class="mb-8 flex items-end justify-between gap-6 flex-wrap">
        <div class="max-w-3xl">
          <div class="text-[10px] uppercase tracking-[0.18em] font-medium mb-3" style="color: var(--accent);">Operaciones</div>
          <h1 class="font-display text-[2.25rem] leading-[1.1] font-medium ink tracking-tight">Facturas</h1>
          <p class="text-[15px] ink-soft mt-3 leading-relaxed max-w-2xl">
            ${invoices.length} factura${invoices.length === 1 ? '' : 's'} en total · ${renderMoney(totalNet, totalCurrency)} neto sin impuestos${failedCount > 0 ? ` · <span style="color: var(--danger);"><strong>${failedCount}</strong> con dispatch fallido</span>` : ''}.
            Los impuestos los aplica NetSuite al emitir el CFDI.
          </p>
        </div>
      </header>
    `;

    const tableBody = table({
      rows: invoices,
      empty: 'Sin facturas emitidas',
      rowHref: (i) => `/admin/invoices/${i.id}`,
      columns: [
        { label: '#', render: (i) => `<span class="font-mono-pro ink-faint num">${i.sequentialId}</span>` },
        { label: 'Folio fiscal', render: (i) => i.number ? `<code class="font-mono-pro text-[12px] ink">${escapeHtml(i.number)}</code>` : '<span class="ink-faint">—</span>' },
        { label: 'Cliente', render: (i) => `<span class="ink">${escapeHtml(i.customer.name)}</span>` },
        { label: 'Periodo', render: (i) => i.periodFrom && i.periodTo ? `<span class="text-xs ink-soft">${fmtDateOnly(i.periodFrom)} → ${fmtDateOnly(i.periodTo)}</span>` : '<span class="ink-faint">—</span>' },
        { label: 'Status', render: (i) => statusBadge(i.status) },
        { label: 'Dispatch', render: (i) => statusBadge(i.externalDispatchStatus) },
        { label: 'Total neto', render: (i) => renderMoney(i.feesAmountCents, i.currency), className: 'text-right' },
        { label: 'Emitida', render: (i) => `<span class="text-xs ink-soft">${fmtDateOnly(i.issuingDate)}</span>` },
      ],
    });

    reply.type('text/html').send(layout({
      title: 'Facturas', active: '/admin/invoices', orgSlug: org.slug, flash,
      body: header + tableBody,
    }));
  });

  app.get('/admin/invoices/:id', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { id } = request.params as { id: string };
    const invoice = await prisma.invoice.findFirst({
      where: { id, organizationId: org.id },
      include: { customer: true, fees: { orderBy: { position: 'asc' } } },
    });
    if (!invoice) {
      reply.status(404).type('text/html').send(layout({
        title: 'Not Found', orgSlug: org.slug,
        body: pageHeader('Factura no existe') + btn('/admin/invoices', '← back'),
      }));
      return;
    }

    const canVoid = invoice.status !== 'voided';
    const canConfirm = invoice.externalDispatchStatus !== 'confirmed';
    const techMode = adminContextStorage.getStore()?.techMode ?? false;

    // Header: número grande de invoice + estado + acciones.
    const header = `
      <div class="flex items-start justify-between gap-6 mb-2">
        <div>
          <div class="text-[11px] uppercase tracking-[0.14em] mb-2 ink-faint">
            Factura · <a class="hover:underline" style="color: var(--accent-deep);" href="/admin/customers/${escapeHtml(invoice.customer.externalId)}">${escapeHtml(invoice.customer.name)}</a>
          </div>
          <h1 class="font-display text-[2rem] leading-tight font-medium ink tracking-tight">
            ${invoice.number ? `<code class="font-mono-pro text-[1.6rem]">${escapeHtml(invoice.number)}</code>` : `#${invoice.sequentialId}`}
          </h1>
          <div class="flex items-center gap-2 mt-3">
            ${statusBadge(invoice.status)}
            ${statusBadge(invoice.externalDispatchStatus)}
            ${statusBadge(invoice.paymentStatus)}
          </div>
        </div>
        <div class="shrink-0">${secondaryLink('/admin/invoices', '← Facturas')}</div>
      </div>
    `;

    // Cifras grandes: total, periodo, emitida.
    const renderMoneyBig = (cents: number, currency: string): string =>
      `<div class="font-mono-pro text-3xl ink num tracking-tight">${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
       <div class="text-[10px] uppercase tracking-wider ink-faint mt-1">${escapeHtml(currency)} · neto sin impuestos</div>`;
    const metricsRow = `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-px surface-card mb-8" style="border-radius: 6px; overflow: hidden;">
        <div class="px-6 py-5 surface-card">
          <div class="text-[10px] uppercase tracking-[0.14em] ink-faint mb-2">Total neto</div>
          ${renderMoneyBig(invoice.feesAmountCents, invoice.currency)}
        </div>
        <div class="px-6 py-5 surface-card">
          <div class="text-[10px] uppercase tracking-[0.14em] ink-faint mb-2">Periodo facturado</div>
          ${invoice.periodFrom && invoice.periodTo
            ? `<div class="font-mono-pro text-sm ink mt-1">${fmtDateOnly(invoice.periodFrom)} <span class="ink-faint">→</span> ${fmtDateOnly(invoice.periodTo)}</div>`
            : `<div class="ink-faint italic">No aplica (factura individual)</div>`}
        </div>
        <div class="px-6 py-5 surface-card">
          <div class="text-[10px] uppercase tracking-[0.14em] ink-faint mb-2">Emitida</div>
          <div class="font-mono-pro text-sm ink mt-1">${fmtDateOnly(invoice.issuingDate)}</div>
          ${invoice.externalInvoiceConfirmedAt
            ? `<div class="text-[11px] mt-1.5" style="color: var(--accent-deep);">Confirmada ${fmtDateOnly(invoice.externalInvoiceConfirmedAt)}</div>`
            : ''}
        </div>
      </div>
    `;

    // Banner de error si hay dispatch fallido.
    const errorBanner = invoice.externalDispatchError
      ? `<div class="rounded p-4 mb-6" style="background: var(--danger-soft); border: 1px solid var(--danger-soft);">
          <div class="text-[10px] uppercase tracking-[0.14em] font-medium mb-2" style="color: var(--danger);">Error de dispatch</div>
          <code class="font-mono-pro text-xs ink">${escapeHtml(invoice.externalDispatchError)}</code>
        </div>`
      : '';

    // Líneas de la factura.
    const feesTable = invoice.fees.length === 0
      ? '<div class="text-sm ink-faint italic py-6 text-center">Sin líneas en esta factura.</div>'
      : table({
          rows: invoice.fees,
          columns: [
            { label: 'Concepto', render: (f) => {
              const kindLabels: Record<string, string> = { monthly: 'Renta mensual', setup: 'Setup', removal: 'Baja', service_addon: 'Add-on de plan', customer_addon: 'Add-on de cliente', one_off: 'One-off' };
              return `<div class="font-medium ink">${escapeHtml(kindLabels[f.kind] ?? f.kind)}</div><div class="text-xs ink-faint mt-0.5">${escapeHtml(f.description ?? '')}</div>`;
            } },
            { label: 'Unidades', render: (f) => `<span class="font-mono-pro num text-sm">${escapeHtml(f.units)}</span>` },
            { label: 'Precio /u', render: (f) => `<span class="font-mono-pro num text-sm">${escapeHtml(f.preciseUnitAmount)}</span>` },
            { label: 'Total', render: (f) => `<span class="font-mono-pro num">${(f.amountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span> <span class="text-[10px] uppercase ink-faint">${escapeHtml(invoice.currency)}</span>`, className: 'text-right' },
            { label: 'Detalle', render: (f) => {
              const units = f.billedUnitsDetail as unknown[];
              if (units.length === 0) return '<span class="ink-faint text-xs">—</span>';
              return `<details><summary class="cursor-pointer text-xs hover:underline" style="color: var(--accent-deep);">${units.length} unidad${units.length === 1 ? '' : 'es'}</summary><div class="mt-2 max-h-64 overflow-auto">${code(units)}</div></details>`;
            } },
          ],
        });

    // Acciones: void + simular folio (en finance / billing-ops, normalmente).
    const voidAction = canVoid
      ? `<form method="post" action="/admin/invoices/${invoice.id}/void" class="inline" onsubmit="return confirm('¿Anular factura #${invoice.sequentialId}? Esta acción no se puede deshacer.')">
          <button type="submit" class="inline-flex items-center justify-center rounded text-sm font-medium px-4 py-2 transition-colors" style="background: var(--danger); color: #FAFAFA;">Anular factura</button>
        </form>`
      : `<span class="pill pill-danger">Anulada</span>`;
    const confirmForm = canConfirm ? `
      <form method="post" action="/admin/invoices/${invoice.id}/simulate-confirm" class="space-y-4">
        <p class="text-sm ink-soft">Para staging y demos: simula el callback de NetSuite que confirma el folio fiscal y el UUID CFDI.</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          ${formField({
            label: 'Folio fiscal',
            required: true,
            input: `<input required name="folio" value="A-2026-${String(invoice.sequentialId).padStart(6, '0')}" class="${INPUT_CLASS_MONO}">`,
          })}
          ${formField({
            label: 'UUID CFDI',
            input: `<input name="uuid_cfdi" placeholder="vacío para simulación rápida" class="${INPUT_CLASS_MONO}">`,
          })}
        </div>
        ${primaryButton('Simular confirmación NetSuite')}
      </form>
    ` : '<div class="text-sm ink-faint">La factura ya está confirmada por NetSuite.</div>';

    const externalBlock = invoice.externalInvoiceFolio
      ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <div>
            <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Folio fiscal</div>
            <div class="font-mono-pro ink">${escapeHtml(invoice.externalInvoiceFolio)}</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">UUID CFDI</div>
            <div class="font-mono-pro ink text-xs">${invoice.externalInvoiceUuidCfdi ? escapeHtml(invoice.externalInvoiceUuidCfdi) : '<span class="ink-faint">—</span>'}</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Sistema</div>
            <div class="font-mono-pro ink">${escapeHtml(invoice.externalInvoiceSystem ?? '—')}</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Emitida en NetSuite</div>
            <div class="font-mono-pro ink">${invoice.externalInvoiceIssuedAt ? fmtDate(invoice.externalInvoiceIssuedAt) : '<span class="ink-faint">—</span>'}</div>
          </div>
        </div>`
      : '<div class="text-sm ink-faint italic">Aún sin confirmar por NetSuite — sin folio fiscal disponible.</div>';

    const techBlocks = techMode ? (
      panel({
        title: 'Datos técnicos',
        description: 'Identificadores internos, units annex y metadata raw.',
        body: `
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm mb-5">
            <div>
              <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">UUID interno</div>
              <code class="font-mono-pro text-xs ink">${escapeHtml(invoice.id)}</code>
            </div>
            <div>
              <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Sequential ID</div>
              <span class="font-mono-pro num ink">${invoice.sequentialId}</span>
            </div>
            <div class="sm:col-span-2">
              <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Idempotency key</div>
              <code class="font-mono-pro text-xs ink">${invoice.idempotencyKey ? escapeHtml(invoice.idempotencyKey) : '—'}</code>
            </div>
          </div>
          <details class="mb-4"><summary class="cursor-pointer text-sm font-medium" style="color: var(--accent-deep);">Units annex (JSON)</summary><div class="mt-3">${code(invoice.unitsAnnex)}</div></details>
          <details><summary class="cursor-pointer text-sm font-medium" style="color: var(--accent-deep);">Metadata (JSON)</summary><div class="mt-3">${code(invoice.metadata)}</div></details>
        `,
      })
    ) : '';

    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: `Factura ${invoice.number ?? '#' + invoice.sequentialId}`,
      active: '/admin/invoices', orgSlug: org.slug, flash,
      body: header
        + metricsRow
        + errorBanner
        + panel({ title: `Líneas · ${invoice.fees.length}`, description: 'Conceptos cobrados. Los impuestos los calcula NetSuite al emitir el CFDI.', body: feesTable })
        + panel({ title: 'Información fiscal · NetSuite', body: externalBlock })
        + panel({
            title: 'Acciones',
            body: `<div class="space-y-6">${voidAction}<hr style="border-top: 1px solid var(--rule-soft);">${confirmForm}</div>`,
          })
        + techBlocks,
    }));
  });

  app.post('/admin/invoices/:id/void', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { id } = request.params as { id: string };
    const result = await app.inject({
      method: 'POST', url: `/api/v1/invoices/${id}/void`,
      headers: { authorization: `Bearer ${org.apiKey}` },
    });
    if (result.statusCode !== 200) setFlash(reply, 'error', result.body.slice(0, 240));
    else setFlash(reply, 'success', 'Invoice voided');
    reply.redirect(`/admin/invoices/${id}`);
  });

  app.post('/admin/invoices/:id/simulate-confirm', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, string>;
    if (!org.netsuiteCallbackSecret) {
      setFlash(reply, 'error', 'Org sin netsuite_callback_secret (D12 fail-closed)');
      return reply.redirect(`/admin/invoices/${id}`);
    }
    const payload = JSON.stringify({
      external_invoice: {
        folio: body.folio,
        uuid_cfdi: body.uuid_cfdi || null,
        system: 'netsuite',
        netsuite_internal_id: `rec-sim-${Math.random().toString(36).slice(2, 10)}`,
        issued_at: new Date().toISOString(),
        total_amount_cents: 0,
        currency: 'MXN',
      },
    });
    const sig = buildSignatureHeader(org.netsuiteCallbackSecret, payload);
    const result = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${id}/external-confirm`,
      headers: { 'content-type': 'application/json', 'x-netsuite-signature': sig },
      payload,
    });
    if (result.statusCode !== 200) setFlash(reply, 'error', result.body.slice(0, 240));
    else setFlash(reply, 'success', `Invoice confirmada con folio ${body.folio}`);
    reply.redirect(`/admin/invoices/${id}`);
  });

  // ------------------------------------------------------------------
  // Credit notes.
  // ------------------------------------------------------------------
  app.get('/admin/credit-notes', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const cns = await prisma.creditNote.findMany({
      where: { organizationId: org.id }, orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { externalId: true, name: true } },
        invoice: { select: { id: true, number: true, sequentialId: true } },
      },
    });
    const flash = readFlash(request, reply);

    const totalNet = cns.reduce((sum, cn) => sum + cn.totalAmountCents, 0);
    const totalCurrency = cns[0]?.currency ?? 'MXN';
    const pendingCount = cns.filter((cn) => cn.externalDispatchStatus !== 'confirmed' && cn.externalDispatchStatus !== 'failed').length;

    const renderMoney = (cents: number, currency: string): string =>
      `<span class="font-mono-pro num">${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span> <span class="text-[10px] uppercase ink-faint">${escapeHtml(currency)}</span>`;

    const header = `
      <header class="mb-8 flex items-end justify-between gap-6 flex-wrap">
        <div class="max-w-3xl">
          <div class="text-[10px] uppercase tracking-[0.18em] font-medium mb-3" style="color: var(--accent);">Operaciones</div>
          <h1 class="font-display text-[2.25rem] leading-[1.1] font-medium ink tracking-tight">Notas de crédito</h1>
          <p class="text-[15px] ink-soft mt-3 leading-relaxed max-w-2xl">
            ${cns.length} en total · ${renderMoney(totalNet, totalCurrency)} acreditado${pendingCount > 0 ? ` · <span style="color: var(--warn);"><strong>${pendingCount}</strong> sin confirmar por NetSuite</span>` : ''}.
          </p>
        </div>
      </header>
    `;

    const tableBody = table({
      rows: cns,
      empty: 'Sin notas de crédito emitidas',
      rowHref: (cn) => `/admin/credit-notes/${cn.id}`,
      columns: [
        { label: 'Folio', render: (cn) => cn.number ? `<code class="font-mono-pro text-[12px] ink">${escapeHtml(cn.number)}</code>` : `<span class="font-mono-pro ink-faint num">#${cn.sequentialId}</span>` },
        { label: 'Factura', render: (cn) => cn.invoice.number ? `<code class="font-mono-pro text-[11px] ink-soft">${escapeHtml(cn.invoice.number)}</code>` : `<span class="font-mono-pro ink-faint">#${cn.invoice.sequentialId}</span>` },
        { label: 'Cliente', render: (cn) => `<span class="ink">${escapeHtml(cn.customer.name)}</span>` },
        { label: 'Status', render: (cn) => statusBadge(cn.status) },
        { label: 'Dispatch', render: (cn) => statusBadge(cn.externalDispatchStatus) },
        { label: 'Total', render: (cn) => renderMoney(cn.totalAmountCents, cn.currency), className: 'text-right' },
        { label: 'Razón', render: (cn) => `<span class="text-xs ink-soft">${escapeHtml(cn.reason)}</span>` },
      ],
    });

    reply.type('text/html').send(layout({
      title: 'Notas de crédito', active: '/admin/credit-notes', orgSlug: org.slug, flash,
      body: header + tableBody,
    }));
  });

  app.get('/admin/credit-notes/:id', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { id } = request.params as { id: string };
    const cn = await prisma.creditNote.findFirst({
      where: { id, organizationId: org.id },
      include: { customer: true, invoice: true, items: { include: { fee: true } } },
    });
    if (!cn) {
      reply.status(404).type('text/html').send(layout({
        title: 'Not Found', orgSlug: org.slug,
        body: pageHeader('Nota de crédito no existe') + btn('/admin/credit-notes', '← back'),
      }));
      return;
    }

    const canConfirm = cn.externalDispatchStatus !== 'confirmed';
    const techMode = adminContextStorage.getStore()?.techMode ?? false;

    const header = `
      <div class="flex items-start justify-between gap-6 mb-2">
        <div>
          <div class="text-[11px] uppercase tracking-[0.14em] mb-2 ink-faint">
            Nota de crédito · <a class="hover:underline" style="color: var(--accent-deep);" href="/admin/customers/${escapeHtml(cn.customer.externalId)}">${escapeHtml(cn.customer.name)}</a> · sobre <a class="hover:underline" style="color: var(--accent-deep);" href="/admin/invoices/${cn.invoiceId}">${cn.invoice.number ?? '#' + cn.invoice.sequentialId}</a>
          </div>
          <h1 class="font-display text-[2rem] leading-tight font-medium ink tracking-tight">
            ${cn.number ? `<code class="font-mono-pro text-[1.6rem]">${escapeHtml(cn.number)}</code>` : `#${cn.sequentialId}`}
          </h1>
          <div class="flex items-center gap-2 mt-3">
            ${statusBadge(cn.status)}
            ${statusBadge(cn.externalDispatchStatus)}
            ${statusBadge(cn.creditStatus)}
          </div>
        </div>
        <div class="shrink-0">${secondaryLink('/admin/credit-notes', '← Notas de crédito')}</div>
      </div>
    `;

    const metricsRow = `
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-px surface-card mb-8" style="border-radius: 6px; overflow: hidden;">
        <div class="px-6 py-5 surface-card">
          <div class="text-[10px] uppercase tracking-[0.14em] ink-faint mb-2">Total acreditado</div>
          <div class="font-mono-pro text-3xl ink num tracking-tight">${(cn.totalAmountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div class="text-[10px] uppercase tracking-wider ink-faint mt-1">${escapeHtml(cn.currency)} · neto sin impuestos</div>
        </div>
        <div class="px-6 py-5 surface-card">
          <div class="text-[10px] uppercase tracking-[0.14em] ink-faint mb-2">Razón</div>
          <div class="text-sm ink mt-1">${escapeHtml(cn.reason)}</div>
          ${cn.description ? `<div class="text-xs ink-soft mt-1.5 leading-relaxed">${escapeHtml(cn.description)}</div>` : ''}
        </div>
        <div class="px-6 py-5 surface-card">
          <div class="text-[10px] uppercase tracking-[0.14em] ink-faint mb-2">Emitida</div>
          <div class="font-mono-pro text-sm ink mt-1">${fmtDateOnly(cn.issuingDate)}</div>
          ${cn.externalCreditNoteConfirmedAt
            ? `<div class="text-[11px] mt-1.5" style="color: var(--accent-deep);">Confirmada ${fmtDateOnly(cn.externalCreditNoteConfirmedAt)}</div>`
            : ''}
        </div>
      </div>
    `;

    const itemsTable = cn.items.length === 0
      ? '<div class="text-sm ink-faint italic py-6 text-center">Sin líneas en esta nota de crédito.</div>'
      : table({
          rows: cn.items,
          columns: [
            { label: 'Concepto', render: (it) => {
              const kindLabels: Record<string, string> = { monthly: 'Renta mensual', setup: 'Setup', removal: 'Baja', service_addon: 'Add-on de plan', customer_addon: 'Add-on de cliente', one_off: 'One-off' };
              return `<div class="font-medium ink">${escapeHtml(kindLabels[it.fee.kind] ?? it.fee.kind)}</div><div class="text-xs ink-faint mt-0.5">${escapeHtml(it.fee.description ?? '')}</div>`;
            } },
            { label: 'Monto acreditado', render: (it) => `<span class="font-mono-pro num">${(it.amountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span> <span class="text-[10px] uppercase ink-faint">${escapeHtml(it.amountCurrency)}</span>`, className: 'text-right' },
            ...(techMode ? [{ label: 'Fee ID', render: (it: typeof cn.items[number]) => `<code class="font-mono-pro text-[11px] ink-faint">${escapeHtml(it.feeId.slice(0, 8))}…</code>` }] : []),
          ],
        });

    const externalBlock = cn.externalCreditNoteFolio
      ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <div>
            <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Folio fiscal</div>
            <div class="font-mono-pro ink">${escapeHtml(cn.externalCreditNoteFolio)}</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">UUID CFDI</div>
            <div class="font-mono-pro ink text-xs">${cn.externalCreditNoteUuidCfdi ? escapeHtml(cn.externalCreditNoteUuidCfdi) : '<span class="ink-faint">—</span>'}</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Sistema</div>
            <div class="font-mono-pro ink">${escapeHtml(cn.externalCreditNoteSystem ?? '—')}</div>
          </div>
          <div>
            <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Emitida en NetSuite</div>
            <div class="font-mono-pro ink">${cn.externalCreditNoteIssuedAt ? fmtDate(cn.externalCreditNoteIssuedAt) : '<span class="ink-faint">—</span>'}</div>
          </div>
        </div>`
      : '<div class="text-sm ink-faint italic">Aún sin confirmar por NetSuite — sin folio fiscal disponible.</div>';

    const confirmForm = canConfirm
      ? `<form method="post" action="/admin/credit-notes/${cn.id}/simulate-confirm" class="space-y-4">
          <p class="text-sm ink-soft">Para staging y demos: simula el callback de NetSuite que confirma el folio fiscal.</p>
          ${formField({
            label: 'Folio fiscal de la nota',
            required: true,
            input: `<input required name="folio" value="B-2026-${String(cn.sequentialId).padStart(6, '0')}" class="${INPUT_CLASS_MONO}" style="max-width: 20rem;">`,
          })}
          ${primaryButton('Simular confirmación NetSuite')}
        </form>`
      : '<div class="text-sm ink-faint">La nota ya está confirmada por NetSuite.</div>';

    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: `Nota de crédito ${cn.number ?? '#' + cn.sequentialId}`,
      active: '/admin/credit-notes', orgSlug: org.slug, flash,
      body: header
        + metricsRow
        + panel({ title: `Líneas · ${cn.items.length}`, description: 'Conceptos acreditados.', body: itemsTable })
        + panel({ title: 'Información fiscal · NetSuite', body: externalBlock })
        + panel({ title: 'Acciones', body: confirmForm }),
    }));
  });

  app.post('/admin/credit-notes/:id/simulate-confirm', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, string>;
    if (!org.netsuiteCallbackSecret) {
      setFlash(reply, 'error', 'Sin netsuite_callback_secret');
      return reply.redirect(`/admin/credit-notes/${id}`);
    }
    const payload = JSON.stringify({
      external_credit_note: {
        folio: body.folio,
        uuid_cfdi: null,
        system: 'netsuite',
        netsuite_internal_id: `rec-sim-${Math.random().toString(36).slice(2, 10)}`,
        issued_at: new Date().toISOString(),
      },
    });
    const sig = buildSignatureHeader(org.netsuiteCallbackSecret, payload);
    const result = await app.inject({
      method: 'POST',
      url: `/api/v1/credit_notes/${id}/external-confirm`,
      headers: { 'content-type': 'application/json', 'x-netsuite-signature': sig },
      payload,
    });
    if (result.statusCode !== 200) setFlash(reply, 'error', result.body.slice(0, 240));
    else setFlash(reply, 'success', `CN confirmada con folio ${body.folio}`);
    reply.redirect(`/admin/credit-notes/${id}`);
  });

  // ------------------------------------------------------------------
  // Settings.
  // ------------------------------------------------------------------
  app.get('/admin/settings', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const cookies = (request as unknown as { cookies?: Record<string, string | undefined> }).cookies ?? {};
    const currentCookie = cookies.admin_display_tz ?? '';
    const effective = adminContextStorage.getStore()?.displayTz ?? 'UTC';
    const commonTz = [
      'UTC', 'America/Mexico_City', 'America/New_York', 'America/Los_Angeles', 'America/Chicago',
      'America/Bogota', 'America/Lima', 'America/Buenos_Aires', 'America/Sao_Paulo',
      'Europe/Madrid', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo',
    ];
    const optionsHtml = commonTz.map((tz) =>
      `<option value="${escapeHtml(tz)}" ${tz === currentCookie ? 'selected' : ''}>${escapeHtml(tz)}</option>`,
    ).join('');
    const form = `
      <form method="post" action="/admin/settings" class="space-y-4 max-w-2xl">
        <label class="block">
          <span class="text-sm text-gray-700">Display timezone (IANA)</span>
          <select name="display_tz" class="mt-1 block w-full rounded border-gray-300">
            <option value="">— usar tz de la org (${escapeHtml(org.timezone)})</option>
            ${optionsHtml}
          </select>
        </label>
        <label class="block">
          <span class="text-sm text-gray-700">O zona custom</span>
          <input name="display_tz_custom" placeholder="ej. America/Tijuana" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
        </label>
        <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded">Guardar preferencia</button>
      </form>
    `;
    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: 'Settings', active: '/admin/settings', orgSlug: org.slug, flash,
      body: pageHeader('Settings') + card('Display timezone', `
        <p class="text-sm text-gray-600 mb-3">Las fechas mostradas en el admin se renderizan en esta zona. Las respuestas de la API siguen en UTC.</p>
        ${kv([
          ['Efectiva', `<code>${escapeHtml(effective)}</code>`],
          ['Cookie actual', currentCookie ? `<code>${escapeHtml(currentCookie)}</code>` : '<span class="text-gray-400">(sin set)</span>'],
          ['Org timezone', `<code>${escapeHtml(org.timezone)}</code>`],
        ])}
        <div class="mt-4">${form}</div>
      `),
    }));
  });

  app.post('/admin/settings', async (request, reply) => {
    const body = (request.body ?? {}) as { display_tz?: string; display_tz_custom?: string };
    const candidate = (body.display_tz_custom?.trim() || body.display_tz || '').trim();
    if (candidate === '') {
      reply.clearCookie('admin_display_tz', { path: '/' });
      setFlash(reply, 'success', 'Preferencia limpiada — volviendo a tz de la org.');
      return reply.redirect('/admin/settings');
    }
    if (!isValidIanaTimezone(candidate)) {
      setFlash(reply, 'error', `"${candidate}" no es una zona IANA válida.`);
      return reply.redirect('/admin/settings');
    }
    reply.setCookie('admin_display_tz', candidate, {
      path: '/', httpOnly: false, sameSite: 'lax', maxAge: 60 * 60 * 24 * 365,
    });
    setFlash(reply, 'success', `Timezone actualizada a ${candidate}.`);
    reply.redirect('/admin/settings');
  });

  // v20: toggle del modo técnico — esconde/muestra IDs, raw JSON,
  // idempotency keys y demás plomería. Cookie de 1 año por sesión del
  // navegador. El form en la sidebar manda `next` y `return_to`.
  app.post('/admin/settings/tech-mode', async (request, reply) => {
    const body = (request.body ?? {}) as { next?: string; return_to?: string };
    const next = body.next === 'on' ? 'on' : 'off';
    if (next === 'on') {
      reply.setCookie('admin_tech_mode', 'on', {
        path: '/', httpOnly: false, sameSite: 'lax', maxAge: 60 * 60 * 24 * 365,
      });
    } else {
      reply.clearCookie('admin_tech_mode', { path: '/' });
    }
    // Validar return_to para evitar open redirect — sólo permitimos URLs
    // relativas que empiecen con /admin.
    const returnTo = body.return_to;
    const safeReturn = returnTo && returnTo.startsWith('/admin') ? returnTo : '/admin';
    reply.redirect(safeReturn);
  });
}
