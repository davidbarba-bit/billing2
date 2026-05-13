// Admin back-office routes mounted at /admin/*.
//
// Server-rendered with template literals (no build step). Tailwind via CDN,
// HTMX for interactivity. Protected by HTTP Basic Auth: ADMIN_USER +
// ADMIN_PASSWORD env vars (defaults to `admin` / random for dev).

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import basicAuth from '@fastify/basic-auth';
import formbody from '@fastify/formbody';
import type { Organization, PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config.js';
import type { NetSuiteDispatcher } from '../services/netsuite-dispatcher.js';
import { seedNumaris } from './seed.js';
import { buildSignatureHeader } from '../services/hmac.js';
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
  // The admin is single-tenant for now: it operates on the first
  // organization in the table. Adding a tenant switcher is straightforward
  // once you have more than one org.
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

export async function registerAdmin(app: FastifyInstance, deps: Deps): Promise<void> {
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    await app.register(formbody);
  }
  // Need cookies for flash messages.
  const { default: fastifyCookie } = await import('@fastify/cookie');
  await app.register(fastifyCookie);

  const adminUser = process.env.ADMIN_USER ?? 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin';
  await app.register(basicAuth, {
    validate: async (username, password) => {
      const userOk = timingSafeStringEqual(username, adminUser);
      const passOk = timingSafeStringEqual(password, adminPassword);
      if (!userOk || !passOk) {
        throw new Error('invalid credentials');
      }
    },
    authenticate: { realm: 'mini-Lago admin' },
  });

  // All /admin/* routes get the Basic Auth pre-handler.
  app.addHook('preHandler', (request, reply, done) => {
    if (request.url.startsWith('/admin')) {
      app.basicAuth(request, reply, done);
      return;
    }
    done();
  });

  const { prisma } = deps;

  // ------------------------------------------------------------------
  // Dashboard.
  // ------------------------------------------------------------------
  app.get('/admin', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) {
      reply.type('text/html').send(layout({
        title: 'Setup',
        body: card('Setup', '<p>No hay organización. Arranca el server con <code>npm run dev</code> y vuelve.</p>'),
        orgSlug: '—',
      }));
      return;
    }
    const [customers, plans, addOns, subs, activeSubs, invoices, invoicesCalc, invoicesDispatched, invoicesConfirmed, creditNotes, events] = await Promise.all([
      prisma.customer.count({ where: { organizationId: org.id } }),
      prisma.plan.count({ where: { organizationId: org.id } }),
      prisma.addOn.count({ where: { organizationId: org.id } }),
      prisma.subscription.count({ where: { organizationId: org.id } }),
      prisma.subscription.count({ where: { organizationId: org.id, status: 'active' } }),
      prisma.invoice.count({ where: { organizationId: org.id } }),
      prisma.invoice.count({ where: { organizationId: org.id, status: 'calculated' } }),
      prisma.invoice.count({ where: { organizationId: org.id, externalDispatchStatus: 'dispatched' } }),
      prisma.invoice.count({ where: { organizationId: org.id, externalDispatchStatus: 'confirmed' } }),
      prisma.creditNote.count({ where: { organizationId: org.id } }),
      prisma.event.count({ where: { organizationId: org.id } }),
    ]);

    const counts = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        ${counter('Customers', customers, '/admin/customers')}
        ${counter('Plans', plans, '/admin/plans')}
        ${counter('Subscriptions', `${activeSubs}/${subs}`, '/admin/subscriptions')}
        ${counter('Add-ons', addOns, '/admin/add-ons')}
        ${counter('Events', events, '/admin/events')}
        ${counter('Invoices', invoices, '/admin/invoices')}
        ${counter('Credit notes', creditNotes, '/admin/credit-notes')}
        ${counter('Dispatch confirmed', invoicesConfirmed, '/admin/invoices')}
      </div>
      <div class="grid grid-cols-3 gap-4 mb-6">
        ${counter('Invoices calculated', invoicesCalc)}
        ${counter('Invoices dispatched', invoicesDispatched)}
        ${counter('Invoices confirmed', invoicesConfirmed)}
      </div>
    `;
    const seedAction = postButton('/admin/seed', 'Seed Numaris (3 camiones)', 'primary');
    const flash = readFlash(request, reply);
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
      ])),
    }));
  });

  app.post('/admin/seed', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const result = await seedNumaris(prisma, org);
    setFlash(reply, 'success', `Seed listo · customer=${result.customerExternalId} sub=${result.subscriptionExternalId} eventos+=${result.eventsCreated}`);
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
      title: 'Customers',
      active: '/admin/customers',
      orgSlug: org.slug,
      flash,
      body: pageHeader('Customers') + table({
        rows: customers,
        empty: 'Sin customers — usa "Seed Numaris" en el dashboard',
        rowHref: (c) => `/admin/customers/${c.externalId}`,
        columns: [
          { label: 'External ID', render: (c) => `<code>${escapeHtml(c.externalId)}</code>` },
          { label: 'Name', render: (c) => escapeHtml(c.name) },
          { label: 'Currency', render: (c) => escapeHtml(c.currency) },
          { label: 'Country', render: (c) => escapeHtml(c.country ?? '—') },
          { label: 'Timezone', render: (c) => escapeHtml(c.timezone ?? c.country ?? '—') },
          { label: 'Taxes', render: (c) => c.taxLinks.map((l) => badge(l.tax.code, 'blue')).join(' ') || '—' },
          { label: 'Created', render: (c) => fmtDate(c.createdAt) },
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
        subscriptions: { include: { plan: true }, orderBy: { createdAt: 'desc' } },
        invoices: { orderBy: { createdAt: 'desc' } },
        creditNotes: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!customer) {
      reply.status(404).type('text/html').send(layout({
        title: 'Not Found',
        orgSlug: org.slug,
        body: pageHeader('Not found') + '<p>Customer no existe.</p>',
      }));
      return;
    }

    const recentEvents = await prisma.event.findMany({
      where: {
        organizationId: org.id,
        externalSubscriptionId: { in: customer.subscriptions.map((s) => s.externalId) },
      },
      orderBy: { timestamp: 'desc' },
      take: 10,
    });

    const info = kv([
      ['Lago ID', `<code>${escapeHtml(customer.id)}</code>`],
      ['External ID', `<code>${escapeHtml(customer.externalId)}</code>`],
      ['Name', escapeHtml(customer.name)],
      ['Slug', escapeHtml(customer.slug)],
      ['Currency', escapeHtml(customer.currency)],
      ['Country', escapeHtml(customer.country ?? '—')],
      ['Timezone', escapeHtml(customer.timezone ?? '—')],
      ['Applicable timezone', escapeHtml(customer.timezone ?? customer.organization.timezone)],
      ['Tax ID', escapeHtml(customer.taxIdentificationNumber ?? '—')],
      ['Taxes', customer.taxLinks.map((l) => badge(l.tax.code, 'blue')).join(' ') || '—'],
      ['Created', fmtDate(customer.createdAt)],
      ['Updated', fmtDate(customer.updatedAt)],
    ]);

    const subsBlock = table({
      rows: customer.subscriptions,
      empty: 'Sin subscriptions',
      rowHref: (s) => `/admin/subscriptions/${s.externalId}`,
      columns: [
        { label: 'External ID', render: (s) => `<code>${escapeHtml(s.externalId)}</code>` },
        { label: 'Plan', render: (s) => `<code>${escapeHtml(s.plan.code)}</code>` },
        { label: 'Status', render: (s) => statusBadge(s.status) },
        { label: 'Billing time', render: (s) => escapeHtml(s.billingTime) },
        { label: 'Period end', render: (s) => fmtDate(s.currentBillingPeriodEndingAt) },
      ],
    });

    const invoicesBlock = table({
      rows: customer.invoices,
      empty: 'Sin invoices',
      rowHref: (i) => `/admin/invoices/${i.id}`,
      columns: [
        { label: 'Number', render: (i) => i.number ? `<code>${escapeHtml(i.number)}</code>` : '<span class="text-gray-400">—</span>' },
        { label: 'Status', render: (i) => statusBadge(i.status) },
        { label: 'Dispatch', render: (i) => statusBadge(i.externalDispatchStatus) },
        { label: 'Total', render: (i) => fmtMoney(i.totalAmountCents, i.currency) },
        { label: 'Issued', render: (i) => fmtDateOnly(i.issuingDate) },
      ],
    });

    const creditNotesBlock = table({
      rows: customer.creditNotes,
      empty: 'Sin credit notes',
      rowHref: (cn) => `/admin/credit-notes/${cn.id}`,
      columns: [
        { label: 'Number', render: (cn) => cn.number ? `<code>${escapeHtml(cn.number)}</code>` : '<span class="text-gray-400">—</span>' },
        { label: 'Status', render: (cn) => statusBadge(cn.status) },
        { label: 'Dispatch', render: (cn) => statusBadge(cn.externalDispatchStatus) },
        { label: 'Total', render: (cn) => fmtMoney(cn.totalAmountCents, cn.currency) },
        { label: 'Reason', render: (cn) => escapeHtml(cn.reason) },
      ],
    });

    const eventsBlock = table({
      rows: recentEvents,
      empty: 'Sin eventos recientes',
      columns: [
        { label: 'Transaction ID', render: (e) => `<code>${escapeHtml(e.transactionId)}</code>` },
        { label: 'Subscription', render: (e) => escapeHtml(e.externalSubscriptionId) },
        { label: 'Code', render: (e) => escapeHtml(e.code) },
        { label: 'Operation', render: (e) => {
          const props = e.properties as { operation_type?: string; unit_external_id?: string; unit_label?: string };
          return `${badge(props.operation_type ?? '?', props.operation_type === 'remove' ? 'red' : 'green')} ${escapeHtml(props.unit_external_id ?? '')}${props.unit_label ? ` <span class="text-gray-500">(${escapeHtml(props.unit_label)})</span>` : ''}`;
        } },
        { label: 'Timestamp', render: (e) => fmtDate(e.timestamp) },
      ],
    });

    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: `Customer · ${customer.externalId}`,
      active: '/admin/customers',
      orgSlug: org.slug,
      flash,
      body: pageHeader(customer.name, btn('/admin/customers', '← back to customers'))
        + card('Identidad', info)
        + card(`Subscriptions (${customer.subscriptions.length})`, subsBlock)
        + card(`Invoices (${customer.invoices.length})`, invoicesBlock,
          `${btn(`/admin/invoices/new?customer=${customer.externalId}`, '+ Nueva invoice', 'primary')}`)
        + card(`Credit notes (${customer.creditNotes.length})`, creditNotesBlock)
        + card('Últimos eventos', eventsBlock),
    }));
  });

  // ------------------------------------------------------------------
  // Plans.
  // ------------------------------------------------------------------
  app.get('/admin/plans', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const plans = await prisma.plan.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: 'desc' },
      include: { charges: { include: { billableMetric: true } }, _count: { select: { subscriptions: true } } },
    });
    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: 'Plans',
      active: '/admin/plans',
      orgSlug: org.slug,
      flash,
      body: pageHeader('Plans')
        + table({
          rows: plans,
          empty: 'Sin plans',
          columns: [
            { label: 'Code', render: (p) => `<code>${escapeHtml(p.code)}</code>` },
            { label: 'Name', render: (p) => escapeHtml(p.name) },
            { label: 'Interval', render: (p) => badge(p.interval, 'blue') },
            { label: 'Amount base', render: (p) => fmtMoney(p.amountCents, p.amountCurrency) },
            { label: 'Charges', render: (p) => p.charges.map((c) => {
              const amt = (c.properties as { amount?: string }).amount;
              return `<div class="text-xs">${escapeHtml(c.billableMetric.code)} · $${escapeHtml(amt ?? '0')}${c.prorated ? ' · prorrateado' : ''}</div>`;
            }).join('') },
            { label: 'Subs', render: (p) => String(p._count.subscriptions) },
          ],
        }),
    }));
  });

  // ------------------------------------------------------------------
  // Billable metrics (list + create).
  // ------------------------------------------------------------------
  app.get('/admin/billable-metrics', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const bms = await prisma.billableMetric.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: 'desc' },
    });
    const flash = readFlash(request, reply);
    const form = `
      <form method="post" action="/admin/billable-metrics" class="grid grid-cols-2 gap-3 max-w-2xl">
        <label class="block"><span class="text-sm text-gray-600">Code</span>
          <input required name="code" class="mt-1 block w-full rounded border-gray-300 shadow-sm font-mono" placeholder="bm-foo">
        </label>
        <label class="block"><span class="text-sm text-gray-600">Name</span>
          <input required name="name" class="mt-1 block w-full rounded border-gray-300 shadow-sm">
        </label>
        <label class="block"><span class="text-sm text-gray-600">Aggregation</span>
          <select name="aggregation_type" class="mt-1 block w-full rounded border-gray-300 shadow-sm">
            <option value="unique_count_agg" selected>unique_count_agg</option>
          </select>
        </label>
        <label class="block"><span class="text-sm text-gray-600">Field name</span>
          <input name="field_name" value="unit_external_id" class="mt-1 block w-full rounded border-gray-300 shadow-sm font-mono">
        </label>
        <label class="block col-span-2"><input type="checkbox" name="recurring" value="1" checked> <span class="ml-1">Recurring (necesario para prorated:true)</span></label>
        <div class="col-span-2"><button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded">Crear BM</button></div>
      </form>
    `;
    reply.type('text/html').send(layout({
      title: 'Billable metrics',
      active: '/admin/billable-metrics',
      orgSlug: org.slug,
      flash,
      body: pageHeader('Billable metrics')
        + card('Crear BM', form)
        + card('Existentes', table({
          rows: bms,
          empty: 'Sin BMs',
          columns: [
            { label: 'Code', render: (b) => `<code>${escapeHtml(b.code)}</code>` },
            { label: 'Name', render: (b) => escapeHtml(b.name) },
            { label: 'Aggregation', render: (b) => escapeHtml(b.aggregationType) },
            { label: 'Recurring', render: (b) => b.recurring ? badge('yes', 'green') : badge('no', 'gray') },
            { label: 'Field', render: (b) => `<code class="text-xs">${escapeHtml(b.fieldName ?? '')}</code>` },
          ],
        })),
    }));
  });

  app.post('/admin/billable-metrics', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const body = request.body as Record<string, string>;
    try {
      await prisma.billableMetric.create({
        data: {
          organizationId: org.id,
          name: body.name ?? '',
          code: body.code ?? '',
          aggregationType: body.aggregation_type ?? 'unique_count_agg',
          fieldName: body.field_name || null,
          recurring: body.recurring === '1',
        },
      });
      setFlash(reply, 'success', `BM ${body.code} creada`);
    } catch (err) {
      setFlash(reply, 'error', err instanceof Error ? err.message : String(err));
    }
    reply.redirect('/admin/billable-metrics');
  });

  // ------------------------------------------------------------------
  // Add-ons (list + create + edit + delete).
  // ------------------------------------------------------------------
  app.get('/admin/add-ons', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const addOns = await prisma.addOn.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { fees: true } } },
    });
    const flash = readFlash(request, reply);
    const form = `
      <form method="post" action="/admin/add-ons" class="grid grid-cols-2 gap-3 max-w-2xl">
        <label class="block"><span class="text-sm text-gray-600">Code</span>
          <input required name="code" class="mt-1 block w-full rounded border-gray-300 shadow-sm font-mono" placeholder="cobro-foo">
        </label>
        <label class="block"><span class="text-sm text-gray-600">Name</span>
          <input required name="name" class="mt-1 block w-full rounded border-gray-300 shadow-sm">
        </label>
        <label class="block"><span class="text-sm text-gray-600">Amount (cents)</span>
          <input required type="number" name="amount_cents" value="45000" min="1" class="mt-1 block w-full rounded border-gray-300 shadow-sm">
        </label>
        <label class="block"><span class="text-sm text-gray-600">Currency</span>
          <input required name="amount_currency" value="MXN" class="mt-1 block w-full rounded border-gray-300 shadow-sm">
        </label>
        <label class="block col-span-2"><span class="text-sm text-gray-600">Description</span>
          <input name="description" class="mt-1 block w-full rounded border-gray-300 shadow-sm">
        </label>
        <div class="col-span-2"><button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded">Crear add-on</button></div>
      </form>
    `;
    reply.type('text/html').send(layout({
      title: 'Add-ons',
      active: '/admin/add-ons',
      orgSlug: org.slug,
      flash,
      body: pageHeader('Add-ons')
        + card('Crear add-on', form)
        + card('Existentes', table({
          rows: addOns,
          empty: 'Sin add-ons',
          columns: [
            { label: 'Code', render: (a) => `<code>${escapeHtml(a.code)}</code>` },
            { label: 'Name', render: (a) => escapeHtml(a.name) },
            { label: 'Amount', render: (a) => fmtMoney(a.amountCents, a.amountCurrency) },
            { label: 'Fees', render: (a) => String(a._count.fees) },
            { label: 'Acciones', render: (a) => `${postButton(`/admin/add-ons/${encodeURIComponent(a.code)}/delete`, 'Delete', 'danger', `¿Borrar add-on ${a.code}?`)}` },
          ],
        })),
    }));
  });

  app.post('/admin/add-ons', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const body = request.body as Record<string, string>;
    try {
      await prisma.addOn.create({
        data: {
          organizationId: org.id,
          name: body.name ?? '',
          code: body.code ?? '',
          description: body.description || null,
          amountCents: Number(body.amount_cents),
          amountCurrency: body.amount_currency ?? 'MXN',
        },
      });
      setFlash(reply, 'success', `Add-on ${body.code} creado`);
    } catch (err) {
      setFlash(reply, 'error', err instanceof Error ? err.message : String(err));
    }
    reply.redirect('/admin/add-ons');
  });

  app.post('/admin/add-ons/:code/delete', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin/add-ons');
    const { code: addOnCode } = request.params as { code: string };
    const addOn = await prisma.addOn.findUnique({
      where: { organizationId_code: { organizationId: org.id, code: addOnCode } },
    });
    if (!addOn) {
      setFlash(reply, 'error', 'add-on no encontrado');
      return reply.redirect('/admin/add-ons');
    }
    const feeCount = await prisma.fee.count({ where: { addOnId: addOn.id } });
    if (feeCount > 0) {
      setFlash(reply, 'error', `409 add_on_referenced_by_fees · tiene ${feeCount} fees (D6)`);
      return reply.redirect('/admin/add-ons');
    }
    await prisma.addOn.delete({ where: { id: addOn.id } });
    setFlash(reply, 'success', `Add-on ${addOnCode} eliminado`);
    reply.redirect('/admin/add-ons');
  });

  // ------------------------------------------------------------------
  // Taxes.
  // ------------------------------------------------------------------
  app.get('/admin/taxes', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const taxes = await prisma.tax.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { customers: true, addOnLinks: true } } },
    });
    const flash = readFlash(request, reply);
    const form = `
      <form method="post" action="/admin/taxes" class="grid grid-cols-2 gap-3 max-w-2xl">
        <label class="block"><span class="text-sm text-gray-600">Code</span>
          <input required name="code" class="mt-1 block w-full rounded border-gray-300 shadow-sm font-mono" placeholder="iva-mx-16">
        </label>
        <label class="block"><span class="text-sm text-gray-600">Name</span>
          <input required name="name" class="mt-1 block w-full rounded border-gray-300 shadow-sm">
        </label>
        <label class="block"><span class="text-sm text-gray-600">Rate (%)</span>
          <input required name="rate" value="16" class="mt-1 block w-full rounded border-gray-300 shadow-sm font-mono">
        </label>
        <label class="block"><span class="text-sm text-gray-600">Description</span>
          <input name="description" class="mt-1 block w-full rounded border-gray-300 shadow-sm">
        </label>
        <div class="col-span-2"><button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded">Crear tax</button></div>
      </form>
    `;
    reply.type('text/html').send(layout({
      title: 'Taxes',
      active: '/admin/taxes',
      orgSlug: org.slug,
      flash,
      body: pageHeader('Taxes')
        + card('Crear tax', form)
        + card('Existentes', table({
          rows: taxes,
          empty: 'Sin taxes',
          columns: [
            { label: 'Code', render: (t) => `<code>${escapeHtml(t.code)}</code>` },
            { label: 'Name', render: (t) => escapeHtml(t.name) },
            { label: 'Rate', render: (t) => `${Number(t.rate)}%` },
            { label: 'Customers', render: (t) => String(t._count.customers) },
            { label: 'Add-ons', render: (t) => String(t._count.addOnLinks) },
          ],
        })),
    }));
  });

  app.post('/admin/taxes', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const body = request.body as Record<string, string>;
    try {
      const { Decimal } = await import('@prisma/client/runtime/library');
      await prisma.tax.create({
        data: {
          organizationId: org.id,
          name: body.name ?? '',
          code: body.code ?? '',
          description: body.description || null,
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
  // Subscriptions.
  // ------------------------------------------------------------------
  app.get('/admin/subscriptions', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const subs = await prisma.subscription.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: 'desc' },
      include: { customer: true, plan: true },
    });
    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: 'Subscriptions',
      active: '/admin/subscriptions',
      orgSlug: org.slug,
      flash,
      body: pageHeader('Subscriptions')
        + table({
          rows: subs,
          empty: 'Sin subscriptions',
          rowHref: (s) => `/admin/subscriptions/${s.externalId}`,
          columns: [
            { label: 'External ID', render: (s) => `<code>${escapeHtml(s.externalId)}</code>` },
            { label: 'Customer', render: (s) => escapeHtml(s.customer.externalId) },
            { label: 'Plan', render: (s) => escapeHtml(s.plan.code) },
            { label: 'Status', render: (s) => statusBadge(s.status) },
            { label: 'Billing', render: (s) => badge(s.billingTime, 'blue') },
            { label: 'Period start', render: (s) => fmtDate(s.currentBillingPeriodStartedAt) },
            { label: 'Period end', render: (s) => fmtDate(s.currentBillingPeriodEndingAt) },
          ],
        }),
    }));
  });

  app.get('/admin/subscriptions/:externalId', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { externalId } = request.params as { externalId: string };
    const sub = await prisma.subscription.findUnique({
      where: { organizationId_externalId: { organizationId: org.id, externalId } },
      include: {
        customer: true,
        plan: { include: { charges: { include: { billableMetric: true } } } },
        events: { orderBy: { timestamp: 'desc' }, take: 100 },
      },
    });
    if (!sub) {
      reply.status(404).type('text/html').send(layout({
        title: 'Not Found', orgSlug: org.slug,
        body: pageHeader('Not found') + '<p>Subscription no existe.</p>',
      }));
      return;
    }

    const info = kv([
      ['Lago ID', `<code>${escapeHtml(sub.id)}</code>`],
      ['External ID', `<code>${escapeHtml(sub.externalId)}</code>`],
      ['Customer', `<a class="text-indigo-700 underline" href="/admin/customers/${escapeHtml(sub.customer.externalId)}">${escapeHtml(sub.customer.externalId)}</a>`],
      ['Plan', `<code>${escapeHtml(sub.plan.code)}</code>`],
      ['Status', statusBadge(sub.status)],
      ['Billing time', sub.billingTime],
      ['Subscription at', fmtDate(sub.subscriptionAt)],
      ['Started at', fmtDate(sub.startedAt)],
      ['Period start', fmtDate(sub.currentBillingPeriodStartedAt)],
      ['Period end', fmtDate(sub.currentBillingPeriodEndingAt)],
    ]);

    const eventsBlock = table({
      rows: sub.events,
      empty: 'Sin eventos',
      columns: [
        { label: 'Transaction ID', render: (e) => `<code>${escapeHtml(e.transactionId)}</code>` },
        { label: 'Code', render: (e) => escapeHtml(e.code) },
        { label: 'Unit', render: (e) => {
          const p = e.properties as { unit_external_id?: string; unit_label?: string; operation_type?: string };
          return `${badge(p.operation_type ?? '?', p.operation_type === 'remove' ? 'red' : 'green')} ${escapeHtml(p.unit_external_id ?? '')}${p.unit_label ? ` <span class="text-gray-500">(${escapeHtml(p.unit_label)})</span>` : ''}`;
        } },
        { label: 'Timestamp', render: (e) => fmtDate(e.timestamp) },
      ],
    });

    // Show current_usage live by reusing the same engine via app.inject.
    let usageBlock = '';
    try {
      const apiKey = sub.customer.organizationId === org.id ? org.apiKey : null;
      if (apiKey) {
        const usageRes = await app.inject({
          method: 'GET',
          url: `/api/v1/customers/${encodeURIComponent(sub.customer.externalId)}/current_usage?external_subscription_id=${encodeURIComponent(sub.externalId)}&apply_taxes=true`,
          headers: { authorization: `Bearer ${apiKey}` },
        });
        if (usageRes.statusCode === 200) {
          usageBlock = card('Current usage', code(usageRes.json()));
        } else {
          usageBlock = card('Current usage', `<pre class="text-red-700 text-sm">${escapeHtml(usageRes.body)}</pre>`);
        }
      }
    } catch (err) {
      usageBlock = card('Current usage', `<pre class="text-red-700 text-sm">${escapeHtml(err instanceof Error ? err.message : String(err))}</pre>`);
    }

    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: `Subscription · ${sub.externalId}`,
      active: '/admin/subscriptions',
      orgSlug: org.slug,
      flash,
      body: pageHeader(sub.name ?? sub.externalId, btn('/admin/subscriptions', '← back'))
        + card('Identidad', info)
        + usageBlock
        + card(`Eventos (${sub.events.length})`, eventsBlock),
    }));
  });

  // ------------------------------------------------------------------
  // Events list.
  // ------------------------------------------------------------------
  app.get('/admin/events', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const q = request.query as { sub?: string };
    const events = await prisma.event.findMany({
      where: { organizationId: org.id, ...(q.sub ? { externalSubscriptionId: q.sub } : {}) },
      orderBy: { timestamp: 'desc' },
      take: 200,
    });
    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: 'Events',
      active: '/admin/events',
      orgSlug: org.slug,
      flash,
      body: pageHeader('Events (últimos 200)') + table({
        rows: events,
        empty: 'Sin eventos',
        columns: [
          { label: 'Transaction ID', render: (e) => `<code class="text-xs">${escapeHtml(e.transactionId)}</code>` },
          { label: 'Subscription', render: (e) => `<a class="text-indigo-700 underline" href="/admin/events?sub=${encodeURIComponent(e.externalSubscriptionId)}">${escapeHtml(e.externalSubscriptionId)}</a>` },
          { label: 'BM code', render: (e) => `<code class="text-xs">${escapeHtml(e.code)}</code>` },
          { label: 'Unit', render: (e) => {
            const p = e.properties as { unit_external_id?: string; unit_label?: string; operation_type?: string; kind?: string };
            return `${badge(p.operation_type ?? '?', p.operation_type === 'remove' ? 'red' : 'green')} ${escapeHtml(p.unit_external_id ?? '')}${p.unit_label ? ` <span class="text-gray-500 text-xs">(${escapeHtml(p.unit_label)})</span>` : ''} ${p.kind ? badge(p.kind, 'gray') : ''}`;
          } },
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
      title: 'Invoices',
      active: '/admin/invoices',
      orgSlug: org.slug,
      flash,
      body: pageHeader('Invoices', btn('/admin/invoices/new', '+ Nueva invoice', 'primary'))
        + table({
          rows: invoices,
          empty: 'Sin invoices',
          rowHref: (i) => `/admin/invoices/${i.id}`,
          columns: [
            { label: '#', render: (i) => String(i.sequentialId) },
            { label: 'Number', render: (i) => i.number ? `<code>${escapeHtml(i.number)}</code>` : '<span class="text-gray-400">—</span>' },
            { label: 'Customer', render: (i) => escapeHtml(i.customer.externalId) },
            { label: 'Status', render: (i) => statusBadge(i.status) },
            { label: 'Dispatch', render: (i) => statusBadge(i.externalDispatchStatus) },
            { label: 'Total', render: (i) => fmtMoney(i.totalAmountCents, i.currency) },
            { label: 'Fees', render: (i) => String(i._count.fees) },
            { label: 'Issued', render: (i) => fmtDateOnly(i.issuingDate) },
          ],
        }),
    }));
  });

  // New invoice form.
  app.get('/admin/invoices/new', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const q = request.query as { customer?: string };
    const customers = await prisma.customer.findMany({ where: { organizationId: org.id }, orderBy: { externalId: 'asc' } });
    const addOns = await prisma.addOn.findMany({ where: { organizationId: org.id }, orderBy: { code: 'asc' } });
    const flash = readFlash(request, reply);
    const customerOptions = customers.map((c) =>
      `<option value="${escapeHtml(c.externalId)}" ${q.customer === c.externalId ? 'selected' : ''}>${escapeHtml(c.externalId)} · ${escapeHtml(c.name)}</option>`,
    ).join('');
    const addOnOptions = addOns.map((a) =>
      `<option value="${escapeHtml(a.code)}" data-amount="${a.amountCents}">${escapeHtml(a.code)} · ${fmtMoney(a.amountCents, a.amountCurrency)}</option>`,
    ).join('');

    const form = `
      <form method="post" action="/admin/invoices" class="space-y-4">
        <label class="block max-w-xl"><span class="text-sm text-gray-600">Customer</span>
          <select required name="external_customer_id" class="mt-1 block w-full rounded border-gray-300">${customerOptions}</select>
        </label>
        <label class="block max-w-xl"><span class="text-sm text-gray-600">Currency</span>
          <input name="currency" value="MXN" class="mt-1 block w-full rounded border-gray-300 font-mono">
        </label>
        <label class="block max-w-xl"><span class="text-sm text-gray-600">Idempotency key (opcional)</span>
          <input name="idempotency_key" class="mt-1 block w-full rounded border-gray-300 font-mono" placeholder="org:month-key:strategy">
        </label>

        <div class="border-t pt-4">
          <h3 class="font-semibold mb-2">Fees</h3>
          <div id="fees" class="space-y-2">
            <div class="grid grid-cols-12 gap-2 items-end">
              <label class="col-span-5"><span class="text-xs text-gray-600">Add-on</span>
                <select required name="add_on_code_0" class="block w-full rounded border-gray-300">${addOnOptions}</select>
              </label>
              <label class="col-span-2"><span class="text-xs text-gray-600">Unit amount (cents)</span>
                <input required type="number" name="unit_amount_cents_0" value="45000" class="block w-full rounded border-gray-300 font-mono">
              </label>
              <label class="col-span-1"><span class="text-xs text-gray-600">Units</span>
                <input required name="units_0" value="1" class="block w-full rounded border-gray-300 font-mono">
              </label>
              <label class="col-span-4"><span class="text-xs text-gray-600">Description</span>
                <input name="description_0" class="block w-full rounded border-gray-300">
              </label>
            </div>
          </div>
          <p class="text-xs text-gray-500 mt-2">El motor recalcula <code>units</code>/<code>amount_cents</code> a partir de eventos cuando hay subscription. Los valores aquí son hints.</p>
        </div>

        <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded">Calcular invoice</button>
      </form>
    `;
    reply.type('text/html').send(layout({
      title: 'Nueva invoice',
      active: '/admin/invoices',
      orgSlug: org.slug,
      flash,
      body: pageHeader('Nueva invoice', btn('/admin/invoices', '← back'))
        + card('Crear', form),
    }));
  });

  app.post('/admin/invoices', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const body = request.body as Record<string, string>;
    const fees: Array<{ add_on_code: string; unit_amount_cents: number; units: string; description?: string }> = [];
    let i = 0;
    while (body[`add_on_code_${i}`]) {
      fees.push({
        add_on_code: body[`add_on_code_${i}`]!,
        unit_amount_cents: Number(body[`unit_amount_cents_${i}`]!),
        units: body[`units_${i}`] ?? '1',
        description: body[`description_${i}`] || undefined,
      });
      i += 1;
    }
    const headers: Record<string, string> = { authorization: `Bearer ${org.apiKey}`, 'content-type': 'application/json' };
    if (body.idempotency_key) headers['idempotency-key'] = body.idempotency_key;
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers,
      payload: {
        invoice: {
          external_customer_id: body.external_customer_id,
          currency: body.currency || 'MXN',
          fees,
          metadata: body.idempotency_key ? { idempotency_key: body.idempotency_key } : {},
        },
      },
    });
    if (result.statusCode !== 200) {
      setFlash(reply, 'error', `Invoice rechazada: ${result.body.slice(0, 240)}`);
      return reply.redirect('/admin/invoices/new');
    }
    const invoiceId = (result.json() as { invoice: { lago_id: string } }).invoice.lago_id;
    setFlash(reply, 'success', `Invoice creada · dispatch: ver detalle`);
    reply.redirect(`/admin/invoices/${invoiceId}`);
  });

  app.get('/admin/invoices/:lagoId', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { lagoId } = request.params as { lagoId: string };
    const invoice = await prisma.invoice.findUnique({
      where: { id: lagoId },
      include: {
        customer: { include: { organization: true, taxLinks: { include: { tax: true } } } },
        fees: { orderBy: { position: 'asc' } },
        appliedTaxes: true,
        creditNotes: true,
      },
    });
    if (!invoice || invoice.organizationId !== org.id) {
      reply.status(404).type('text/html').send(layout({
        title: 'Not Found', orgSlug: org.slug,
        body: pageHeader('Not found') + '<p>Invoice no existe.</p>',
      }));
      return;
    }

    const info = kv([
      ['Lago ID', `<code>${escapeHtml(invoice.id)}</code>`],
      ['Sequential ID', String(invoice.sequentialId)],
      ['Number (folio)', invoice.number ? `<code>${escapeHtml(invoice.number)}</code>` : '<span class="text-gray-400">— (sin folio NetSuite)</span>'],
      ['Customer', `<a class="text-indigo-700 underline" href="/admin/customers/${escapeHtml(invoice.customer.externalId)}">${escapeHtml(invoice.customer.externalId)}</a>`],
      ['Status', statusBadge(invoice.status)],
      ['External dispatch', statusBadge(invoice.externalDispatchStatus)],
      ['Payment status', statusBadge(invoice.paymentStatus)],
      ['Invoice type', escapeHtml(invoice.invoiceType)],
      ['Currency', escapeHtml(invoice.currency)],
      ['Fees amount', fmtMoney(invoice.feesAmountCents, invoice.currency)],
      ['Taxes amount', fmtMoney(invoice.taxesAmountCents, invoice.currency)],
      ['Total amount', `<b>${fmtMoney(invoice.totalAmountCents, invoice.currency)}</b>`],
      ['Issued', fmtDateOnly(invoice.issuingDate)],
      ['Due', fmtDateOnly(invoice.paymentDueDate)],
      ['Idempotency key', invoice.idempotencyKey ? `<code class="text-xs">${escapeHtml(invoice.idempotencyKey)}</code>` : '—'],
      ['Dispatch ID', invoice.netsuiteDispatchId ? `<code class="text-xs">${escapeHtml(invoice.netsuiteDispatchId)}</code>` : '—'],
      ['External error', invoice.externalDispatchError ? `<span class="text-red-700">${escapeHtml(invoice.externalDispatchError)}</span>` : '—'],
    ]);

    const feesBlock = table({
      rows: invoice.fees,
      columns: [
        { label: 'Item', render: (f) => `<div><code>${escapeHtml(f.itemCode)}</code></div><div class="text-xs text-gray-500">${escapeHtml(f.itemName)}</div>` },
        { label: 'Units', render: (f) => `<code>${escapeHtml(f.units)}</code>` },
        { label: 'Unit', render: (f) => `$${escapeHtml(f.preciseUnitAmount)}` },
        { label: 'Amount', render: (f) => fmtMoney(f.amountCents, f.amountCurrency) },
        { label: 'Taxes', render: (f) => fmtMoney(f.taxesAmountCents, f.amountCurrency) },
        { label: 'Total', render: (f) => fmtMoney(f.totalAmountCents, f.amountCurrency) },
        { label: 'Detail', render: (f) => `<details><summary class="cursor-pointer text-indigo-700">${(f.billedUnitsDetail as unknown[]).length} unidades</summary>${code(f.billedUnitsDetail)}</details>` },
      ],
    });

    const externalInvoice = invoice.externalInvoiceFolio ? code({
      folio: invoice.externalInvoiceFolio,
      uuid_cfdi: invoice.externalInvoiceUuidCfdi,
      system: invoice.externalInvoiceSystem,
      netsuite_internal_id: invoice.externalInvoiceNetsuiteInternalId,
      pdf_url: invoice.externalInvoicePdfUrl,
      xml_url: invoice.externalInvoiceXmlUrl,
      issued_at: invoice.externalInvoiceIssuedAt,
      confirmed_at: invoice.externalInvoiceConfirmedAt,
    }) : '<span class="text-gray-500">No confirmada (sin folio fiscal aún)</span>';

    // Action buttons.
    const canVoid = invoice.status !== 'voided';
    const canConfirm = invoice.externalDispatchStatus !== 'confirmed';
    const folioField = `
      <form method="post" action="/admin/invoices/${invoice.id}/simulate-confirm" class="flex gap-2 items-end">
        <label class="block flex-1"><span class="text-xs text-gray-600">Folio fiscal</span>
          <input required name="folio" value="A-2026-${String(invoice.sequentialId).padStart(6, '0')}" class="block w-full rounded border-gray-300 font-mono text-sm">
        </label>
        <label class="block flex-1"><span class="text-xs text-gray-600">UUID CFDI</span>
          <input name="uuid_cfdi" value="00000000-0000-0000-0000-${String(invoice.sequentialId).padStart(12, '0')}" class="block w-full rounded border-gray-300 font-mono text-sm">
        </label>
        <button class="px-3 py-1.5 rounded bg-indigo-600 text-white text-sm" ${canConfirm ? '' : 'disabled'}>Simular folio NetSuite</button>
      </form>
    `;
    const actions = `<div class="space-y-3">
      ${canVoid ? postButton(`/admin/invoices/${invoice.id}/void`, 'Void invoice', 'danger', `¿Anular invoice ${invoice.sequentialId}?`) : '<span class="text-gray-400">voided</span>'}
      <div>${folioField}</div>
    </div>`;

    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: `Invoice #${invoice.sequentialId}`,
      active: '/admin/invoices',
      orgSlug: org.slug,
      flash,
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

  app.post('/admin/invoices/:lagoId/void', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { lagoId } = request.params as { lagoId: string };
    const result = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${lagoId}/void`,
      headers: { authorization: `Bearer ${org.apiKey}` },
    });
    if (result.statusCode !== 200) {
      setFlash(reply, 'error', `Void rechazado: ${result.body.slice(0, 240)}`);
    } else {
      setFlash(reply, 'success', 'Invoice voided');
    }
    reply.redirect(`/admin/invoices/${lagoId}`);
  });

  app.post('/admin/invoices/:lagoId/simulate-confirm', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { lagoId } = request.params as { lagoId: string };
    const body = request.body as Record<string, string>;
    if (!org.netsuiteCallbackSecret) {
      setFlash(reply, 'error', 'La organización no tiene netsuite_callback_secret configurado (D12 fail-closed)');
      return reply.redirect(`/admin/invoices/${lagoId}`);
    }
    const payload = JSON.stringify({
      external_invoice: {
        folio: body.folio,
        uuid_cfdi: body.uuid_cfdi || null,
        system: 'netsuite',
        netsuite_internal_id: `rec-sim-${Math.random().toString(36).slice(2, 10)}`,
        pdf_url: null,
        xml_url: null,
        issued_at: new Date().toISOString(),
        due_date: null,
        payment_status: 'pending',
        total_amount_cents: 0,
        currency: 'MXN',
      },
    });
    const signature = buildSignatureHeader(org.netsuiteCallbackSecret, payload);
    const result = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${lagoId}/external-confirm`,
      headers: { 'content-type': 'application/json', 'x-netsuite-signature': signature },
      payload,
    });
    if (result.statusCode !== 200) {
      setFlash(reply, 'error', `Confirm rechazado: ${result.body.slice(0, 240)}`);
    } else {
      setFlash(reply, 'success', `Invoice confirmada con folio ${body.folio}`);
    }
    reply.redirect(`/admin/invoices/${lagoId}`);
  });

  // ------------------------------------------------------------------
  // Credit notes.
  // ------------------------------------------------------------------
  app.get('/admin/credit-notes', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const cns = await prisma.creditNote.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: 'desc' },
      include: { customer: true, invoice: true },
    });
    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: 'Credit notes',
      active: '/admin/credit-notes',
      orgSlug: org.slug,
      flash,
      body: pageHeader('Credit notes')
        + table({
          rows: cns,
          empty: 'Sin credit notes',
          rowHref: (cn) => `/admin/credit-notes/${cn.id}`,
          columns: [
            { label: 'Number', render: (cn) => cn.number ? `<code>${escapeHtml(cn.number)}</code>` : '<span class="text-gray-400">—</span>' },
            { label: 'Invoice', render: (cn) => cn.invoice.number ? `<code>${escapeHtml(cn.invoice.number)}</code>` : `<code class="text-xs">${escapeHtml(cn.invoiceId)}</code>` },
            { label: 'Customer', render: (cn) => escapeHtml(cn.customer.externalId) },
            { label: 'Status', render: (cn) => statusBadge(cn.status) },
            { label: 'Dispatch', render: (cn) => statusBadge(cn.externalDispatchStatus) },
            { label: 'Total', render: (cn) => fmtMoney(cn.totalAmountCents, cn.currency) },
            { label: 'Reason', render: (cn) => escapeHtml(cn.reason) },
          ],
        }),
    }));
  });

  app.get('/admin/credit-notes/:lagoId', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { lagoId } = request.params as { lagoId: string };
    const cn = await prisma.creditNote.findUnique({
      where: { id: lagoId },
      include: {
        customer: true,
        invoice: true,
        items: { include: { fee: true } },
        appliedTaxes: true,
      },
    });
    if (!cn || cn.organizationId !== org.id) {
      reply.status(404).type('text/html').send(layout({
        title: 'Not Found', orgSlug: org.slug,
        body: pageHeader('Not found') + '<p>Credit note no existe.</p>',
      }));
      return;
    }
    const info = kv([
      ['Lago ID', `<code>${escapeHtml(cn.id)}</code>`],
      ['Number (folio)', cn.number ? `<code>${escapeHtml(cn.number)}</code>` : '—'],
      ['Invoice', `<a class="text-indigo-700 underline" href="/admin/invoices/${cn.invoiceId}">${cn.invoice.number ?? cn.invoiceId}</a>`],
      ['Customer', `<a class="text-indigo-700 underline" href="/admin/customers/${escapeHtml(cn.customer.externalId)}">${escapeHtml(cn.customer.externalId)}</a>`],
      ['Status', statusBadge(cn.status)],
      ['Dispatch', statusBadge(cn.externalDispatchStatus)],
      ['Credit status', statusBadge(cn.creditStatus)],
      ['Reason', escapeHtml(cn.reason)],
      ['Description', `<span class="font-sans">${escapeHtml(cn.description ?? '—')}</span>`],
      ['Idem marker', cn.idempotencyMarker ? `<code class="text-xs">${escapeHtml(cn.idempotencyMarker)}</code>` : '—'],
      ['Sub total ex. tax', fmtMoney(cn.subTotalExcludingTaxesAmountCents, cn.currency)],
      ['Taxes', fmtMoney(cn.taxesAmountCents, cn.currency)],
      ['Total', `<b>${fmtMoney(cn.totalAmountCents, cn.currency)}</b>`],
      ['Issued', fmtDateOnly(cn.issuingDate)],
    ]);
    const itemsBlock = table({
      rows: cn.items,
      columns: [
        { label: 'Fee', render: (it) => `<code class="text-xs">${escapeHtml(it.feeId)}</code><div class="text-xs text-gray-500">${escapeHtml(it.fee.itemCode)}</div>` },
        { label: 'Amount', render: (it) => fmtMoney(it.amountCents, it.amountCurrency) },
      ],
    });
    const externalCn = cn.externalCreditNoteFolio ? code({
      folio: cn.externalCreditNoteFolio,
      uuid_cfdi: cn.externalCreditNoteUuidCfdi,
      system: cn.externalCreditNoteSystem,
      issued_at: cn.externalCreditNoteIssuedAt,
      confirmed_at: cn.externalCreditNoteConfirmedAt,
    }) : '<span class="text-gray-500">No confirmada (sin folio fiscal aún)</span>';

    const canConfirm = cn.externalDispatchStatus !== 'confirmed';
    const confirmForm = `
      <form method="post" action="/admin/credit-notes/${cn.id}/simulate-confirm" class="flex gap-2 items-end">
        <label class="block flex-1"><span class="text-xs text-gray-600">Folio fiscal CN</span>
          <input required name="folio" value="B-2026-${String(cn.sequentialId).padStart(6, '0')}" class="block w-full rounded border-gray-300 font-mono text-sm">
        </label>
        <label class="block flex-1"><span class="text-xs text-gray-600">UUID CFDI</span>
          <input name="uuid_cfdi" value="00000000-0000-0000-0000-${String(cn.sequentialId).padStart(12, '0')}" class="block w-full rounded border-gray-300 font-mono text-sm">
        </label>
        <button class="px-3 py-1.5 rounded bg-indigo-600 text-white text-sm" ${canConfirm ? '' : 'disabled'}>Simular folio NetSuite</button>
      </form>
    `;

    const flash = readFlash(request, reply);
    reply.type('text/html').send(layout({
      title: `Credit note · ${cn.number ?? cn.id}`,
      active: '/admin/credit-notes',
      orgSlug: org.slug,
      flash,
      body: pageHeader(`Credit note #${cn.sequentialId}`, btn('/admin/credit-notes', '← back'))
        + card('Identidad', info)
        + card('Acciones', confirmForm)
        + card('Items', itemsBlock)
        + card('Applied taxes', code(cn.appliedTaxes))
        + card('External credit note', externalCn),
    }));
  });

  app.post('/admin/credit-notes/:lagoId/simulate-confirm', async (request, reply) => {
    const org = await getOrg(prisma);
    if (!org) return reply.redirect('/admin');
    const { lagoId } = request.params as { lagoId: string };
    const body = request.body as Record<string, string>;
    if (!org.netsuiteCallbackSecret) {
      setFlash(reply, 'error', 'Sin netsuite_callback_secret configurado');
      return reply.redirect(`/admin/credit-notes/${lagoId}`);
    }
    const payload = JSON.stringify({
      external_credit_note: {
        folio: body.folio,
        uuid_cfdi: body.uuid_cfdi || null,
        system: 'netsuite',
        netsuite_internal_id: `rec-sim-${Math.random().toString(36).slice(2, 10)}`,
        pdf_url: null,
        xml_url: null,
        issued_at: new Date().toISOString(),
      },
    });
    const signature = buildSignatureHeader(org.netsuiteCallbackSecret, payload);
    const result = await app.inject({
      method: 'POST',
      url: `/api/v1/credit_notes/${lagoId}/external-confirm`,
      headers: { 'content-type': 'application/json', 'x-netsuite-signature': signature },
      payload,
    });
    if (result.statusCode !== 200) {
      setFlash(reply, 'error', `Confirm rechazado: ${result.body.slice(0, 240)}`);
    } else {
      setFlash(reply, 'success', `CN confirmada con folio ${body.folio}`);
    }
    reply.redirect(`/admin/credit-notes/${lagoId}`);
  });
}

function counter(label: string, value: string | number, href?: string): string {
  const inner = `<div class="text-xs uppercase text-gray-500 tracking-wider">${escapeHtml(label)}</div>
    <div class="text-2xl font-semibold mt-1">${escapeHtml(value)}</div>`;
  if (href) {
    return `<a href="${href}" class="block bg-white border rounded p-4 hover:shadow">${inner}</a>`;
  }
  return `<div class="bg-white border rounded p-4">${inner}</div>`;
}
