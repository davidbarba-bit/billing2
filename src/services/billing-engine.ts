// Billing engine — v3.
//
// `computeCustomerInvoice` takes a Customer + all its active Services + each
// service's units + service-level add-ons + customer-level add-ons, and a
// billing period [periodStart, periodEnd]. Produces:
//
//   - 1 monthly fee per service that has units active in the period.
//   - N setup fees per service (one per unit needing setup-billing this period).
//   - K service_addon fees: 1 per active ServiceAddOn per service (per-unit math).
//   - M customer_addon fees: 1 per active CustomerAddOn (flat math, no units).
//   - Applied taxes computed on the total.

import type {
  Customer,
  CustomerAddOn,
  PrismaClient,
  Service,
  ServiceAddOn,
  Tax,
  Unit,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { applyFraction, bankersRound, fraction4 } from './rounding.js';
import { isoUtc } from './tz.js';

export type FeeKind = 'monthly' | 'setup' | 'service_addon' | 'customer_addon';

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

export function computeCustomerInvoice(opts: ComputeOptions): ComputedInvoice {
  const { services, customerAddOns, taxes, periodStart, periodEnd, daysInPeriod } = opts;
  const fees: ComputedFee[] = [];

  // Per-service fees.
  for (const service of services) {
    if (service.status !== 'active') continue;
    // Monthly fee (aggregated per-unit prorrateo for THIS service).
    const monthlyFee = buildMonthlyFee(service, service.units, periodStart, periodEnd, daysInPeriod);
    if (monthlyFee) fees.push(monthlyFee);
    // Setup fees: one bundled fee per service for units with setup pending.
    const setupFee = buildSetupFee(service, service.units, periodStart, periodEnd);
    if (setupFee) fees.push(setupFee);
    // Service add-ons: per-unit recurring modifiers tied to this service.
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
  }

  // Customer-level flat add-ons.
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

  // --- apply taxes ---
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

  // Units annex consolidated across all fees.
  const annexMap = new Map<string, { external_id: string; label: string | null; fees: Array<{ kind: FeeKind; amount_cents: number }> }>();
  for (const fee of fees) {
    for (const d of fee.billedUnitsDetail) {
      let entry = annexMap.get(d.external_id);
      if (!entry) {
        entry = { external_id: d.external_id, label: d.label, fees: [] };
        annexMap.set(d.external_id, entry);
      }
      if (!entry.label && d.label) entry.label = d.label;
      entry.fees.push({ kind: fee.kind, amount_cents: d.amount_cents });
    }
  }
  const unitsAnnex = Array.from(annexMap.values()).sort((a, b) =>
    a.external_id < b.external_id ? -1 : 1,
  );

  return { fees, feesAmountCents: feesBeforeTax, taxesAmountCents, totalAmountCents, unitsAnnex, appliedTaxes };
}

// ---------------------------------------------------------------------------
// Helpers.
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
    entries.push({
      unit,
      activeFrom: effFrom,
      activeTo: unit.activeTo === null ? null : effTo,
      fraction: fraction4(fraction),
    });
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

function buildMonthlyFee(
  service: Service,
  units: Unit[],
  periodStart: Date,
  periodEnd: Date,
  daysInPeriod: number,
): ComputedFee | null {
  if (service.monthlyUnitAmountCents <= 0) return null;
  const entries = buildUnitEntries(units, periodStart, periodEnd, daysInPeriod);
  if (entries.length === 0) return null;
  const { amountCents, distributed } = distribute(entries, service.monthlyUnitAmountCents);
  const totalFractionStr = fraction4(entries.reduce((acc, e) => acc + Number(e.fraction), 0));
  const detail: BilledUnitDetail[] = entries.map((e, i) => ({
    external_id: e.unit.externalId,
    label: e.unit.label,
    active_from: isoUtc(e.activeFrom),
    active_to: e.activeTo ? isoUtc(e.activeTo) : null,
    billed_fraction: e.fraction,
    amount_cents: distributed[i]!,
  }));
  return {
    kind: 'monthly',
    serviceId: service.id,
    description: `${service.name} — mensual (${entries.length} unidad${entries.length === 1 ? '' : 'es'}, factor ${totalFractionStr})`,
    units: totalFractionStr,
    unitAmountCents: service.monthlyUnitAmountCents,
    preciseUnitAmount: (service.monthlyUnitAmountCents / 100).toFixed(2),
    amountCents,
    taxesAmountCents: 0,
    taxesRate: 0,
    totalAmountCents: amountCents,
    billedUnitsDetail: detail,
    unitIds: entries.map((e) => e.unit.id),
  };
}

function buildSetupFee(
  service: Service,
  units: Unit[],
  periodStart: Date,
  periodEnd: Date,
): ComputedFee | null {
  if (service.setupUnitAmountCents <= 0) return null;
  const setupCandidates = units
    .filter((u) => u.setupBilledAt === null
      && u.activeFrom <= periodEnd
      && (u.activeTo === null || u.activeTo >= periodStart))
    .sort((a, b) => (a.externalId < b.externalId ? -1 : 1));
  if (setupCandidates.length === 0) return null;
  const detail: BilledUnitDetail[] = setupCandidates.map((u) => ({
    external_id: u.externalId,
    label: u.label,
    active_from: isoUtc(u.activeFrom),
    active_to: null,
    billed_fraction: '1.0000',
    amount_cents: service.setupUnitAmountCents,
  }));
  const amountCents = service.setupUnitAmountCents * setupCandidates.length;
  return {
    kind: 'setup',
    serviceId: service.id,
    description: `${service.name} — setup × ${setupCandidates.length}`,
    units: `${setupCandidates.length}.0000`,
    unitAmountCents: service.setupUnitAmountCents,
    preciseUnitAmount: (service.setupUnitAmountCents / 100).toFixed(2),
    amountCents,
    taxesAmountCents: 0,
    taxesRate: 0,
    totalAmountCents: amountCents,
    billedUnitsDetail: detail,
    unitIds: setupCandidates.map((u) => u.id),
  };
}

function buildServiceAddOnFee(
  service: ServiceForBilling,
  addOn: ServiceAddOn,
  addOnFrom: Date,
  addOnTo: Date,
  daysInPeriod: number,
  periodStart: Date,
  periodEnd: Date,
): ComputedFee | null {
  if (addOn.amountCents <= 0) return null;
  // Clamp each unit's active interval to BOTH the period and the add-on's
  // own active interval.
  const entries = buildUnitEntries(service.units, periodStart, periodEnd, daysInPeriod, addOnFrom, addOnTo);
  if (entries.length === 0) return null;
  const { amountCents, distributed } = distribute(entries, addOn.amountCents);
  const totalFractionStr = fraction4(entries.reduce((acc, e) => acc + Number(e.fraction), 0));
  const detail: BilledUnitDetail[] = entries.map((e, i) => ({
    external_id: e.unit.externalId,
    label: e.unit.label,
    active_from: isoUtc(e.activeFrom),
    active_to: e.activeTo ? isoUtc(e.activeTo) : null,
    billed_fraction: e.fraction,
    amount_cents: distributed[i]!,
  }));
  return {
    kind: 'service_addon',
    serviceId: service.id,
    serviceAddOnId: addOn.id,
    description: `${addOn.name} (${service.name}) — ${entries.length} unidad${entries.length === 1 ? '' : 'es'}, factor ${totalFractionStr}`,
    units: totalFractionStr,
    unitAmountCents: addOn.amountCents,
    preciseUnitAmount: (addOn.amountCents / 100).toFixed(2),
    amountCents,
    taxesAmountCents: 0,
    taxesRate: 0,
    totalAmountCents: amountCents,
    billedUnitsDetail: detail,
    unitIds: entries.map((e) => e.unit.id),
  };
}

function buildCustomerAddOnFee(
  addOn: CustomerAddOn,
  from: Date,
  to: Date,
  daysInPeriod: number,
): ComputedFee | null {
  if (addOn.amountCents <= 0) return null;
  const days = daysInInterval(from, to);
  if (days <= 0) return null;
  const fraction = days / Math.max(1, daysInPeriod);
  const fractionStr = fraction4(fraction);
  const amountCents = bankersRound(fraction * addOn.amountCents);
  return {
    kind: 'customer_addon',
    customerAddOnId: addOn.id,
    description: `${addOn.name} (flat · factor ${fractionStr})`,
    units: fractionStr,
    unitAmountCents: addOn.amountCents,
    preciseUnitAmount: (addOn.amountCents / 100).toFixed(2),
    amountCents,
    taxesAmountCents: 0,
    taxesRate: 0,
    totalAmountCents: amountCents,
    // Synthetic single-row detail so the annex still has the add-on reflected.
    billedUnitsDetail: [{
      external_id: `customer-addon:${addOn.code}`,
      label: addOn.name,
      active_from: isoUtc(from),
      active_to: isoUtc(to),
      billed_fraction: fractionStr,
      amount_cents: amountCents,
    }],
    unitIds: [],
  };
}

// ---------------------------------------------------------------------------
// Period helpers.
// ---------------------------------------------------------------------------

export function billingPeriodFor(
  customer: Customer,
  tz: string,
  reference: Date = new Date(),
): { start: Date; end: Date; daysInPeriod: number } {
  if (customer.billingTime === 'anniversary') {
    const anchor = DateTime.fromJSDate(customer.subscriptionAt, { zone: 'utc' }).setZone(tz);
    const ref = DateTime.fromJSDate(reference, { zone: 'utc' }).setZone(tz);
    let candidate = ref.startOf('day').set({ day: anchor.day });
    if (candidate > ref) candidate = candidate.minus({ months: 1 });
    const start = candidate.startOf('day').set({ day: anchor.day });
    const end = start.plus({ months: 1 }).minus({ seconds: 1 });
    return {
      start: start.toUTC().toJSDate(),
      end: end.toUTC().toJSDate(),
      daysInPeriod: Math.round(start.plus({ months: 1 }).diff(start, 'days').days),
    };
  }
  const startDt = DateTime.fromJSDate(reference, { zone: 'utc' }).setZone(tz).startOf('month');
  const endDt = startDt.plus({ months: 1 }).minus({ seconds: 1 });
  return {
    start: startDt.toUTC().toJSDate(),
    end: endDt.toUTC().toJSDate(),
    daysInPeriod: Math.round(startDt.plus({ months: 1 }).diff(startDt, 'days').days),
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
