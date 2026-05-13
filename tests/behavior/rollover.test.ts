// Period roll-over cron (D9) must move periods forward but never emit invoices.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { tickRollOver } from '../../src/cron/period-rollover.js';

describe('period rollover (D9)', () => {
  let h: Harness;
  beforeAll(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  it('rolls a stale period forward without emitting an invoice', async () => {
    const customer = await h.prisma.customer.create({
      data: { organizationId: h.organization.id, externalId: 'c-roll', name: 'roll', sequentialId: 1, slug: 'X-001', currency: 'MXN', timezone: 'America/Mexico_City' },
    });
    const plan = await h.prisma.plan.create({
      data: { organizationId: h.organization.id, name: 'P', code: 'plan-roll', interval: 'monthly', amountCents: 0, amountCurrency: 'MXN' },
    });
    const stalePast = new Date('2020-01-31T23:59:59Z');
    await h.prisma.subscription.create({
      data: {
        organizationId: h.organization.id, customerId: customer.id, planId: plan.id, externalId: 'sub-roll',
        status: 'active', billingTime: 'calendar', subscriptionAt: new Date('2020-01-01T00:00:00Z'),
        currentBillingPeriodStartedAt: new Date('2020-01-01T06:00:00Z'),
        currentBillingPeriodEndingAt: stalePast,
      },
    });

    const invoiceCountBefore = await h.prisma.invoice.count();
    const summary = await tickRollOver(h.prisma);
    expect(summary.rolledOver).toBeGreaterThanOrEqual(1);
    const invoiceCountAfter = await h.prisma.invoice.count();
    expect(invoiceCountAfter).toBe(invoiceCountBefore);

    const updated = await h.prisma.subscription.findFirstOrThrow({ where: { externalId: 'sub-roll' } });
    expect(updated.currentBillingPeriodEndingAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('activates pending subscriptions whose subscription_at has passed', async () => {
    const customer = await h.prisma.customer.create({
      data: { organizationId: h.organization.id, externalId: 'c-pending', name: 'p', sequentialId: 2, slug: 'X-002', currency: 'MXN' },
    });
    const plan = await h.prisma.plan.create({
      data: { organizationId: h.organization.id, name: 'P2', code: 'plan-roll-2', interval: 'monthly', amountCents: 0, amountCurrency: 'MXN' },
    });
    await h.prisma.subscription.create({
      data: {
        organizationId: h.organization.id, customerId: customer.id, planId: plan.id, externalId: 'sub-pend',
        status: 'pending', billingTime: 'anniversary', subscriptionAt: new Date(Date.now() - 86400_000),
      },
    });

    const summary = await tickRollOver(h.prisma);
    expect(summary.activated).toBeGreaterThanOrEqual(1);
    const updated = await h.prisma.subscription.findFirstOrThrow({ where: { externalId: 'sub-pend' } });
    expect(updated.status).toBe('active');
    expect(updated.startedAt).not.toBeNull();
  });
});
