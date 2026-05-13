// Plan serializer matching fixture 06.

import type { Charge, BillableMetric, Plan } from '@prisma/client';
import { isoUtc } from '../services/tz.js';

export type ChargeWithMetric = Charge & { billableMetric: BillableMetric };
export type PlanWithCharges = Plan & {
  charges: ChargeWithMetric[];
};

export type PlanCounters = {
  customers_count: number;
  active_subscriptions_count: number;
  draft_invoices_count: number;
};

export function serializePlan(plan: PlanWithCharges, counters: PlanCounters) {
  // Normalise bill_charges_monthly when interval is `monthly` (always null).
  const billChargesMonthly = plan.interval === 'monthly' ? null : plan.billChargesMonthly;

  const charges = plan.charges.map((c) => ({
    lago_id: c.id,
    lago_billable_metric_id: c.billableMetricId,
    invoice_display_name: c.invoiceDisplayName ?? null,
    billable_metric_code: c.billableMetric.code,
    created_at: isoUtc(c.createdAt),
    charge_model: c.chargeModel,
    invoiceable: c.invoiceable,
    regroup_paid_fees: c.regroupPaidFees ?? null,
    pay_in_advance: c.payInAdvance,
    prorated: c.prorated,
    min_amount_cents: c.minAmountCents,
    properties: c.properties as Record<string, unknown>,
    filters: [],
    taxes: [],
  }));

  return {
    plan: {
      lago_id: plan.id,
      name: plan.name,
      invoice_display_name: plan.invoiceDisplayName ?? null,
      created_at: isoUtc(plan.createdAt),
      code: plan.code,
      interval: plan.interval,
      description: plan.description ?? '',
      amount_cents: plan.amountCents,
      amount_currency: plan.amountCurrency,
      trial_period: plan.trialPeriod !== null && plan.trialPeriod !== undefined ? Number(plan.trialPeriod) : null,
      pay_in_advance: plan.payInAdvance,
      bill_charges_monthly: billChargesMonthly,
      customers_count: counters.customers_count,
      active_subscriptions_count: counters.active_subscriptions_count,
      draft_invoices_count: counters.draft_invoices_count,
      parent_id: plan.parentId ?? null,
      charges,
      usage_thresholds: [],
      taxes: [],
    },
  };
}
