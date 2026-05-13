// Billable metric serializer matching Lago's wire shape.

import type { BillableMetric } from '@prisma/client';
import { isoUtc } from '../services/tz.js';

export type BillableMetricCounters = {
  active_subscriptions_count: number;
  draft_invoices_count: number;
  plans_count: number;
};

export function serializeBillableMetric(
  bm: BillableMetric,
  counters: BillableMetricCounters = { active_subscriptions_count: 0, draft_invoices_count: 0, plans_count: 0 },
) {
  return {
    billable_metric: {
      lago_id: bm.id,
      name: bm.name,
      code: bm.code,
      description: '',
      recurring: bm.recurring,
      aggregation_type: bm.aggregationType,
      weighted_interval: bm.weightedInterval ?? null,
      field_name: bm.fieldName ?? null,
      expression: '',
      created_at: isoUtc(bm.createdAt),
      active_subscriptions_count: counters.active_subscriptions_count,
      draft_invoices_count: counters.draft_invoices_count,
      plans_count: counters.plans_count,
    },
  };
}
