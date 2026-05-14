// Billing engine — v4.
//
// Cambios clave vs v3:
//   1. `billingPeriodFor` ahora calcula periodos de N meses (1/3/6/12) anclados
//      al día N del mes (1..28). El primer periodo de un customer puede ser un
//      "stub" parcial entre subscription_at y el primer anchor alineado.
//   2. Services con pricing_model='one_off':
//      - No tienen monthly recurrente ni setup.
//      - Cobran 1 vez per_unit cuando aparece la unit (kind='one_off').
//      - Si customer.nonrecurring_trigger='immediate' → 1 invoice individual
//        emitida al instante del POST /events (no participan en la cycle invoice).
//      - Si customer.nonrecurring_trigger='next_cycle' → la unit espera hasta
//        el cierre del ciclo y sale en la cycle invoice del customer.
//      - En ambos casos: la unit se marca `oneoff_billed_at` y no vuelve a
//        aparecer en facturas futuras.

import type {
  Customer,
  CustomerAddOn,
  Prisma,
  PrismaClient,
  Service,
  ServiceAddOn,
  Tax,
  Unit,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { DateTime } from 'luxon';
import { applyFraction, bankersRound, fraction4 } from './rounding.js';
import { isoUtc } from './tz.js';

export type FeeKind = 'monthly' | 'setup' | 'service_addon' | 'customer_addon' | 'one_off';

export type BilledUnitDetail = {
  external_id: string;
  label: string | null;
  active_from: string;
  active_to: string | null;
  billed_fraction: string;
  amount_cents: number;
};

export type ComputedFee = {
  kind: FeeKind;
  serviceId?: string;
  serviceAddOnId?: string;
  customerAddOnId?: string;
  description: string;
  units: string;
  unitAmountCents: number;
  preciseUnitAmount: string;
  amountCents: number;
  taxesAmountCents: number;
  taxesRate: number;
  totalAmountCents: number;
  billedUnitsDetail: BilledUnitDetail[];
  unitIds: string[];
};

export type ComputedInvoice = {
  fees: ComputedFee[];
  feesAmountCents: number;
  taxesAmountCents: number;
  totalAmountCents: number;
  unitsAnnex: Array<{
    external_id: string;
    label: string | null;
    fees: Array<{ kind: FeeKind; amount_cents: number }>;
  }>;
  appliedTaxes: Array<{ tax: Tax; amountCents: number }>;
};

export type ServiceForBilling = Service & {
  units: Unit[];
  addOns: ServiceAddOn[];
};

export type ComputeOptions = {
  customer: Customer;
  services: ServiceForBilling[];
  customerAddOns: CustomerAddOn[];
  taxes: Tax[];
  periodStart: Date;
  periodEnd: Date;
  daysInPeriod: number;
};

// ---------------------------------------------------------------------------
// Cycle invoice (POST /api/v1/invoices con customer_external_id).
// Agrega fees de TODOS los services del customer:
//   - recurring → monthly + setup + service_addon (prorrateados)
//   - one_off + next_cycle → one_off fees pendientes (marca billed)
//   - one_off + immediate → no participa (se factura per-ping aparte)
// + customer_addons flat (prorrateados) + tax stack.
// ---------------------------------------------------------------------------
export function computeCustomerInvoice(opts: ComputeOptions): ComputedInvoice {
  const { customer, services, customerAddOns, taxes, periodStart, periodEnd, daysInPeriod } = opts;
  const fees: ComputedFee[] = [];

  for (const service of services) {
    if (service.status !== 'active') continue;

    if (service.pricingModel === 'recurring') {
      const monthlyFee = buildMonthlyFee(service, service.units, periodStart, periodEnd, daysInPeriod);
      if (monthlyFee) fees.push(monthlyFee);
      const setupFee = buildSetupFee(service, service.units, periodStart, periodEnd);
      if (setupFee) fees.push(setupFee);
      for (const addOn of service.addOns) {
        if (addOn.activeFrom > periodEnd) continue;
        if (addOn.activeTo !== null && addOn.activeTo <= periodStart) continue;
        const addOnFrom = addOn.activeFrom < periodStart ? periodStart : addOn.activeFrom;
        const addOnTo = addOn.activeTo === null
          ? periodEnd
          : (addOn.activeTo > periodEnd ? periodEnd : addOn.activeTo);
        const fee = buildServiceAddOnFee(service, addOn, addOnFrom, addOnTo, daysInPeriod, periodStart, periodEnd);
        if (fee) fees.push(fee);
      }
    } else if (service.pricingModel === 'one_off') {
      // Solo si el customer acumula one-offs hasta el cierre. El modo
      // "immediate" emite invoice individual desde el handler de /events
      // (ver `computeOneOffPingInvoice`), no aquí.
      if (customer.nonrecurringTrigger !== 'next_cycle') continue;
      const fee = buildOneOffFee(service, service.units, periodStart, periodEnd);
      if (fee) fees.push(fee);
    }
  }

  for (const addOn of customerAddOns) {
    if (addOn.activeFrom > periodEnd) continue;
    if (addOn.activeTo !== null && addOn.activeTo <= periodStart) continue;
    const from = addOn.activeFrom < periodStart ? periodStart : addOn.activeFrom;
    const to = addOn.activeTo === null
      ? periodEnd
      : (addOn.activeTo > periodEnd ? periodEnd : addOn.activeTo);
    const fee = buildCustomerAddOnFee(addOn, from, to, daysInPeriod);
    if (fee) fees.push(fee);
  }

  return finalize(fees, taxes);
}

// ---------------------------------------------------------------------------
// Invoice individual por un único ping (modo immediate).
// Construida con UNA unit recién creada para un service one_off.
// ---------------------------------------------------------------------------
export function computeOneOffPingInvoice(opts: {
  service: Service;
  unit: Unit;
  taxes: Tax[];
}): ComputedInvoice {
  const { service, unit, taxes } = opts;
  if (service.pricingModel !== 'one_off') throw new Error('computeOneOffPingInvoice requires pricing_model=one_off');
  if (service.monthlyUnitAmountCents <= 0) throw new Error('one_off service has zero monthlyUnitAmountCents');

  const amountCents = service.monthlyUnitAmountCents;
  const detail: BilledUnitDetail = {
    external_id: unit.externalId,
    label: unit.label,
    active_from: isoUtc(unit.activeFrom),
    active_to: null,
    billed_fraction: '1.0000',
    amount_cents: amountCents,
  };
  const fee: ComputedFee = {
    kind: 'one_off',
    serviceId: service.id,
    description: `${service.name} — ${unit.label ?? unit.externalId} (one-off ping)`,
    units: '1.0000',
    unitAmountCents: amountCents,
    preciseUnitAmount: (amountCents / 100).toFixed(2),
    amountCents,
    taxesAmountCents: 0,
    taxesRate: 0,
    totalAmountCents: amountCents,
    billedUnitsDetail: [detail],
    unitIds: [unit.id],
  };
  return finalize([fee], taxes);
}

// ---------------------------------------------------------------------------
// Finalize: aplica taxes, balancea residuo y arma units_annex.
// ---------------------------------------------------------------------------
function finalize(fees: ComputedFee[], taxes: Tax[]): ComputedInvoice {
  const totalRate = taxes.reduce((acc, t) => acc + Number(t.rate), 0);
  const feesBeforeTax = fees.reduce((acc, f) => acc + f.amountCents, 0);
  const taxesAmountCents = bankersRound(feesBeforeTax * (totalRate / 100));
  const totalAmountCents = feesBeforeTax + taxesAmountCents;

  for (const fee of fees) {
    fee.taxesRate = totalRate;
    fee.taxesAmountCents = bankersRound(fee.amountCents * (totalRate / 100));
    fee.totalAmountCents = fee.amountCents + fee.taxesAmountCents;
  }
  const summedTax = fees.reduce((acc, f) => acc + f.taxesAmountCents, 0);
  const diff = taxesAmountCents - summedTax;
  if (diff !== 0 && fees.length > 0) {
    const last = fees[fees.length - 1]!;
    last.taxesAmountCents += diff;
    last.totalAmountCents += diff;
  }

  const appliedTaxes = taxes.map((tax) => ({
    tax,
    amountCents: bankersRound(feesBeforeTax * (Number(tax.rate) / 100)),
  }));

  const annexMap = new Map<string, { external_id: string; label: string | null; fees: Array<{ kind: FeeKind; amount_cents: number }> }>();
  for (const fee of fees) {
    for (const d of fee.billedUnitsDetail) {
      let entry = annexMap.get(d.external_id);
      if (!entry) { entry = { external_id: d.external_id, label: d.label, fees: [] }; annexMap.set(d.external_id, entry); }
      if (!entry.label && d.label) entry.label = d.label;
      entry.fees.push({ kind: fee.kind, amount_cents: d.amount_cents });
    }
  }
  const unitsAnnex = Array.from(annexMap.values()).sort((a, b) => (a.external_id < b.external_id ? -1 : 1));

  return { fees, feesAmountCents: feesBeforeTax, taxesAmountCents, totalAmountCents, unitsAnnex, appliedTaxes };
}

// ---------------------------------------------------------------------------
// Helpers de prorrateo.
// ---------------------------------------------------------------------------

function daysInInterval(from: Date, to: Date, tz = 'UTC'): number {
  const fromDt = DateTime.fromJSDate(from, { zone: 'utc' }).setZone(tz).startOf('day');
  const toDt = DateTime.fromJSDate(to, { zone: 'utc' }).setZone(tz).plus({ seconds: 1 }).startOf('day');
  return Math.max(0, Math.round(toDt.diff(fromDt, 'days').days));
}

type UnitEntry = { unit: Unit; activeFrom: Date; activeTo: Date | null; fraction: string };

function buildUnitEntries(
  units: Unit[],
  periodStart: Date,
  periodEnd: Date,
  daysInPeriod: number,
  clampFrom: Date = periodStart,
  clampTo: Date = periodEnd,
): UnitEntry[] {
  const entries: UnitEntry[] = [];
  for (const unit of units) {
    if (unit.activeTo !== null && unit.activeTo <= periodStart) continue;
    if (unit.activeFrom > periodEnd) continue;
    const effFrom = new Date(Math.max(unit.activeFrom.getTime(), clampFrom.getTime()));
    const effTo = unit.activeTo === null
      ? clampTo
      : new Date(Math.min(unit.activeTo.getTime(), clampTo.getTime()));
    if (effTo <= effFrom) continue;
    const days = daysInInterval(effFrom, effTo);
    if (days <= 0) continue;
    const fraction = days / Math.max(1, daysInPeriod);
    entries.push({ unit, activeFrom: effFrom, activeTo: unit.activeTo === null ? null : effTo, fraction: fraction4(fraction) });
  }
  entries.sort((a, b) => (a.unit.externalId < b.unit.externalId ? -1 : 1));
  return entries;
}

function distribute(entries: UnitEntry[], unitAmountCents: number): { amountCents: number; distributed: number[] } {
  const totalFraction = entries.reduce((acc, e) => acc + Number(e.fraction), 0);
  const amountCents = bankersRound(totalFraction * unitAmountCents);
  const nominal = entries.map((e) => applyFraction(e.fraction, unitAmountCents));
  const subtotal = nominal.reduce((a, b) => a + b, 0);
  const residual = amountCents - subtotal;
  let bestIdx = 0;
  let bestFraction = -1;
  for (let i = 0; i < entries.length; i++) {
    const v = Number(entries[i]!.fraction);
    if (v > bestFraction) { bestFraction = v; bestIdx = i; }
  }
  const distributed = [...nominal];
  if (residual !== 0 && distributed.length > 0) distributed[bestIdx] = distributed[bestIdx]! + residual;
  return { amountCents, distributed };
}

function buildMonthlyFee(service: Service, units: Unit[], periodStart: Date, periodEnd: Date, daysInPeriod: number): ComputedFee | null {
  if (service.monthlyUnitAmountCents <= 0) return null;
  const entries = buildUnitEntries(units, periodStart, periodEnd, daysInPeriod);
  if (entries.length === 0) return null;
  const { amountCents, distributed } = distribute(entries, service.monthlyUnitAmountCents);
  const totalFractionStr = fraction4(entries.reduce((acc, e) => acc + Number(e.fraction), 0));
  const detail: BilledUnitDetail[] = entries.map((e, i) => ({
    external_id: e.unit.externalId, label: e.unit.label,
    active_from: isoUtc(e.activeFrom), active_to: e.activeTo ? isoUtc(e.activeTo) : null,
    billed_fraction: e.fraction, amount_cents: distributed[i]!,
  }));
  return {
    kind: 'monthly', serviceId: service.id,
    description: `${service.name} — periodo (${entries.length} unidad${entries.length === 1 ? '' : 'es'}, factor ${totalFractionStr})`,
    units: totalFractionStr, unitAmountCents: service.monthlyUnitAmountCents,
    preciseUnitAmount: (service.monthlyUnitAmountCents / 100).toFixed(2),
    amountCents, taxesAmountCents: 0, taxesRate: 0, totalAmountCents: amountCents,
    billedUnitsDetail: detail, unitIds: entries.map((e) => e.unit.id),
  };
}

function buildSetupFee(service: Service, units: Unit[], periodStart: Date, periodEnd: Date): ComputedFee | null {
  if (service.setupUnitAmountCents <= 0) return null;
  const setupCandidates = units
    .filter((u) => u.setupBilledAt === null && u.activeFrom <= periodEnd && (u.activeTo === null || u.activeTo >= periodStart))
    .sort((a, b) => (a.externalId < b.externalId ? -1 : 1));
  if (setupCandidates.length === 0) return null;
  const detail: BilledUnitDetail[] = setupCandidates.map((u) => ({
    external_id: u.externalId, label: u.label,
    active_from: isoUtc(u.activeFrom), active_to: null,
    billed_fraction: '1.0000', amount_cents: service.setupUnitAmountCents,
  }));
  const amountCents = service.setupUnitAmountCents * setupCandidates.length;
  return {
    kind: 'setup', serviceId: service.id,
    description: `${service.name} — setup × ${setupCandidates.length}`,
    units: `${setupCandidates.length}.0000`, unitAmountCents: service.setupUnitAmountCents,
    preciseUnitAmount: (service.setupUnitAmountCents / 100).toFixed(2),
    amountCents, taxesAmountCents: 0, taxesRate: 0, totalAmountCents: amountCents,
    billedUnitsDetail: detail, unitIds: setupCandidates.map((u) => u.id),
  };
}

// One-off agrupado: 1 fee por service con TODAS las units one-off pendientes
// que se activaron dentro del periodo. Modo next_cycle.
function buildOneOffFee(service: Service, units: Unit[], periodStart: Date, periodEnd: Date): ComputedFee | null {
  if (service.monthlyUnitAmountCents <= 0) return null;
  const pending = units
    .filter((u) => u.oneoffBilledAt === null && u.activeFrom <= periodEnd && u.activeFrom >= periodStart)
    .sort((a, b) => (a.externalId < b.externalId ? -1 : 1));
  if (pending.length === 0) return null;
  const detail: BilledUnitDetail[] = pending.map((u) => ({
    external_id: u.externalId, label: u.label,
    active_from: isoUtc(u.activeFrom), active_to: null,
    billed_fraction: '1.0000', amount_cents: service.monthlyUnitAmountCents,
  }));
  const amountCents = service.monthlyUnitAmountCents * pending.length;
  return {
    kind: 'one_off', serviceId: service.id,
    description: `${service.name} — one-off × ${pending.length}`,
    units: `${pending.length}.0000`, unitAmountCents: service.monthlyUnitAmountCents,
    preciseUnitAmount: (service.monthlyUnitAmountCents / 100).toFixed(2),
    amountCents, taxesAmountCents: 0, taxesRate: 0, totalAmountCents: amountCents,
    billedUnitsDetail: detail, unitIds: pending.map((u) => u.id),
  };
}

function buildServiceAddOnFee(
  service: ServiceForBilling, addOn: ServiceAddOn, addOnFrom: Date, addOnTo: Date,
  daysInPeriod: number, periodStart: Date, periodEnd: Date,
): ComputedFee | null {
  if (addOn.amountCents <= 0) return null;
  const entries = buildUnitEntries(service.units, periodStart, periodEnd, daysInPeriod, addOnFrom, addOnTo);
  if (entries.length === 0) return null;
  const { amountCents, distributed } = distribute(entries, addOn.amountCents);
  const totalFractionStr = fraction4(entries.reduce((acc, e) => acc + Number(e.fraction), 0));
  const detail: BilledUnitDetail[] = entries.map((e, i) => ({
    external_id: e.unit.externalId, label: e.unit.label,
    active_from: isoUtc(e.activeFrom), active_to: e.activeTo ? isoUtc(e.activeTo) : null,
    billed_fraction: e.fraction, amount_cents: distributed[i]!,
  }));
  return {
    kind: 'service_addon', serviceId: service.id, serviceAddOnId: addOn.id,
    description: `${addOn.name} (${service.name}) — ${entries.length} unidad${entries.length === 1 ? '' : 'es'}, factor ${totalFractionStr}`,
    units: totalFractionStr, unitAmountCents: addOn.amountCents,
    preciseUnitAmount: (addOn.amountCents / 100).toFixed(2),
    amountCents, taxesAmountCents: 0, taxesRate: 0, totalAmountCents: amountCents,
    billedUnitsDetail: detail, unitIds: entries.map((e) => e.unit.id),
  };
}

function buildCustomerAddOnFee(addOn: CustomerAddOn, from: Date, to: Date, daysInPeriod: number): ComputedFee | null {
  if (addOn.amountCents <= 0) return null;
  const days = daysInInterval(from, to);
  if (days <= 0) return null;
  const fraction = days / Math.max(1, daysInPeriod);
  const fractionStr = fraction4(fraction);
  const amountCents = bankersRound(fraction * addOn.amountCents);
  return {
    kind: 'customer_addon', customerAddOnId: addOn.id,
    description: `${addOn.name} (flat · factor ${fractionStr})`,
    units: fractionStr, unitAmountCents: addOn.amountCents,
    preciseUnitAmount: (addOn.amountCents / 100).toFixed(2),
    amountCents, taxesAmountCents: 0, taxesRate: 0, totalAmountCents: amountCents,
    billedUnitsDetail: [{
      external_id: `customer-addon:${addOn.code}`, label: addOn.name,
      active_from: isoUtc(from), active_to: isoUtc(to),
      billed_fraction: fractionStr, amount_cents: amountCents,
    }],
    unitIds: [],
  };
}

// ---------------------------------------------------------------------------
// Period helper v4: intervalos N meses anclados a día N del mes.
//
// Si `reference` cae antes del primer anchor alineado, el periodo es un stub
// desde subscription_at hasta el primer anchor (los días parciales del primer
// mes se prorratean dentro de ese stub más corto).
// ---------------------------------------------------------------------------
export function billingPeriodFor(
  customer: Customer,
  tz: string,
  reference: Date = new Date(),
): { start: Date; end: Date; daysInPeriod: number } {
  const anchor = Math.min(28, Math.max(1, customer.billingAnchorDay));
  const months = customer.billingPeriodMonths;
  const subDt = DateTime.fromJSDate(customer.subscriptionAt, { zone: 'utc' }).setZone(tz).startOf('day');
  const refDt = DateTime.fromJSDate(reference, { zone: 'utc' }).setZone(tz).startOf('day');

  // Primer anchor alineado on-or-after subscription_at.
  let firstAnchor = subDt.set({ day: anchor });
  if (firstAnchor < subDt) firstAnchor = firstAnchor.plus({ months: 1 });

  if (refDt < firstAnchor) {
    // Stub: [subscription_at, primer anchor).
    const start = subDt;
    const end = firstAnchor.minus({ seconds: 1 });
    return {
      start: start.toUTC().toJSDate(),
      end: end.toUTC().toJSDate(),
      daysInPeriod: Math.max(1, Math.round(firstAnchor.diff(start, 'days').days)),
    };
  }

  // Periodo alineado regular que contiene `reference`.
  const monthsSinceAnchor = Math.floor(refDt.diff(firstAnchor, 'months').months);
  const periodIndex = Math.floor(monthsSinceAnchor / months);
  const start = firstAnchor.plus({ months: periodIndex * months });
  const end = start.plus({ months }).minus({ seconds: 1 });
  return {
    start: start.toUTC().toJSDate(),
    end: end.toUTC().toJSDate(),
    daysInPeriod: Math.max(1, Math.round(start.plus({ months }).diff(start, 'days').days)),
  };
}

export async function markSetupsBilled(
  prisma: PrismaClient,
  unitIds: string[],
  billedAt: Date = new Date(),
): Promise<void> {
  if (unitIds.length === 0) return;
  await prisma.unit.updateMany({
    where: { id: { in: unitIds }, setupBilledAt: null },
    data: { setupBilledAt: billedAt },
  });
}

export async function markOneOffBilled(
  prisma: PrismaClient,
  unitIds: string[],
  billedAt: Date = new Date(),
): Promise<void> {
  if (unitIds.length === 0) return;
  await prisma.unit.updateMany({
    where: { id: { in: unitIds }, oneoffBilledAt: null },
    data: { oneoffBilledAt: billedAt },
  });
}

// Helper para persistir las fees de un ComputedInvoice. Usado por el handler
// principal y por el handler de pings inmediatos.
export async function persistComputedInvoice(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  computed: ComputedInvoice,
): Promise<void> {
  for (let i = 0; i < computed.fees.length; i++) {
    const fee = computed.fees[i]!;
    await tx.fee.create({
      data: {
        invoiceId,
        serviceId: fee.serviceId ?? null,
        serviceAddOnId: fee.serviceAddOnId ?? null,
        customerAddOnId: fee.customerAddOnId ?? null,
        kind: fee.kind,
        description: fee.description,
        units: fee.units,
        unitAmountCents: fee.unitAmountCents,
        preciseUnitAmount: fee.preciseUnitAmount,
        amountCents: fee.amountCents,
        taxesAmountCents: fee.taxesAmountCents,
        taxesRate: new Decimal(fee.taxesRate) as unknown as Prisma.Decimal,
        totalAmountCents: fee.totalAmountCents,
        billedUnitsDetail: fee.billedUnitsDetail as object,
        position: i,
      },
    });
  }
}
