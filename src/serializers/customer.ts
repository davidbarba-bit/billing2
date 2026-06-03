// Customer serializer (v5 — sin tax stack, NetSuite calcula impuestos).

import type { Customer, Organization } from '@prisma/client';
import { applicableTimezone, isoUtc } from '../services/tz.js';

export type CustomerWithLinks = Customer & {
  organization: Organization;
};

export function serializeCustomer(customer: CustomerWithLinks) {
  return {
    customer: {
      id: customer.id,
      external_id: customer.externalId,
      sequential_id: customer.sequentialId,
      slug: customer.slug,
      name: customer.name,
      email: customer.email ?? null,
      phone: customer.phone ?? null,
      // v22: la identidad fiscal (RFC, dirección, NetSuite) vive en las
      // razones sociales (TaxEntity), no en el Customer.
      currency: customer.currency,
      timezone: customer.timezone ?? null,
      applicable_timezone: applicableTimezone(customer.timezone, customer.organization.timezone),
      status: customer.status,
      billing_period_months: customer.billingPeriodMonths,
      billing_anchor_day: customer.billingAnchorDay,
      // v15: solo aplica si period_months > 1. NULL → anclado al mes de subscription_at (legacy).
      billing_anchor_month: customer.billingAnchorMonth ?? null,
      nonrecurring_trigger: customer.nonrecurringTrigger,
      cycle_invoice_mode: customer.cycleInvoiceMode,
      subscription_at: isoUtc(customer.subscriptionAt),
      started_at: customer.startedAt ? isoUtc(customer.startedAt) : null,
      terminated_at: customer.terminatedAt ? isoUtc(customer.terminatedAt) : null,
      current_billing_period_started_at: customer.currentBillingPeriodStartedAt
        ? isoUtc(customer.currentBillingPeriodStartedAt) : null,
      current_billing_period_ending_at: customer.currentBillingPeriodEndingAt
        ? isoUtc(customer.currentBillingPeriodEndingAt) : null,
      metadata: customer.metadata ?? {},
      created_at: isoUtc(customer.createdAt),
      updated_at: isoUtc(customer.updatedAt),
    },
  };
}

export function serializeEmbeddedCustomer(customer: CustomerWithLinks) {
  return {
    id: customer.id,
    external_id: customer.externalId,
    name: customer.name,
    currency: customer.currency,
    timezone: customer.timezone ?? null,
    applicable_timezone: applicableTimezone(customer.timezone, customer.organization.timezone),
  };
}
