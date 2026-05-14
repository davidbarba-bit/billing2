// Service serializer.

import type { Service, Tax } from '@prisma/client';
import { isoUtc } from '../services/tz.js';
import { serializeTax } from './tax.js';

export type ServiceWithLinks = Service & {
  taxLinks: Array<{ tax: Tax }>;
};

export function serializeService(service: ServiceWithLinks) {
  return {
    service: {
      id: service.id,
      code: service.code,
      name: service.name,
      description: service.description ?? null,
      customer_id: service.customerId,
      currency: service.currency,
      monthly_unit_amount_cents: service.monthlyUnitAmountCents,
      setup_unit_amount_cents: service.setupUnitAmountCents,
      status: service.status,
      billing_time: service.billingTime,
      subscription_at: isoUtc(service.subscriptionAt),
      started_at: service.startedAt ? isoUtc(service.startedAt) : null,
      terminated_at: service.terminatedAt ? isoUtc(service.terminatedAt) : null,
      current_billing_period_started_at: service.currentBillingPeriodStartedAt
        ? isoUtc(service.currentBillingPeriodStartedAt)
        : null,
      current_billing_period_ending_at: service.currentBillingPeriodEndingAt
        ? isoUtc(service.currentBillingPeriodEndingAt)
        : null,
      metadata: service.metadata ?? {},
      taxes: service.taxLinks.map(({ tax }) => serializeTax(tax).tax),
      created_at: isoUtc(service.createdAt),
      updated_at: isoUtc(service.updatedAt),
    },
  };
}
