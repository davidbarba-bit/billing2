// Detalle del customer rediseñado en tabs. Esconde toda la plomería
// técnica (IDs, idempotency, raw fields) detrás del toggle "Modo técnico"
// y deja al frente sólo lo accionable: estado del cliente, próximo cierre,
// acciones rápidas y los datos críticos del periodo en curso.

import type {
  Customer,
  CustomerAddOn,
  CreditNote,
  EventLog,
  Invoice,
  Organization,
  Service,
  Unit,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { adminContextStorage } from './context.js';
import {
  badge,
  btn,
  card,
  escapeHtml,
  fmtDate,
  fmtDateOnly,
  fmtMoney,
  fmtRelative,
  kv,
  pageHeader,
  postButton,
  statusBadge,
  table,
  tabs,
  techOnly,
} from './views.js';

type CustomerWithRelations = Customer & {
  services: (Service & { units?: Unit[] })[];
  addOns: CustomerAddOn[];
  invoices: Invoice[];
  creditNotes: CreditNote[];
};

export const CUSTOMER_TABS = [
  'resumen',
  'plan',
  'unidades',
  'addons',
  'facturas',
  'eventos',
  'datos',
] as const;

export type CustomerTab = (typeof CUSTOMER_TABS)[number];

export function isCustomerTab(value: string | undefined): value is CustomerTab {
  return typeof value === 'string' && (CUSTOMER_TABS as readonly string[]).includes(value);
}

// Datos derivados que se calculan en el handler y se pasan a render.
type DerivedMetrics = {
  // Renta mensual recurrente del customer (units activas con billing
  // iniciado × monthly + service add-ons + customer add-ons).
  mrrCents: number;
  // Suma de fees de invoices NO-voided emitidas en el mes en curso.
  mtdCents: number;
  // Conteo de invoices del customer con dispatch fallido a NetSuite.
  dispatchFailedCount: number;
  // Próxima fecha de cierre (de currentBillingPeriodEndingAt o calculada).
  nextCloseAt: Date | null;
};

export function computeCustomerMetrics(args: {
  customer: CustomerWithRelations;
  tz: string;
}): DerivedMetrics {
  const { customer, tz } = args;
  const now = new Date();

  let mrr = 0;
  for (const svc of customer.services) {
    if (svc.status !== 'active') continue;
    if (svc.pricingModel !== 'recurring') continue;
    const units = svc.units ?? [];
    const activeBillingUnits = units.filter((u) => {
      if (u.activeTo !== null) return false;
      const start = u.billingStartsAt ?? u.activeFrom;
      return start <= now;
    }).length;
    mrr += activeBillingUnits * svc.monthlyUnitAmountCents;
  }
  for (const ao of customer.addOns) {
    if (ao.activeTo === null) mrr += ao.amountCents;
  }

  const monthStart = DateTime.now().setZone(tz).startOf('month').toUTC().toJSDate();
  const monthEnd = DateTime.now().setZone(tz).endOf('month').toUTC().toJSDate();
  const mtd = customer.invoices
    .filter((i) => i.status !== 'voided')
    .filter((i) => i.issuingDate >= monthStart && i.issuingDate <= monthEnd)
    .reduce((sum, i) => sum + i.feesAmountCents, 0);

  const dispatchFailedCount = customer.invoices
    .filter((i) => i.externalDispatchStatus === 'failed')
    .length;

  return {
    mrrCents: mrr,
    mtdCents: mtd,
    dispatchFailedCount,
    nextCloseAt: customer.currentBillingPeriodEndingAt,
  };
}

// Header reusable para todos los tabs.
function renderHeader(customer: CustomerWithRelations, metrics: DerivedMetrics): string {
  // `customer.status` refleja el momento en el ciclo de vida de la
  // suscripción, no el avance del onboarding operativo:
  //   - pending    → subscription_at todavía en el futuro (un cron lo
  //                  activa automáticamente al llegar la fecha).
  //   - active     → suscripción en curso.
  //   - terminated → baja definitiva.
  const stateBadge = (() => {
    if (customer.status === 'pending') return badge('programado', 'blue');
    if (customer.status === 'terminated') return badge('terminado', 'gray');
    return badge('activo', 'green');
  })();

  const activeServiceCount = customer.services.filter((s) => s.status === 'active').length;

  const alerts: string[] = [];
  if (metrics.dispatchFailedCount > 0) {
    alerts.push(`<span class="text-red-700">${metrics.dispatchFailedCount} factura${metrics.dispatchFailedCount === 1 ? '' : 's'} con dispatch fallido</span>`);
  }
  // Aviso real de onboarding: customer activo pero sin services activos.
  // El status='pending' por sí solo no implica falta de onboarding.
  if (customer.status === 'active' && activeServiceCount === 0) {
    alerts.push(`<span class="text-amber-700">Sin plan activo — completar onboarding</span>`);
  }
  if (customer.status === 'pending') {
    alerts.push(`<span class="text-blue-700">Inicia ${fmtDateOnly(customer.subscriptionAt)}</span>`);
  }

  const alertHtml = alerts.length > 0
    ? `<div class="text-xs mt-1">${alerts.join(' · ')}</div>`
    : '';

  return `<div class="flex items-start justify-between mb-6">
    <div>
      <h1 class="text-2xl font-bold">${escapeHtml(customer.name)}</h1>
      <div class="flex items-center gap-2 mt-1.5 text-sm text-gray-600">
        ${stateBadge}
        ${customer.email ? `<span>${escapeHtml(customer.email)}</span>` : ''}
        ${techOnly(`<code class="text-xs text-gray-500">${escapeHtml(customer.externalId)}</code>`)}
      </div>
      ${alertHtml}
    </div>
    <div>${btn('/admin/customers', '← Clientes')}</div>
  </div>`;
}

function renderTabsNav(externalId: string, active: CustomerTab, counts: {
  services: number;
  units: number;
  addOns: number;
  invoices: number;
  creditNotes: number;
}): string {
  return tabs({
    baseHref: `/admin/customers/${encodeURIComponent(externalId)}`,
    active,
    items: [
      { key: 'resumen', label: 'Resumen' },
      { key: 'plan', label: 'Plan & calendario', count: counts.services },
      { key: 'unidades', label: 'Unidades', count: counts.units },
      { key: 'addons', label: 'Add-ons', count: counts.addOns },
      { key: 'facturas', label: 'Facturas', count: counts.invoices + counts.creditNotes },
      { key: 'eventos', label: 'Eventos' },
      { key: 'datos', label: 'Datos fiscales' },
    ],
  });
}

// --- Tab: Resumen ---------------------------------------------------------

function renderResumen(customer: CustomerWithRelations, metrics: DerivedMetrics): string {
  // Card de cifras clave del customer.
  const statsRow = `
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      <div class="bg-white border rounded p-4">
        <div class="text-xs uppercase text-gray-500 font-semibold">Renta mensual</div>
        <div class="text-xl font-semibold mt-1">${fmtMoney(metrics.mrrCents, customer.currency)}</div>
        <div class="text-xs text-gray-500 mt-1">Equivalente mensual de units activas + add-ons</div>
      </div>
      <div class="bg-white border rounded p-4">
        <div class="text-xs uppercase text-gray-500 font-semibold">Facturado este mes</div>
        <div class="text-xl font-semibold mt-1">${fmtMoney(metrics.mtdCents, customer.currency)}</div>
        <div class="text-xs text-gray-500 mt-1">Suma de facturas emitidas en mes en curso</div>
      </div>
      <div class="bg-white border rounded p-4">
        <div class="text-xs uppercase text-gray-500 font-semibold">Próximo cierre</div>
        <div class="text-xl font-semibold mt-1">
          ${metrics.nextCloseAt ? fmtDateOnly(metrics.nextCloseAt) : '<span class="text-gray-400">—</span>'}
        </div>
        <div class="text-xs text-gray-500 mt-1">
          ${metrics.nextCloseAt ? fmtRelative(metrics.nextCloseAt) : 'Aún no calculado'}
        </div>
      </div>
    </div>
  `;

  // Acciones rápidas. Hay tres ramas según el estado real del customer:
  //   - terminated   → ninguna acción posible.
  //   - status=pending (subscription_at futuro) → puedes configurar plan,
  //                    units, datos, pero no facturar todavía. Banner azul
  //                    informativo, sin urgencia.
  //   - activo SIN services activos → onboarding real incompleto. Banner
  //                    amber con la guía.
  //   - activo con plan → acciones de facturación normales.
  const activeServiceCount = customer.services.filter((s) => s.status === 'active').length;
  const actions = (() => {
    if (customer.status === 'terminated') {
      return `<div class="text-sm text-gray-500 italic">Customer terminado — sin acciones disponibles.</div>`;
    }
    if (customer.status === 'pending') {
      return `
        <div class="rounded border border-blue-300 bg-blue-50 p-4">
          <div class="text-sm font-semibold text-blue-900">Suscripción programada para ${fmtDateOnly(customer.subscriptionAt)}</div>
          <p class="text-sm text-blue-800 mt-1">
            La suscripción aún no inicia. Se activa automáticamente cuando llegue la fecha
            (un proceso periódico la levanta sin intervención manual).
            Mientras tanto puedes configurar planes, unidades y datos fiscales.
          </p>
          <p class="text-xs text-blue-700 mt-2">
            Las acciones de facturación (vista previa, emisión) se habilitarán cuando inicie.
          </p>
        </div>
      `;
    }
    if (activeServiceCount === 0) {
      return `
        <div class="rounded border border-amber-300 bg-amber-50 p-4">
          <div class="text-sm font-semibold text-amber-900">Onboarding incompleto: este cliente no tiene plan activo</div>
          <p class="text-sm text-amber-800 mt-1">
            La suscripción ya inició pero no hay servicios activos. Sin plan no se puede facturar.
          </p>
          <ol class="text-sm text-amber-800 mt-2 list-decimal list-inside space-y-1">
            <li>Crea al menos un servicio con unidades.</li>
            <li>Opcional: agrega add-ons o configura datos fiscales.</li>
          </ol>
          <div class="mt-3">
            <a href="/admin/services/new?customer=${escapeHtml(customer.externalId)}" class="inline-flex items-center px-4 py-2 bg-amber-600 text-white rounded text-sm font-medium hover:bg-amber-700">+ Crear primer plan</a>
          </div>
        </div>
      `;
    }
    return `
      <div class="flex flex-wrap gap-2">
        <a href="/admin/customers/${escapeHtml(customer.externalId)}/preview" class="px-4 py-2 rounded bg-white text-gray-700 border text-sm font-medium hover:bg-gray-50 inline-flex items-center">Vista previa del periodo</a>
        <form method="post" action="/admin/customers/${escapeHtml(customer.externalId)}/invoice" class="inline" onsubmit="return confirm('¿Calcular factura del periodo en curso? Esta acción crea una factura y no se puede deshacer.')">
          <button type="submit" class="px-4 py-2 rounded bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">Calcular factura del periodo</button>
        </form>
      </div>
      <div class="text-xs text-gray-500 mt-2">La factura se calcula sobre el periodo en curso (${metrics.nextCloseAt ? `cierra ${fmtDateOnly(metrics.nextCloseAt)}` : 'sin cierre calculado'}).</div>
    `;
  })();

  // Últimas 3 invoices.
  const recentInvoices = customer.invoices.slice(0, 3);
  const recentInvoicesHtml = recentInvoices.length === 0
    ? `<div class="text-sm text-gray-500 italic py-2">Sin facturas todavía.</div>`
    : `
      <ul class="divide-y -my-2">
        ${recentInvoices.map((inv) => `
          <li class="py-2 flex items-center justify-between text-sm">
            <a href="/admin/invoices/${inv.id}" class="text-indigo-700 hover:underline">
              ${inv.number ? `<code>${escapeHtml(inv.number)}</code>` : `#${inv.sequentialId}`}
            </a>
            <span class="text-gray-500">${fmtDateOnly(inv.issuingDate)}</span>
            <span class="ml-auto font-mono">${fmtMoney(inv.feesAmountCents, inv.currency)}</span>
            <span class="ml-3">${statusBadge(inv.status)}</span>
            <span class="ml-1">${statusBadge(inv.externalDispatchStatus)}</span>
          </li>
        `).join('')}
      </ul>
    `;

  return statsRow
    + card('Acciones', actions)
    + card(`Últimas facturas (${customer.invoices.length} total)`, recentInvoicesHtml,
        customer.invoices.length > 3 ? `<a href="/admin/customers/${escapeHtml(customer.externalId)}?tab=facturas" class="text-sm text-indigo-700 hover:underline">Ver todas →</a>` : undefined);
}

// --- Tab: Plan & calendario -----------------------------------------------

function renderPlan(customer: CustomerWithRelations): string {
  const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  const periodLabel = customer.billingPeriodMonths === 1
    ? 'Mensual'
    : customer.billingPeriodMonths === 3
    ? 'Trimestral'
    : customer.billingPeriodMonths === 6
    ? 'Semestral'
    : 'Anual';

  const scheduleSummary = `
    <div class="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
      <div><span class="text-gray-500">Frecuencia:</span> <strong>${periodLabel}</strong></div>
      <div><span class="text-gray-500">Día de corte:</span> <strong>día ${customer.billingAnchorDay} del mes</strong></div>
      <div class="col-span-2"><span class="text-gray-500">Periodo en curso:</span>
        ${customer.currentBillingPeriodStartedAt
          ? `<strong>${fmtDateOnly(customer.currentBillingPeriodStartedAt)} → ${fmtDateOnly(customer.currentBillingPeriodEndingAt)}</strong>`
          : '<span class="text-gray-400">(aún no calculado)</span>'}
      </div>
      ${customer.billingPeriodMonths > 1 ? `
      <div><span class="text-gray-500">Mes ancla:</span> <strong>${customer.billingAnchorMonth ? monthNames[customer.billingAnchorMonth - 1] : '(según subscription_at)'}</strong></div>
      ` : ''}
      <div><span class="text-gray-500">Cobro no-recurrente:</span>
        <strong>${customer.nonrecurringTrigger === 'immediate' ? 'inmediato (factura individual)' : 'al próximo cierre'}</strong>
      </div>
      <div class="col-span-2"><span class="text-gray-500">Modo de factura:</span>
        <strong>${customer.cycleInvoiceMode === 'split_by_kind' ? 'split — recurrentes y únicos en facturas separadas' : 'unificada — todo en una factura'}</strong>
      </div>
    </div>
  `;

  // Schedule edit form — sigue siendo el form rico que ya existía,
  // accesible vía detalles plegados para no abrumar.
  const scheduleEdit = renderScheduleEditForm(customer);

  const services = customer.services;
  const servicesTable = table({
    rows: services,
    empty: 'Sin planes/services asignados',
    rowHref: (s) => `/admin/services/${s.code}`,
    columns: [
      { label: 'Nombre', render: (s) => escapeHtml(s.name) },
      { label: 'Tipo', render: (s) => s.pricingModel === 'one_off' ? badge('one-off', 'blue') : badge('recurrente', 'green') },
      { label: 'Status', render: (s) => statusBadge(s.status) },
      { label: 'Renta /unidad', render: (s) => `${fmtMoney(s.monthlyUnitAmountCents, s.currency)} /u` },
      { label: 'Setup /unidad', render: (s) => s.setupUnitAmountCents > 0 ? `${fmtMoney(s.setupUnitAmountCents, s.currency)} /u` : '<span class="text-gray-400">—</span>' },
      { label: 'Cambio de precio', render: (s) => s.pendingEffectiveFrom ? badge(`programado ${fmtDateOnly(s.pendingEffectiveFrom)}`, 'yellow') : '<span class="text-gray-400 text-xs">—</span>' },
    ],
  });

  return card('Calendario de facturación', scheduleSummary)
    + card('Editar calendario', scheduleEdit)
    + card(`Planes (${services.length})`, servicesTable,
        btn(`/admin/services/new?customer=${customer.externalId}`, '+ Nuevo plan', 'primary'));
}

function renderScheduleEditForm(customer: CustomerWithRelations): string {
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
  const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  const periodOptions = [1, 3, 6, 12].map((n) =>
    `<option value="${n}" ${n === customer.billingPeriodMonths ? 'selected' : ''}>${n} mes${n === 1 ? '' : 'es'}</option>`).join('');
  const triggerOptions = [
    `<option value="next_cycle" ${customer.nonrecurringTrigger === 'next_cycle' ? 'selected' : ''}>Al próximo cierre (acumular y cobrar al cerrar el periodo)</option>`,
    `<option value="immediate" ${customer.nonrecurringTrigger === 'immediate' ? 'selected' : ''}>Inmediato (factura individual al recibir el evento)</option>`,
  ].join('');
  const cycleModeOptions = [
    `<option value="unified" ${customer.cycleInvoiceMode === 'unified' ? 'selected' : ''}>1 factura — renta + setup + baja en un solo documento</option>`,
    `<option value="split_by_kind" ${customer.cycleInvoiceMode === 'split_by_kind' ? 'selected' : ''}>2 facturas — recurrentes (renta + add-ons) y únicos (setup + baja) separados</option>`,
  ].join('');
  const anchorMonthOptions = ['<option value="">— (anclado a subscription_at)</option>']
    .concat(monthNames.map((name, i) => {
      const n = i + 1;
      return `<option value="${n}" ${n === customer.billingAnchorMonth ? 'selected' : ''}>${n} — ${name}</option>`;
    }))
    .join('');

  const banner = terminated
    ? `<div class="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900 mb-3">Customer <code>terminated</code> — schedule no editable.</div>`
    : blocked
    ? `<div class="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 mb-3"><strong>${nonVoidedInvoices} invoice${nonVoidedInvoices === 1 ? '' : 's'} no-voided bloque${nonVoidedInvoices === 1 ? 'a' : 'an'} cambios a <code>subscription_at</code>, <code>anchor_day</code>, <code>period_months</code> y <code>anchor_month</code>.</strong> Voidálas primero. El campo <code>nonrecurring_trigger</code> sí se puede editar.</div>`
    : '';
  const disabledHard = blocked || terminated ? 'disabled' : '';
  const disabledSoft = terminated ? 'disabled' : '';

  return `
    ${banner}
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
        <label class="block"><span class="text-sm text-gray-700">Anchor month <span class="text-xs text-gray-500">(solo trimestral/semestral/anual)</span></span>
          <select ${disabledHard} name="billing_anchor_month" class="mt-1 block w-full rounded border-gray-300 text-sm ${disabledHard ? 'bg-gray-100' : ''}">${anchorMonthOptions}</select>
          <span class="text-xs text-gray-500">Define en qué mes calendario inicia un ciclo.</span>
        </label>
        <label class="block col-span-2"><span class="text-sm text-gray-700">Trigger no-recurrente</span>
          <select ${disabledSoft} name="nonrecurring_trigger" class="mt-1 block w-full rounded border-gray-300 text-sm ${disabledSoft ? 'bg-gray-100' : ''}">${triggerOptions}</select>
        </label>
        <label class="block col-span-2"><span class="text-sm text-gray-700">Modo cycle invoice</span>
          <select ${disabledSoft} name="cycle_invoice_mode" class="mt-1 block w-full rounded border-gray-300 text-sm ${disabledSoft ? 'bg-gray-100' : ''}">${cycleModeOptions}</select>
        </label>
      </div>
      ${terminated ? '' : `<button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded text-sm">Actualizar calendario</button>`}
    </form>
  `;
}

// --- Tab: Unidades --------------------------------------------------------

function renderUnidades(customer: CustomerWithRelations): string {
  type UnitRow = Unit & { serviceCode: string; serviceName: string; pricingModel: string; setupAmount: number };

  const rows: UnitRow[] = [];
  for (const svc of customer.services) {
    for (const u of (svc.units ?? [])) {
      rows.push({
        ...u,
        serviceCode: svc.code,
        serviceName: svc.name,
        pricingModel: svc.pricingModel,
        setupAmount: svc.setupUnitAmountCents,
      });
    }
  }

  if (rows.length === 0) {
    return `<div class="bg-white border rounded p-8 text-center text-gray-500">
      Este cliente todavía no tiene unidades. Las unidades se crean dentro de cada plan.
    </div>`;
  }

  rows.sort((a, b) => {
    if (a.activeTo === null && b.activeTo !== null) return -1;
    if (a.activeTo !== null && b.activeTo === null) return 1;
    return b.activeFrom.getTime() - a.activeFrom.getTime();
  });

  return table({
    rows,
    empty: 'Sin unidades',
    columns: [
      { label: 'Identificador', render: (u) => `<code>${escapeHtml(u.externalId)}</code>${u.label ? `<div class="text-xs text-gray-500">${escapeHtml(u.label)}</div>` : ''}` },
      { label: 'Plan', render: (u) => `<a class="text-indigo-700 underline" href="/admin/services/${escapeHtml(u.serviceCode)}">${escapeHtml(u.serviceName)}</a>` },
      { label: 'Status', render: (u) => statusBadge(u.activeTo === null ? 'active' : 'terminated') },
      { label: 'Activa desde', render: (u) => fmtDateOnly(u.activeFrom) },
      { label: 'Activa hasta', render: (u) => fmtDateOnly(u.activeTo) },
      { label: 'Facturación inicial', render: (u) => {
        const isOneOff = u.pricingModel === 'one_off';
        const billedAt = isOneOff ? u.oneoffBilledAt : u.setupBilledAt;
        if (!isOneOff && u.setupAmount === 0) {
          return '<span class="text-gray-400 text-xs">sin setup</span>';
        }
        return billedAt
          ? badge(isOneOff ? 'pagada' : 'setup pagado', 'green')
          : badge('pendiente', 'yellow');
      } },
      { label: '', render: (u) => `<a class="text-indigo-700 hover:underline text-xs" href="/admin/units/${u.id}/edit">editar</a>` },
    ],
  });
}

// --- Tab: Add-ons ---------------------------------------------------------

function renderAddons(customer: CustomerWithRelations): string {
  const tableHtml = table({
    rows: customer.addOns,
    empty: 'Sin add-ons flat',
    columns: [
      { label: 'Code', render: (a) => `<code>${escapeHtml(a.code)}</code>` },
      { label: 'Nombre', render: (a) => escapeHtml(a.name) },
      { label: 'Monto /mes', render: (a) => `${fmtMoney(a.amountCents, customer.currency)} flat/mes` },
      { label: 'Status', render: (a) => statusBadge(a.activeTo === null ? 'active' : 'terminated') },
      { label: 'Vigente desde', render: (a) => fmtDateOnly(a.activeFrom) },
      { label: 'Vigente hasta', render: (a) => fmtDateOnly(a.activeTo) },
      { label: '', render: (a) => a.activeTo === null
        ? postButton(`/admin/customer-add-ons/${a.id}/terminate`, 'Terminar', 'danger', `¿Terminar add-on ${a.code}?`)
        : '<span class="text-gray-400 text-xs">terminado</span>' },
    ],
  });

  const form = `
    <details>
      <summary class="cursor-pointer text-indigo-700 font-medium">+ Agregar add-on flat</summary>
      <form method="post" action="/admin/customers/${escapeHtml(customer.externalId)}/add-ons" class="mt-3 space-y-3 max-w-2xl">
        <p class="text-xs text-gray-500">Cargos flat independientes de unidades o servicios (ej. "10 reglas de evento +$1,000/mes").</p>
        <div class="grid grid-cols-2 gap-3">
          <label class="block"><span class="text-sm text-gray-700">Code</span>
            <input required name="code" placeholder="reglas-10" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
          </label>
          <label class="block"><span class="text-sm text-gray-700">Nombre</span>
            <input required name="name" placeholder="Reglas de evento 5→10" class="mt-1 block w-full rounded border-gray-300 text-sm">
          </label>
          <label class="block"><span class="text-sm text-gray-700">Monto flat (cents) /mes</span>
            <input required type="number" name="amount_cents" min="0" value="100000" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
          </label>
          <label class="block"><span class="text-sm text-gray-700">NetSuite item code</span>
            <input name="netsuite_item_code" placeholder="ADDON-FLAT" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
          </label>
          <label class="block col-span-2"><span class="text-sm text-gray-700">Descripción</span>
            <input name="description" class="mt-1 block w-full rounded border-gray-300 text-sm">
          </label>
        </div>
        <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded">Crear add-on</button>
      </form>
    </details>
  `;

  return tableHtml + '<div class="mt-6">' + form + '</div>';
}

// --- Tab: Facturas --------------------------------------------------------

function renderFacturas(customer: CustomerWithRelations): string {
  const invoicesTable = table({
    rows: customer.invoices,
    empty: 'Sin facturas',
    rowHref: (i) => `/admin/invoices/${i.id}`,
    columns: [
      { label: '#', render: (i) => String(i.sequentialId) },
      { label: 'Folio', render: (i) => i.number ? `<code>${escapeHtml(i.number)}</code>` : '<span class="text-gray-400">—</span>' },
      { label: 'Status', render: (i) => statusBadge(i.status) },
      { label: 'Dispatch', render: (i) => statusBadge(i.externalDispatchStatus) },
      { label: 'Periodo', render: (i) => i.periodFrom && i.periodTo ? `${fmtDateOnly(i.periodFrom)} → ${fmtDateOnly(i.periodTo)}` : '<span class="text-gray-400">—</span>' },
      { label: 'Total', render: (i) => fmtMoney(i.feesAmountCents, i.currency) },
      { label: 'Emitida', render: (i) => fmtDateOnly(i.issuingDate) },
    ],
  });

  const cnsTable = table({
    rows: customer.creditNotes,
    empty: 'Sin notas de crédito',
    rowHref: (cn) => `/admin/credit-notes/${cn.id}`,
    columns: [
      { label: 'Folio', render: (cn) => cn.number ? `<code>${escapeHtml(cn.number)}</code>` : '<span class="text-gray-400">—</span>' },
      { label: 'Status', render: (cn) => statusBadge(cn.status) },
      { label: 'Dispatch', render: (cn) => statusBadge(cn.externalDispatchStatus) },
      { label: 'Total', render: (cn) => fmtMoney(cn.totalAmountCents, cn.currency) },
      { label: 'Razón', render: (cn) => escapeHtml(cn.reason) },
      { label: 'Emitida', render: (cn) => fmtDateOnly(cn.issuingDate) },
    ],
  });

  return card(`Facturas (${customer.invoices.length})`, invoicesTable)
    + card(`Notas de crédito (${customer.creditNotes.length})`, cnsTable);
}

// --- Tab: Eventos ---------------------------------------------------------

function renderEventos(events: EventLog[]): string {
  if (events.length === 0) {
    return `<div class="bg-white border rounded p-8 text-center text-gray-500">
      Sin eventos registrados para este cliente.
    </div>`;
  }
  return table({
    rows: events,
    empty: 'Sin eventos',
    columns: [
      { label: 'Cuándo', render: (e) => fmtDate(e.timestamp) },
      { label: 'Operación', render: (e) => badge(e.operationType, e.operationType === 'add' ? 'green' : 'gray') },
      { label: 'Tipo', render: (e) => e.kind ? escapeHtml(e.kind) : '<span class="text-gray-400">—</span>' },
      { label: 'Unit', render: (e) => `<code>${escapeHtml(e.unitExternalId)}</code>${e.unitLabel ? `<div class="text-xs text-gray-500">${escapeHtml(e.unitLabel)}</div>` : ''}` },
    ],
  });
}

// --- Tab: Datos fiscales --------------------------------------------------

function renderDatos(customer: CustomerWithRelations): string {
  const nonVoidedInvoices = customer.invoices.filter((i) => i.status !== 'voided').length;
  const currencyBlocked = nonVoidedInvoices > 0;
  const terminated = customer.status === 'terminated';

  if (terminated) {
    return `<div class="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-900">Customer <code>terminated</code> — datos no editables.</div>`;
  }

  const currencyHint = currencyBlocked
    ? `<span class="text-xs text-amber-700">Bloqueada: hay facturas emitidas en <code>${escapeHtml(customer.currency)}</code>.</span>`
    : '<span class="text-xs text-gray-500">Puede cambiarse mientras no haya facturas no-voided.</span>';

  const form = `
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
        ${techOnly(`
        <label class="block col-span-2"><span class="text-sm text-gray-700">NetSuite internal ID <span class="text-gray-400">(cache)</span></span>
          <input name="netsuite_internal_id" value="${escapeHtml(customer.netsuiteInternalId ?? '')}" placeholder="ej. 614" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
          <span class="text-xs text-gray-500">Si NetSuite ya creó el customer y conoces su internal id, ponlo aquí para que el dispatch lo use directo. Si queda vacío, el dispatch envía <code>eid:${escapeHtml(customer.externalId)}</code>.</span>
        </label>
        <div class="block col-span-2 bg-indigo-50 border border-indigo-200 rounded p-3 text-sm">
          <div class="text-xs text-indigo-700 uppercase font-semibold">Entity handle al dispatch</div>
          <code class="font-mono text-indigo-900">${escapeHtml(customer.netsuiteInternalId ? customer.netsuiteInternalId : `eid:${customer.externalId}`)}</code>
          <div class="text-xs text-indigo-700 mt-1">${customer.netsuiteInternalId ? 'Internal id directo (faster path).' : 'Fallback por external id — NetSuite hará lookup.'}</div>
        </div>
        `)}
      </div>
      <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded text-sm">Guardar datos</button>
    </form>
  `;

  // Identidad técnica — sólo en modo técnico.
  const identity = techOnly(card('Identidad técnica', kv([
    ['External ID', `<code>${escapeHtml(customer.externalId)}</code>`],
    ['Slug', `<code>${escapeHtml(customer.slug)}</code>`],
    ['UUID interno', `<code>${escapeHtml(customer.id)}</code>`],
    ['Sequential ID', String(customer.sequentialId)],
    ['Creado', fmtDate(customer.createdAt)],
    ['Actualizado', fmtDate(customer.updatedAt)],
  ])));

  return card('Datos del cliente', form) + identity;
}

// --- Punto de entrada -----------------------------------------------------

export function renderCustomerDetail(args: {
  customer: CustomerWithRelations;
  events: EventLog[];
  tab: CustomerTab;
  org: Organization;
}): string {
  const tz = adminContextStorage.getStore()?.displayTz ?? args.org.timezone ?? 'UTC';
  const metrics = computeCustomerMetrics({ customer: args.customer, tz });

  const totalUnits = args.customer.services.reduce((sum, s) => sum + ((s.units ?? []).length), 0);
  const counts = {
    services: args.customer.services.length,
    units: totalUnits,
    addOns: args.customer.addOns.length,
    invoices: args.customer.invoices.length,
    creditNotes: args.customer.creditNotes.length,
  };

  const tabContent = (() => {
    switch (args.tab) {
      case 'resumen': return renderResumen(args.customer, metrics);
      case 'plan': return renderPlan(args.customer);
      case 'unidades': return renderUnidades(args.customer);
      case 'addons': return renderAddons(args.customer);
      case 'facturas': return renderFacturas(args.customer);
      case 'eventos': return renderEventos(args.events);
      case 'datos': return renderDatos(args.customer);
    }
  })();

  return renderHeader(args.customer, metrics)
    + renderTabsNav(args.customer.externalId, args.tab, counts)
    + tabContent;
}


// --- Form de alta de cliente ---------------------------------------------

// Form para crear un cliente desde la UI. Los valores se pre-pueblan con
// `form` para preservar input del usuario al re-renderizar tras un error.
// El submit POSTea a /admin/customers/new que internamente llama al API.
export function renderNewCustomerForm(
  form: Record<string, string | undefined>,
  orgTimezone: string,
): string {
  const v = (k: string): string => escapeHtml(form[k] ?? "");
  const periodMonths = form.billing_period_months ?? "1";
  const periodOptions = [
    { value: "1", label: "1 mes — mensual" },
    { value: "3", label: "3 meses — trimestral" },
    { value: "6", label: "6 meses — semestral" },
    { value: "12", label: "12 meses — anual" },
  ].map((o) => `<option value="${o.value}" ${o.value === periodMonths ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("");

  const monthNames = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const anchorMonthOptions = ["<option value=\"\">— (anclado al mes de inicio)</option>"]
    .concat(monthNames.map((name, i) => {
      const n = i + 1;
      const selected = String(n) === form.billing_anchor_month ? "selected" : "";
      return `<option value="${n}" ${selected}>${n} — ${name}</option>`;
    }))
    .join("");

  const triggerOptions = [
    { value: "next_cycle", label: "Al próximo cierre (acumular y cobrar al cerrar el periodo)" },
    { value: "immediate", label: "Inmediato (factura individual al recibir el evento)" },
  ].map((o) => {
    const selected = (form.nonrecurring_trigger ?? "next_cycle") === o.value ? "selected" : "";
    return `<option value="${o.value}" ${selected}>${escapeHtml(o.label)}</option>`;
  }).join("");

  const cycleModeOptions = [
    { value: "unified", label: "1 factura — renta + setup + baja en un solo documento" },
    { value: "split_by_kind", label: "2 facturas — recurrentes (renta + add-ons) y únicos (setup + baja) separados" },
  ].map((o) => {
    const selected = (form.cycle_invoice_mode ?? "unified") === o.value ? "selected" : "";
    return `<option value="${o.value}" ${selected}>${escapeHtml(o.label)}</option>`;
  }).join("");

  const intro = `
    <div class="bg-indigo-50 border border-indigo-200 rounded p-4 mb-6 text-sm text-indigo-900">
      <div class="font-semibold mb-1">Crear cliente</div>
      <p>En operación normal los clientes llegan por API desde Numaris. Este form es para casos
      manuales, demos o pruebas. Solo nombre, identificador y moneda son obligatorios; el resto
      tiene defaults razonables y puedes editarlos después en el detalle del cliente.</p>
    </div>
  `;

  return pageHeader("Nuevo cliente", btn("/admin/customers", "← Cancelar"))
    + intro
    + card("Datos del cliente", `
    <form method="post" action="/admin/customers/new" class="space-y-5 max-w-3xl">
      <div class="grid grid-cols-2 gap-4">
        <label class="block col-span-2">
          <span class="text-sm font-medium text-gray-700">Identificador externo <span class="text-red-600">*</span></span>
          <input required name="external_id" value="${v("external_id")}" placeholder="ej. transportes-marva o cust-001" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
          <span class="text-xs text-gray-500">ID estable para mapear con sistemas externos (Numaris, NetSuite). Único por organización; no se puede cambiar.</span>
        </label>
        <label class="block col-span-2">
          <span class="text-sm font-medium text-gray-700">Nombre comercial <span class="text-red-600">*</span></span>
          <input required name="name" value="${v("name")}" placeholder="Transportes MARVA S.A. de C.V." class="mt-1 block w-full rounded border-gray-300 text-sm">
        </label>
        <label class="block">
          <span class="text-sm font-medium text-gray-700">Moneda <span class="text-red-600">*</span></span>
          <input required name="currency" value="${escapeHtml(form.currency ?? "MXN")}" maxlength="3" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm uppercase">
          <span class="text-xs text-gray-500">ISO 4217 — MXN, USD, EUR, etc.</span>
        </label>
        <label class="block">
          <span class="text-sm font-medium text-gray-700">País</span>
          <input name="country" value="${v("country")}" maxlength="2" placeholder="MX" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm uppercase">
          <span class="text-xs text-gray-500">ISO 3166-1 alpha-2.</span>
        </label>
        <label class="block">
          <span class="text-sm font-medium text-gray-700">Timezone (IANA)</span>
          <input name="timezone" value="${v("timezone")}" placeholder="${escapeHtml(orgTimezone)} (default de la organización)" class="mt-1 block w-full rounded border-gray-300 font-mono text-sm">
          <span class="text-xs text-gray-500">Determina cómo se interpreta el día de corte.</span>
        </label>
      </div>

      <div class="border-t pt-5">
        <h3 class="text-sm font-semibold text-gray-700 mb-3">Calendario de facturación</h3>
        <div class="grid grid-cols-2 gap-4">
          <label class="block col-span-2">
            <span class="text-sm font-medium text-gray-700">Inicio de suscripción (UTC)</span>
            <input type="datetime-local" name="subscription_at" value="${v("subscription_at")}" class="mt-1 block w-full rounded border-gray-300 text-sm">
            <span class="text-xs text-gray-500">Si lo dejas vacío usa el momento del alta. Si es futuro, el cliente queda <em>programado</em> hasta que llegue la fecha.</span>
          </label>
          <label class="block">
            <span class="text-sm font-medium text-gray-700">Frecuencia</span>
            <select name="billing_period_months" class="mt-1 block w-full rounded border-gray-300 text-sm">${periodOptions}</select>
          </label>
          <label class="block">
            <span class="text-sm font-medium text-gray-700">Día de corte (1–28)</span>
            <input type="number" name="billing_anchor_day" min="1" max="28" value="${escapeHtml(form.billing_anchor_day ?? "1")}" class="mt-1 block w-full rounded border-gray-300 text-sm">
            <span class="text-xs text-gray-500">Día del mes en que cierra el periodo.</span>
          </label>
          <label class="block col-span-2">
            <span class="text-sm font-medium text-gray-700">Mes ancla (solo si la frecuencia es trimestral / semestral / anual)</span>
            <select name="billing_anchor_month" class="mt-1 block w-full rounded border-gray-300 text-sm">${anchorMonthOptions}</select>
            <span class="text-xs text-gray-500">Alinea el ciclo a un mes calendario específico. Ignorado para la frecuencia mensual.</span>
          </label>
        </div>
      </div>

      <div class="border-t pt-5">
        <h3 class="text-sm font-semibold text-gray-700 mb-3">Estructura de facturación</h3>
        <p class="text-xs text-gray-500 mb-3">
          Decide cuándo se cobran los cargos no recurrentes (setup, baja, servicios one-off) y
          cómo se estructuran los conceptos en la factura del cierre.
        </p>
        <div class="grid grid-cols-2 gap-4">
          <label class="block">
            <span class="text-sm font-medium text-gray-700">Cuándo cobrar los no recurrentes</span>
            <select name="nonrecurring_trigger" class="mt-1 block w-full rounded border-gray-300 text-sm">${triggerOptions}</select>
            <span class="text-xs text-gray-500">Aplica a setup, baja y servicios one-off cuando llega un evento.</span>
          </label>
          <label class="block">
            <span class="text-sm font-medium text-gray-700">Estructura de la factura del cierre</span>
            <select name="cycle_invoice_mode" class="mt-1 block w-full rounded border-gray-300 text-sm">${cycleModeOptions}</select>
            <span class="text-xs text-gray-500">Cómo se agrupan los conceptos en la factura al cerrar el periodo.</span>
          </label>
        </div>
      </div>

      <div class="border-t pt-5 flex items-center gap-3">
        <button type="submit" class="px-5 py-2 rounded bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">Crear cliente</button>
        <a href="/admin/customers" class="text-sm text-gray-600 hover:text-gray-900">Cancelar</a>
        <span class="text-xs text-gray-500 ml-auto">Los datos fiscales completos (dirección, NetSuite ID) se editan después en la pestaña <strong>Datos fiscales</strong>.</span>
      </div>
    </form>
  `);
}
