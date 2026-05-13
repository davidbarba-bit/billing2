// Subscription serializer matching fixtures 07 / 07b.

import type { Subscription } from '@prisma/client';
import { isoUtc } from '../services/tz.js';
import { serializePlan, type PlanCounters, type PlanWithCharges } from './plan.js';

export function serializeSubscription(
  subscription: Subscription,
  options: {
    customerExternalId: string;
    planCode: string;
    plan: PlanWithCharges | null;
    planCounters?: PlanCounters | null;
  },
) {
  const dt = (d: Date | null | undefined) => (d ? isoUtc(d) : null);

  const data: Record<string, unknown> = {
    lago_id: subscription.id,
    external_id: subscription.externalId,
    lago_customer_id: subscription.customerId,
    external_customer_id: options.customerExternalId,
    name: subscription.name ?? null,
    plan_code: options.planCode,
    status: subscription.status,
    billing_time: subscription.billingTime,
    subscription_at: dt(subscription.subscriptionAt),
    started_at: dt(subscription.startedAt),
    trial_ended_at: dt(subscription.trialEndedAt),
    ending_at: dt(subscription.endingAt),
    terminated_at: dt(subscription.terminatedAt),
    canceled_at: dt(subscription.canceledAt),
    created_at: dt(subscription.createdAt),
    previous_plan_code: subscription.previousPlanCode ?? null,
    next_plan_code: subscription.nextPlanCode ?? null,
    downgrade_plan_date: dt(subscription.downgradePlanDate),
    current_billing_period_started_at: dt(subscription.currentBillingPeriodStartedAt),
    current_billing_period_ending_at: dt(subscription.currentBillingPeriodEndingAt),
  };

  if (options.plan && options.planCounters) {
    data.plan = serializePlan(options.plan, options.planCounters).plan;
  }

  return { subscription: data };
}
