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
import { buildCustomerSlug } from '../../src/services/slug.js';

export type CreateCustomerDirectOpts = {
  externalId: string;
  name?: string;
  currency?: string;
  timezone?: string | null;
  billingPeriodMonths?: number;
  billingAnchorDay?: number;
  billingAnchorMonth?: number | null;
  nonrecurringTrigger?: 'immediate' | 'next_cycle';
  cycleInvoiceMode?: 'unified' | 'split_by_kind';
  subscriptionAt?: Date;
  status?: 'pending' | 'active' | 'terminated';
  email?: string | null;
  phone?: string | null;
  metadata?: Prisma.InputJsonValue;
};

// Creates a customer with billing configuration via prisma, plus its default
// tax entity. Use this in tests that need specific billing config (the public
// API no longer accepts those fields).
export async function createCustomerDirect(
  prisma: PrismaClient,
  org: Organization,
  opts: CreateCustomerDirectOpts,
): Promise<{ id: string; externalId: string }> {
  const subscriptionAt = opts.subscriptionAt ?? new Date();
  return prisma.$transaction(async (tx) => {
    const orgUpdated = await tx.organization.update({
      where: { id: org.id },
      data: { customerCounter: { increment: 1 } },
      select: { customerCounter: true, slug: true },
    });
    const sequentialId = orgUpdated.customerCounter;
    const created = await tx.customer.create({
      data: {
        organizationId: org.id,
        externalId: opts.externalId,
        sequentialId,
        slug: buildCustomerSlug(orgUpdated.slug, sequentialId),
        name: opts.name ?? opts.externalId,
        email: opts.email ?? null,
        phone: opts.phone ?? null,
        currency: opts.currency ?? 'MXN',
        timezone: opts.timezone ?? null,
        billingPeriodMonths: opts.billingPeriodMonths ?? 1,
        billingAnchorDay: opts.billingAnchorDay ?? 1,
        billingAnchorMonth: opts.billingAnchorMonth ?? null,
        nonrecurringTrigger: opts.nonrecurringTrigger ?? 'next_cycle',
        cycleInvoiceMode: opts.cycleInvoiceMode ?? 'unified',
        subscriptionAt,
        startedAt: opts.status === 'pending' ? null : subscriptionAt,
        status: opts.status ?? 'active',
        metadata: opts.metadata ?? {},
      },
    });
    await tx.taxEntity.create({
      data: {
        organizationId: org.id,
        customerId: created.id,
        externalId: created.externalId,
        legalName: created.name,
        isDefault: true,
        active: true,
      },
    });
    return { id: created.id, externalId: created.externalId };
  });
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
