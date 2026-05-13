// Proration + units annex (D13 + invariant #17) and unit_label persistence (D14).
//
// These cover the cases that fixture 11 illustrates without trying to
// reproduce the exact synthetic numbers: we seed events directly, request
// /current_usage, and assert the math.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';

describe('proration + anexo + label persistence', () => {
  let h: Harness;
  beforeAll(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  let counter = 0;
  async function setup(): Promise<{ customerExternalId: string; subscriptionExternalId: string; bmCode: string }> {
    counter += 1;
    const customerExternalId = `carga-${counter}`;
    const planCode = `plan-${counter}`;
    const subExternalId = `sub-${counter}`;
    const bmCode = `bm-monthly-${counter}`;
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: { external_id: customerExternalId, name: 'Carga', currency: 'MXN', timezone: 'America/Mexico_City' } },
    });
    const bm = await h.prisma.billableMetric.create({
      data: { organizationId: h.organization.id, name: 'BM', code: bmCode, aggregationType: 'unique_count_agg', fieldName: 'unit_external_id', recurring: true },
    });
    const plan = await h.prisma.plan.create({
      data: { organizationId: h.organization.id, name: 'P', code: planCode, interval: 'monthly', amountCents: 0, amountCurrency: 'MXN' },
    });
    await h.prisma.charge.create({
      data: { planId: plan.id, billableMetricId: bm.id, chargeModel: 'standard', prorated: true, properties: { amount: '450.00' } as object },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/subscriptions', headers: h.authHeader(),
      payload: { subscription: { external_customer_id: customerExternalId, plan_code: planCode, external_id: subExternalId, billing_time: 'calendar' } },
    });
    return { customerExternalId, subscriptionExternalId: subExternalId, bmCode };
  }

  it('current_usage with one full-month active unit reports units=1.0 and amount=450 × 100', async () => {
    const { customerExternalId, subscriptionExternalId, bmCode } = await setup();
    // Get the subscription's period start.
    const sub = await h.prisma.subscription.findFirstOrThrow({ where: { externalId: subscriptionExternalId } });
    const periodStart = sub.currentBillingPeriodStartedAt!;
    // Place an "add" event 1 second after the period start so the rounded
    // epoch lands within the window.
    const ts = Math.floor(periodStart.getTime() / 1000) + 1;
    const event = await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: {
        event: {
          transaction_id: 'tx-add-1',
          external_subscription_id: subscriptionExternalId,
          code: bmCode,
          timestamp: ts,
          properties: { unit_external_id: 'u-1', unit_label: 'Camión 001', kind: 'monthly-ping', operation_type: 'add' },
        },
      },
    });
    expect(event.statusCode).toBe(200);

    const usage = await h.app.inject({
      method: 'GET',
      url: `/api/v1/customers/${customerExternalId}/current_usage?external_subscription_id=${subscriptionExternalId}&apply_taxes=false`,
      headers: h.authHeader(),
    });
    expect(usage.statusCode).toBe(200);
    const body = usage.json() as { customer_usage: { charges_usage: Array<{ units: string; amount_cents: number }> } };
    const monthly = body.customer_usage.charges_usage.find((c) => c.units !== '0.0');
    expect(monthly).toBeTruthy();
    expect(monthly!.units).toBe('1.0');
    expect(monthly!.amount_cents).toBe(45000);
  });

  it('unit_label persistence (D14 + invariant #18)', async () => {
    const { customerExternalId, subscriptionExternalId, bmCode } = await setup();
    const sub = await h.prisma.subscription.findFirstOrThrow({ where: { externalId: subscriptionExternalId } });
    const periodStart = sub.currentBillingPeriodStartedAt!;

    // First event with label L1.
    const ev1 = await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'tx-l1', external_subscription_id: subscriptionExternalId, code: bmCode,
        timestamp: Math.floor(periodStart.getTime() / 1000),
        properties: { unit_external_id: 'u-9', unit_label: 'L1', operation_type: 'add' },
      } },
    });
    expect(ev1.statusCode).toBe(200);
    // Second event with label L2 (same unit).
    const ev2 = await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'tx-l2', external_subscription_id: subscriptionExternalId, code: bmCode,
        timestamp: Math.floor(periodStart.getTime() / 1000) + 86400,
        properties: { unit_external_id: 'u-9', unit_label: 'L2', operation_type: 'add' },
      } },
    });
    expect(ev2.statusCode).toBe(200);

    // The persisted label should now be L2.
    const customer = await h.prisma.customer.findUniqueOrThrow({
      where: { organizationId_externalId: { organizationId: h.organization.id, externalId: customerExternalId } },
    });
    const row = await h.prisma.unitLabel.findUnique({
      where: {
        customerId_externalSubscriptionId_unitExternalId: {
          customerId: customer.id,
          externalSubscriptionId: subscriptionExternalId,
          unitExternalId: 'u-9',
        },
      },
    });
    expect(row?.label).toBe('L2');
  });
});
