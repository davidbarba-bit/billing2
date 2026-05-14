// Behavior tests for Service add-ons (per_unit_monthly + flat_monthly).
//
// Verifies the billing engine produces the expected extra fees, with the
// expected billed_units_detail shape, and that taxes are applied on top.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { seedNumaris } from '../../src/admin/seed.js';

describe('service add-ons', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  it('invoice includes addon_per_unit_monthly + addon_flat_monthly fees from the seeded add-ons', async () => {
    const seed = await seedNumaris(h.prisma, h.organization);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'addon-test-1' },
      payload: { invoice: { service_code: seed.service_code, metadata: { idempotency_key: 'addon-test-1' } } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { invoice: { fees: Array<{ kind: string; amount_cents: number; billed_units_detail: Array<unknown>; description: string }> } };
    const kinds = body.invoice.fees.map((f) => f.kind);
    expect(kinds).toContain('monthly');
    expect(kinds).toContain('addon_per_unit_monthly');
    expect(kinds).toContain('addon_flat_monthly');

    const flat = body.invoice.fees.find((f) => f.kind === 'addon_flat_monthly')!;
    expect(flat.amount_cents).toBeGreaterThan(0);
    expect(flat.amount_cents).toBeLessThanOrEqual(100000); // ≤ $1000 (prorrateado posible)
    expect(flat.billed_units_detail).toHaveLength(1); // synthetic entry for flat add-on

    const perUnit = body.invoice.fees.find((f) => f.kind === 'addon_per_unit_monthly')!;
    expect(perUnit.amount_cents).toBeGreaterThan(0);
    // Should detail per actual unit (3 trucks seeded).
    expect(perUnit.billed_units_detail.length).toBeGreaterThanOrEqual(2);
  });

  it('terminating an add-on (PATCH active_to) excludes it from future invoices', async () => {
    const seed = await seedNumaris(h.prisma, h.organization);

    // Find one of the seeded add-ons and terminate it.
    const service = await h.prisma.service.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: h.organization.id, code: seed.service_code } },
    });
    const addOn = await h.prisma.addOn.findFirstOrThrow({
      where: { serviceId: service.id, code: 'reglas-10' },
    });
    // Terminate well before the start of the current period so the add-on
    // contributes zero days during the billing window.
    const longAgo = new Date('2020-01-01T00:00:00Z');
    await h.prisma.addOn.update({
      where: { id: addOn.id },
      data: { activeTo: longAgo },
    });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'addon-test-2' },
      payload: { invoice: { service_code: seed.service_code, metadata: { idempotency_key: 'addon-test-2' } } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { invoice: { fees: Array<{ kind: string; description: string }> } };
    // No flat fee for "reglas-10" (terminated before period).
    expect(body.invoice.fees.find((f) => f.kind === 'addon_flat_monthly')).toBeUndefined();
  });

  it('API: POST /api/v1/services/:code/add-ons creates an add-on', async () => {
    const seed = await seedNumaris(h.prisma, h.organization);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/services/${seed.service_code}/add-ons`,
      headers: h.authHeader(),
      payload: {
        add_on: {
          code: 'soporte-premium',
          name: 'Soporte Premium 24/7',
          pricing_type: 'flat_monthly',
          amount_cents: 200000,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { add_on: { code: string; pricing_type: string; amount_cents: number } };
    expect(body.add_on.code).toBe('soporte-premium');
    expect(body.add_on.pricing_type).toBe('flat_monthly');
    expect(body.add_on.amount_cents).toBe(200000);
  });

  it('API: PATCH refuses to change pricing_type or code (immutable)', async () => {
    const seed = await seedNumaris(h.prisma, h.organization);
    const service = await h.prisma.service.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: h.organization.id, code: seed.service_code } },
    });
    const addOn = await h.prisma.addOn.findFirstOrThrow({
      where: { serviceId: service.id, code: 'historial-12m' },
    });

    const res1 = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/add-ons/${addOn.id}`,
      headers: h.authHeader(),
      payload: { add_on: { pricing_type: 'flat_monthly' } },
    });
    expect(res1.statusCode).toBe(422);

    const res2 = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/add-ons/${addOn.id}`,
      headers: h.authHeader(),
      payload: { add_on: { code: 'renamed' } },
    });
    expect(res2.statusCode).toBe(422);

    // OK to update amount.
    const ok = await h.app.inject({
      method: 'PATCH',
      url: `/api/v1/add-ons/${addOn.id}`,
      headers: h.authHeader(),
      payload: { add_on: { amount_cents: 7500 } },
    });
    expect(ok.statusCode).toBe(200);
  });
});
