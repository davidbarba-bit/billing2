// Detalle del customer rediseñado en tabs. Esconde toda la plomería
// técnica (IDs, idempotency, raw fields) detrás del toggle "Modo técnico"
// y deja al frente sólo lo accionable: estado del cliente, próximo cierre,
// acciones rápidas y los datos críticos del periodo en curso.

import type {
  CatalogEvent,
  CatalogEventOccurrence,
  Customer,
  CustomerAddOn,
  CreditNote,
  EventLog,
  Invoice,
  Organization,
  Service,
  TaxEntity,
  Unit,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { adminContextStorage } from './context.js';
import {
  INPUT_CLASS,
  INPUT_CLASS_MONO,
  badge,
  btn,
  card,
  escapeHtml,
  fmtDate,
  fmtDateOnly,
  fmtMoney,
  fmtRelative,
  formField,
  formSection,
  kv,
  modal,
  modalTrigger,
  pageHeader,
  pageTitle,
  panel,
  postButton,
  primaryButton,
  secondaryLink,
  statusBadge,
  table,
  tabs,
  techOnly,
} from './views.js';

export type TaxEntityWithCounts = TaxEntity & {
  _count: { services: number; customerAddOns: number; catalogEventOccurrences: number; invoices: number };
};

type CustomerWithRelations = Customer & {
  services: (Service & { units?: Unit[]; taxEntity?: TaxEntity })[];
  addOns: (CustomerAddOn & { taxEntity?: TaxEntity })[];
  invoices: Invoice[];
  creditNotes: CreditNote[];
  taxEntities: TaxEntityWithCounts[];
};

export const CUSTOMER_TABS = [
  'resumen',
  'plan',
  'unidades',
  'addons',
  'cargos',
  'precios-eventos',
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
  catalogEventOccurrences: number;
}): string {
  return tabs({
    baseHref: `/admin/customers/${encodeURIComponent(externalId)}`,
    active,
    items: [
      { key: 'resumen', label: 'Resumen' },
      { key: 'plan', label: 'Plan & calendario', count: counts.services },
      { key: 'unidades', label: 'Unidades', count: counts.units },
      { key: 'addons', label: 'Add-ons', count: counts.addOns },
      { key: 'cargos', label: 'Cargos extras', count: counts.catalogEventOccurrences },
      { key: 'precios-eventos', label: 'Precios de eventos' },
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
      <div><span class="text-gray-500">Cobro de servicios prepago:</span>
        <strong>${customer.nonrecurringTrigger === 'immediate' ? 'inmediato (factura individual al primer evento)' : 'al próximo cierre del periodo'}</strong>
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
      { label: 'Nombre', render: (s) => `${escapeHtml(s.name)}${s.taxEntity && !s.taxEntity.isDefault ? `<div class="text-xs ink-faint mt-0.5">↳ ${escapeHtml(s.taxEntity.legalName)}</div>` : ''}` },
      { label: 'Tipo', render: (s) => s.pricingModel === 'one_off' ? badge('prepago', 'blue') : badge('recurrente', 'green') },
      { label: 'Status', render: (s) => statusBadge(s.status) },
      { label: 'Renta /unidad', render: (s) => `${fmtMoney(s.monthlyUnitAmountCents, s.currency)} /u` },
      { label: 'Setup /unidad', render: (s) => s.setupUnitAmountCents > 0 ? `${fmtMoney(s.setupUnitAmountCents, s.currency)} /u` : '<span class="text-gray-400">—</span>' },
      { label: 'Cambio de precio', render: (s) => s.pendingEffectiveFrom ? badge(`programado ${fmtDateOnly(s.pendingEffectiveFrom)}`, 'yellow') : '<span class="text-gray-400 text-xs">—</span>' },
    ],
  });

  const scheduleBlock = `
    ${scheduleSummary}
    <div class="mt-5 pt-5" style="border-top: 1px solid var(--rule-soft);">
      ${modalTrigger({ modalId: 'modal-schedule-edit', label: 'Editar calendario de facturación' })}
    </div>
  `;

  const scheduleModal = modal({
    id: 'modal-schedule-edit',
    title: 'Editar calendario de facturación',
    description: 'Recalcula el ciclo actual y guarda el cambio en el historial.',
    body: scheduleEdit,
  });

  return card('Calendario de facturación', scheduleBlock)
    + card(`Planes (${services.length})`, servicesTable,
        btn(`/admin/services/new?customer=${customer.externalId}`, '+ Nuevo plan', 'primary'))
    + scheduleModal;
}

function renderScheduleEditForm(customer: CustomerWithRelations): string {
  const nonVoidedInvoices = customer.invoices.filter((i) => i.status !== 'voided').length;
  const blocked = nonVoidedInvoices > 0;
  const terminated = customer.status === 'terminated';
  const displayTz = adminContextStorage.getStore()?.displayTz ?? 'UTC';
  const dtLocal = (d: Date | null | undefined): string => {
    if (!d) return '';
    return DateTime.fromJSDate(d, { zone: 'utc' })
      .setZone(displayTz)
      .toFormat("yyyy-LL-dd'T'HH:mm");
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

  const disabledHard = blocked || terminated ? 'disabled' : '';
  const disabledSoft = terminated ? 'disabled' : '';
  const disabledClass = (flag: string) => flag ? ' style="opacity: 0.5; pointer-events: none;"' : '';

  const banner = terminated
    ? `<div class="rounded p-4 mb-5 text-sm" style="background: var(--danger-soft); border: 1px solid var(--danger-soft); color: var(--danger);">Cliente terminado — el calendario no se puede editar.</div>`
    : blocked
    ? `<div class="rounded p-4 mb-5 text-sm" style="background: var(--warn-soft); border: 1px solid var(--warn-soft); color: var(--warn);"><strong>${nonVoidedInvoices} factura${nonVoidedInvoices === 1 ? '' : 's'} no anulada${nonVoidedInvoices === 1 ? '' : 's'} bloquea${nonVoidedInvoices === 1 ? '' : 'n'} cambios a suscripción, día de corte, frecuencia y mes ancla.</strong> Anúlalas primero. El trigger no-recurrente y el modo de factura sí se pueden editar.</div>`
    : '';

  const cicloSection = formSection({
    title: 'Ciclo',
    description: 'Inicio de suscripción, frecuencia y día de corte del periodo.',
    body: `
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5"${disabledClass(disabledHard)}>
        ${formField({
          label: 'Inicio de suscripción',
          hint: `Se interpreta en tu zona <code class="font-mono-pro">${escapeHtml(displayTz)}</code>.`,
          input: `<input ${disabledHard} type="datetime-local" name="subscription_at" value="${escapeHtml(dtLocal(customer.subscriptionAt))}" class="${INPUT_CLASS}">`,
        })}
        ${formField({
          label: 'Día de corte (1–28)',
          hint: 'Día del mes en que cierra el periodo.',
          input: `<input ${disabledHard} type="number" name="billing_anchor_day" min="1" max="28" value="${customer.billingAnchorDay}" class="${INPUT_CLASS_MONO} max-w-xs">`,
        })}
        ${formField({
          label: 'Frecuencia',
          input: `<select ${disabledHard} name="billing_period_months" class="${INPUT_CLASS}">${periodOptions}</select>`,
        })}
        ${formField({
          label: 'Mes ancla',
          hint: 'Solo aplica si la frecuencia es trimestral / semestral / anual. Define en qué mes calendario inicia un ciclo.',
          input: `<select ${disabledHard} name="billing_anchor_month" class="${INPUT_CLASS}">${anchorMonthOptions}</select>`,
        })}
      </div>
    `,
  });

  const facturacionSection = formSection({
    title: 'Estructura de facturación',
    description: 'Cuándo se facturan los servicios prepago y cómo se agrupan los conceptos al cerrar el periodo.',
    body: `
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5"${disabledClass(disabledSoft)}>
        ${formField({
          label: 'Cuándo facturar los servicios prepago',
          hint: 'Aplica al paquete prepago completo (setup + N mensualidades) cuando llega el primer evento.',
          input: `<select ${disabledSoft} name="nonrecurring_trigger" class="${INPUT_CLASS}">${triggerOptions}</select>`,
        })}
        ${formField({
          label: 'Estructura de la factura del cierre',
          hint: 'Cómo se agrupan los conceptos (renta, setup, baja) en la factura al cerrar el periodo.',
          input: `<select ${disabledSoft} name="cycle_invoice_mode" class="${INPUT_CLASS}">${cycleModeOptions}</select>`,
        })}
      </div>
    `,
  });

  return `
    ${banner}
    <form method="post" action="/admin/customers/${escapeHtml(customer.externalId)}/billing-schedule" class="space-y-0"
      onsubmit="return confirm('Esto recalculará el ciclo actual y guardará el cambio en el historial. ¿Continuar?')">
      ${cicloSection}
      ${facturacionSection}
      ${terminated ? '' : `<div class="flex items-center gap-3 pt-6 mt-2" style="border-top: 1px solid var(--rule);">${primaryButton('Actualizar calendario')}</div>`}
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

  const activePlans = customer.services.filter((s) => s.status !== 'terminated');

  // Modal de nueva unidad — incluye selector de plan + campos comunes.
  // La selección del plan determina qué campos "ya facturado afuera" aplican
  // (vía CSS :has() — sin JS frágil).
  const newUnitForm = (() => {
    if (activePlans.length === 0) return '';
    const planOptions = activePlans.map((p) => {
      const prepaidHint = p.prepaidMonthsDefault !== null ? `${p.prepaidMonthsDefault}m` : '';
      return `<option value="${escapeHtml(p.code)}" data-pricing-model="${escapeHtml(p.pricingModel)}" data-prepaid-default="${escapeHtml(String(p.prepaidMonthsDefault ?? ''))}">${escapeHtml(p.name)} — ${escapeHtml(p.code)}${p.pricingModel === 'one_off' ? ` · prepago ${prepaidHint}` : ' · recurrente'}</option>`;
    }).join('');

    // CSS :has() para mostrar/ocultar campos según el plan seleccionado.
    const conditionalStyles = `<style>
      .unit-prepago-only, .unit-recurring-only { display: none; }
      form:has(select[name="service_code"] option:checked[data-pricing-model="one_off"]) .unit-prepago-only { display: block; }
      form:has(select[name="service_code"] option:checked[data-pricing-model="recurring"]) .unit-recurring-only { display: block; }
    </style>`;

    return `${conditionalStyles}
      <form method="post" action="/admin/customers/${escapeHtml(customer.externalId)}/units" class="space-y-0">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5 mb-6">
          ${formField({
            label: 'Plan',
            required: true,
            span: 2,
            hint: 'A qué plan del cliente se va a asociar la unidad.',
            input: `<select required name="service_code" class="${INPUT_CLASS}">${planOptions}</select>`,
          })}
          ${formField({
            label: 'Identificador externo',
            required: true,
            input: `<input required name="external_id" placeholder="gps-001" class="${INPUT_CLASS_MONO}">`,
            hint: 'ID estable proporcionado por el sistema externo.',
          })}
          ${formField({
            label: 'Etiqueta',
            input: `<input name="label" placeholder="Camión 001" class="${INPUT_CLASS}">`,
            hint: 'Texto humano descriptivo (opcional).',
          })}
          ${formField({
            label: 'Activa desde',
            required: true,
            input: `<input required type="datetime-local" name="active_from" class="${INPUT_CLASS}">`,
            hint: 'Verdad operativa — cuándo empezó a reportar.',
          })}
          ${formField({
            label: 'Empieza a facturarse',
            input: `<input type="datetime-local" name="billing_starts_at" class="${INPUT_CLASS}">`,
            hint: 'Override opcional. Si lo dejas vacío se factura desde activa.',
          })}
        </div>
        <div class="unit-prepago-only mb-6">
          ${formField({
            label: 'Meses prepagados',
            hint: 'Opcional — si lo dejas vacío usa el default del plan.',
            input: `<input type="number" name="prepaid_months" min="1" class="${INPUT_CLASS_MONO}" style="max-width: 12rem;">`,
          })}
        </div>
        <div class="unit-recurring-only rounded p-4 text-sm mb-6" style="background: var(--warn-soft); border: 1px solid var(--warn-soft);">
          <div class="text-[10px] uppercase tracking-wider font-medium mb-2" style="color: var(--warn);">Cobros ya pagados afuera</div>
          <label class="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" name="setup_already_billed" value="1" class="mt-0.5">
            <span class="text-sm ink-soft">El setup ya se facturó en el sistema legacy. La unidad sigue facturando renta normal pero no incluirá el renglón de setup.</span>
          </label>
        </div>
        <div class="unit-prepago-only rounded p-4 text-sm mb-6" style="background: var(--warn-soft); border: 1px solid var(--warn-soft);">
          <div class="text-[10px] uppercase tracking-wider font-medium mb-2" style="color: var(--warn);">Cobros ya pagados afuera</div>
          <label class="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" name="one_off_already_billed" value="1" class="mt-0.5">
            <span class="text-sm ink-soft">El paquete prepago ya se facturó en el sistema legacy (setup + N mensualidades). La unidad no se cobrará al primer evento ni al cierre.</span>
          </label>
        </div>
        <div class="flex items-center gap-3 pt-4" style="border-top: 1px solid var(--rule);">
          ${primaryButton('Crear unidad')}
        </div>
      </form>`;
  })();

  const newUnitModal = newUnitForm
    ? modal({
        id: 'modal-new-unit-customer',
        title: 'Agregar unidad',
        description: 'Selecciona el plan al que se va a asociar la unidad. El identificador externo lo proporciona el sistema externo (GPS, video, etc.).',
        body: newUnitForm,
      })
    : '';

  const addAction = activePlans.length > 0
    ? modalTrigger({ modalId: 'modal-new-unit-customer', label: '+ Agregar unidad' })
    : '';

  if (rows.length === 0) {
    return panel({
      title: 'Unidades',
      description: activePlans.length > 0
        ? 'Las unidades se asocian a un plan del cliente.'
        : 'Este cliente no tiene planes activos. Crea un plan primero para poder agregar unidades.',
      actions: addAction,
      body: `<div class="text-sm ink-faint italic py-6 text-center">Este cliente todavía no tiene unidades.</div>`,
    }) + newUnitModal;
  }

  rows.sort((a, b) => {
    if (a.activeTo === null && b.activeTo !== null) return -1;
    if (a.activeTo !== null && b.activeTo === null) return 1;
    return b.activeFrom.getTime() - a.activeFrom.getTime();
  });

  const unitsTable = table({
    rows,
    empty: 'Sin unidades',
    columns: [
      { label: 'Identificador', render: (u) => `<code class="font-mono-pro text-xs">${escapeHtml(u.externalId)}</code>${u.label ? `<div class="text-xs ink-faint mt-0.5">${escapeHtml(u.label)}</div>` : ''}` },
      { label: 'Plan', render: (u) => `<a class="hover:underline" style="color: var(--accent-deep);" href="/admin/services/${escapeHtml(u.serviceCode)}">${escapeHtml(u.serviceName)}</a>` },
      { label: 'Status', render: (u) => statusBadge(u.activeTo === null ? 'active' : 'terminated') },
      { label: 'Activa desde', render: (u) => fmtDateOnly(u.activeFrom) },
      { label: 'Activa hasta', render: (u) => fmtDateOnly(u.activeTo) },
      { label: 'Facturación inicial', render: (u) => {
        const isOneOff = u.pricingModel === 'one_off';
        const billedAt = isOneOff ? u.oneoffBilledAt : u.setupBilledAt;
        if (!isOneOff && u.setupAmount === 0) {
          return '<span class="ink-faint text-xs">sin setup</span>';
        }
        return billedAt
          ? `<span class="pill pill-success">${isOneOff ? 'pagada' : 'setup pagado'}</span>`
          : `<span class="pill pill-warn">pendiente</span>`;
      } },
      { label: '', render: (u) => `<a class="text-xs hover:underline" style="color: var(--accent-deep);" href="/admin/units/${u.id}/edit">editar</a>` },
    ],
  });

  return panel({
    title: `Unidades · ${rows.length}`,
    description: 'Unidades de todos los planes del cliente.',
    actions: addAction,
    body: unitsTable,
  }) + newUnitModal;
}

// --- Tab: Add-ons ---------------------------------------------------------

function renderAddons(customer: CustomerWithRelations): string {
  // v22: razones sociales activas del cliente para el select (incluye también
  // la actual en modales de edición — se filtra ahí).
  const activeTaxEntities = customer.taxEntities.filter((te) => te.active);
  const defaultTe = customer.taxEntities.find((te) => te.isDefault);

  const tableHtml = customer.addOns.length === 0
    ? `<div class="text-sm ink-faint italic py-6 text-center">Sin add-ons flat. Los add-ons flat son cargos fijos mensuales independientes de unidades.</div>`
    : table({
        rows: customer.addOns,
        empty: 'Sin add-ons flat',
        columns: [
          { label: 'Código', render: (a) => `<code class="font-mono-pro text-xs">${escapeHtml(a.code)}</code>` },
          { label: 'Nombre', render: (a) => `${escapeHtml(a.name)}${a.taxEntity && !a.taxEntity.isDefault ? `<div class="text-xs ink-faint mt-0.5">↳ ${escapeHtml(a.taxEntity.legalName)}</div>` : ''}` },
          { label: 'Monto /mes', render: (a) => `<span class="font-mono-pro">${fmtMoney(a.amountCents, customer.currency)}</span> <span class="ink-faint text-xs">flat/mes</span>` },
          { label: 'Status', render: (a) => statusBadge(a.activeTo === null ? 'active' : 'terminated') },
          { label: 'Vigente desde', render: (a) => fmtDateOnly(a.activeFrom) },
          { label: 'Vigente hasta', render: (a) => fmtDateOnly(a.activeTo) },
          { label: '', render: (a) => {
            if (a.activeTo !== null) return '<span class="ink-faint text-xs">terminado</span>';
            const editBtn = activeTaxEntities.length > 1 ? modalTrigger({ modalId: `modal-edit-addon-${a.id}`, label: 'Razón social' }) : '';
            const termBtn = postButton(`/admin/customer-add-ons/${a.id}/terminate`, 'Terminar', 'danger', `¿Terminar add-on ${a.code}?`);
            return `<div class="flex items-center gap-2 justify-end">${editBtn}${termBtn}</div>`;
          } },
        ],
      });

  // v22: select de razón social para el form. Se muestra solo si hay más de
  // una activa; con una sola, el add-on hereda la default sin preguntar.
  const taxEntitySelect = activeTaxEntities.length > 1
    ? formField({
        label: 'Razón social',
        span: 2,
        hint: 'Razón social a la que se factura este add-on. Default = la del cliente.',
        input: `<select name="tax_entity_id" class="${INPUT_CLASS}">${activeTaxEntities.map((te) => {
          const sel = te.isDefault ? 'selected' : '';
          const label = (te.isDefault ? `${te.legalName} (default)` : te.legalName)
            + (te.taxIdentificationNumber ? ` — ${te.taxIdentificationNumber}` : '');
          return `<option value="${escapeHtml(te.id)}" ${sel}>${escapeHtml(label)}</option>`;
        }).join('')}</select>`,
      })
    : '';

  const addonForm = `
    <form method="post" action="/admin/customers/${escapeHtml(customer.externalId)}/add-ons" class="space-y-0">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5 mb-6">
        ${formField({
          label: 'Nombre',
          required: true,
          span: 2,
          hint: 'El código se genera automáticamente.',
          input: `<input required name="name" placeholder="Reglas de evento 5 → 10" class="${INPUT_CLASS}">`,
        })}
        ${formField({
          label: 'Monto flat mensual',
          required: true,
          hint: `Cargo fijo cada periodo, independiente de unidades. En ${escapeHtml(customer.currency)}.`,
          input: `<div class="relative">
            <span class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-[11px] font-mono-pro uppercase tracking-wider ink-faint">${escapeHtml(customer.currency)}</span>
            <input required type="number" step="0.01" min="0" name="amount" placeholder="0.00" class="${INPUT_CLASS_MONO} pl-14 text-right">
          </div>`,
        })}
        ${formField({
          label: 'Item code NetSuite',
          input: `<input name="netsuite_item_code" placeholder="ADDON-FLAT" class="${INPUT_CLASS_MONO}">`,
        })}
        ${formField({
          label: 'Descripción',
          span: 2,
          input: `<input name="description" class="${INPUT_CLASS}">`,
        })}
        ${taxEntitySelect}
      </div>
      <div class="flex items-center gap-3 pt-4" style="border-top: 1px solid var(--rule);">
        ${primaryButton('Crear add-on')}
      </div>
    </form>
  `;

  const addonModal = modal({
    id: 'modal-new-customer-addon',
    title: 'Nuevo add-on flat',
    description: 'Cargo fijo mensual a nivel del cliente, independiente de unidades o planes (ej. "10 reglas de evento +$1,000/mes").',
    body: addonForm,
  });

  // Modales de "editar razón social" por add-on activo (solo cuando hay >1
  // razón social activa, condición ya manejada en la columna de acciones).
  const editTaxEntityModals = activeTaxEntities.length > 1
    ? customer.addOns.filter((a) => a.activeTo === null).map((a) => modal({
        id: `modal-edit-addon-${a.id}`,
        title: `Razón social — ${a.name}`,
        description: 'Aplica a próximos ciclos. Las facturas ya emitidas conservan su razón social.',
        body: `
          <form method="post" action="/admin/customer-add-ons/${a.id}/tax-entity" class="space-y-0">
            <div class="mb-6">
              ${formField({
                label: 'Razón social',
                input: `<select name="tax_entity_id" class="${INPUT_CLASS}">${customer.taxEntities.filter((te) => te.active || te.id === a.taxEntityId).map((te) => {
                  const sel = te.id === a.taxEntityId ? 'selected' : '';
                  const label = (te.isDefault ? `${te.legalName} (default)` : te.legalName)
                    + (te.taxIdentificationNumber ? ` — ${te.taxIdentificationNumber}` : '')
                    + (te.active ? '' : ' [inactiva]');
                  return `<option value="${escapeHtml(te.id)}" ${sel}>${escapeHtml(label)}</option>`;
                }).join('')}</select>`,
              })}
            </div>
            <div class="flex items-center gap-3 pt-4" style="border-top: 1px solid var(--rule);">
              ${primaryButton('Guardar razón social')}
            </div>
          </form>
        `,
      })).join('')
    : '';

  const addButton = modalTrigger({ modalId: 'modal-new-customer-addon', label: '+ Agregar add-on flat' });
  void defaultTe; // reservado para futuras pistas en UI

  return panel({
    title: `Add-ons flat · ${customer.addOns.length}`,
    description: 'Cargos fijos mensuales independientes de unidades o servicios.',
    actions: addButton,
    body: tableHtml,
  }) + addonModal + editTaxEntityModals;
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

// --- Tab: Cargos extras (ocurrencias del catálogo de eventos) -------------

export type CustomerCatalogEventPricingRow = {
  catalogEventId: string;
  amountCents: number;
  billingMode: string;
};

function renderCargosExtras(args: {
  customer: CustomerWithRelations;
  catalogEvents: CatalogEvent[];
  pricings: CustomerCatalogEventPricingRow[];
  occurrences: Array<CatalogEventOccurrence & { catalogEvent: { code: string; name: string }; fee: { invoiceId: string } | null; taxEntity?: { legalName: string; isDefault: boolean } | null }>;
}): string {
  const activeCatalog = args.catalogEvents.filter((e) => e.active);
  const pricingByEventId = new Map(args.pricings.map((p) => [p.catalogEventId, p] as const));
  // Un evento es "registrable" si tiene precio pactado para este cliente O
  // si el catálogo le tiene default. Sin ninguna de las dos, no podemos
  // resolver monto al crear la ocurrencia.
  const eventsRegistrables = activeCatalog.filter((e) =>
    pricingByEventId.has(e.id) || e.defaultAmountCents !== null
  );

  const newButton = eventsRegistrables.length > 0 && args.customer.status !== 'terminated'
    ? modalTrigger({ modalId: 'modal-new-cargo-extra', label: '+ Registrar evento' })
    : '';

  const occurrencesTable = args.occurrences.length === 0
    ? `<div class="text-sm ink-faint italic py-6 text-center">Este cliente todavía no tiene cargos extras registrados.</div>`
    : table({
        rows: args.occurrences,
        empty: 'Sin cargos extras',
        columns: [
          { label: 'Evento', render: (o) => `<a class="hover:underline" style="color: var(--accent-deep);" href="/admin/catalogo-eventos/${encodeURIComponent(o.catalogEvent.code)}">${escapeHtml(o.catalogEvent.name)}</a>${o.taxEntity && !o.taxEntity.isDefault ? `<div class="text-xs ink-faint mt-0.5">↳ ${escapeHtml(o.taxEntity.legalName)}</div>` : ''}` },
          { label: 'Unidad', render: (o) => o.unitExternalId
            ? `<code class="font-mono-pro text-xs">${escapeHtml(o.unitExternalId)}</code>`
            : '<span class="ink-faint text-xs">—</span>' },
          { label: 'Monto', render: (o) => `<span class="font-mono-pro">${fmtMoney(o.amountCents, args.customer.currency)}</span>` },
          { label: 'Modo', render: (o) => o.billingMode === 'immediate'
            ? `<span class="pill pill-info">Inmediato</span>`
            : `<span class="pill pill-warn">Próximo ciclo</span>` },
          { label: 'Status', render: (o) => o.feeId
            ? (o.fee?.invoiceId
              ? `<a class="text-xs hover:underline" style="color: var(--accent-deep);" href="/admin/invoices/${escapeHtml(o.fee.invoiceId)}">facturado</a>`
              : `<span class="pill pill-success">facturado</span>`)
            : `<span class="pill pill-warn">pendiente</span>` },
          { label: 'Ocurrido', render: (o) => fmtDateOnly(o.occurredAt) },
          { label: 'Referencia', render: (o) => o.reference
            ? `<span class="text-xs">${escapeHtml(o.reference)}</span>`
            : '<span class="ink-faint text-xs">—</span>' },
        ],
      });

  const formModal = eventsRegistrables.length > 0 && args.customer.status !== 'terminated'
    ? renderCargoExtraModal({ customer: args.customer, catalogEvents: eventsRegistrables, pricingByEventId })
    : '';

  let description: string;
  if (activeCatalog.length === 0) {
    description = 'No hay eventos activos en el catálogo. Define al menos uno en <a class="hover:underline" style="color: var(--accent-deep);" href="/admin/catalogo-eventos">Catálogo de eventos facturables</a> antes de registrar cargos extras.';
  } else if (eventsRegistrables.length === 0) {
    description = 'Ningún evento activo tiene precio resolvible: ni hay precio pactado con este cliente ni default en el catálogo. Configura uno de los dos antes de registrar cargos.';
  } else {
    description = 'Cargos puntuales registrados para este cliente. Si pactaste un precio específico para este cliente, ese se usa. Si no, se usa el default del catálogo del evento.';
  }

  return panel({
    title: `Cargos extras · ${args.occurrences.length}`,
    description,
    actions: newButton,
    body: occurrencesTable,
  }) + formModal;
}

function renderCargoExtraModal(args: {
  customer: CustomerWithRelations;
  catalogEvents: CatalogEvent[];
  pricingByEventId: Map<string, CustomerCatalogEventPricingRow>;
}): string {
  // Cada option muestra el precio efectivo: el pactado para este cliente si
  // existe, o el default del catálogo si no. El monto y modo no se editan
  // aquí — se configuran en "Precios de eventos" (cliente) o en el catálogo.
  const eventOptions = args.catalogEvents.map((e) => {
    const p = args.pricingByEventId.get(e.id);
    const amount = p ? p.amountCents : (e.defaultAmountCents ?? 0);
    const mode = p ? p.billingMode : e.defaultBillingMode;
    const source = p ? 'pactado' : 'default del catálogo';
    const modeLabel = mode === 'immediate' ? 'inmediato' : 'próximo ciclo';
    const label = `${e.name} — ${fmtMoney(amount, args.customer.currency)} (${modeLabel}, ${source})`;
    return `<option value="${escapeHtml(e.code)}">${escapeHtml(label)}</option>`;
  }).join('');

  const form = `
    <form method="post" action="/admin/customers/${escapeHtml(args.customer.externalId)}/catalog-events" class="space-y-0">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5 mb-6">
        ${formField({
          label: 'Evento del catálogo',
          required: true,
          span: 2,
          hint: 'Si el cliente tiene precio pactado se usa ese. Si no, se usa el default del catálogo del evento.',
          input: `<select required name="catalog_event_code" class="${INPUT_CLASS}"><option value="">— elegir evento —</option>${eventOptions}</select>`,
        })}
        ${formField({
          label: 'Unidad (opcional)',
          hint: 'External ID de la unidad afectada, si aplica. Texto libre.',
          input: `<input name="unit_external_id" placeholder="gps-001" class="${INPUT_CLASS_MONO}">`,
        })}
        ${formField({
          label: 'Referencia (opcional)',
          hint: 'Ticket, orden de servicio, nota interna.',
          input: `<input name="reference" placeholder="ticket-3421" class="${INPUT_CLASS}">`,
        })}
        ${formField({
          label: 'Fecha y hora del evento',
          span: 2,
          hint: 'Cuándo ocurrió. Si lo dejas vacío usa el momento del registro.',
          input: `<input type="datetime-local" name="occurred_at" class="${INPUT_CLASS}">`,
        })}
      </div>
      <div class="flex items-center gap-3 pt-4" style="border-top: 1px solid var(--rule);">
        ${primaryButton('Registrar evento')}
      </div>
    </form>
  `;

  return modal({
    id: 'modal-new-cargo-extra',
    title: 'Registrar cargo extra',
    description: 'Registra un cargo puntual del catálogo de eventos para este cliente. El precio y el modo de facturación se toman del precio pactado.',
    body: form,
  });
}

// --- Tab: Precios de eventos facturables (pricing por cliente) -----------

function renderPreciosEventos(args: {
  customer: CustomerWithRelations;
  catalogEvents: CatalogEvent[];
  pricings: CustomerCatalogEventPricingRow[];
}): string {
  const activeCatalog = args.catalogEvents.filter((e) => e.active);
  const pricingByEventId = new Map(args.pricings.map((p) => [p.catalogEventId, p] as const));
  const terminated = args.customer.status === 'terminated';
  const currency = args.customer.currency;

  if (activeCatalog.length === 0) {
    return panel({
      title: 'Precios de eventos facturables',
      description: 'No hay eventos activos en el catálogo. Define al menos uno en <a class="hover:underline" style="color: var(--accent-deep);" href="/admin/catalogo-eventos">Catálogo de eventos facturables</a>.',
      body: '',
    });
  }

  const rows = activeCatalog.map((e) => {
    const p = pricingByEventId.get(e.id);
    const amountValue = p ? (p.amountCents / 100).toFixed(2) : '';
    const modeValue = p?.billingMode ?? 'next_cycle';
    const status = p
      ? `<span class="pill pill-success">configurado</span>`
      : `<span class="pill pill-warn">sin precio</span>`;

    const formAction = `/admin/customers/${escapeHtml(args.customer.externalId)}/catalog-event-pricing`;
    const editForm = terminated ? '' : `
      <form method="post" action="${formAction}" class="flex items-end gap-2">
        <input type="hidden" name="catalog_event_code" value="${escapeHtml(e.code)}">
        <div class="relative">
          <span class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-[11px] font-mono-pro uppercase tracking-wider ink-faint">${escapeHtml(currency)}</span>
          <input required type="number" step="0.01" min="0" name="amount" value="${escapeHtml(amountValue)}" placeholder="0.00" class="${INPUT_CLASS_MONO} pl-14 text-right" style="width: 9rem;">
        </div>
        <select name="billing_mode" class="${INPUT_CLASS}" style="width: 12rem;">
          <option value="next_cycle" ${modeValue === 'next_cycle' ? 'selected' : ''}>Próximo ciclo</option>
          <option value="immediate" ${modeValue === 'immediate' ? 'selected' : ''}>Inmediato</option>
        </select>
        ${primaryButton(p ? 'Actualizar' : 'Configurar')}
      </form>
    `;

    return {
      event: e,
      status,
      pricing: p,
      editForm,
    };
  });

  const t = table({
    rows,
    empty: 'Sin eventos',
    columns: [
      { label: 'Evento', render: (r) => `<div class="ink">${escapeHtml(r.event.name)}</div><code class="font-mono-pro text-xs ink-faint">${escapeHtml(r.event.code)}</code>` },
      { label: 'Default del catálogo', render: (r) => r.event.defaultAmountCents !== null
        ? `<span class="font-mono-pro text-xs">${fmtMoney(r.event.defaultAmountCents, currency)}</span>`
        : '<span class="ink-faint text-xs">—</span>' },
      { label: 'Status', render: (r) => r.status },
      { label: 'Precio para este cliente', render: (r) => r.editForm },
    ],
  });

  return panel({
    title: `Precios de eventos facturables · ${args.pricings.length}/${activeCatalog.length}`,
    description: 'Precio y modo de facturación pactados con este cliente para cada evento del catálogo. Cuando un sistema externo (API) registra una ocurrencia, se cobra según lo configurado aquí.',
    body: t,
  });
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
// v22: separa "Datos comerciales" (del Customer: nombre, contacto, moneda,
// tz) de "Razones sociales" (TaxEntity: identidad fiscal por la que se
// emiten los CFDI). Cada plan/add-on/evento se factura a una razón social.

function renderDatos(customer: CustomerWithRelations): string {
  const terminated = customer.status === 'terminated';
  if (terminated) {
    return `<div class="rounded p-4 text-sm" style="background: var(--danger-soft); color: var(--danger); border: 1px solid var(--danger-soft);">Cliente <code class="font-mono-pro">terminado</code> — datos no editables.</div>`;
  }

  const nonVoidedInvoices = customer.invoices.filter((i) => i.status !== 'voided').length;
  const currencyBlocked = nonVoidedInvoices > 0;
  const currencyHint = currencyBlocked
    ? `Bloqueada: hay facturas emitidas en <code class="font-mono-pro">${escapeHtml(customer.currency)}</code>.`
    : 'Puede cambiarse mientras no haya facturas activas.';

  // --- Panel 1: datos comerciales (del Customer) ---------------------------
  const comercialForm = `
    <form method="post" action="/admin/customers/${escapeHtml(customer.externalId)}/edit" class="space-y-0">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5 mb-6">
        ${formField({ label: 'Nombre comercial', required: true, span: 2,
          input: `<input required name="name" value="${escapeHtml(customer.name)}" class="${INPUT_CLASS}">` })}
        ${formField({ label: 'Email de contacto',
          input: `<input type="email" name="email" value="${escapeHtml(customer.email ?? '')}" class="${INPUT_CLASS}">` })}
        ${formField({ label: 'Teléfono',
          input: `<input name="phone" value="${escapeHtml(customer.phone ?? '')}" class="${INPUT_CLASS}">` })}
        ${formField({ label: 'Moneda', hint: currencyHint,
          input: `<input ${currencyBlocked ? 'readonly' : ''} name="currency" value="${escapeHtml(customer.currency)}" maxlength="3" class="${INPUT_CLASS_MONO} uppercase ${currencyBlocked ? 'opacity-60' : ''}">` })}
        ${formField({ label: 'Timezone (IANA)', hint: 'Para definir el corte del ciclo. Vacío usa la de la organización.',
          input: `<input name="timezone" value="${escapeHtml(customer.timezone ?? '')}" placeholder="America/Mexico_City" class="${INPUT_CLASS_MONO}">` })}
      </div>
      <div class="flex items-center gap-3 pt-4" style="border-top: 1px solid var(--rule);">
        ${primaryButton('Guardar datos comerciales')}
      </div>
    </form>
  `;

  // --- Panel 2: razones sociales (TaxEntity) -------------------------------
  const entities = customer.taxEntities ?? [];
  const newButton = modalTrigger({ modalId: 'modal-new-tax-entity', label: '+ Nueva razón social' });

  const entityCard = (e: TaxEntityWithCounts): string => {
    const refs = e._count.services + e._count.customerAddOns + e._count.catalogEventOccurrences + e._count.invoices;
    const badges = [
      e.isDefault ? `<span class="pill pill-info">Default</span>` : '',
      e.active ? '' : `<span class="pill pill-warn">Inactiva</span>`,
    ].filter(Boolean).join(' ');
    const actions = [
      modalTrigger({ modalId: `modal-edit-tax-entity-${e.id}`, label: 'Editar' }),
      !e.isDefault && e.active
        ? postButton(`/admin/customers/${escapeHtml(customer.externalId)}/tax-entities/${e.id}/default`, 'Marcar default', 'secondary')
        : '',
      !e.isDefault
        ? postButton(`/admin/customers/${escapeHtml(customer.externalId)}/tax-entities/${e.id}/toggle`, e.active ? 'Desactivar' : 'Activar', 'secondary')
        : '',
      !e.isDefault && refs === 0
        ? postButton(`/admin/customers/${escapeHtml(customer.externalId)}/tax-entities/${e.id}/delete`, 'Eliminar', 'danger', `¿Eliminar la razón social "${e.legalName}"?`)
        : '',
    ].filter(Boolean).join('');
    const handle = e.netsuiteInternalId ? e.netsuiteInternalId : `eid:${e.externalId}`;
    return `
      <div class="surface-card" style="border-radius: 6px; padding: 1.25rem 1.5rem;">
        <div class="flex items-start justify-between gap-4 mb-3">
          <div>
            <div class="font-display text-base font-medium ink">${escapeHtml(e.legalName)} ${badges}</div>
            <div class="font-mono-pro text-xs ink-faint mt-1">${e.taxIdentificationNumber ? escapeHtml(e.taxIdentificationNumber) : '— sin RFC —'}</div>
          </div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
          <div><span class="text-[10px] uppercase tracking-wider ink-faint">Identificador externo</span><div class="ink font-mono-pro">${escapeHtml(e.externalId)}</div></div>
          <div><span class="text-[10px] uppercase tracking-wider ink-faint">Régimen</span><div class="ink">${e.taxRegime ? escapeHtml(e.taxRegime) : '<span class="ink-faint">—</span>'}</div></div>
          <div><span class="text-[10px] uppercase tracking-wider ink-faint">Uso CFDI</span><div class="ink">${e.cfdiUse ? escapeHtml(e.cfdiUse) : '<span class="ink-faint">—</span>'}</div></div>
          <div><span class="text-[10px] uppercase tracking-wider ink-faint">CP</span><div class="ink font-mono-pro">${e.zipcode ? escapeHtml(e.zipcode) : '<span class="ink-faint">—</span>'}</div></div>
          <div class="sm:col-span-2"><span class="text-[10px] uppercase tracking-wider ink-faint">Correo fiscal</span><div class="ink">${e.email ? escapeHtml(e.email) : '<span class="ink-faint">—</span>'}</div></div>
          ${techOnly(`<div class="sm:col-span-3"><span class="text-[10px] uppercase tracking-wider ink-faint">Handle a NetSuite</span><div class="ink font-mono-pro">${escapeHtml(handle)}</div></div>`)}
        </div>
        <div class="mt-4 pt-4 flex items-center gap-3 flex-wrap" style="border-top: 1px solid var(--rule-soft);">
          ${actions}
          <span class="ml-auto text-xs ink-faint">${refs} ${refs === 1 ? 'referencia' : 'referencias'}</span>
        </div>
      </div>
    `;
  };

  const entitiesList = entities.length === 0
    ? `<div class="text-sm ink-faint italic py-6 text-center">Sin razones sociales. Crea la primera con el botón de arriba.</div>`
    : `<div class="space-y-4">${entities.map(entityCard).join('')}</div>`;

  const newModal = modal({
    id: 'modal-new-tax-entity',
    title: 'Nueva razón social',
    description: 'Identidad fiscal a la que se pueden facturar planes de este cliente. Cada CFDI se emite a una sola razón social.',
    body: renderTaxEntityForm(customer, null),
  });
  const editModals = entities.map((e) => modal({
    id: `modal-edit-tax-entity-${e.id}`,
    title: 'Editar razón social',
    description: e.isDefault ? 'Esta es la razón social default del cliente.' : undefined,
    body: renderTaxEntityForm(customer, e),
  })).join('');

  // Identidad técnica — sólo en modo técnico.
  const identity = techOnly(card('Identidad técnica', kv([
    ['External ID', `<code>${escapeHtml(customer.externalId)}</code>`],
    ['Slug', `<code>${escapeHtml(customer.slug)}</code>`],
    ['UUID interno', `<code>${escapeHtml(customer.id)}</code>`],
    ['Sequential ID', String(customer.sequentialId)],
    ['Creado', fmtDate(customer.createdAt)],
    ['Actualizado', fmtDate(customer.updatedAt)],
  ])));

  return panel({
      title: 'Datos comerciales',
      description: 'Información de la cuenta comercial. La identidad fiscal vive en las razones sociales (abajo).',
      body: comercialForm,
    })
    + panel({
      title: `Razones sociales · ${entities.length}`,
      description: 'Entidades fiscales (RFC) a las que se facturan los planes de este cliente. Una está marcada como default y la heredan los planes nuevos.',
      actions: newButton,
      body: entitiesList,
    })
    + newModal
    + editModals
    + identity;
}

function renderTaxEntityForm(customer: CustomerWithRelations, e: TaxEntityWithCounts | null): string {
  const action = e
    ? `/admin/customers/${escapeHtml(customer.externalId)}/tax-entities/${e.id}`
    : `/admin/customers/${escapeHtml(customer.externalId)}/tax-entities`;
  const v = (val: string | null | undefined): string => escapeHtml(val ?? '');
  return `
    <form method="post" action="${action}" class="space-y-0">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5 mb-6">
        ${formField({ label: 'Razón social', required: true, span: 2,
          hint: 'Como aparece en la Constancia de Situación Fiscal.',
          input: `<input required name="legal_name" value="${v(e?.legalName)}" placeholder="Transportes Pilot SA de CV" class="${INPUT_CLASS}">` })}
        ${formField({ label: 'Identificador externo', span: 2,
          hint: e
            ? 'Slug ASCII estable que se envía a NetSuite como external_id del customer. Cambiarlo después de que NetSuite ya lo creó rompe el mapeo.'
            : 'Slug ASCII estable para NetSuite (letras, números, <code>-</code>, <code>_</code>, <code>.</code>). Si lo dejas vacío se autogenera como <code>' + escapeHtml(customer.externalId) + '-N</code>.',
          input: `<input name="external_id" value="${v(e?.externalId)}" pattern="[A-Za-z0-9._-]+" placeholder="${escapeHtml(customer.externalId)}-filial" class="${INPUT_CLASS_MONO}">` })}
        ${formField({ label: 'RFC',
          input: `<input name="tax_identification_number" value="${v(e?.taxIdentificationNumber)}" class="${INPUT_CLASS_MONO} uppercase">` })}
        ${formField({ label: 'Régimen fiscal (código SAT)', hint: 'Ej. 601, 626.',
          input: `<input name="tax_regime" value="${v(e?.taxRegime)}" placeholder="601" class="${INPUT_CLASS_MONO}">` })}
        ${formField({ label: 'Uso CFDI default', hint: 'Ej. G03, P01.',
          input: `<input name="cfdi_use" value="${v(e?.cfdiUse)}" placeholder="G03" class="${INPUT_CLASS_MONO}">` })}
        ${formField({ label: 'Correo fiscal', hint: 'A donde se envían los CFDI.',
          input: `<input type="email" name="email" value="${v(e?.email)}" class="${INPUT_CLASS}">` })}
        ${formField({ label: 'Dirección línea 1', span: 2,
          input: `<input name="address_line1" value="${v(e?.addressLine1)}" class="${INPUT_CLASS}">` })}
        ${formField({ label: 'Dirección línea 2', span: 2,
          input: `<input name="address_line2" value="${v(e?.addressLine2)}" class="${INPUT_CLASS}">` })}
        ${formField({ label: 'Ciudad',
          input: `<input name="city" value="${v(e?.city)}" class="${INPUT_CLASS}">` })}
        ${formField({ label: 'Estado',
          input: `<input name="state" value="${v(e?.state)}" class="${INPUT_CLASS}">` })}
        ${formField({ label: 'CP',
          input: `<input name="zipcode" value="${v(e?.zipcode)}" class="${INPUT_CLASS_MONO}">` })}
        ${formField({ label: 'País (ISO 2 letras)',
          input: `<input name="country" value="${v(e?.country)}" maxlength="2" placeholder="MX" class="${INPUT_CLASS_MONO} uppercase">` })}
        ${techOnly(formField({ label: 'NetSuite internal ID', span: 2,
          hint: 'Internal id del customer en NetSuite para esta razón social. Vacío = dispatch por external id.',
          input: `<input name="netsuite_internal_id" value="${v(e?.netsuiteInternalId)}" placeholder="ej. 614" class="${INPUT_CLASS_MONO}">` }))}
        ${!e ? formField({ label: 'Marcar como default', span: 2,
          hint: 'La razón social default la heredan los planes nuevos. Si es la primera del cliente, se marca default automáticamente.',
          input: `<label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" name="is_default" value="1"> <span class="text-sm ink-soft">Usar como razón social default del cliente</span></label>` }) : ''}
      </div>
      <div class="flex items-center gap-3 pt-4" style="border-top: 1px solid var(--rule);">
        ${primaryButton(e ? 'Guardar razón social' : 'Crear razón social')}
      </div>
    </form>
  `;
}

// --- Punto de entrada -----------------------------------------------------

export function renderCustomerDetail(args: {
  customer: CustomerWithRelations;
  events: EventLog[];
  tab: CustomerTab;
  org: Organization;
  catalogEvents: CatalogEvent[];
  catalogEventOccurrences: Array<CatalogEventOccurrence & { catalogEvent: { code: string; name: string }; fee: { invoiceId: string } | null; taxEntity?: { legalName: string; isDefault: boolean } | null }>;
  customerCatalogEventPricings: CustomerCatalogEventPricingRow[];
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
    catalogEventOccurrences: args.catalogEventOccurrences.length,
  };

  const tabContent = (() => {
    switch (args.tab) {
      case 'resumen': return renderResumen(args.customer, metrics);
      case 'plan': return renderPlan(args.customer);
      case 'unidades': return renderUnidades(args.customer);
      case 'addons': return renderAddons(args.customer);
      case 'cargos': return renderCargosExtras({
        customer: args.customer,
        catalogEvents: args.catalogEvents,
        pricings: args.customerCatalogEventPricings,
        occurrences: args.catalogEventOccurrences,
      });
      case 'precios-eventos': return renderPreciosEventos({
        customer: args.customer,
        catalogEvents: args.catalogEvents,
        pricings: args.customerCatalogEventPricings,
      });
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
  opts: { displayTz: string; orgTimezone: string },
): string {
  const { displayTz, orgTimezone } = opts;
  const v = (k: string): string => escapeHtml(form[k] ?? '');

  const periodMonths = form.billing_period_months ?? '1';
  const periodOptions = [
    { value: '1', label: '1 mes — mensual' },
    { value: '3', label: '3 meses — trimestral' },
    { value: '6', label: '6 meses — semestral' },
    { value: '12', label: '12 meses — anual' },
  ].map((o) => `<option value="${o.value}" ${o.value === periodMonths ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');

  const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const anchorMonthOptions = ['<option value="">— (anclado al mes de inicio)</option>']
    .concat(monthNames.map((name, i) => {
      const n = i + 1;
      const selected = String(n) === form.billing_anchor_month ? 'selected' : '';
      return `<option value="${n}" ${selected}>${n} — ${name}</option>`;
    }))
    .join('');

  const triggerOptions = [
    { value: 'next_cycle', label: 'Al próximo cierre (acumular y cobrar al cerrar el periodo)' },
    { value: 'immediate', label: 'Inmediato (factura individual al recibir el evento)' },
  ].map((o) => {
    const selected = (form.nonrecurring_trigger ?? 'next_cycle') === o.value ? 'selected' : '';
    return `<option value="${o.value}" ${selected}>${escapeHtml(o.label)}</option>`;
  }).join('');

  const cycleModeOptions = [
    { value: 'unified', label: '1 factura — renta + setup + baja en un solo documento' },
    { value: 'split_by_kind', label: '2 facturas — recurrentes (renta + add-ons) y únicos (setup + baja) separados' },
  ].map((o) => {
    const selected = (form.cycle_invoice_mode ?? 'unified') === o.value ? 'selected' : '';
    return `<option value="${o.value}" ${selected}>${escapeHtml(o.label)}</option>`;
  }).join('');

  const identificationSection = formSection({
    title: 'Identificación',
    description: 'Datos básicos del cliente. El ID interno se genera automáticamente a partir del nombre.',
    body: `
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5">
        ${formField({
          label: 'Nombre comercial',
          required: true,
          span: 2,
          input: `<input required name="name" value="${v('name')}" placeholder="Transportes MARVA S.A. de C.V." class="${INPUT_CLASS}">`,
        })}
        ${formField({
          label: 'Moneda',
          required: true,
          hint: 'ISO 4217 — MXN, USD, EUR, etc.',
          input: `<input required name="currency" value="${escapeHtml(form.currency ?? 'MXN')}" maxlength="3" class="${INPUT_CLASS_MONO} uppercase">`,
        })}
        ${formField({
          label: 'Timezone (IANA)',
          span: 2,
          hint: 'Determina cómo se interpreta el día de corte.',
          input: `<input name="timezone" value="${v('timezone')}" placeholder="${escapeHtml(orgTimezone)} (default de la organización)" class="${INPUT_CLASS_MONO}">`,
        })}
      </div>
    `,
  });

  const taxEntitySection = formSection({
    title: 'Razón social default',
    description: 'Un cliente puede tener varias razones sociales; cada una corresponde a un customer distinto en NetSuite. El alta crea la primera (la default) — el RFC, dirección y NetSuite internal id se completan después en Datos fiscales.',
    body: `
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5">
        ${formField({
          label: 'Razón social',
          span: 2,
          hint: 'Como aparece en la Constancia de Situación Fiscal. Opcional: si se omite, se usa el nombre comercial y se puede corregir después.',
          input: `<input name="tax_entity_legal_name" value="${v('tax_entity_legal_name')}" placeholder="Aditivos y Vitaminas Mexicanas S.A. de C.V." class="${INPUT_CLASS}">`,
        })}
        ${formField({
          label: 'Identificador externo',
          span: 2,
          hint: 'Slug ASCII (letras, números, <code>-</code>, <code>_</code>, <code>.</code>) de esta razón social; es lo que se envía a NetSuite como external id del customer. Opcional: si se omite, hereda el ID interno del cliente.',
          input: `<input name="tax_entity_external_id" value="${v('tax_entity_external_id')}" pattern="[A-Za-z0-9._-]+" placeholder="ej. 1894" title="Solo letras, números y - _ ." class="${INPUT_CLASS_MONO}">`,
        })}
      </div>
    `,
  });

  const calendarSection = formSection({
    title: 'Calendario de facturación',
    description: 'Define cuándo arranca la suscripción, la frecuencia y el día de corte.',
    body: `
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5">
        ${formField({
          label: 'Inicio de suscripción',
          span: 2,
          hint: `Se interpreta en tu zona <code class="font-mono-pro">${escapeHtml(displayTz)}</code>. Si lo dejas vacío usa el momento del alta. Si es futuro, el cliente queda <em>programado</em> hasta que llegue la fecha.`,
          input: `<input type="datetime-local" name="subscription_at" value="${v('subscription_at')}" class="${INPUT_CLASS}">`,
        })}
        ${formField({
          label: 'Frecuencia',
          input: `<select name="billing_period_months" class="${INPUT_CLASS}">${periodOptions}</select>`,
        })}
        ${formField({
          label: 'Día de corte (1–28)',
          hint: 'Día del mes en que cierra el periodo.',
          input: `<input type="number" name="billing_anchor_day" min="1" max="28" value="${escapeHtml(form.billing_anchor_day ?? '1')}" class="${INPUT_CLASS_MONO} max-w-xs">`,
        })}
        ${formField({
          label: 'Mes ancla',
          span: 2,
          hint: 'Solo aplica si la frecuencia es trimestral / semestral / anual. Alinea el ciclo a un mes calendario específico.',
          input: `<select name="billing_anchor_month" class="${INPUT_CLASS}">${anchorMonthOptions}</select>`,
        })}
      </div>
    `,
  });

  const billingSection = formSection({
    title: 'Estructura de facturación',
    description: 'Cuándo se factura el paquete prepago y cómo se agrupan los conceptos al cerrar el periodo. El setup y la baja de servicios recurrentes se configuran a nivel del servicio.',
    body: `
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5">
        ${formField({
          label: 'Cuándo facturar los servicios prepago',
          hint: 'Aplica al paquete prepago completo (setup + N mensualidades) cuando llega el primer evento.',
          input: `<select name="nonrecurring_trigger" class="${INPUT_CLASS}">${triggerOptions}</select>`,
        })}
        ${formField({
          label: 'Estructura de la factura del cierre',
          hint: 'Cómo se agrupan los conceptos (renta, setup, baja) en la factura al cerrar el periodo.',
          input: `<select name="cycle_invoice_mode" class="${INPUT_CLASS}">${cycleModeOptions}</select>`,
        })}
      </div>
    `,
  });

  const actions = `
    <div class="flex items-center gap-3 pt-6 mt-2 border-t border-slate-200">
      ${primaryButton('Crear cliente')}
      ${secondaryLink('/admin/customers', 'Cancelar')}
      <span class="ml-auto text-xs ink-faint">Los datos fiscales completos (dirección, NetSuite ID) se editan después en la pestaña <strong>Datos fiscales</strong>.</span>
    </div>
  `;

  const form_ = `
    <form method="post" action="/admin/customers/new" class="space-y-0">
      ${identificationSection}
      ${taxEntitySection}
      ${calendarSection}
      ${billingSection}
      ${actions}
    </form>
  `;

  return pageTitle({
    eyebrow: 'Clientes',
    title: 'Nuevo cliente',
    description: 'En operación normal los clientes llegan por API desde Numaris. Este formulario es para casos manuales, demos o pruebas. Solo nombre, identificador y moneda son obligatorios; el resto tiene defaults razonables.',
    actions: secondaryLink('/admin/customers', '← Clientes'),
  }) + panel({ body: form_ });
}
