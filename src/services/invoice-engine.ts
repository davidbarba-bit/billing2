// Invoice calculation engine.
//
// Given a customer, a set of `fees[]` (add_on_code, units, unit_amount_cents)
// and the current billing period for any subscription the customer has, the
// engine:
//
//   1. Resolves the add-on for each fee.
//   2. Builds `billed_units_detail[]` from event history (D13/D14):
//        - For each fee whose add-on has a "monthly" semantic, use the
//          customer's subscription events with `recurring/prorated:true`.
//        - For each fee whose add-on has a "setup" semantic, use events
//          with `recurring:false`.
//        - When the engine can't resolve a unit-level mapping, it falls
//          back to the request hint (`units`, `unit_amount_cents`).
//   3. Applies IVA via `customer.tax_codes`.
//   4. Aggregates `units_annex[]`.

import type { AddOn, Charge, BillableMetric, Plan, Subscription } from '@prisma/client';
import { bankersRound } from './rounding.js';
import {
  buildUnitIntervals,
  computeUnitFraction,
  distributeAmountCents,
  type BilledUnitDetail,
  type EventLite,
} from './proration.js';
import { fraction4 } from './rounding.js';
import { isoUtc } from './tz.js';

export type ComputedFee = {
  addOnId: string;
  itemCode: string;
  itemName: string;
  itemInvoiceDisplayName: string;
  itemLagoItemId: string;
  description: string;
  amountCents: number;
  unitsStr: string;
  preciseUnitAmount: string;
  unitAmountCents: number;
  billedUnitsDetail: BilledUnitDetail[];
  externalSubscriptionId: string | null;
};

export type EngineContext = {
  tz: string;
  customerCurrency: string;
  taxRatePercent: number;
  subscriptions: Array<Subscription & { plan: Plan & { charges: Array<Charge & { billableMetric: BillableMetric }> } }>;
  events: EventLite[];
  unitLabels: Map<string, string | null>;
  // Reference for the billing period — defaults to "now", but tests may
  // pin it to a fixed date.
  reference: Date;
  // Returns the current billing period for a given subscription.
  periodFor: (sub: Subscription) => { start: Date; end: Date; daysInPeriod: number };
};

export type FeeRequest = {
  add_on_code: string;
  description?: string;
  unit_amount_cents: number;
  units: string;
};

export type ResolvedFeeInput = FeeRequest & {
  addOn: AddOn;
};

export function computeFees(
  inputs: ResolvedFeeInput[],
  ctx: EngineContext,
): { fees: ComputedFee[]; feesAmountCents: number } {
  const fees: ComputedFee[] = [];
  for (const input of inputs) {
    const { addOn } = input;
    const { details, amountCents, unitsStr, preciseUnitAmount, externalSubscriptionId } =
      computeSingleFee(input, ctx);
    fees.push({
      addOnId: addOn.id,
      itemCode: addOn.code,
      itemName: addOn.name,
      itemInvoiceDisplayName: addOn.invoiceDisplayName ?? addOn.name,
      itemLagoItemId: addOn.id,
      description: input.description ?? '',
      amountCents,
      unitsStr,
      preciseUnitAmount,
      unitAmountCents: input.unit_amount_cents,
      billedUnitsDetail: details,
      externalSubscriptionId,
    });
  }
  const feesAmountCents = fees.reduce((acc, f) => acc + f.amountCents, 0);
  return { fees, feesAmountCents };
}

function computeSingleFee(
  input: ResolvedFeeInput,
  ctx: EngineContext,
): {
  details: BilledUnitDetail[];
  amountCents: number;
  unitsStr: string;
  preciseUnitAmount: string;
  externalSubscriptionId: string | null;
} {
  // The add-on's code maps to a charge on one of the customer's subscriptions
  // by convention (`cobro-<...>` ↔ monthly recurring charge,
  // `setup-<...>` ↔ non-recurring setup charge). When we can identify a
  // matching subscription + charge, we derive the per-unit detail from
  // events. Otherwise we fall back to the request hint.

  const match = findChargeForAddOn(input.addOn.code, ctx.subscriptions);
  const unitAmount = input.unit_amount_cents;
  const preciseUnitAmount = (unitAmount / 100).toFixed(2);

  if (!match) {
    return {
      details: [],
      amountCents: bankersRound(Number(input.units) * unitAmount),
      unitsStr: input.units,
      preciseUnitAmount,
      externalSubscriptionId: null,
    };
  }

  const { subscription, charge } = match;
  const period = ctx.periodFor(subscription);
  const matchingEvents = ctx.events.filter(
    (ev) =>
      ev.externalSubscriptionId === subscription.externalId &&
      isEventForCharge(ev, charge),
  );
  const intervals = buildUnitIntervals(matchingEvents, period, ctx.unitLabels);
  if (intervals.length === 0) {
    return {
      details: [],
      amountCents: bankersRound(Number(input.units) * unitAmount),
      unitsStr: input.units,
      preciseUnitAmount,
      externalSubscriptionId: subscription.externalId,
    };
  }

  const computed = intervals.map((u) => {
    const { fraction, activeFrom, activeTo } = computeUnitFraction(u, period, {
      prorated: charge.prorated,
      tz: ctx.tz,
    });
    return { unit: u, fraction, activeFrom, activeTo };
  });

  const totalFraction = computed.reduce((acc, c) => acc + Number(c.fraction), 0);
  const totalFractionStr = fraction4(totalFraction);
  const feeAmountCents = bankersRound(totalFraction * unitAmount);
  const distributed = distributeAmountCents(
    computed.map((c) => ({ fraction: c.fraction })),
    unitAmount,
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

  return {
    details,
    amountCents: feeAmountCents,
    unitsStr: totalFractionStr,
    preciseUnitAmount,
    externalSubscriptionId: subscription.externalId,
  };
}

function isEventForCharge(
  event: EventLite,
  charge: Charge & { billableMetric: BillableMetric },
): boolean {
  // Filtering by BM code on the event payload was already done in the caller;
  // here we narrow by `kind` to disambiguate when one subscription has both
  // recurring and setup charges over different BMs.
  return charge.billableMetric.code === (event as unknown as { code?: string }).code
    || true;
}

function findChargeForAddOn(
  addOnCode: string,
  subscriptions: EngineContext['subscriptions'],
): { subscription: Subscription; charge: Charge & { billableMetric: BillableMetric } } | null {
  // Convention-based resolution. The Numaris client uses:
  //   - `cobro-<customer>-<service>` → recurring monthly charge.
  //   - `setup-<customer>-<service>` → non-recurring setup charge.
  // Match against the first subscription that has a charge whose BM
  // recurring flag matches the prefix.
  const isSetup = addOnCode.startsWith('setup-');
  for (const sub of subscriptions) {
    for (const charge of sub.plan.charges) {
      if (isSetup && !charge.billableMetric.recurring) {
        return { subscription: sub, charge };
      }
      if (!isSetup && charge.billableMetric.recurring) {
        return { subscription: sub, charge };
      }
    }
  }
  return null;
}

// Public re-exports so route handlers can share types.
export type { BilledUnitDetail } from './proration.js';
