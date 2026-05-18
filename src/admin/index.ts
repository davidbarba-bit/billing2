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
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import basicAuth from '@fastify/basic-auth';
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
  badge,
  btn,
  card,
  code,
  escapeHtml,
  fmtDate,
  fmtDateOnly,
  fmtMoney,
  kv,
  layout,
  pageHeader,
  postButton,
  statusBadge,
  table,
} from './views.js';

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

  const adminUser = process.env.ADMIN_USER ?? 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin';
  await app.register(basicAuth, {
    validate: async (username, password) => {
      const userOk = timingSafeStringEqual(username, adminUser);
      const passOk = timingSafeStringEqual(password, adminPassword);
      if (!userOk || !passOk) throw new Error('invalid credentials');
    },
    authenticate: { realm: 'mini-Lago admin' },
  });

  app.addHook('preHandler', (request, reply, done) => {
    if (request.url.startsWith('/admin')) {
      app.basicAuth(request, reply, done);
      return;
    }
    done();
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
    adminContextStorage.enterWith({ displayTz: tz });
    done();
  });

  // ------------------------------------------------------------------
  // Dashboard.
  // ------------------------------------------------------------------
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
    const [customers, activeServices, activeUnits, events, invoices, invCalc, invDispatched, invConfirmed, creditNotes] = await Promise.all([
      prisma.customer.count({ where: { organizationId: org.id } }),
      prisma.service.count({ where: { organizationId: org.id, status: 'active' } }),
      prisma.unit.count({ where: { service: { organizationId: org.id }, activeTo: null } }),
      prisma.eventLog.count({ where: { organizationId: org.id } }),
      prisma.invoice.count({ where: { organizationId: org.id } }),
      prisma.invoice.count({ where: { organizationId: org.id, status: 'calculated' } }),
      prisma.invoice.count({ where: { organizationId: org.id, externalDispatchStatus: 'dispatched' } }),
      prisma.invoice.count({ where: { organizationId: org.id, externalDispatchStatus: 'confirmed' } }),
      prisma.creditNote.count({ where: { organizationId: org.id } }),
    ]);

    const counts = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        ${counter('Customers', customers, '/admin/customers')}
        ${counter('Services', activeServices, '/admin/services')}
        ${counter('Units', activeUnits, '/admin/units')}
        ${counter('Events', events, '/admin/events')}
        ${counter('Invoices', invoices, '/admin/invoices')}
        ${counter('Credit notes', creditNotes, '/admin/credit-notes')}
        ${counter('Dispatch confirmed', invConfirmed)}
      </div>
      <div class="grid grid-cols-3 gap-4 mb-6">
        ${counter('Invoices calculated', invCalc)}
        ${counter('Invoices dispatched', invDispatched)}
        ${counter('Invoices confirmed', invConfirmed)}
      </div>
    `;

    const seedAction = postButton('/admin/seed', 'Seed Numaris (3 unidades)', 'primary');
    const flash = readFlash(request, reply);
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

    reply.type('text/html').send(layout({
      title: 'Dashboard',
      active: '/admin',
      orgSlug: org.slug,
      flash,
      body: pageHeader('Dashboard', seedAction) + counts + card('Organización', kv([
        ['ID', `<code>${escapeHtml(org.id)}</code>`],
        ['Slug', escapeHtml(org.slug)],
        ['Timezone', escapeHtml(org.timezone)],
        ['API key', `<code>${escapeHtml(org.apiKey)}</code>`],
        ['NetSuite callback secret', org.netsuiteCallbackSecret ? '<span class="text-green-700">configurado</span>' : '<span class="text-yellow-700">no configurado</span>'],
        ['NetSuite dispatch flag', deps.config.featureNetsuiteDispatchEnabled ? badge('on', 'green') : badge('off', 'yellow')],
      ])) + card('Zona peligrosa', resetForm),
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
    });
    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: 'Customers', active: '/admin/customers', orgSlug: org.slug, flash,
      body: pageHeader('Customers') + table({
        rows: customers,
        empty: 'Sin customers — usa "Seed Numaris" en el dashboard',
        rowHref: (c) => `/admin/customers/${c.externalId}`,
        columns: [
          { label: 'Nombre', render: (c) => escapeHtml(c.name) },
          { label: 'Currency', render: (c) => escapeHtml(c.currency) },
          { label: 'Country', render: (c) => escapeHtml(c.country ?? '—') },
          { label: 'Timezone', render: (c) => escapeHtml(c.timezone ?? '—') },
          { label: 'Creado', render: (c) => fmtDate(c.createdAt) },
        ],
      }),
    }));
  });

  app.get('/admin/customers/:externalId', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { externalId } = request.params as { externalId: string };
    const customer = await prisma.customer.findUnique({
      where: { organizationId_externalId: { organizationId: org.id, externalId } },
      include: {
        organization: true,
        services: { orderBy: { createdAt: 'desc' } },
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

    const info = kv([
      ['External ID', `<code>${escapeHtml(customer.externalId)}</code>`],
      ['Slug', escapeHtml(customer.slug)],
      ['Nombre', escapeHtml(customer.name)],
      ['Currency', escapeHtml(customer.currency)],
      ['Country', escapeHtml(customer.country ?? '—')],
      ['Timezone', escapeHtml(customer.timezone ?? '—')],
      ['Tax ID', escapeHtml(customer.taxIdentificationNumber ?? '—')],
      ['Status', statusBadge(customer.status)],
      ['Intervalo', badge(`${customer.billingPeriodMonths}M`, 'blue')],
      ['Día de cierre', `día ${customer.billingAnchorDay} del mes`],
      ['No-recurrente', badge(customer.nonrecurringTrigger, customer.nonrecurringTrigger === 'immediate' ? 'green' : 'gray')],
      ['Subscription at', fmtDate(customer.subscriptionAt)],
      ['Started at', fmtDate(customer.startedAt)],
      ['Period start', fmtDate(customer.currentBillingPeriodStartedAt)],
      ['Period end', fmtDate(customer.currentBillingPeriodEndingAt)],
      ['Creado', fmtDate(customer.createdAt)],
      ['Actualizado', fmtDate(customer.updatedAt)],
    ]);

    const customerAddOnsBlock = table({
      rows: customer.addOns,
      empty: 'Sin customer add-ons',
      columns: [
        { label: 'Code', render: (a) => `<code>${escapeHtml(a.code)}</code>` },
        { label: 'Nombre', render: (a) => escapeHtml(a.name) },
        { label: 'Amount /mes', render: (a) => `${fmtMoney(a.amountCents, customer.currency)} flat/mes` },
        { label: 'Status', render: (a) => statusBadge(a.activeTo === null ? 'active' : 'terminated') },
        { label: 'Active from', render: (a) => fmtDate(a.activeFrom) },
        { label: 'Active to', render: (a) => fmtDate(a.activeTo) },
        { label: 'Acciones', render: (a) => a.activeTo === null
          ? postButton(`/admin/customer-add-ons/${a.id}/terminate`, 'Terminar', 'danger', `¿Terminar add-on ${a.code}?`)
          : '<span class="text-gray-400">terminated</span>' },
      ],
    });

    const customerAddOnForm = `
      <details>
        <summary class="cursor-pointer text-indigo-700 font-medium">+ Agregar customer add-on (flat)</summary>
        <form method="post" action="/admin/customers/${escapeHtml(customer.externalId)}/add-ons" class="mt-3 space-y-3 max-w-2xl">
          <p class="text-xs text-gray-500">Cargos flat independientes de unidades o services (ej. "10 reglas de evento +$1000/mes").</p>
          <div class="grid grid-cols-2 gap-3">
            <label class="block"><span class="text-sm text-gray-700">Code</span>
              <input required name="code" placeholder="reglas-10" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Nombre</span>
              <input required name="name" placeholder="Reglas de evento 5→10" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Amount flat (cents) /mes</span>
              <input required type="number" name="amount_cents" min="0" value="100000" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">NetSuite item code</span>
              <input name="netsuite_item_code" placeholder="ADDON-FLAT" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
            </label>
            <label class="block col-span-2"><span class="text-sm text-gray-700">Descripción</span>
              <input name="description" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
          </div>
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded">Crear customer add-on</button>
        </form>
      </details>
    `;

    const invoiceForm = `
      <form method="post" action="/admin/customers/${escapeHtml(customer.externalId)}/invoice" class="inline">
        <button type="submit" class="px-3 py-1.5 rounded bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">Calcular factura del periodo</button>
      </form>
      <a href="/admin/customers/${escapeHtml(customer.externalId)}/preview" class="ml-2 px-3 py-1.5 rounded bg-white text-gray-700 border text-sm font-medium hover:bg-gray-50 inline-flex items-center">Vista previa (dry-run)</a>
    `;

    const servicesBlock = table({
      rows: customer.services,
      empty: 'Sin services',
      rowHref: (s) => `/admin/services/${s.code}`,
      columns: [
        { label: 'Nombre', render: (s) => escapeHtml(s.name) },
        { label: 'Status', render: (s) => statusBadge(s.status) },
        { label: 'Mensual', render: (s) => fmtMoney(s.monthlyUnitAmountCents, s.currency) + '/u' },
        { label: 'Setup', render: (s) => fmtMoney(s.setupUnitAmountCents, s.currency) + '/u' },
      ],
    });

    const invoicesBlock = table({
      rows: customer.invoices,
      empty: 'Sin invoices',
      rowHref: (i) => `/admin/invoices/${i.id}`,
      columns: [
        { label: '#', render: (i) => String(i.sequentialId) },
        { label: 'Folio', render: (i) => i.number ? `<code>${escapeHtml(i.number)}</code>` : '<span class="text-gray-400">—</span>' },
        { label: 'Status', render: (i) => statusBadge(i.status) },
        { label: 'Dispatch', render: (i) => statusBadge(i.externalDispatchStatus) },
        { label: 'Total', render: (i) => fmtMoney(i.feesAmountCents, i.currency) },
        { label: 'Emitida', render: (i) => fmtDateOnly(i.issuingDate) },
      ],
    });

    const cnsBlock = table({
      rows: customer.creditNotes,
      empty: 'Sin credit notes',
      rowHref: (cn) => `/admin/credit-notes/${cn.id}`,
      columns: [
        { label: 'Folio', render: (cn) => cn.number ? `<code>${escapeHtml(cn.number)}</code>` : '—' },
        { label: 'Status', render: (cn) => statusBadge(cn.status) },
        { label: 'Total', render: (cn) => fmtMoney(cn.totalAmountCents, cn.currency) },
        { label: 'Razón', render: (cn) => escapeHtml(cn.reason) },
      ],
    });

    // v11: card "Calendario de facturación" con edición inline.
    // El gate de "no invoices no-voided" se aplica en el API; aquí solo
    // mostramos el aviso para que el admin sepa por qué está deshabilitado.
    const scheduleBlock = (() => {
      const nonVoidedInvoices = customer.invoices.filter((i) => i.status !== 'voided').length;
      const blocked = nonVoidedInvoices > 0;
      const terminated = customer.status === 'terminated';
      const dtLocal = (d: Date | null | undefined): string => {
        if (!d) return '';
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mi = String(d.getUTCMinutes()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
      };
      const summary = kv([
        ['Subscription at', fmtDate(customer.subscriptionAt)],
        ['Anchor day', String(customer.billingAnchorDay)],
        ['Period months', String(customer.billingPeriodMonths)],
        ['Trigger no-recurrente', badge(customer.nonrecurringTrigger, customer.nonrecurringTrigger === 'immediate' ? 'green' : 'gray')],
        ['Periodo vigente', `${fmtDate(customer.currentBillingPeriodStartedAt)} → ${fmtDate(customer.currentBillingPeriodEndingAt)}`],
      ]);
      const periodOptions = [1, 3, 6, 12].map((n) =>
        `<option value="${n}" ${n === customer.billingPeriodMonths ? 'selected' : ''}>${n} mes${n === 1 ? '' : 'es'}</option>`).join('');
      const triggerOptions = [
        `<option value="next_cycle" ${customer.nonrecurringTrigger === 'next_cycle' ? 'selected' : ''}>next_cycle (cobrar en próximo cierre)</option>`,
        `<option value="immediate" ${customer.nonrecurringTrigger === 'immediate' ? 'selected' : ''}>immediate (factura individual al ping)</option>`,
      ].join('');
      const banner = terminated
        ? `<div class="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900 mb-3">Customer <code>terminated</code> — schedule no editable.</div>`
        : blocked
        ? `<div class="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 mb-3"><strong>${nonVoidedInvoices} invoice${nonVoidedInvoices === 1 ? '' : 's'} no-voided bloque${nonVoidedInvoices === 1 ? 'a' : 'an'} cambios a <code>subscription_at</code>, <code>anchor_day</code> y <code>period_months</code>.</strong> Voidálas primero. El campo <code>nonrecurring_trigger</code> sí se puede editar.</div>`
        : '';
      const disabledHard = blocked || terminated ? 'disabled' : '';
      const disabledSoft = terminated ? 'disabled' : '';
      const form = `
        <form method="post" action="/admin/customers/${escapeHtml(customer.externalId)}/billing-schedule" class="space-y-3 max-w-3xl"
          onsubmit="return confirm('Esto recalculará el ciclo actual y guardará el cambio en el historial. ¿Continuar?')">
          <div class="grid grid-cols-2 gap-3">
            <label class="block"><span class="text-sm text-gray-700">Subscription at (UTC)</span>
              <input ${disabledHard} type="datetime-local" name="subscription_at" value="${escapeHtml(dtLocal(customer.subscriptionAt))}" class="mt-1 block w-full rounded border-gray-300 text-sm ${disabledHard ? 'bg-gray-100' : ''}">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Anchor day (1–28)</span>
              <input ${disabledHard} type="number" name="billing_anchor_day" min="1" max="28" value="${customer.billingAnchorDay}" class="mt-1 block w-full rounded border-gray-300 text-sm ${disabledHard ? 'bg-gray-100' : ''}">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Period months</span>
              <select ${disabledHard} name="billing_period_months" class="mt-1 block w-full rounded border-gray-300 text-sm ${disabledHard ? 'bg-gray-100' : ''}">${periodOptions}</select>
            </label>
            <label class="block"><span class="text-sm text-gray-700">Trigger no-recurrente</span>
              <select ${disabledSoft} name="nonrecurring_trigger" class="mt-1 block w-full rounded border-gray-300 text-sm ${disabledSoft ? 'bg-gray-100' : ''}">${triggerOptions}</select>
            </label>
          </div>
          ${terminated ? '' : `<button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded text-sm">Actualizar calendario</button>`}
        </form>
      `;
      return summary + '<div class="mt-4 pt-4 border-t">' + banner + form + '</div>';
    })();

    // v12: card "Datos del cliente" — edición de soft fields.
    // currency tiene gate por invoices (mismo aviso que el de schedule, pero
    // independiente — currency es soft "tirando a hard").
    const softBlock = (() => {
      const nonVoidedInvoices = customer.invoices.filter((i) => i.status !== 'voided').length;
      const currencyBlocked = nonVoidedInvoices > 0;
      const terminated = customer.status === 'terminated';
      if (terminated) {
        return `<div class="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">Customer <code>terminated</code> — datos no editables.</div>`;
      }
      const currencyHint = currencyBlocked
        ? `<span class="text-xs text-amber-700">Bloqueada: hay invoices emitidas en <code>${escapeHtml(customer.currency)}</code>.</span>`
        : '<span class="text-xs text-gray-500">Puede cambiarse mientras no haya invoices no-voided.</span>';
      return `
        <form method="post" action="/admin/customers/${escapeHtml(customer.externalId)}/edit" class="space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <label class="block"><span class="text-sm text-gray-700">Nombre</span>
              <input required name="name" value="${escapeHtml(customer.name)}" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Tax ID (RFC)</span>
              <input name="tax_identification_number" value="${escapeHtml(customer.taxIdentificationNumber ?? '')}" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Email</span>
              <input type="email" name="email" value="${escapeHtml(customer.email ?? '')}" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Teléfono</span>
              <input name="phone" value="${escapeHtml(customer.phone ?? '')}" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
            <label class="block col-span-2"><span class="text-sm text-gray-700">Dirección línea 1</span>
              <input name="address_line1" value="${escapeHtml(customer.addressLine1 ?? '')}" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
            <label class="block col-span-2"><span class="text-sm text-gray-700">Dirección línea 2</span>
              <input name="address_line2" value="${escapeHtml(customer.addressLine2 ?? '')}" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Ciudad</span>
              <input name="city" value="${escapeHtml(customer.city ?? '')}" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Estado</span>
              <input name="state" value="${escapeHtml(customer.state ?? '')}" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">CP</span>
              <input name="zipcode" value="${escapeHtml(customer.zipcode ?? '')}" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">País (ISO 2 letras)</span>
              <input name="country" value="${escapeHtml(customer.country ?? '')}" maxlength="2" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm uppercase">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Timezone (IANA)</span>
              <input name="timezone" value="${escapeHtml(customer.timezone ?? '')}" placeholder="America/Mexico_City" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Currency</span>
              <input ${currencyBlocked ? 'readonly' : ''} name="currency" value="${escapeHtml(customer.currency)}" maxlength="3" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm uppercase ${currencyBlocked ? 'bg-gray-100' : ''}">
              ${currencyHint}
            </label>
          </div>
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded text-sm">Guardar datos</button>
        </form>
      `;
    })();

    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: `Customer · ${customer.externalId}`, active: '/admin/customers', orgSlug: org.slug, flash,
      body: pageHeader(customer.name, btn('/admin/customers', '← back'))
        + card('Identidad', info)
        + card('Datos del cliente', softBlock)
        + card('Calendario de facturación', scheduleBlock)
        + card('Acciones', invoiceForm)
        + card(`Services (${customer.services.length})`, servicesBlock,
          btn(`/admin/services/new?customer=${customer.externalId}`, '+ Nuevo service', 'primary'))
        + card(`Customer add-ons flat (${customer.addOns.length})`, customerAddOnsBlock + '<div class="mt-4">' + customerAddOnForm + '</div>')
        + card(`Invoices (${customer.invoices.length})`, invoicesBlock)
        + card(`Credit notes (${customer.creditNotes.length})`, cnsBlock),
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
      orderBy: { createdAt: 'desc' },
      include: { customer: true, _count: { select: { units: true } } },
    });
    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: 'Services', active: '/admin/services', orgSlug: org.slug, flash,
      body: pageHeader('Services', btn('/admin/services/new', '+ Nuevo service', 'primary')) + table({
        rows: services,
        empty: 'Sin services',
        rowHref: (s) => `/admin/services/${s.code}`,
        columns: [
          { label: 'Nombre', render: (s) => escapeHtml(s.name) },
          { label: 'Customer', render: (s) => escapeHtml(s.customer.name) },
          { label: 'Status', render: (s) => statusBadge(s.status) },
          { label: 'Modelo', render: (s) => badge(s.pricingModel, s.pricingModel === 'one_off' ? 'green' : 'blue') },
          { label: 'Monto /u', render: (s) => fmtMoney(s.monthlyUnitAmountCents, s.currency) },
          { label: 'Setup /u', render: (s) => fmtMoney(s.setupUnitAmountCents, s.currency) },
          { label: 'Prepaid (m)', render: (s) => s.pricingModel === 'one_off' ? (s.prepaidMonthsDefault !== null ? String(s.prepaidMonthsDefault) : '<span class="text-red-600">—</span>') : '<span class="text-gray-400">n/a</span>' },
          { label: 'Units', render: (s) => String(s._count.units) },
        ],
      }),
    }));
  });

  app.get('/admin/services/new', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const q = request.query as { customer?: string };
    const customers = await prisma.customer.findMany({ where: { organizationId: org.id }, orderBy: { externalId: 'asc' } });
    const flash = readFlash(request, reply);
    const customerOptions = customers.map((c) =>
      `<option value="${escapeHtml(c.externalId)}" ${q.customer === c.externalId ? 'selected' : ''}>${escapeHtml(c.externalId)} · ${escapeHtml(c.name)}</option>`,
    ).join('');
    const form = `
      <form method="post" action="/admin/services" class="space-y-4 max-w-3xl">
        <div class="grid grid-cols-2 gap-3">
          <label class="block"><span class="text-sm text-gray-700">Customer</span>
            <select required name="customer_external_id" class="mt-1 block w-full rounded border-gray-300">${customerOptions}</select>
          </label>
          <label class="block"><span class="text-sm text-gray-700">Currency</span>
            <input name="currency" value="MXN" class="mt-1 block w-full rounded border-gray-300 font-mono">
          </label>
          <label class="block"><span class="text-sm text-gray-700">Code</span>
            <input required name="code" placeholder="combustible-foo" class="mt-1 block w-full rounded border-gray-300 font-mono">
          </label>
          <label class="block"><span class="text-sm text-gray-700">Nombre</span>
            <input required name="name" class="mt-1 block w-full rounded border-gray-300">
          </label>
          <label class="block col-span-2"><span class="text-sm text-gray-700">Pricing model</span>
            <select required name="pricing_model" class="mt-1 block w-full rounded border-gray-300">
              <option value="recurring" selected>recurring — renta por unidad cada periodo del customer (+ setup opcional)</option>
              <option value="one_off">one_off — cargo único por unidad cuando aparece, no genera renta</option>
            </select>
          </label>
          <label class="block"><span class="text-sm text-gray-700">Monto por unidad (cents)</span>
            <input required type="number" name="monthly_unit_amount_cents" value="45000" min="0" class="mt-1 block w-full rounded border-gray-300">
            <span class="text-xs text-gray-500">recurring: cobro por periodo. one_off: cobro único.</span>
          </label>
          <label class="block"><span class="text-sm text-gray-700">Setup por unidad (cents)</span>
            <input type="number" name="setup_unit_amount_cents" value="0" min="0" class="mt-1 block w-full rounded border-gray-300">
            <span class="text-xs text-gray-500">Cargo único por unit al primer ping. Aplica a recurring y one_off.</span>
          </label>
          <label class="block col-span-2"><span class="text-sm text-gray-700">Meses prepagados por defecto (solo one_off)</span>
            <input type="number" name="prepaid_months_default" min="1" placeholder="48" class="mt-1 block w-full rounded border-gray-300">
            <span class="text-xs text-gray-500">Cuántos meses paga el cliente por adelantado por cada unit nueva. Override por unit en POST /events. Dejar vacío si es recurring.</span>
          </label>
        </div>
        <div class="border-t pt-3 mt-3">
          <h3 class="text-sm font-semibold text-gray-700 mb-2">Códigos de producto NetSuite</h3>
          <p class="text-xs text-gray-500 mb-3">Códigos del catálogo de NetSuite a los que se mapean las líneas de la factura. El código <strong>mensual</strong> también se usa para mensualidades prepagadas (services one_off). Si quedan vacíos, las invoices se emiten con item_code=null y NetSuite probablemente las rechace.</p>
          <div class="grid grid-cols-2 gap-3">
            <label class="block"><span class="text-sm text-gray-700">Item code mensual</span>
              <input name="netsuite_monthly_item_code" placeholder="SUB-MONTHLY" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
              <span class="text-xs text-gray-500">Recurring: cada periodo. One_off: las N mensualidades prepagadas.</span>
            </label>
            <label class="block"><span class="text-sm text-gray-700">Item code setup</span>
              <input name="netsuite_setup_item_code" placeholder="SUB-SETUP" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
              <span class="text-xs text-gray-500">Cargo único per-unit (si setup &gt; 0).</span>
            </label>
          </div>
        </div>
        <p class="text-xs text-gray-500">El ciclo de facturación lo define el customer. <strong>Los impuestos los calcula NetSuite</strong> según la configuración fiscal del cliente; mini-Lago solo envía montos netos.</p>
        <label class="block"><span class="text-sm text-gray-700">Descripción</span>
          <input name="description" class="mt-1 block w-full rounded border-gray-300">
        </label>
        <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded">Crear service</button>
      </form>
    `;
    reply.type('text/html').send(layout({
      title: 'Nuevo service', active: '/admin/services', orgSlug: org.slug, flash,
      body: pageHeader('Nuevo service', btn('/admin/services', '← back')) + card('Crear', form),
    }));
  });

  app.post('/admin/services', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const body = request.body as Record<string, string>;
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: { authorization: `Bearer ${org.apiKey}`, 'content-type': 'application/json' },
      payload: {
        service: {
          code: body.code,
          customer_external_id: body.customer_external_id,
          name: body.name,
          description: (body.description as string) || undefined,
          currency: body.currency || 'MXN',
          pricing_model: body.pricing_model || 'recurring',
          monthly_unit_amount_cents: Number(body.monthly_unit_amount_cents ?? 0),
          setup_unit_amount_cents: Number(body.setup_unit_amount_cents ?? 0),
          prepaid_months_default: body.prepaid_months_default ? Number(body.prepaid_months_default) : undefined,
          netsuite_monthly_item_code: body.netsuite_monthly_item_code || null,
          netsuite_setup_item_code: body.netsuite_setup_item_code || null,
        },
      },
    });
    if (result.statusCode !== 200) {
      setFlash(reply, 'error', `Rechazado: ${result.body.slice(0, 240)}`);
      return reply.redirect('/admin/services/new');
    }
    setFlash(reply, 'success', `Service "${body.code}" creado`);
    reply.redirect(`/admin/services/${body.code}`);
  });

  app.get('/admin/services/:code', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { code: svcCode } = request.params as { code: string };
    const service = await prisma.service.findUnique({
      where: { organizationId_code: { organizationId: org.id, code: svcCode } },
      include: {
        customer: true,
        units: { orderBy: [{ activeFrom: 'desc' }] },
        addOns: { orderBy: [{ activeFrom: 'desc' }] },
      },
    });
    if (!service) {
      reply.status(404).type('text/html').send(layout({
        title: 'Not Found', orgSlug: org.slug,
        body: pageHeader('Service no existe') + btn('/admin/services', '← back'),
      }));
      return;
    }
    // v7: el precio "vigente ahora" puede ser el `pending*` si su effective_from
    // ya pasó. Resolvemos para mostrar valores correctos.
    const now = new Date();
    const pendingActive =
      service.pendingEffectiveFrom !== null
      && service.pendingMonthlyUnitAmountCents !== null
      && service.pendingSetupUnitAmountCents !== null
      && service.pendingEffectiveFrom <= now;
    const effectiveMonthly = pendingActive ? service.pendingMonthlyUnitAmountCents! : service.monthlyUnitAmountCents;
    const effectiveSetup = pendingActive ? service.pendingSetupUnitAmountCents! : service.setupUnitAmountCents;
    const pendingFuture =
      service.pendingEffectiveFrom !== null
      && service.pendingMonthlyUnitAmountCents !== null
      && service.pendingSetupUnitAmountCents !== null
      && service.pendingEffectiveFrom > now;
    const info = kv([
      ['Code', `<code>${escapeHtml(service.code)}</code>`],
      ['Nombre', escapeHtml(service.name)],
      ['Customer', `<a class="text-indigo-700 underline" href="/admin/customers/${escapeHtml(service.customer.externalId)}">${escapeHtml(service.customer.externalId)}</a>`],
      ['Status', statusBadge(service.status)],
      ['Pricing model', badge(service.pricingModel, service.pricingModel === 'one_off' ? 'green' : 'blue')],
      ['Monto /unidad (vigente)', fmtMoney(effectiveMonthly, service.currency) + (service.pricingModel === 'one_off' ? ' /mes prepagado' : ' /periodo')],
      ['Setup /unidad (vigente)', fmtMoney(effectiveSetup, service.currency)],
      ['Meses prepagados (default)', service.pricingModel === 'one_off' ? (service.prepaidMonthsDefault !== null ? String(service.prepaidMonthsDefault) + ' meses' : '<span class="text-red-600">no configurado — se debe especificar por unit</span>') : '<span class="text-gray-400">n/a (recurring)</span>'],
      ['Terminated at', fmtDate(service.terminatedAt)],
    ]);

    const isOneOff = service.pricingModel === 'one_off';
    const unitsBlock = table({
      rows: service.units,
      empty: 'Sin unidades',
      columns: [
        { label: 'External ID', render: (u) => `<code>${escapeHtml(u.externalId)}</code>` },
        { label: 'Label', render: (u) => escapeHtml(u.label ?? '—') },
        { label: 'Status', render: (u) => statusBadge(u.activeTo === null ? 'active' : 'terminated') },
        { label: 'Active from', render: (u) => fmtDate(u.activeFrom) },
        // v8: billing_starts_at visible solo si está seteado (override).
        { label: 'Billing starts', render: (u) => u.billingStartsAt ? `<span class="text-amber-700 font-medium" title="override de fecha de facturación (migración)">${escapeHtml(fmtDate(u.billingStartsAt))}</span>` : '<span class="text-gray-400">—</span>' },
        { label: 'Active to', render: (u) => fmtDate(u.activeTo) },
        ...(isOneOff
          ? [
              { label: 'Meses prepagados', render: (u: typeof service.units[number]) => u.prepaidMonths !== null ? `${u.prepaidMonths}m` : (service.prepaidMonthsDefault !== null ? `${service.prepaidMonthsDefault}m (default)` : '<span class="text-red-600">—</span>') },
              { label: 'One-off facturado', render: (u: typeof service.units[number]) => u.oneoffBilledAt ? badge('billed', 'green') : badge('pendiente', 'yellow') },
            ]
          : [
              // Setup gate solo aplica si el service tiene setup > 0. Si es 0,
              // setupBilledAt nunca se marca y mostrar "pendiente" eternamente
              // es confuso → mostramos "n/a" en gris.
              { label: 'Setup billed', render: (u: typeof service.units[number]) =>
                service.setupUnitAmountCents === 0
                  ? '<span class="text-gray-400 text-xs">n/a (sin setup)</span>'
                  : (u.setupBilledAt ? badge('billed', 'green') : badge('pendiente', 'yellow'))
              },
            ]),
        { label: 'Acciones', render: (u) => `<a class="text-indigo-700 underline text-xs" href="/admin/units/${u.id}/edit">editar</a>` },
      ],
    });

    // v3: invoices are per-customer. The "calcular factura" button now
    // lives on the customer page; here we just link to the customer's
    // invoices.
    const invoicesLink = `<a class="text-indigo-700 underline" href="/admin/customers/${escapeHtml(service.customer.externalId)}">Ver invoices del customer →</a>`;
    const terminateForm = service.status !== 'terminated' ? postButton(`/admin/services/${service.code}/terminate`, 'Terminar service', 'danger', `¿Terminar ${service.code}?`) : '';

    // v7: card de cambio de precio. Muestra el cambio pendiente (si existe y
    // aún no entra en vigor), permite programar uno nuevo (sobreescribe el
    // anterior) y permite cancelarlo si aún no entró en vigor.
    const priceChangeBlock = service.status === 'terminated'
      ? '<p class="text-sm text-gray-500">Service terminado — los precios no se pueden modificar.</p>'
      : (() => {
        const pendingRow = pendingFuture
          ? `
            <div class="rounded border border-amber-300 bg-amber-50 p-3 text-sm space-y-1">
              <div class="font-medium text-amber-900">Cambio programado</div>
              <div>Mensual: <strong>${escapeHtml(fmtMoney(service.pendingMonthlyUnitAmountCents!, service.currency))}</strong></div>
              <div>Setup: <strong>${escapeHtml(fmtMoney(service.pendingSetupUnitAmountCents!, service.currency))}</strong></div>
              <div>Entra en vigor: <strong>${escapeHtml(fmtDate(service.pendingEffectiveFrom!))}</strong></div>
              <div class="pt-2">${postButton(`/admin/services/${service.code}/pending-price/cancel`, 'Cancelar cambio programado', 'danger', '¿Cancelar el cambio de precio programado?')}</div>
            </div>`
          : '<p class="text-sm text-gray-500">No hay cambio de precio programado.</p>';

        // Default effective_from sugerido: mañana 00:00 UTC (input datetime-local).
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const yyyy = tomorrow.getUTCFullYear();
        const mm = String(tomorrow.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(tomorrow.getUTCDate()).padStart(2, '0');
        const defaultEffective = `${yyyy}-${mm}-${dd}T00:00`;

        const form = `
          <details class="mt-4"${pendingFuture ? '' : ' open'}>
            <summary class="cursor-pointer text-indigo-700 font-medium">${pendingFuture ? 'Sobrescribir' : '+ Programar'} cambio de precio</summary>
            <form method="post" action="/admin/services/${escapeHtml(service.code)}/price" class="mt-3 space-y-3 max-w-2xl">
              <p class="text-xs text-gray-500">El nuevo precio aplicará a la facturación de cada cliente cuyo ciclo empiece on-or-after la fecha indicada. Clientes mid-cycle mantienen el precio vigente hasta el siguiente cierre. Aplica igual a servicios recurring y one_off.</p>
              <div class="grid grid-cols-2 gap-3">
                <label class="block"><span class="text-sm text-gray-700">Monto mensual /unidad (cents)</span>
                  <input required type="number" name="monthly_unit_amount_cents" min="0" value="${effectiveMonthly}" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
                </label>
                <label class="block"><span class="text-sm text-gray-700">Setup /unidad (cents)</span>
                  <input required type="number" name="setup_unit_amount_cents" min="0" value="${effectiveSetup}" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
                </label>
                <label class="block col-span-2"><span class="text-sm text-gray-700">Vigente a partir de (UTC)</span>
                  <input required type="datetime-local" name="effective_from" value="${defaultEffective}" class="mt-1 block w-full rounded border-gray-300 text-sm">
                </label>
              </div>
              <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded">${pendingFuture ? 'Sobrescribir' : 'Programar'} cambio</button>
            </form>
          </details>`;
        return pendingRow + form;
      })();

    const addOnsBlock = table({
      rows: service.addOns,
      empty: 'Sin add-ons per-unit',
      columns: [
        { label: 'Code', render: (a) => `<code>${escapeHtml(a.code)}</code>` },
        { label: 'Nombre', render: (a) => escapeHtml(a.name) },
        { label: 'Amount /u', render: (a) => `${fmtMoney(a.amountCents, service.currency)}/u/mes` },
        { label: 'Status', render: (a) => statusBadge(a.activeTo === null ? 'active' : 'terminated') },
        { label: 'Active from', render: (a) => fmtDate(a.activeFrom) },
        { label: 'Active to', render: (a) => fmtDate(a.activeTo) },
        { label: 'Acciones', render: (a) => a.activeTo === null
          ? postButton(`/admin/service-add-ons/${a.id}/terminate`, 'Terminar', 'danger', `¿Terminar add-on ${a.code}?`)
          : '<span class="text-gray-400">terminated</span>' },
      ],
    });

    const addOnForm = `
      <details>
        <summary class="cursor-pointer text-indigo-700 font-medium">+ Agregar add-on per-unit</summary>
        <form method="post" action="/admin/services/${escapeHtml(service.code)}/add-ons" class="mt-3 space-y-3 max-w-2xl">
          <p class="text-xs text-gray-500">Add-ons per-unit se cobran sobre cada unidad activa del service. Si necesitas un cargo flat independiente de unidades, agrégalo a nivel customer.</p>
          <div class="grid grid-cols-2 gap-3">
            <label class="block"><span class="text-sm text-gray-700">Code</span>
              <input required name="code" placeholder="historial-12m" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Nombre</span>
              <input required name="name" placeholder="Historial 6→12 meses" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Amount per unit (cents) /mes</span>
              <input required type="number" name="amount_cents" min="0" value="5000" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">NetSuite item code</span>
              <input name="netsuite_item_code" placeholder="ADDON-PERUNIT" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
            </label>
            <label class="block col-span-2"><span class="text-sm text-gray-700">Descripción</span>
              <input name="description" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
          </div>
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded">Crear add-on</button>
        </form>
      </details>
    `;

    // v8: form de migración manual — crea una unit con active_from y
    // billing_starts_at explícitos. Útil cuando integras desde otra plataforma
    // GPS donde la unit ya existía y necesitas controlar exactamente cuándo
    // empieza a facturarse (full mes, skip mes, prorrateo parcial).
    const migrateForm = service.status === 'terminated' ? '' : `
      <details class="mt-4">
        <summary class="cursor-pointer text-indigo-700 font-medium">+ Migrar unit (con billing_starts_at)</summary>
        <form method="post" action="/admin/services/${escapeHtml(service.code)}/units" class="mt-3 space-y-3 max-w-3xl">
          <p class="text-xs text-gray-500">Crea una unit con override de fecha de facturación. <code>active_from</code> = cuándo empezó a reportar (verdad operativa). <code>billing_starts_at</code> = desde cuándo se factura. Déjalo vacío para usar <code>active_from</code> (comportamiento normal con proration por mes calendario).</p>
          <div class="grid grid-cols-2 gap-3">
            <label class="block"><span class="text-sm text-gray-700">External ID</span>
              <input required name="external_id" placeholder="gps-001" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Label (opcional)</span>
              <input name="label" placeholder="Camión 001" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Active from (UTC)</span>
              <input required type="datetime-local" name="active_from" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Billing starts at (UTC, opcional)</span>
              <input type="datetime-local" name="billing_starts_at" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
            ${isOneOff ? `
            <label class="block col-span-2"><span class="text-sm text-gray-700">Meses prepagados (opcional — default del service: ${service.prepaidMonthsDefault ?? '—'})</span>
              <input type="number" name="prepaid_months" min="1" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
            </label>` : ''}
          </div>
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded">Crear unit migrada</button>
        </form>
      </details>
    `;

    // v9: card de códigos NetSuite — edición inline, vacío = null.
    const netsuiteBlock = (() => {
      const monthlyVal = service.netsuiteMonthlyItemCode ?? '';
      const setupVal = service.netsuiteSetupItemCode ?? '';
      const isOne = service.pricingModel === 'one_off';
      const missing: string[] = [];
      // monthly aplica para ambos pricing_models (recurring y one_off
      // comparten el mismo item — en one_off representa las N mensualidades
      // prepagadas).
      if (!service.netsuiteMonthlyItemCode) missing.push('monthly');
      if (service.setupUnitAmountCents > 0 && !service.netsuiteSetupItemCode) missing.push('setup');
      const warning = missing.length > 0
        ? `<div class="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 mb-3"><strong>Códigos faltantes:</strong> ${missing.map((m) => `<code>${m}</code>`).join(', ')}. Las invoices emitidas tendrán item_code=null en esas líneas; NetSuite probablemente las rechace.</div>`
        : '<div class="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-900 mb-3">Todos los códigos requeridos para este service están configurados.</div>';
      const monthlyHint = isOne
        ? 'Para las N mensualidades prepagadas (fees kind=one_off).'
        : 'Para fees kind=monthly.';
      return warning + `
        <form method="post" action="/admin/services/${escapeHtml(service.code)}/netsuite-codes" class="space-y-3 max-w-3xl">
          <div class="grid grid-cols-2 gap-3">
            <label class="block"><span class="text-sm text-gray-700">Item code mensual</span>
              <input name="netsuite_monthly_item_code" value="${escapeHtml(monthlyVal)}" placeholder="SUB-MONTHLY" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
              <span class="text-xs text-gray-500">${escapeHtml(monthlyHint)}</span>
            </label>
            <label class="block"><span class="text-sm text-gray-700">Item code setup</span>
              <input name="netsuite_setup_item_code" value="${escapeHtml(setupVal)}" placeholder="SUB-SETUP" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
              <span class="text-xs text-gray-500">Para fees kind=setup. Aplica si setup &gt; 0.</span>
            </label>
          </div>
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded text-sm">Guardar códigos</button>
        </form>
      `;
    })();

    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: `Service · ${service.code}`, active: '/admin/services', orgSlug: org.slug, flash,
      body: pageHeader(service.name, btn('/admin/services', '← back'))
        + card('Identidad', info)
        + card('Precio', priceChangeBlock)
        + card('Códigos NetSuite', netsuiteBlock)
        + card('Acciones', `${terminateForm} <span class="ml-3">${invoicesLink}</span>`)
        + card(`Add-ons per-unit (${service.addOns.length})`, addOnsBlock + '<div class="mt-4">' + addOnForm + '</div>')
        + card(`Units (${service.units.length})`, unitsBlock + migrateForm),
    }));
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
    if (body.subscription_at) payload.subscription_at = toUtcIso(body.subscription_at);
    if (body.billing_anchor_day) payload.billing_anchor_day = Number(body.billing_anchor_day);
    if (body.billing_period_months) payload.billing_period_months = Number(body.billing_period_months);
    if (body.nonrecurring_trigger) payload.nonrecurring_trigger = body.nonrecurring_trigger;
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
      include: { customer: true, _count: { select: { fees: true } } },
    });
    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: 'Invoices', active: '/admin/invoices', orgSlug: org.slug, flash,
      body: pageHeader('Invoices') + table({
        rows: invoices,
        empty: 'Sin invoices',
        rowHref: (i) => `/admin/invoices/${i.id}`,
        columns: [
          { label: '#', render: (i) => String(i.sequentialId) },
          { label: 'Folio', render: (i) => i.number ? `<code>${escapeHtml(i.number)}</code>` : '<span class="text-gray-400">—</span>' },
          { label: 'Customer', render: (i) => escapeHtml(i.customer.externalId) },
          { label: 'Period', render: (i) => i.periodFrom && i.periodTo ? `${fmtDateOnly(i.periodFrom)} → ${fmtDateOnly(i.periodTo)}` : '—' },
          { label: 'Status', render: (i) => statusBadge(i.status) },
          { label: 'Dispatch', render: (i) => statusBadge(i.externalDispatchStatus) },
          { label: 'Total', render: (i) => fmtMoney(i.feesAmountCents, i.currency) },
          { label: 'Emitida', render: (i) => fmtDateOnly(i.issuingDate) },
        ],
      }),
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
        body: pageHeader('Invoice no existe') + btn('/admin/invoices', '← back'),
      }));
      return;
    }
    const info = kv([
      ['ID', `<code>${escapeHtml(invoice.id)}</code>`],
      ['Sequential', String(invoice.sequentialId)],
      ['Folio fiscal', invoice.number ? `<code>${escapeHtml(invoice.number)}</code>` : '<span class="text-gray-400">— (sin folio NetSuite)</span>'],
      ['Customer', `<a class="text-indigo-700 underline" href="/admin/customers/${escapeHtml(invoice.customer.externalId)}">${escapeHtml(invoice.customer.externalId)}</a>`],
      ['Status', statusBadge(invoice.status)],
      ['Dispatch', statusBadge(invoice.externalDispatchStatus)],
      ['Payment', statusBadge(invoice.paymentStatus)],
      ['Currency', escapeHtml(invoice.currency)],
      ['Period from', fmtDate(invoice.periodFrom)],
      ['Period to', fmtDate(invoice.periodTo)],
      ['Fees (neto)', `<b>${fmtMoney(invoice.feesAmountCents, invoice.currency)}</b>`],
      ['Impuestos', '<span class="text-gray-400">Los calcula NetSuite al emitir el CFDI</span>'],
      ['Emitida', fmtDateOnly(invoice.issuingDate)],
      ['External error', invoice.externalDispatchError ? `<span class="text-red-700">${escapeHtml(invoice.externalDispatchError)}</span>` : '—'],
    ]);

    const feesBlock = table({
      rows: invoice.fees,
      columns: [
        { label: 'Kind', render: (f) => badge(f.kind, f.kind === 'setup' ? 'blue' : 'green') },
        { label: 'Descripción', render: (f) => escapeHtml(f.description ?? '') },
        { label: 'Units', render: (f) => `<code>${escapeHtml(f.units)}</code>` },
        { label: '$/u', render: (f) => `$${escapeHtml(f.preciseUnitAmount)}` },
        { label: 'Amount (neto)', render: (f) => fmtMoney(f.amountCents, invoice.currency) },
        { label: 'Detail', render: (f) => `<details><summary class="cursor-pointer text-indigo-700">${(f.billedUnitsDetail as unknown[]).length} unidades</summary>${code(f.billedUnitsDetail)}</details>` },
      ],
    });

    const externalInvoice = invoice.externalInvoiceFolio ? code({
      folio: invoice.externalInvoiceFolio,
      uuid_cfdi: invoice.externalInvoiceUuidCfdi,
      system: invoice.externalInvoiceSystem,
      netsuite_internal_id: invoice.externalInvoiceNetsuiteInternalId,
      issued_at: invoice.externalInvoiceIssuedAt,
      confirmed_at: invoice.externalInvoiceConfirmedAt,
    }) : '<span class="text-gray-500">No confirmada (sin folio fiscal aún)</span>';

    const canVoid = invoice.status !== 'voided';
    const canConfirm = invoice.externalDispatchStatus !== 'confirmed';
    const folioField = `
      <form method="post" action="/admin/invoices/${invoice.id}/simulate-confirm" class="flex gap-2 items-end">
        <label class="block flex-1"><span class="text-xs text-gray-600">Folio fiscal</span>
          <input required name="folio" value="A-2026-${String(invoice.sequentialId).padStart(6, '0')}" class="block w-full rounded border-gray-300 font-mono text-sm">
        </label>
        <label class="block flex-1"><span class="text-xs text-gray-600">UUID CFDI</span>
          <input name="uuid_cfdi" class="block w-full rounded border-gray-300 font-mono text-sm">
        </label>
        <button class="px-3 py-1.5 rounded bg-indigo-600 text-white text-sm" ${canConfirm ? '' : 'disabled'}>Simular folio NetSuite</button>
      </form>
    `;
    const actions = `<div class="space-y-3">
      ${canVoid ? postButton(`/admin/invoices/${invoice.id}/void`, 'Void invoice', 'danger', `¿Anular invoice #${invoice.sequentialId}?`) : '<span class="text-gray-400">voided</span>'}
      <div>${folioField}</div>
    </div>`;

    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: `Invoice #${invoice.sequentialId}`, active: '/admin/invoices', orgSlug: org.slug, flash,
      body: pageHeader(`Invoice #${invoice.sequentialId}`, btn('/admin/invoices', '← back'))
        + card('Identidad', info)
        + card('Acciones', actions)
        + card(`Fees (${invoice.fees.length})`, feesBlock)
        + card('Units annex', code(invoice.unitsAnnex))
        + card('External invoice (folio fiscal + impuestos calculados por NetSuite)', externalInvoice)
        + card('Metadata', code(invoice.metadata)),
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
      include: { customer: true, invoice: true },
    });
    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: 'Credit notes', active: '/admin/credit-notes', orgSlug: org.slug, flash,
      body: pageHeader('Credit notes') + table({
        rows: cns,
        empty: 'Sin credit notes',
        rowHref: (cn) => `/admin/credit-notes/${cn.id}`,
        columns: [
          { label: 'Folio', render: (cn) => cn.number ? `<code>${escapeHtml(cn.number)}</code>` : '<span class="text-gray-400">—</span>' },
          { label: 'Invoice', render: (cn) => cn.invoice.number ? `<code>${escapeHtml(cn.invoice.number)}</code>` : `<code class="text-xs">${escapeHtml(cn.invoiceId.slice(0, 8))}…</code>` },
          { label: 'Customer', render: (cn) => escapeHtml(cn.customer.externalId) },
          { label: 'Status', render: (cn) => statusBadge(cn.status) },
          { label: 'Dispatch', render: (cn) => statusBadge(cn.externalDispatchStatus) },
          { label: 'Total', render: (cn) => fmtMoney(cn.totalAmountCents, cn.currency) },
          { label: 'Razón', render: (cn) => escapeHtml(cn.reason) },
        ],
      }),
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
        body: pageHeader('Credit note no existe') + btn('/admin/credit-notes', '← back'),
      }));
      return;
    }
    const info = kv([
      ['ID', `<code>${escapeHtml(cn.id)}</code>`],
      ['Folio', cn.number ? `<code>${escapeHtml(cn.number)}</code>` : '—'],
      ['Invoice', `<a class="text-indigo-700 underline" href="/admin/invoices/${cn.invoiceId}">${cn.invoice.number ?? cn.invoiceId.slice(0, 8)}</a>`],
      ['Customer', `<a class="text-indigo-700 underline" href="/admin/customers/${escapeHtml(cn.customer.externalId)}">${escapeHtml(cn.customer.externalId)}</a>`],
      ['Status', statusBadge(cn.status)],
      ['Dispatch', statusBadge(cn.externalDispatchStatus)],
      ['Credit status', statusBadge(cn.creditStatus)],
      ['Razón', escapeHtml(cn.reason)],
      ['Descripción', escapeHtml(cn.description ?? '—')],
      ['Total (neto)', `<b>${fmtMoney(cn.totalAmountCents, cn.currency)}</b>`],
      ['Impuestos', '<span class="text-gray-400">Los calcula NetSuite al emitir el CFDI</span>'],
    ]);
    const itemsBlock = table({
      rows: cn.items,
      columns: [
        { label: 'Fee', render: (it) => `<code class="text-xs">${escapeHtml(it.feeId.slice(0, 8))}…</code><div class="text-xs text-gray-500">${escapeHtml(it.fee.kind)}</div>` },
        { label: 'Amount', render: (it) => fmtMoney(it.amountCents, it.amountCurrency) },
      ],
    });
    const externalCN = cn.externalCreditNoteFolio ? code({
      folio: cn.externalCreditNoteFolio,
      uuid_cfdi: cn.externalCreditNoteUuidCfdi,
      system: cn.externalCreditNoteSystem,
      issued_at: cn.externalCreditNoteIssuedAt,
      confirmed_at: cn.externalCreditNoteConfirmedAt,
    }) : '<span class="text-gray-500">No confirmada</span>';
    const canConfirm = cn.externalDispatchStatus !== 'confirmed';
    const confirmForm = `
      <form method="post" action="/admin/credit-notes/${cn.id}/simulate-confirm" class="flex gap-2 items-end">
        <label class="block flex-1"><span class="text-xs text-gray-600">Folio CN</span>
          <input required name="folio" value="B-2026-${String(cn.sequentialId).padStart(6, '0')}" class="block w-full rounded border-gray-300 font-mono text-sm">
        </label>
        <button class="px-3 py-1.5 rounded bg-indigo-600 text-white text-sm" ${canConfirm ? '' : 'disabled'}>Simular folio NetSuite</button>
      </form>
    `;
    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: `Credit note · ${cn.number ?? cn.id}`, active: '/admin/credit-notes', orgSlug: org.slug, flash,
      body: pageHeader(`Credit note #${cn.sequentialId}`, btn('/admin/credit-notes', '← back'))
        + card('Identidad', info)
        + card('Acciones', confirmForm)
        + card('Items', itemsBlock)
        + card('External credit note', externalCN),
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
}
