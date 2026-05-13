// Tests for events (#4, #5, #13a), plans (#6), subscriptions (#7, #7b).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';

describe('events / plans / subscriptions', () => {
  let h: Harness;
  beforeAll(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  it('rejects ISO timestamp on /events with 422 must_be_unix_epoch_seconds (invariant #3)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: h.authHeader(),
      payload: {
        event: {
          transaction_id: 'tx-iso-1',
          external_subscription_id: 'sub-x',
          code: 'bm-x',
          timestamp: '2026-05-12T22:20:00Z',
          properties: { unit_external_id: 'u-1', operation_type: 'add' },
        },
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'validation_errors',
      error_details: { timestamp: ['must_be_unix_epoch_seconds'] },
    });
  });

  it('returns 422 value_already_exist on duplicate transaction_id (invariant #4)', async () => {
    const payload = {
      event: {
        transaction_id: 'tx-dup-1',
        external_subscription_id: 'sub-x',
        code: 'bm-x',
        timestamp: 1747080000,
        properties: { unit_external_id: 'u-1', operation_type: 'add' },
      },
    };
    const first = await h.app.inject({ method: 'POST', url: '/api/v1/events', headers: h.authHeader(), payload });
    expect(first.statusCode).toBe(200);
    const second = await h.app.inject({ method: 'POST', url: '/api/v1/events', headers: h.authHeader(), payload });
    expect(second.statusCode).toBe(422);
    expect(second.json()).toMatchObject({
      error_details: { transaction_id: ['value_already_exist'] },
    });
  });

  it('creates a plan whose charge requires recurring metric for prorated:true (invariant #5)', async () => {
    const bm = await h.prisma.billableMetric.create({
      data: { organizationId: h.organization.id, name: 'BM-recurring', code: 'bm-r', aggregationType: 'unique_count_agg', fieldName: 'unit_external_id', recurring: true },
    });
    const bmNonRecurring = await h.prisma.billableMetric.create({
      data: { organizationId: h.organization.id, name: 'BM-not-recurring', code: 'bm-nr', aggregationType: 'unique_count_agg', fieldName: 'unit_external_id', recurring: false },
    });

    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: h.authHeader(),
      payload: {
        plan: {
          name: 'P',
          code: 'plan-ok',
          interval: 'monthly',
          amount_cents: 0,
          amount_currency: 'MXN',
          charges: [{ billable_metric_id: bm.id, charge_model: 'standard', prorated: true, invoiceable: true, properties: { amount: '450.00' } }],
        },
      },
    });
    expect(ok.statusCode).toBe(200);

    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: h.authHeader(),
      payload: {
        plan: {
          name: 'P2',
          code: 'plan-bad',
          interval: 'monthly',
          amount_cents: 0,
          amount_currency: 'MXN',
          charges: [{ billable_metric_id: bmNonRecurring.id, charge_model: 'standard', prorated: true, invoiceable: true, properties: { amount: '450.00' } }],
        },
      },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({
      error_details: { 'charges[0].prorated': ['requires_recurring_metric'] },
    });
  });

  it('subscription pending state + DELETE without ?status=pending → 404 (invariant #8)', async () => {
    const customer = await h.prisma.customer.create({
      data: {
        organizationId: h.organization.id,
        externalId: 'cust-pending',
        name: 'pending',
        sequentialId: 99,
        slug: 'X-099',
        currency: 'MXN',
      },
    });
    const bm = await h.prisma.billableMetric.create({
      data: { organizationId: h.organization.id, name: 'BM-pending', code: 'bm-pending', aggregationType: 'unique_count_agg', fieldName: 'unit_external_id', recurring: true },
    });
    const plan = await h.prisma.plan.create({
      data: {
        organizationId: h.organization.id, name: 'P-pending', code: 'plan-pending',
        interval: 'monthly', amountCents: 0, amountCurrency: 'MXN',
      },
    });
    await h.prisma.charge.create({
      data: { planId: plan.id, billableMetricId: bm.id, chargeModel: 'standard', prorated: true, properties: { amount: '450.00' } as object },
    });

    const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions',
      headers: h.authHeader(),
      payload: {
        subscription: {
          external_customer_id: customer.externalId,
          plan_code: plan.code,
          external_id: 'sub-pending',
          billing_time: 'anniversary',
          subscription_at: future,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { subscription: { status: string; started_at: null } };
    expect(body.subscription.status).toBe('pending');
    expect(body.subscription.started_at).toBeNull();

    const del404 = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/subscriptions/sub-pending',
      headers: h.authHeader(),
    });
    expect(del404.statusCode).toBe(404);

    const del200 = await h.app.inject({
      method: 'DELETE',
      url: '/api/v1/subscriptions/sub-pending?status=pending',
      headers: h.authHeader(),
    });
    expect(del200.statusCode).toBe(200);
  });

  it('calendar billing period ends in customer tz, not UTC (D4 + invariant #12)', async () => {
    const customer = await h.prisma.customer.create({
      data: {
        organizationId: h.organization.id,
        externalId: 'cust-cal',
        name: 'cal',
        sequentialId: 100,
        slug: 'X-100',
        currency: 'MXN',
        timezone: 'America/Mexico_City',
      },
    });
    const bm = await h.prisma.billableMetric.create({
      data: { organizationId: h.organization.id, name: 'BM-cal', code: 'bm-cal', aggregationType: 'unique_count_agg', fieldName: 'unit_external_id', recurring: true },
    });
    const plan = await h.prisma.plan.create({
      data: { organizationId: h.organization.id, name: 'P-cal', code: 'plan-cal', interval: 'monthly', amountCents: 0, amountCurrency: 'MXN' },
    });
    await h.prisma.charge.create({
      data: { planId: plan.id, billableMetricId: bm.id, chargeModel: 'standard', prorated: true, properties: { amount: '450.00' } as object },
    });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/subscriptions',
      headers: h.authHeader(),
      payload: {
        subscription: {
          external_customer_id: customer.externalId,
          plan_code: plan.code,
          external_id: 'sub-cal',
          billing_time: 'calendar',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { subscription: { current_billing_period_ending_at: string } };
    // The ending datetime should be a UTC timestamp on the 1st of next month
    // at 06:00:00Z (MX is UTC-6 in non-DST months); we accept any month so
    // the test stays stable across the year.
    const ending = body.subscription.current_billing_period_ending_at;
    expect(ending).toMatch(/^20\d\d-\d{2}-\d{2}T0[56]:59:59Z$/);
  });
});
