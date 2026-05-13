// Proration engine. Given a billing period and the events that landed in it,
// computes the per-unit `billed_units_detail[]` rows that the invoice and
// the current_usage response surface.
//
// Spec D13 + invariant #17:
//   - `billed_fraction` is a string decimal of EXACTLY 4 digits.
//   - For `unique_count_agg recurring:true prorated:true`:
//     fraction = active_days_within_period / days_in_period
//   - For `unique_count_agg recurring:false` (setup): 1.0000 per new unit.
//   - Σ billed_units_detail[].amount_cents == fee.amount_cents
//     The residual cent goes to the unit with the largest `billed_fraction`;
//     ties broken alphabetically by `external_id`.

import { DateTime } from 'luxon';
import { applyFraction, bankersRound, fraction4 } from './rounding.js';
import { isoUtc } from './tz.js';

export type EventLite = {
  timestamp: Date;
  externalSubscriptionId: string;
  properties: {
    unit_external_id?: string;
    unit_label?: string;
    kind?: string;
    operation_type?: 'add' | 'remove';
  } & Record<string, unknown>;
};

export type UnitInterval = {
  externalId: string;
  label: string | null;
  // Active intervals clipped to the period; multiple intervals if the unit
  // was added/removed multiple times within the same period.
  intervals: Array<{ start: Date; end: Date | null }>;
};

export type BilledUnitDetail = {
  external_id: string;
  label: string | null;
  active_from: string;
  active_to: string | null;
  billed_fraction: string;
  amount_cents: number;
};

// Build a list of per-unit active intervals from the events that landed in
// the period for this subscription/BM. Add/remove operations are paired in
// chronological order. A unit can have multiple intervals if it was added,
// removed, and re-added.
export function buildUnitIntervals(
  events: EventLite[],
  period: { start: Date; end: Date },
  unitLabels: Map<string, string | null>,
): UnitInterval[] {
  type Per = { intervals: Array<{ start: Date | null; end: Date | null }>; label: string | null };
  const map = new Map<string, Per>();

  const sorted = [...events].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  for (const ev of sorted) {
    const unitId = ev.properties?.unit_external_id;
    if (!unitId) continue;
    let per = map.get(unitId);
    if (!per) {
      per = { intervals: [], label: unitLabels.get(unitId) ?? null };
      map.set(unitId, per);
    }
    const op = ev.properties?.operation_type ?? 'add';
    const label = ev.properties?.unit_label;
    if (label !== undefined) per.label = label;
    if (op === 'add') {
      per.intervals.push({ start: ev.timestamp, end: null });
    } else if (op === 'remove') {
      const last = per.intervals[per.intervals.length - 1];
      if (last && last.end === null) {
        last.end = ev.timestamp;
      } else {
        // Standalone remove: model as a zero-duration interval at `timestamp`.
        per.intervals.push({ start: ev.timestamp, end: ev.timestamp });
      }
    }
  }

  const clipped: UnitInterval[] = [];
  for (const [unitId, per] of map.entries()) {
    const intervals: Array<{ start: Date; end: Date | null }> = [];
    for (const iv of per.intervals) {
      if (!iv.start) continue;
      const start = iv.start < period.start ? period.start : iv.start;
      const rawEnd = iv.end ?? null;
      const endClipped = rawEnd && rawEnd > period.end ? period.end : rawEnd;
      // Skip intervals fully before or after the period.
      if (rawEnd && rawEnd < period.start) continue;
      if (iv.start > period.end) continue;
      intervals.push({ start, end: endClipped });
    }
    if (intervals.length === 0) continue;
    clipped.push({ externalId: unitId, label: per.label, intervals });
  }
  clipped.sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
  return clipped;
}

// For an active interval list, compute `billed_fraction` based on the
// proration mode.
export function computeUnitFraction(
  unit: UnitInterval,
  period: { start: Date; end: Date; daysInPeriod: number },
  options: { prorated: boolean; tz: string },
): { fraction: string; activeFrom: Date; activeTo: Date | null } {
  if (!options.prorated) {
    // Setup-style: each unit counts as a full 1.0000.
    const first = unit.intervals[0]!;
    return {
      fraction: '1.0000',
      activeFrom: first.start,
      activeTo: first.end,
    };
  }

  // Prorated: sum active days within the period; fraction = sum / daysInPeriod.
  let activeDays = 0;
  let firstStartMs: number | null = null;
  let lastEndMs: number | null = null;
  let stillOpen = false;
  for (const iv of unit.intervals) {
    const startDt = DateTime.fromJSDate(iv.start, { zone: 'utc' }).setZone(options.tz).startOf('day');
    const endRaw: Date = iv.end ?? period.end;
    // Treat the end as an inclusive boundary — bump by one second so the day
    // of `endRaw` counts as active. Eg. iv.end = 2026-05-31T23:59:59 MX →
    // exclusive next-day boundary = 2026-06-01T00:00 MX.
    const endDt = DateTime.fromJSDate(endRaw, { zone: 'utc' }).setZone(options.tz).plus({ seconds: 1 }).startOf('day');
    const days = Math.max(0, Math.round(endDt.diff(startDt, 'days').days));
    activeDays += days;
    const startMs = iv.start.getTime();
    if (firstStartMs === null || startMs < firstStartMs) firstStartMs = startMs;
    if (iv.end === null) {
      stillOpen = true;
    } else if (!stillOpen) {
      const endMs = iv.end.getTime();
      if (lastEndMs === null || endMs > lastEndMs) lastEndMs = endMs;
    }
  }
  if (stillOpen) lastEndMs = null;
  const firstStart = firstStartMs === null ? unit.intervals[0]!.start : new Date(firstStartMs);
  const lastEnd: Date | null = lastEndMs === null ? null : new Date(lastEndMs);
  const fraction = activeDays / Math.max(1, period.daysInPeriod);
  return {
    fraction: fraction4(fraction),
    activeFrom: firstStart,
    activeTo: lastEnd,
  };
}

// Distribute `total_amount_cents = sum(amount_cents)` across units so the
// invariant Σ billed_units_detail[].amount_cents == fee.amount_cents holds.
// Each unit's nominal amount is `bankersRound(fraction × unit_amount_cents)`,
// and the residual (if any) is assigned to the unit with the largest
// `billed_fraction` (ties broken alphabetically).
export function distributeAmountCents(
  units: Array<{ fraction: string }>,
  unitAmountCents: number,
  feeTotalAmountCents: number,
): number[] {
  const nominal = units.map((u) => applyFraction(u.fraction, unitAmountCents));
  const subtotal = nominal.reduce((a, b) => a + b, 0);
  const residual = feeTotalAmountCents - subtotal;
  if (residual === 0) return nominal;

  // Indices sorted by fraction desc, then by external_id (the caller knows).
  let bestIdx = 0;
  let bestFraction = -1;
  for (let i = 0; i < units.length; i++) {
    const v = Number(units[i]!.fraction);
    if (v > bestFraction) {
      bestFraction = v;
      bestIdx = i;
    }
  }
  const out = [...nominal];
  out[bestIdx] = out[bestIdx]! + residual;
  return out;
}

export function buildBilledUnitsDetail(
  unitIntervals: UnitInterval[],
  period: { start: Date; end: Date; daysInPeriod: number },
  unitAmountCents: number,
  prorated: boolean,
  tz: string,
): { details: BilledUnitDetail[]; unitsTotalFractionStr: string; amountCents: number } {
  const computed = unitIntervals.map((u) => {
    const { fraction, activeFrom, activeTo } = computeUnitFraction(u, period, { prorated, tz });
    return { unit: u, fraction, activeFrom, activeTo };
  });

  const totalFraction = computed.reduce((acc, c) => acc + Number(c.fraction), 0);
  const totalFractionStr = fraction4(totalFraction);
  // The fee `amount_cents` is computed from the **summed fraction** (so the
  // total stays consistent even when individual rounding goes one way or the
  // other). Then distribute the residual across units.
  const feeAmountCents = bankersRound((totalFraction * unitAmountCents));
  const distributed = distributeAmountCents(
    computed.map((c) => ({ fraction: c.fraction })),
    unitAmountCents,
    feeAmountCents,
  );

  const details: BilledUnitDetail[] = computed.map((c, i) => ({
    external_id: c.unit.externalId,
    label: c.unit.label,
    active_from: isoUtc(c.activeFrom),
    active_to: c.activeTo ? isoUtc(c.activeTo) : null,
    billed_fraction: c.fraction,
    amount_cents: distributed[i]!,
  }));

  return { details, unitsTotalFractionStr: totalFractionStr, amountCents: feeAmountCents };
}
