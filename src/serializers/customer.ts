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
      tax_identification_number: customer.taxIdentificationNumber ?? null,
      address_line1: customer.addressLine1 ?? null,
      address_line2: customer.addressLine2 ?? null,
      state: customer.state ?? null,
      zipcode: customer.zipcode ?? null,
      city: customer.city ?? null,
      country: customer.country ?? null,
      currency: customer.currency,
      timezone: customer.timezone ?? null,
      applicable_timezone: applicableTimezone(customer.timezone, customer.organization.timezone),
      status: customer.status,
      billing_period_months: customer.billingPeriodMonths,
      billing_anchor_day: customer.billingAnchorDay,
      nonrecurring_trigger: customer.nonrecurringTrigger,
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
    tax_identification_number: customer.taxIdentificationNumber ?? null,
    timezone: customer.timezone ?? null,
    applicable_timezone: applicableTimezone(customer.timezone, customer.organization.timezone),
  };
}
