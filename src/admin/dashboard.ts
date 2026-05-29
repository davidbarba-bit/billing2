// Dashboard financiero del admin — métricas operativas para finanzas y
// ops, con "atención requerida" para items accionables.
//
// Diseñado para responder dos preguntas en un solo vistazo:
//   1. ¿Cómo va el negocio este mes? (MRR, MTD, customers activos)
//   2. ¿Qué necesita mi atención ahora? (dispatches fallidos, onboardings
//      pendientes, cambios de precio inminentes, NCs sin confirmar).

import type { Organization, PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import { adminContextStorage } from './context.js';
import {
  attentionItem,
  badge,
  card,
  escapeHtml,
  fmtMoney,
  metricCard,
  pageHeader,
} from './views.js';

type Metrics = {
  mrrCents: number;
  mrrCurrency: string;
  mtdCents: number;
  mtdCurrency: string;
  customersActive: number;
  customersPending: number;
  customersTotal: number;
  cyclesThisMonthTotal: number;
  cyclesThisMonthClosed: number;
  invoicesThisMonthTotal: number;
  invoicesThisMonthConfirmed: number;
  invoicesThisMonthFailed: number;
  invoicesThisMonthPending: number;
  attention: {
    dispatchFailed: number;
    onboardingsPending: number;
    pendingPriceChanges: number;
    cnsPendingDispatch: number;
  };
  monthLabel: string;
};

// Lee la zona del store y se asegura de devolver un valor IANA válido. Si
// no hay store (test isolation), usa la TZ de la org como fallback.
function tzFor(org: Organization): string {
  return adminContextStorage.getStore()?.displayTz ?? org.timezone ?? 'UTC';
}

// MRR = renta mensualizada de los compromisos vigentes. Considera units
// con billing ya iniciado (billingStartsAt ≤ now O activeFrom ≤ now si no
// hay override), service add-ons activos y customer add-ons activos.
// Para customers multi-mes, dividimos la renta entre billingPeriodMonths
// para obtener el equivalente mensual.
async function computeMrr(prisma: PrismaClient, org: Organization): Promise<{ cents: number; currency: string }> {
  const now = new Date();

  // Services activos con units activas. Cargamos en bloque y agregamos en
  // JS — el universo es pequeño (decenas a cientos de services).
  const services = await prisma.service.findMany({
    where: {
      organizationId: org.id,
      status: 'active',
      customer: { status: 'active' },
      // Sólo recurring contribuye al MRR. one_off es ingreso variable.
      pricingModel: 'recurring',
    },
    include: {
      customer: { select: { billingPeriodMonths: true, currency: true } },
      units: {
        where: { activeTo: null },
        select: { activeFrom: true, billingStartsAt: true },
      },
      addOns: {
        where: { activeTo: null },
        select: { amountCents: true },
      },
    },
  });

  let totalCents = 0;
  let currency = '';
  for (const svc of services) {
    const billingStarted = svc.units.filter((u) => {
      const start = u.billingStartsAt ?? u.activeFrom;
      return start <= now;
    }).length;
    if (billingStarted === 0) continue;
    const perUnitMonthly = svc.monthlyUnitAmountCents
      + svc.addOns.reduce((sum, a) => sum + a.amountCents, 0);
    // El monthly fee es la renta MENSUAL (independientemente de si el
    // customer cobra mensual o trimestral — el billingPeriodMonths sólo
    // afecta CUÁNDO se cobra, no el monto mensualizado equivalente).
    totalCents += billingStarted * perUnitMonthly;
    if (!currency) currency = svc.currency;
  }

  // Customer add-ons activos (renta flat por customer).
  const customerAddOns = await prisma.customerAddOn.findMany({
    where: {
      activeTo: null,
      customer: { organizationId: org.id, status: 'active' },
    },
    select: { amountCents: true, customer: { select: { currency: true } } },
  });
  for (const ao of customerAddOns) {
    totalCents += ao.amountCents;
    if (!currency) currency = ao.customer.currency;
  }

  return { cents: Math.round(totalCents), currency: currency || 'MXN' };
}

// MTD (month-to-date) = suma de invoices emitidas este mes calendario
// (en tz de display) que no estén voided.
async function computeMtd(prisma: PrismaClient, org: Organization): Promise<{ cents: number; currency: string }> {
  const tz = tzFor(org);
  const now = DateTime.now().setZone(tz);
  const start = now.startOf('month').toUTC().toJSDate();
  const end = now.endOf('month').toUTC().toJSDate();

  const invoices = await prisma.invoice.findMany({
    where: {
      organizationId: org.id,
      status: { not: 'voided' },
      issuingDate: { gte: start, lte: end },
    },
    select: { feesAmountCents: true, currency: true },
  });

  let totalCents = 0;
  let currency = '';
  for (const inv of invoices) {
    totalCents += inv.feesAmountCents;
    if (!currency) currency = inv.currency;
  }
  return { cents: totalCents, currency: currency || 'MXN' };
}

async function computeCycleProgress(
  prisma: PrismaClient,
  org: Organization,
): Promise<{ total: number; closed: number }> {
  const tz = tzFor(org);
  const now = DateTime.now().setZone(tz);
  const monthStart = now.startOf('month').toUTC().toJSDate();
  const monthEnd = now.endOf('month').toUTC().toJSDate();

  // Customers cuyo periodo en curso termina en este mes.
  const customersClosingThisMonth = await prisma.customer.count({
    where: {
      organizationId: org.id,
      status: 'active',
      currentBillingPeriodEndingAt: { gte: monthStart, lte: monthEnd },
    },
  });

  // Cuántos de esos ya tienen al menos una invoice no-voided cuya
  // periodTo cae en este mes (proxy razonable de "ya cerró").
  const closedInvoices = await prisma.invoice.findMany({
    where: {
      organizationId: org.id,
      status: { not: 'voided' },
      periodTo: { gte: monthStart, lte: monthEnd },
    },
    select: { customerId: true },
    distinct: ['customerId'],
  });

  return { total: customersClosingThisMonth, closed: closedInvoices.length };
}

async function computeInvoiceDispatch(
  prisma: PrismaClient,
  org: Organization,
): Promise<{ total: number; confirmed: number; failed: number; pending: number }> {
  const tz = tzFor(org);
  const now = DateTime.now().setZone(tz);
  const start = now.startOf('month').toUTC().toJSDate();
  const end = now.endOf('month').toUTC().toJSDate();

  const where = {
    organizationId: org.id,
    status: { not: 'voided' as const },
    issuingDate: { gte: start, lte: end },
  };
  const [total, confirmed, failed] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.count({ where: { ...where, externalDispatchStatus: 'confirmed' } }),
    prisma.invoice.count({ where: { ...where, externalDispatchStatus: 'failed' } }),
  ]);
  return { total, confirmed, failed, pending: Math.max(0, total - confirmed - failed) };
}

async function computeAttention(prisma: PrismaClient, org: Organization): Promise<Metrics['attention']> {
  const now = new Date();
  const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [dispatchFailed, onboardingsPending, pendingPriceChanges, cnsPendingDispatch] = await Promise.all([
    prisma.invoice.count({
      where: { organizationId: org.id, externalDispatchStatus: 'failed' },
    }),
    prisma.customer.count({
      where: { organizationId: org.id, status: 'pending' },
    }),
    prisma.service.count({
      where: {
        organizationId: org.id,
        status: 'active',
        pendingEffectiveFrom: { gte: now, lte: in7days },
      },
    }),
    prisma.creditNote.count({
      where: {
        organizationId: org.id,
        externalDispatchStatus: { notIn: ['confirmed', 'failed'] },
        createdAt: { lte: dayAgo },
      },
    }),
  ]);
  return { dispatchFailed, onboardingsPending, pendingPriceChanges, cnsPendingDispatch };
}

export async function computeDashboardMetrics(
  prisma: PrismaClient,
  org: Organization,
): Promise<Metrics> {
  const [mrr, mtd, activeCount, pendingCount, totalCount, cycleProgress, invoiceDispatch, attention] = await Promise.all([
    computeMrr(prisma, org),
    computeMtd(prisma, org),
    prisma.customer.count({ where: { organizationId: org.id, status: 'active' } }),
    prisma.customer.count({ where: { organizationId: org.id, status: 'pending' } }),
    prisma.customer.count({ where: { organizationId: org.id } }),
    computeCycleProgress(prisma, org),
    computeInvoiceDispatch(prisma, org),
    computeAttention(prisma, org),
  ]);

  const tz = tzFor(org);
  const monthLabel = DateTime.now()
    .setZone(tz)
    .setLocale('es')
    .toFormat('LLLL yyyy');

  return {
    mrrCents: mrr.cents,
    mrrCurrency: mrr.currency,
    mtdCents: mtd.cents,
    mtdCurrency: mtd.currency,
    customersActive: activeCount,
    customersPending: pendingCount,
    customersTotal: totalCount,
    cyclesThisMonthTotal: cycleProgress.total,
    cyclesThisMonthClosed: cycleProgress.closed,
    invoicesThisMonthTotal: invoiceDispatch.total,
    invoicesThisMonthConfirmed: invoiceDispatch.confirmed,
    invoicesThisMonthFailed: invoiceDispatch.failed,
    invoicesThisMonthPending: invoiceDispatch.pending,
    attention,
    monthLabel,
  };
}

// Renderiza el cuerpo del dashboard. Devuelve sólo el body — el handler
// se encarga del layout().
export function renderDashboardBody(args: {
  metrics: Metrics;
  org: Organization;
  dispatchFlagOn: boolean;
}): string {
  const { metrics: m, org, dispatchFlagOn } = args;

  // Métricas grandes — la fila prominente.
  const headlineMetrics = `
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      ${metricCard({
        label: 'MRR',
        value: fmtMoney(m.mrrCents, m.mrrCurrency),
        hint: 'Renta mensual recurrente (units activas + add-ons)',
        size: 'prominent',
      })}
      ${metricCard({
        label: `Facturación ${m.monthLabel}`,
        value: fmtMoney(m.mtdCents, m.mtdCurrency),
        hint: `${m.invoicesThisMonthTotal} factura${m.invoicesThisMonthTotal === 1 ? '' : 's'} emitida${m.invoicesThisMonthTotal === 1 ? '' : 's'}`,
        size: 'prominent',
        href: '/admin/invoices',
      })}
      ${metricCard({
        label: 'Clientes activos',
        value: String(m.customersActive),
        hint: m.customersPending > 0
          ? `${m.customersPending} pendiente${m.customersPending === 1 ? '' : 's'} de onboarding`
          : `${m.customersTotal} en total`,
        size: 'prominent',
        href: '/admin/customers',
        tone: m.customersPending > 0 ? 'warning' : 'default',
      })}
    </div>
  `;

  // Progreso del mes — cierres + dispatch.
  const cyclePct = m.cyclesThisMonthTotal > 0
    ? Math.round((m.cyclesThisMonthClosed / m.cyclesThisMonthTotal) * 100)
    : 0;
  const dispatchPct = m.invoicesThisMonthTotal > 0
    ? Math.round((m.invoicesThisMonthConfirmed / m.invoicesThisMonthTotal) * 100)
    : 0;
  const cyclesPending = Math.max(0, m.cyclesThisMonthTotal - m.cyclesThisMonthClosed);

  const progressRow = `
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
      <div class="bg-white border rounded p-5">
        <div class="text-xs uppercase text-gray-500 tracking-wider font-semibold mb-2">Cierres de ${m.monthLabel}</div>
        <div class="flex items-baseline gap-2">
          <span class="text-2xl font-semibold">${m.cyclesThisMonthClosed}</span>
          <span class="text-sm text-gray-500">/ ${m.cyclesThisMonthTotal}</span>
          <span class="ml-auto text-sm font-medium ${cyclePct === 100 ? 'text-green-700' : cyclePct >= 50 ? 'text-indigo-700' : 'text-amber-700'}">${cyclePct}%</span>
        </div>
        <div class="mt-2 h-2 bg-gray-100 rounded overflow-hidden">
          <div class="h-full bg-indigo-500" style="width: ${cyclePct}%"></div>
        </div>
        <div class="text-xs text-gray-500 mt-2">
          ${cyclesPending > 0
            ? `${cyclesPending} cliente${cyclesPending === 1 ? '' : 's'} pendiente${cyclesPending === 1 ? '' : 's'} de cerrar este mes`
            : 'Todos los clientes del mes ya cerraron'}
        </div>
      </div>

      <div class="bg-white border rounded p-5">
        <div class="flex items-center justify-between mb-2">
          <div class="text-xs uppercase text-gray-500 tracking-wider font-semibold">Dispatch a NetSuite</div>
          ${dispatchFlagOn ? badge('feature on', 'green') : badge('feature off', 'yellow')}
        </div>
        <div class="flex items-baseline gap-2">
          <span class="text-2xl font-semibold">${m.invoicesThisMonthConfirmed}</span>
          <span class="text-sm text-gray-500">/ ${m.invoicesThisMonthTotal} confirmadas</span>
          <span class="ml-auto text-sm font-medium ${dispatchPct === 100 ? 'text-green-700' : dispatchPct >= 80 ? 'text-indigo-700' : 'text-amber-700'}">${dispatchPct}%</span>
        </div>
        <div class="mt-2 h-2 bg-gray-100 rounded overflow-hidden flex">
          <div class="h-full bg-green-500" style="width: ${dispatchPct}%"></div>
          <div class="h-full bg-red-500" style="width: ${m.invoicesThisMonthTotal > 0 ? Math.round((m.invoicesThisMonthFailed / m.invoicesThisMonthTotal) * 100) : 0}%"></div>
        </div>
        <div class="text-xs text-gray-500 mt-2">
          ${m.invoicesThisMonthFailed > 0
            ? `<span class="text-red-700 font-medium">${m.invoicesThisMonthFailed} fallida${m.invoicesThisMonthFailed === 1 ? '' : 's'}</span> · ${m.invoicesThisMonthPending} pendiente${m.invoicesThisMonthPending === 1 ? '' : 's'}`
            : `${m.invoicesThisMonthPending} pendiente${m.invoicesThisMonthPending === 1 ? '' : 's'} de confirmar`}
        </div>
      </div>
    </div>
  `;

  // Atención requerida — items accionables.
  const attentionItems: string[] = [];
  if (m.attention.dispatchFailed > 0) {
    attentionItems.push(attentionItem({
      icon: '✗',
      tone: 'danger',
      text: `<strong>${m.attention.dispatchFailed}</strong> factura${m.attention.dispatchFailed === 1 ? '' : 's'} con dispatch fallido — NetSuite rechazó`,
      href: '/admin/invoices?dispatch=failed',
    }));
  }
  if (m.attention.onboardingsPending > 0) {
    attentionItems.push(attentionItem({
      icon: '⏳',
      tone: 'warning',
      text: `<strong>${m.attention.onboardingsPending}</strong> cliente${m.attention.onboardingsPending === 1 ? '' : 's'} pendiente${m.attention.onboardingsPending === 1 ? '' : 's'} de onboarding (creado por API, sin plan asignado)`,
      href: '/admin/customers?status=pending',
    }));
  }
  if (m.attention.pendingPriceChanges > 0) {
    attentionItems.push(attentionItem({
      icon: '⚠',
      tone: 'info',
      text: `<strong>${m.attention.pendingPriceChanges}</strong> cambio${m.attention.pendingPriceChanges === 1 ? '' : 's'} de precio entra${m.attention.pendingPriceChanges === 1 ? '' : 'n'} en vigor en los próximos 7 días`,
      href: '/admin/services',
    }));
  }
  if (m.attention.cnsPendingDispatch > 0) {
    attentionItems.push(attentionItem({
      icon: '⏳',
      tone: 'warning',
      text: `<strong>${m.attention.cnsPendingDispatch}</strong> nota${m.attention.cnsPendingDispatch === 1 ? '' : 's'} de crédito sin confirmar de NetSuite por más de 24h`,
      href: '/admin/credit-notes',
    }));
  }

  const attentionCard = attentionItems.length === 0
    ? card('Atención requerida',
        `<div class="text-sm text-gray-500 italic py-2">
          <span class="text-green-700 font-semibold">●</span> Sin items que requieran atención. Todo en orden.
        </div>`)
    : card(`Atención requerida (${attentionItems.length})`,
        `<ul class="-my-1.5">${attentionItems.join('')}</ul>`);

  // Card de organización — más compacta que la versión anterior.
  const orgCard = card('Esta organización', `
    <div class="text-sm space-y-1.5">
      <div><span class="text-gray-500">Slug:</span> <code class="text-gray-900">${escapeHtml(org.slug)}</code></div>
      <div><span class="text-gray-500">Timezone:</span> <code class="text-gray-900">${escapeHtml(org.timezone)}</code></div>
      <div><span class="text-gray-500">NetSuite callback:</span> ${org.netsuiteCallbackSecret
        ? '<span class="text-green-700">configurado</span>'
        : '<span class="text-yellow-700">no configurado</span>'}</div>
      <div><span class="text-gray-500">Dispatch flag:</span> ${dispatchFlagOn ? badge('on', 'green') : badge('off', 'yellow')}</div>
    </div>
  `);

  return pageHeader(`Buenos días — ${escapeHtml(m.monthLabel)}`)
    + headlineMetrics
    + progressRow
    + attentionCard
    + orgCard;
}
