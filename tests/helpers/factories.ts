// Test factories that bypass the public API.
//
// Since v23, the public API only accepts the minimal customer/unit fields the
// integrator controls (external_id, name, label, etc.). Internal billing
// config (billing_period_months, currency, timezone, prepaid_months,
// billing_starts_at, setup_already_billed, etc.) is administered through the
// admin UI, not through the public API.
//
// Behavior tests still need to set up scenarios with specific billing config.
// They use these factories to write directly to the database, bypassing the
// public API entirely.

import type { Organization, Prisma, PrismaClient } from '@prisma/client';
import { createCustomerFull, type CreateCustomerFullInput } from '../../src/services/customer.js';

export type CreateCustomerDirectOpts = CreateCustomerFullInput & {
  // Tests pueden necesitar forzar status='pending' o 'terminated' después
  // del create — el helper público lo deriva de subscriptionAt vs now.
  status?: 'pending' | 'active' | 'terminated';
};

// Creates a customer with billing configuration via prisma, plus its default
// tax entity. Wrapper sobre createCustomerFull (que comparte la lógica con
// el admin UI). Use this in tests that need specific billing config — the
// public API no longer accepts those fields.
export async function createCustomerDirect(
  prisma: PrismaClient,
  org: Organization,
  opts: CreateCustomerDirectOpts,
): Promise<{ id: string; externalId: string }> {
  const { status, ...input } = opts;
  const result = await createCustomerFull(prisma, org, {
    ...input,
    name: input.name ?? input.externalId,
  });
  if (status !== undefined && status !== 'active') {
    await prisma.customer.update({
      where: { id: result.id },
      data: {
        status,
        ...(status === 'terminated' ? { terminatedAt: new Date() } : {}),
      },
    });
  }
  return result;
}

export type CreateUnitDirectOpts = {
  serviceId: string;
  externalId: string;
  label?: string | null;
  activeFrom?: Date;
  activeTo?: Date | null;
  billingStartsAt?: Date | null;
  prepaidMonths?: number | null;
  setupBilledAt?: Date | null;
  oneoffBilledAt?: Date | null;
};

// Creates a unit with internal billing flags pre-set. The public API no
// longer accepts setup_already_billed / one_off_already_billed / billing_starts_at
// — use this in tests for migration scenarios.
export async function createUnitDirect(
  prisma: PrismaClient,
  opts: CreateUnitDirectOpts,
): Promise<{ id: string }> {
  const unit = await prisma.unit.create({
    data: {
      serviceId: opts.serviceId,
      externalId: opts.externalId,
      label: opts.label ?? null,
      activeFrom: opts.activeFrom ?? new Date(),
      activeTo: opts.activeTo ?? null,
      billingStartsAt: opts.billingStartsAt ?? null,
      prepaidMonths: opts.prepaidMonths ?? null,
      setupBilledAt: opts.setupBilledAt ?? null,
      oneoffBilledAt: opts.oneoffBilledAt ?? null,
    },
  });
  return { id: unit.id };
}

// Creates the pricing row for a (customer, catalog_event) so that the public
// API POST /catalog-events/occurrences can resolve a price. Without this, the
// occurrence endpoint returns 422 customer_catalog_event_pricing_not_set.
export async function createCustomerCatalogEventPricing(
  prisma: PrismaClient,
  org: Organization,
  opts: {
    customerId: string;
    catalogEventId: string;
    amountCents: number;
    billingMode: 'immediate' | 'next_cycle';
  },
): Promise<void> {
  await prisma.customerCatalogEventPricing.create({
    data: {
      organizationId: org.id,
      customerId: opts.customerId,
      catalogEventId: opts.catalogEventId,
      amountCents: opts.amountCents,
      billingMode: opts.billingMode,
    },
  });
}
