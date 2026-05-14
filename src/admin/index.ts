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
    const [customers, services, activeServices, units, activeUnits, events, invoices, invCalc, invDispatched, invConfirmed, creditNotes, taxes] = await Promise.all([
      prisma.customer.count({ where: { organizationId: org.id } }),
      prisma.service.count({ where: { organizationId: org.id } }),
      prisma.service.count({ where: { organizationId: org.id, status: 'active' } }),
      prisma.unit.count({ where: { service: { organizationId: org.id } } }),
      prisma.unit.count({ where: { service: { organizationId: org.id }, activeTo: null } }),
      prisma.eventLog.count({ where: { organizationId: org.id } }),
      prisma.invoice.count({ where: { organizationId: org.id } }),
      prisma.invoice.count({ where: { organizationId: org.id, status: 'calculated' } }),
      prisma.invoice.count({ where: { organizationId: org.id, externalDispatchStatus: 'dispatched' } }),
      prisma.invoice.count({ where: { organizationId: org.id, externalDispatchStatus: 'confirmed' } }),
      prisma.creditNote.count({ where: { organizationId: org.id } }),
      prisma.tax.count({ where: { organizationId: org.id } }),
    ]);

    const counts = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        ${counter('Customers', customers, '/admin/customers')}
        ${counter('Services', `${activeServices}/${services}`, '/admin/services')}
        ${counter('Units', `${activeUnits}/${units}`, '/admin/units')}
        ${counter('Events', events, '/admin/events')}
        ${counter('Invoices', invoices, '/admin/invoices')}
        ${counter('Credit notes', creditNotes, '/admin/credit-notes')}
        ${counter('Taxes', taxes, '/admin/taxes')}
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
      include: { taxLinks: { include: { tax: true } } },
    });
    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: 'Customers', active: '/admin/customers', orgSlug: org.slug, flash,
      body: pageHeader('Customers') + table({
        rows: customers,
        empty: 'Sin customers — usa "Seed Numaris" en el dashboard',
        rowHref: (c) => `/admin/customers/${c.externalId}`,
        columns: [
          { label: 'External ID', render: (c) => `<code>${escapeHtml(c.externalId)}</code>` },
          { label: 'Nombre', render: (c) => escapeHtml(c.name) },
          { label: 'Currency', render: (c) => escapeHtml(c.currency) },
          { label: 'Country', render: (c) => escapeHtml(c.country ?? '—') },
          { label: 'Timezone', render: (c) => escapeHtml(c.timezone ?? '—') },
          { label: 'Taxes', render: (c) => c.taxLinks.map((l) => badge(l.tax.code, 'blue')).join(' ') || '—' },
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
        taxLinks: { include: { tax: true } },
        services: { orderBy: { createdAt: 'desc' } },
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
      ['Taxes', customer.taxLinks.map((l) => badge(l.tax.code, 'blue')).join(' ') || '—'],
      ['Creado', fmtDate(customer.createdAt)],
      ['Actualizado', fmtDate(customer.updatedAt)],
    ]);

    const servicesBlock = table({
      rows: customer.services,
      empty: 'Sin services',
      rowHref: (s) => `/admin/services/${s.code}`,
      columns: [
        { label: 'Code', render: (s) => `<code>${escapeHtml(s.code)}</code>` },
        { label: 'Nombre', render: (s) => escapeHtml(s.name) },
        { label: 'Status', render: (s) => statusBadge(s.status) },
        { label: 'Mensual', render: (s) => fmtMoney(s.monthlyUnitAmountCents, s.currency) + '/u' },
        { label: 'Setup', render: (s) => fmtMoney(s.setupUnitAmountCents, s.currency) + '/u' },
        { label: 'Period end', render: (s) => fmtDate(s.currentBillingPeriodEndingAt) },
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
        { label: 'Total', render: (i) => fmtMoney(i.totalAmountCents, i.currency) },
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

    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: `Customer · ${customer.externalId}`, active: '/admin/customers', orgSlug: org.slug, flash,
      body: pageHeader(customer.name, btn('/admin/customers', '← back'))
        + card('Identidad', info)
        + card(`Services (${customer.services.length})`, servicesBlock,
          btn(`/admin/services/new?customer=${customer.externalId}`, '+ Nuevo service', 'primary'))
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
          { label: 'Code', render: (s) => `<code>${escapeHtml(s.code)}</code>` },
          { label: 'Nombre', render: (s) => escapeHtml(s.name) },
          { label: 'Customer', render: (s) => escapeHtml(s.customer.externalId) },
          { label: 'Status', render: (s) => statusBadge(s.status) },
          { label: 'Mensual /u', render: (s) => fmtMoney(s.monthlyUnitAmountCents, s.currency) },
          { label: 'Setup /u', render: (s) => fmtMoney(s.setupUnitAmountCents, s.currency) },
          { label: 'Units', render: (s) => String(s._count.units) },
          { label: 'Billing', render: (s) => badge(s.billingTime, 'blue') },
        ],
      }),
    }));
  });

  app.get('/admin/services/new', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const q = request.query as { customer?: string };
    const customers = await prisma.customer.findMany({ where: { organizationId: org.id }, orderBy: { externalId: 'asc' } });
    const taxes = await prisma.tax.findMany({ where: { organizationId: org.id }, orderBy: { code: 'asc' } });
    const flash = readFlash(request, reply);
    const customerOptions = customers.map((c) =>
      `<option value="${escapeHtml(c.externalId)}" ${q.customer === c.externalId ? 'selected' : ''}>${escapeHtml(c.externalId)} · ${escapeHtml(c.name)}</option>`,
    ).join('');
    const taxOptions = taxes.map((t) =>
      `<label class="block"><input type="checkbox" name="tax_codes" value="${escapeHtml(t.code)}"> ${escapeHtml(t.code)} (${Number(t.rate)}%)</label>`,
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
          <label class="block"><span class="text-sm text-gray-700">Mensual por unidad (cents)</span>
            <input required type="number" name="monthly_unit_amount_cents" value="45000" min="0" class="mt-1 block w-full rounded border-gray-300">
          </label>
          <label class="block"><span class="text-sm text-gray-700">Setup por unidad (cents)</span>
            <input type="number" name="setup_unit_amount_cents" value="120000" min="0" class="mt-1 block w-full rounded border-gray-300">
          </label>
          <label class="block"><span class="text-sm text-gray-700">Billing time</span>
            <select name="billing_time" class="mt-1 block w-full rounded border-gray-300">
              <option value="calendar" selected>calendar</option>
              <option value="anniversary">anniversary</option>
            </select>
          </label>
          <label class="block"><span class="text-sm text-gray-700">Subscription at (opcional)</span>
            <input name="subscription_at" placeholder="2026-06-15T06:00:00Z" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
          </label>
        </div>
        <div>
          <span class="text-sm text-gray-700">Taxes (vacío = usa taxes del customer)</span>
          <div class="space-y-1 mt-1">${taxOptions || '<p class="text-sm text-gray-500">No hay taxes — créalos en /admin/taxes primero.</p>'}</div>
        </div>
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
    const body = request.body as Record<string, string | string[]>;
    let taxCodes: string[] | undefined;
    if (Array.isArray(body.tax_codes)) taxCodes = body.tax_codes;
    else if (typeof body.tax_codes === 'string' && body.tax_codes) taxCodes = [body.tax_codes];

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
          monthly_unit_amount_cents: Number(body.monthly_unit_amount_cents ?? 0),
          setup_unit_amount_cents: Number(body.setup_unit_amount_cents ?? 0),
          billing_time: body.billing_time || 'calendar',
          subscription_at: (body.subscription_at as string) || undefined,
          tax_codes: taxCodes,
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
        taxLinks: { include: { tax: true } },
        units: { orderBy: [{ activeFrom: 'desc' }] },
        addOns: { orderBy: [{ activeFrom: 'desc' }] },
        invoices: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (!service) {
      reply.status(404).type('text/html').send(layout({
        title: 'Not Found', orgSlug: org.slug,
        body: pageHeader('Service no existe') + btn('/admin/services', '← back'),
      }));
      return;
    }
    const info = kv([
      ['Code', `<code>${escapeHtml(service.code)}</code>`],
      ['Nombre', escapeHtml(service.name)],
      ['Customer', `<a class="text-indigo-700 underline" href="/admin/customers/${escapeHtml(service.customer.externalId)}">${escapeHtml(service.customer.externalId)}</a>`],
      ['Status', statusBadge(service.status)],
      ['Billing time', service.billingTime],
      ['Mensual /unidad', fmtMoney(service.monthlyUnitAmountCents, service.currency)],
      ['Setup /unidad', fmtMoney(service.setupUnitAmountCents, service.currency)],
      ['Subscription at', fmtDate(service.subscriptionAt)],
      ['Started at', fmtDate(service.startedAt)],
      ['Period start', fmtDate(service.currentBillingPeriodStartedAt)],
      ['Period end', fmtDate(service.currentBillingPeriodEndingAt)],
      ['Taxes', service.taxLinks.map((l) => badge(l.tax.code, 'blue')).join(' ') || '<span class="text-gray-400">(hereda del customer)</span>'],
    ]);

    const unitsBlock = table({
      rows: service.units,
      empty: 'Sin unidades',
      columns: [
        { label: 'External ID', render: (u) => `<code>${escapeHtml(u.externalId)}</code>` },
        { label: 'Label', render: (u) => escapeHtml(u.label ?? '—') },
        { label: 'Status', render: (u) => statusBadge(u.activeTo === null ? 'active' : 'terminated') },
        { label: 'Active from', render: (u) => fmtDate(u.activeFrom) },
        { label: 'Active to', render: (u) => fmtDate(u.activeTo) },
        { label: 'Setup billed', render: (u) => u.setupBilledAt ? badge('billed', 'green') : badge('pendiente', 'yellow') },
      ],
    });

    const invoicesBlock = table({
      rows: service.invoices,
      empty: 'Sin invoices',
      rowHref: (i) => `/admin/invoices/${i.id}`,
      columns: [
        { label: '#', render: (i) => String(i.sequentialId) },
        { label: 'Folio', render: (i) => i.number ? `<code>${escapeHtml(i.number)}</code>` : '—' },
        { label: 'Status', render: (i) => statusBadge(i.status) },
        { label: 'Total', render: (i) => fmtMoney(i.totalAmountCents, i.currency) },
        { label: 'Emitida', render: (i) => fmtDateOnly(i.issuingDate) },
      ],
    });

    const invoiceForm = `
      <form method="post" action="/admin/services/${escapeHtml(service.code)}/invoice" class="inline">
        <button type="submit" class="px-3 py-1.5 rounded bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">Calcular factura del periodo</button>
      </form>
    `;
    const terminateForm = service.status !== 'terminated' ? postButton(`/admin/services/${service.code}/terminate`, 'Terminar service', 'danger', `¿Terminar ${service.code}?`) : '';

    const addOnsBlock = table({
      rows: service.addOns,
      empty: 'Sin add-ons',
      columns: [
        { label: 'Code', render: (a) => `<code>${escapeHtml(a.code)}</code>` },
        { label: 'Nombre', render: (a) => escapeHtml(a.name) },
        { label: 'Tipo', render: (a) => badge(a.pricingType, a.pricingType === 'flat_monthly' ? 'blue' : 'green') },
        { label: 'Amount', render: (a) => `${fmtMoney(a.amountCents, service.currency)}${a.pricingType === 'per_unit_monthly' ? '/u' : ''}/mes` },
        { label: 'Status', render: (a) => statusBadge(a.activeTo === null ? 'active' : 'terminated') },
        { label: 'Active from', render: (a) => fmtDate(a.activeFrom) },
        { label: 'Active to', render: (a) => fmtDate(a.activeTo) },
        { label: 'Acciones', render: (a) => a.activeTo === null
          ? postButton(`/admin/add-ons/${a.id}/terminate`, 'Terminar', 'danger', `¿Terminar add-on ${a.code}?`)
          : '<span class="text-gray-400">terminated</span>' },
      ],
    });

    const addOnForm = `
      <details>
        <summary class="cursor-pointer text-indigo-700 font-medium">+ Agregar add-on</summary>
        <form method="post" action="/admin/services/${escapeHtml(service.code)}/add-ons" class="mt-3 space-y-3 max-w-2xl">
          <div class="grid grid-cols-2 gap-3">
            <label class="block"><span class="text-sm text-gray-700">Code</span>
              <input required name="code" placeholder="historial-12m" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Nombre</span>
              <input required name="name" placeholder="Historial 6→12 meses" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
            <label class="block"><span class="text-sm text-gray-700">Pricing type</span>
              <select required name="pricing_type" class="mt-1 block w-full rounded border-gray-300 text-sm">
                <option value="per_unit_monthly">per_unit_monthly — $X por unidad × mes</option>
                <option value="flat_monthly">flat_monthly — $X flat × mes</option>
              </select>
            </label>
            <label class="block"><span class="text-sm text-gray-700">Amount (cents)</span>
              <input required type="number" name="amount_cents" min="0" value="5000" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
            </label>
            <label class="block col-span-2"><span class="text-sm text-gray-700">Descripción</span>
              <input name="description" class="mt-1 block w-full rounded border-gray-300 text-sm">
            </label>
          </div>
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded">Crear add-on</button>
        </form>
      </details>
    `;

    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: `Service · ${service.code}`, active: '/admin/services', orgSlug: org.slug, flash,
      body: pageHeader(service.name, btn('/admin/services', '← back'))
        + card('Identidad', info)
        + card('Acciones', `${invoiceForm} ${terminateForm}`)
        + card(`Add-ons (${service.addOns.length})`, addOnsBlock + '<div class="mt-4">' + addOnForm + '</div>')
        + card(`Units (${service.units.length})`, unitsBlock)
        + card(`Invoices recientes (${service.invoices.length})`, invoicesBlock),
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
        add_on: {
          code: body.code,
          name: body.name,
          description: (body.description as string) || undefined,
          pricing_type: body.pricing_type,
          amount_cents: Number(body.amount_cents),
        },
      },
    });
    if (result.statusCode !== 200) setFlash(reply, 'error', `Rechazado: ${result.body.slice(0, 240)}`);
    else setFlash(reply, 'success', `Add-on "${body.code}" creado`);
    reply.redirect(`/admin/services/${svcCode}`);
  });

  app.post('/admin/add-ons/:id/terminate', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { id } = request.params as { id: string };
    const addOn = await prisma.addOn.findFirst({
      where: { id, service: { organizationId: org.id } },
      include: { service: true },
    });
    if (!addOn) {
      setFlash(reply, 'error', 'add_on no encontrado');
      return reply.redirect('/admin/services');
    }
    const result = await app.inject({
      method: 'DELETE',
      url: `/api/v1/add-ons/${id}`,
      headers: { authorization: `Bearer ${org.apiKey}` },
    });
    if (result.statusCode !== 200) setFlash(reply, 'error', result.body.slice(0, 240));
    else setFlash(reply, 'success', `Add-on ${addOn.code} terminado`);
    reply.redirect(`/admin/services/${addOn.service.code}`);
  });

  app.post('/admin/services/:code/invoice', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { code: svcCode } = request.params as { code: string };
    const idemKey = `admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: { authorization: `Bearer ${org.apiKey}`, 'content-type': 'application/json', 'idempotency-key': idemKey },
      payload: { invoice: { service_code: svcCode, metadata: { idempotency_key: idemKey } } },
    });
    if (result.statusCode !== 200) {
      setFlash(reply, 'error', `Rechazado: ${result.body.slice(0, 240)}`);
      return reply.redirect(`/admin/services/${svcCode}`);
    }
    const invoiceId = (result.json() as { invoice: { id: string } }).invoice.id;
    setFlash(reply, 'success', 'Factura creada.');
    reply.redirect(`/admin/invoices/${invoiceId}`);
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
          { label: 'Active to', render: (u) => fmtDate(u.activeTo) },
          { label: 'Setup', render: (u) => u.setupBilledAt ? badge('billed', 'green') : badge('pendiente', 'yellow') },
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
      include: { customer: true, service: true, _count: { select: { fees: true } } },
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
          { label: 'Service', render: (i) => i.service ? escapeHtml(i.service.code) : '—' },
          { label: 'Status', render: (i) => statusBadge(i.status) },
          { label: 'Dispatch', render: (i) => statusBadge(i.externalDispatchStatus) },
          { label: 'Total', render: (i) => fmtMoney(i.totalAmountCents, i.currency) },
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
      include: { customer: true, service: true, fees: { orderBy: { position: 'asc' } }, appliedTaxes: true },
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
      ['Service', invoice.service ? `<a class="text-indigo-700 underline" href="/admin/services/${escapeHtml(invoice.service.code)}">${escapeHtml(invoice.service.code)}</a>` : '—'],
      ['Status', statusBadge(invoice.status)],
      ['Dispatch', statusBadge(invoice.externalDispatchStatus)],
      ['Payment', statusBadge(invoice.paymentStatus)],
      ['Currency', escapeHtml(invoice.currency)],
      ['Period from', fmtDate(invoice.periodFrom)],
      ['Period to', fmtDate(invoice.periodTo)],
      ['Fees', fmtMoney(invoice.feesAmountCents, invoice.currency)],
      ['Taxes', fmtMoney(invoice.taxesAmountCents, invoice.currency)],
      ['Total', `<b>${fmtMoney(invoice.totalAmountCents, invoice.currency)}</b>`],
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
        { label: 'Amount', render: (f) => fmtMoney(f.amountCents, invoice.currency) },
        { label: 'Taxes', render: (f) => fmtMoney(f.taxesAmountCents, invoice.currency) },
        { label: 'Total', render: (f) => fmtMoney(f.totalAmountCents, invoice.currency) },
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
        + card('Applied taxes', code(invoice.appliedTaxes))
        + card('External invoice (folio fiscal)', externalInvoice)
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
      include: { customer: true, invoice: true, items: { include: { fee: true } }, appliedTaxes: true },
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
      ['Sub total', fmtMoney(cn.subTotalExcludingTaxesAmountCents, cn.currency)],
      ['Taxes', fmtMoney(cn.taxesAmountCents, cn.currency)],
      ['Total', `<b>${fmtMoney(cn.totalAmountCents, cn.currency)}</b>`],
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
        + card('Applied taxes', code(cn.appliedTaxes))
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
  // Taxes.
  // ------------------------------------------------------------------
  app.get('/admin/taxes', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const taxes = await prisma.tax.findMany({
      where: { organizationId: org.id }, orderBy: { createdAt: 'desc' },
      include: { _count: { select: { customers: true, services: true } } },
    });
    const flash = readFlash(request, reply);
    const form = `
      <form method="post" action="/admin/taxes" class="grid grid-cols-2 gap-3 max-w-2xl">
        <label class="block"><span class="text-sm text-gray-600">Code</span>
          <input required name="code" class="mt-1 block w-full rounded border-gray-300 font-mono" placeholder="iva-mx-16">
        </label>
        <label class="block"><span class="text-sm text-gray-600">Nombre</span>
          <input required name="name" class="mt-1 block w-full rounded border-gray-300">
        </label>
        <label class="block"><span class="text-sm text-gray-600">Rate (%)</span>
          <input required name="rate" value="16" class="mt-1 block w-full rounded border-gray-300 font-mono">
        </label>
        <label class="block"><span class="text-sm text-gray-600">Descripción</span>
          <input name="description" class="mt-1 block w-full rounded border-gray-300">
        </label>
        <div class="col-span-2"><button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded">Crear tax</button></div>
      </form>
    `;
    reply.type('text/html').send(layout({
      title: 'Taxes', active: '/admin/taxes', orgSlug: org.slug, flash,
      body: pageHeader('Taxes') + card('Crear tax', form) + card('Existentes', table({
        rows: taxes,
        empty: 'Sin taxes',
        columns: [
          { label: 'Code', render: (t) => `<code>${escapeHtml(t.code)}</code>` },
          { label: 'Nombre', render: (t) => escapeHtml(t.name) },
          { label: 'Rate', render: (t) => `${Number(t.rate)}%` },
          { label: 'Customers', render: (t) => String(t._count.customers) },
          { label: 'Services', render: (t) => String(t._count.services) },
        ],
      })),
    }));
  });

  app.post('/admin/taxes', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const body = request.body as Record<string, string>;
    try {
      await prisma.tax.create({
        data: {
          organizationId: org.id,
          name: body.name ?? '',
          code: body.code ?? '',
          description: (body.description as string) || null,
          rate: new Decimal(body.rate ?? '0'),
        },
      });
      setFlash(reply, 'success', `Tax ${body.code} creado`);
    } catch (err) {
      setFlash(reply, 'error', err instanceof Error ? err.message : String(err));
    }
    reply.redirect('/admin/taxes');
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
