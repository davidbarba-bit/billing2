// Billing engine — Numaris-native.
//
// Given a Service and a billing period [periodStart, periodEnd], computes:
//
//   - a "monthly" fee that aggregates per-unit prorrateo:
//       fraction_per_unit = active_days_within_period / days_in_period
//       amount_per_unit   = bankersRound(fraction × monthlyUnitAmountCents)
//   - one or more "setup" fees, one per unit whose `setup_billed_at` is
//     null at the moment of calculation (fresh installations).
//   - applied taxes from the service's tax_codes (or the customer's if the
//     service has none).
//
// Units are read directly from the `units` table — no event-log replay.

import type { AddOn, PrismaClient, Service, Tax, Unit } from '@prisma/client';
import { DateTime } from 'luxon';
import { applyFraction, bankersRound, fraction4 } from './rounding.js';
import { isoUtc } from './tz.js';

export type BilledUnitDetail = {
  external_id: string;
  label: string | null;
  active_from: string;
  active_to: string | null;
  billed_fraction: string;
  amount_cents: number;
};

export type FeeKind =
  | 'monthly'
  | 'setup'
  | 'addon_per_unit_monthly'
  | 'addon_flat_monthly';

export type ComputedFee = {
  kind: FeeKind;
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
  // For add-on fees we pin the addOnId so the engine can store it on the
  // Fee row (lets the admin / API show which add-on a fee came from).
  addOnId?: string;
};

export type ComputedInvoice = {
  fees: ComputedFee[];
  feesAmountCents: number;
  taxesAmountCents: number;
  totalAmountCents: number;
  unitsAnnex: Array<{ external_id: string; label: string | null; fees: Array<{ kind: string; amount_cents: number }> }>;
  appliedTaxes: Array<{ tax: Tax; amountCents: number }>;
};

export type ComputeOptions = {
  service: Service;
  periodStart: Date;
  periodEnd: Date; // inclusive
  daysInPeriod: number;
  units: Unit[];
  addOns: AddOn[]; // active or partially-active add-ons attached to this service
  taxes: Tax[];
};

export function computeInvoiceLines(opts: ComputeOptions): ComputedInvoice {
  const { service, periodStart, periodEnd, daysInPeriod, units, taxes } = opts;

  const tz = 'UTC'; // proration works on absolute days; tz boundaries are baked into periodStart/periodEnd.

  // --- monthly fee (1 line aggregating all active/partial units) ---
  type Per = { unit: Unit; activeFrom: Date; activeTo: Date | null; fraction: string };
  const monthlyEntries: Per[] = [];
  for (const unit of units) {
    if (!unit.activeFrom) continue;
    // Skip units that don't overlap the period at all.
    if (unit.activeTo !== null && unit.activeTo <= periodStart) continue;
    if (unit.activeFrom > periodEnd) continue;
    const effectiveFrom = unit.activeFrom < periodStart ? periodStart : unit.activeFrom;
    const effectiveTo = unit.activeTo === null
      ? periodEnd
      : (unit.activeTo > periodEnd ? periodEnd : unit.activeTo);
    const fromDt = DateTime.fromJSDate(effectiveFrom, { zone: 'utc' }).setZone(tz).startOf('day');
    const toDt = DateTime.fromJSDate(effectiveTo, { zone: 'utc' }).setZone(tz).plus({ seconds: 1 }).startOf('day');
    const days = Math.max(0, Math.round(toDt.diff(fromDt, 'days').days));
    const fractionRaw = days / Math.max(1, daysInPeriod);
    const fractionStr = fraction4(fractionRaw);
    monthlyEntries.push({
      unit,
      activeFrom: effectiveFrom,
      activeTo: unit.activeTo === null ? null : effectiveTo,
      fraction: fractionStr,
    });
  }
  monthlyEntries.sort((a, b) =>
    a.unit.externalId < b.unit.externalId ? -1 : a.unit.externalId > b.unit.externalId ? 1 : 0,
  );

  const monthlyFee = buildMonthlyFee(service, monthlyEntries);

  // --- setup fees (1 fee per unit whose setup hasn't been billed yet) ---
  const setupCandidates = units
    .filter((u) => u.setupBilledAt === null && u.activeFrom <= periodEnd && (u.activeTo === null || u.activeTo >= periodStart))
    .sort((a, b) => (a.externalId < b.externalId ? -1 : 1));

  const setupFees: ComputedFee[] = [];
  if (service.setupUnitAmountCents > 0 && setupCandidates.length > 0) {
    // One bundled setup fee that covers all newly-installed units this period.
    const detail: BilledUnitDetail[] = setupCandidates.map((u) => ({
      external_id: u.externalId,
      label: u.label,
      active_from: isoUtc(u.activeFrom),
      active_to: null,
      billed_fraction: '1.0000',
      amount_cents: service.setupUnitAmountCents,
    }));
    const setupCount = setupCandidates.length;
    const amountCents = service.setupUnitAmountCents * setupCount;
    setupFees.push({
      kind: 'setup',
      description: `Setup × ${setupCount} unidad${setupCount === 1 ? '' : 'es'}`,
      units: `${setupCount}.0000`,
      unitAmountCents: service.setupUnitAmountCents,
      preciseUnitAmount: (service.setupUnitAmountCents / 100).toFixed(2),
      amountCents,
      taxesAmountCents: 0, // patched below per-tax aggregation
      taxesRate: 0,
      totalAmountCents: amountCents,
      billedUnitsDetail: detail,
      unitIds: setupCandidates.map((u) => u.id),
    });
  }

  // --- add-on fees (recurring modifiers attached to the service) ---
  const addOnFees: ComputedFee[] = [];
  for (const addOn of opts.addOns) {
    // Active window of the add-on intersected with the invoice period.
    if (addOn.activeFrom > periodEnd) continue;
    if (addOn.activeTo !== null && addOn.activeTo <= periodStart) continue;
    const addOnFrom = addOn.activeFrom < periodStart ? periodStart : addOn.activeFrom;
    const addOnTo = addOn.activeTo === null
      ? periodEnd
      : (addOn.activeTo > periodEnd ? periodEnd : addOn.activeTo);

    if (addOn.pricingType === 'flat_monthly') {
      const fee = buildAddOnFlatFee(addOn, addOnFrom, addOnTo, daysInPeriod);
      if (fee) addOnFees.push(fee);
    } else if (addOn.pricingType === 'per_unit_monthly') {
      const fee = buildAddOnPerUnitFee(addOn, addOnFrom, addOnTo, daysInPeriod, units, periodStart, periodEnd);
      if (fee) addOnFees.push(fee);
    }
  }

  // --- apply taxes ---
  const totalRate = taxes.reduce((acc, t) => acc + Number(t.rate), 0);
  const feesBeforeTax = (monthlyFee ? monthlyFee.amountCents : 0)
    + setupFees.reduce((acc, f) => acc + f.amountCents, 0)
    + addOnFees.reduce((acc, f) => acc + f.amountCents, 0);
  const taxesAmountCents = bankersRound(feesBeforeTax * (totalRate / 100));
  const totalAmountCents = feesBeforeTax + taxesAmountCents;

  // Split tax amount per-fee (proportional). Then compute applied_taxes per Tax.
  const fees: ComputedFee[] = [];
  if (monthlyFee) fees.push(monthlyFee);
  fees.push(...setupFees);
  fees.push(...addOnFees);
  for (const fee of fees) {
    fee.taxesRate = totalRate;
    fee.taxesAmountCents = bankersRound(fee.amountCents * (totalRate / 100));
    fee.totalAmountCents = fee.amountCents + fee.taxesAmountCents;
  }
  // Reconcile rounding drift on taxes_amount_cents (sum of per-fee should match invoice taxes).
  const summedTax = fees.reduce((acc, f) => acc + f.taxesAmountCents, 0);
  const diff = taxesAmountCents - summedTax;
  if (diff !== 0 && fees.length > 0) {
    const last = fees[fees.length - 1]!;
    last.taxesAmountCents += diff;
    last.totalAmountCents += diff;
  }

  // Applied taxes (one row per tax — each tax sees the full feesBeforeTax base).
  const appliedTaxes = taxes.map((tax) => ({
    tax,
    amountCents: bankersRound(feesBeforeTax * (Number(tax.rate) / 100)),
  }));

  // Build units annex (consolidated per unit, across both monthly + setup fees).
  const annexMap = new Map<string, { external_id: string; label: string | null; fees: Array<{ kind: string; amount_cents: number }> }>();
  for (const fee of fees) {
    for (const detail of fee.billedUnitsDetail) {
      let entry = annexMap.get(detail.external_id);
      if (!entry) {
        entry = { external_id: detail.external_id, label: detail.label, fees: [] };
        annexMap.set(detail.external_id, entry);
      }
      if (!entry.label && detail.label) entry.label = detail.label;
      entry.fees.push({ kind: fee.kind, amount_cents: detail.amount_cents });
    }
  }
  const unitsAnnex = Array.from(annexMap.values()).sort((a, b) =>
    a.external_id < b.external_id ? -1 : 1,
  );

  return {
    fees,
    feesAmountCents: feesBeforeTax,
    taxesAmountCents,
    totalAmountCents,
    unitsAnnex,
    appliedTaxes,
  };
}

function buildMonthlyFee(
  service: Service,
  entries: Array<{ unit: Unit; activeFrom: Date; activeTo: Date | null; fraction: string }>,
): ComputedFee | null {
  if (service.monthlyUnitAmountCents <= 0 || entries.length === 0) return null;
  const unitAmountCents = service.monthlyUnitAmountCents;

  // Distribute amounts so Σ amount_cents == fee.amount_cents.
  const totalFraction = entries.reduce((acc, e) => acc + Number(e.fraction), 0);
  const totalFractionStr = fraction4(totalFraction);
  const feeAmountCents = bankersRound(totalFraction * unitAmountCents);
  const nominal = entries.map((e) => applyFraction(e.fraction, unitAmountCents));
  const subtotal = nominal.reduce((a, b) => a + b, 0);
  const residual = feeAmountCents - subtotal;

  let bestIdx = 0;
  let bestFraction = -1;
  for (let i = 0; i < entries.length; i++) {
    const v = Number(entries[i]!.fraction);
    if (v > bestFraction) {
      bestFraction = v;
      bestIdx = i;
    }
  }
  const distributed = [...nominal];
  if (residual !== 0) distributed[bestIdx] = distributed[bestIdx]! + residual;

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
    description: `Cobro mensual — ${entries.length} unidad${entries.length === 1 ? '' : 'es'} (factor ${totalFractionStr})`,
    units: totalFractionStr,
    unitAmountCents,
    preciseUnitAmount: (unitAmountCents / 100).toFixed(2),
    amountCents: feeAmountCents,
    taxesAmountCents: 0, // filled in by caller after taxes are resolved
    taxesRate: 0,
    totalAmountCents: feeAmountCents,
    billedUnitsDetail: detail,
    unitIds: entries.map((e) => e.unit.id),
  };
}

// Helper used by route handlers: given a service "now", returns the
// current billing period [start, end] aligned to its billing_time in the
// service's customer applicable timezone.
export function billingPeriodFor(service: Service, tz: string, reference: Date = new Date()): { start: Date; end: Date; daysInPeriod: number } {
  if (service.billingTime === 'anniversary') {
    const anchor = DateTime.fromJSDate(service.subscriptionAt, { zone: 'utc' }).setZone(tz);
    let candidate = DateTime.fromJSDate(reference, { zone: 'utc' }).setZone(tz).startOf('day').set({ day: anchor.day });
    if (candidate > DateTime.fromJSDate(reference, { zone: 'utc' }).setZone(tz)) {
      candidate = candidate.minus({ months: 1 });
    }
    const start = candidate.startOf('day').set({ day: anchor.day });
    const end = start.plus({ months: 1 }).minus({ seconds: 1 });
    return {
      start: start.toUTC().toJSDate(),
      end: end.toUTC().toJSDate(),
      daysInPeriod: Math.round(start.plus({ months: 1 }).diff(start, 'days').days),
    };
  }
  // calendar billing: full calendar month in tz.
  const startDt = DateTime.fromJSDate(reference, { zone: 'utc' }).setZone(tz).startOf('month');
  const endDt = startDt.plus({ months: 1 }).minus({ seconds: 1 });
  return {
    start: startDt.toUTC().toJSDate(),
    end: endDt.toUTC().toJSDate(),
    daysInPeriod: Math.round(startDt.plus({ months: 1 }).diff(startDt, 'days').days),
  };
}

// Helper: count active days in an inclusive interval [from, to] when
// expressed as `endOfInterval + 1s` boundary (matches `buildMonthlyFee`).
function daysInInterval(from: Date, to: Date): number {
  const fromDt = DateTime.fromJSDate(from, { zone: 'utc' }).startOf('day');
  const toDt = DateTime.fromJSDate(to, { zone: 'utc' }).plus({ seconds: 1 }).startOf('day');
  return Math.max(0, Math.round(toDt.diff(fromDt, 'days').days));
}

// Add-on of pricing type "flat_monthly" — one fee, prorated only by the
// add-on's own active days in the period (independent of unit count).
function buildAddOnFlatFee(
  addOn: AddOn,
  from: Date,
  to: Date,
  daysInPeriod: number,
): ComputedFee | null {
  const days = daysInInterval(from, to);
  if (days <= 0) return null;
  const fraction = days / Math.max(1, daysInPeriod);
  const fractionStr = fraction4(fraction);
  const amountCents = bankersRound(fraction * addOn.amountCents);
  return {
    kind: 'addon_flat_monthly',
    description: `${addOn.name} (flat · factor ${fractionStr})`,
    units: fractionStr,
    unitAmountCents: addOn.amountCents,
    preciseUnitAmount: (addOn.amountCents / 100).toFixed(2),
    amountCents,
    taxesAmountCents: 0,
    taxesRate: 0,
    totalAmountCents: amountCents,
    // The "billed_units_detail" for a flat add-on has a single synthetic
    // entry so the units annex still aggregates cleanly per service.
    billedUnitsDetail: [{
      external_id: `addon:${addOn.code}`,
      label: addOn.name,
      active_from: isoUtc(from),
      active_to: isoUtc(to),
      billed_fraction: fractionStr,
      amount_cents: amountCents,
    }],
    unitIds: [],
    addOnId: addOn.id,
  };
}

// Add-on of pricing type "per_unit_monthly" — one fee, summing prorated
// contributions per unit. Mirrors buildMonthlyFee but with the add-on's
// own active interval clipping the unit's effective days.
function buildAddOnPerUnitFee(
  addOn: AddOn,
  addOnFrom: Date,
  addOnTo: Date,
  daysInPeriod: number,
  units: Unit[],
  periodStart: Date,
  periodEnd: Date,
): ComputedFee | null {
  type Per = { unit: Unit; activeFrom: Date; activeTo: Date | null; fraction: string };
  const entries: Per[] = [];
  for (const unit of units) {
    // Skip units that don't overlap the period at all.
    if (unit.activeTo !== null && unit.activeTo <= periodStart) continue;
    if (unit.activeFrom > periodEnd) continue;
    // Effective overlap = (unit window) ∩ (add-on window) ∩ (period window)
    const fromCandidates = [unit.activeFrom, addOnFrom, periodStart];
    const toCandidates: Date[] = [
      unit.activeTo ?? periodEnd,
      addOnTo,
      periodEnd,
    ];
    const start = new Date(Math.max(...fromCandidates.map((d) => d.getTime())));
    const end = new Date(Math.min(...toCandidates.map((d) => d.getTime())));
    if (end <= start) continue;
    const days = daysInInterval(start, end);
    if (days <= 0) continue;
    const fraction = days / Math.max(1, daysInPeriod);
    entries.push({
      unit,
      activeFrom: start,
      activeTo: unit.activeTo === null ? null : end,
      fraction: fraction4(fraction),
    });
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) =>
    a.unit.externalId < b.unit.externalId ? -1 : a.unit.externalId > b.unit.externalId ? 1 : 0,
  );

  const totalFraction = entries.reduce((acc, e) => acc + Number(e.fraction), 0);
  const totalFractionStr = fraction4(totalFraction);
  const amountCents = bankersRound(totalFraction * addOn.amountCents);
  const nominal = entries.map((e) => applyFraction(e.fraction, addOn.amountCents));
  const subtotal = nominal.reduce((a, b) => a + b, 0);
  const residual = amountCents - subtotal;
  let bestIdx = 0;
  let bestFraction = -1;
  for (let i = 0; i < entries.length; i++) {
    const v = Number(entries[i]!.fraction);
    if (v > bestFraction) { bestFraction = v; bestIdx = i; }
  }
  const distributed = [...nominal];
  if (residual !== 0) distributed[bestIdx] = distributed[bestIdx]! + residual;

  const detail: BilledUnitDetail[] = entries.map((e, i) => ({
    external_id: e.unit.externalId,
    label: e.unit.label,
    active_from: isoUtc(e.activeFrom),
    active_to: e.activeTo ? isoUtc(e.activeTo) : null,
    billed_fraction: e.fraction,
    amount_cents: distributed[i]!,
  }));

  return {
    kind: 'addon_per_unit_monthly',
    description: `${addOn.name} — ${entries.length} unidad${entries.length === 1 ? '' : 'es'} (factor ${totalFractionStr})`,
    units: totalFractionStr,
    unitAmountCents: addOn.amountCents,
    preciseUnitAmount: (addOn.amountCents / 100).toFixed(2),
    amountCents,
    taxesAmountCents: 0,
    taxesRate: 0,
    totalAmountCents: amountCents,
    billedUnitsDetail: detail,
    unitIds: entries.map((e) => e.unit.id),
    addOnId: addOn.id,
  };
}

// Apply the side-effect of an invoice on the units: mark setup_billed_at
// for units whose setup just got captured. Caller must do this inside the
// same transaction as the invoice create.
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
