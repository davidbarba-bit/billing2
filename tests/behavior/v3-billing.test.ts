// End-to-end test of the v3 customer-level billing engine.
//
// Verifies:
//   - Customer invoice aggregates fees from all the customer's services.
//   - Per-unit service add-ons add a "service_addon" fee per service.
//   - Flat customer add-ons add a "customer_addon" fee (independent of units).
//   - Setup fees still gated by Unit.setup_billed_at.
//   - Taxes computed on the total.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { seedNumaris } from '../../src/admin/seed.js';

describe('v3 billing (customer-level invoice)', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  it('seeded scenario emits 4 fee kinds and consistent totals', async () => {
    await seedNumaris(h.prisma, h.organization);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'v3-test-1' },
      payload: { invoice: { customer_external_id: 'carga-express-mx', metadata: { idempotency_key: 'v3-test-1' } } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { invoice: { fees: Array<{ kind: string; amount_cents: number }>; fees_amount_cents: number } };
    const inv = body.invoice;
    const kinds = inv.fees.map((f) => f.kind).sort();
    expect(kinds).toContain('monthly');
    expect(kinds).toContain('setup');
    expect(kinds).toContain('service_addon');
    expect(kinds).toContain('customer_addon');

    // v5: mini-Lago no calcula impuestos; el invoice solo expone el neto.
    const sumFees = inv.fees.reduce((a, f) => a + f.amount_cents, 0);
    expect(sumFees).toBe(inv.fees_amount_cents);
  });

  it('customer add-on stays even when the only service has zero monthly amount', async () => {
    // Create a customer with a flat add-on but a zero-priced service.
    // Bajo v8 (proration por mes calendario), el customer_addon de un periodo
    // FULL CALENDAR MONTH se cobra entero. Para evitar que el stub inicial
    // prorratee la prueba a un valor parcial, forzamos period_from/period_to
    // a un mes calendario completo (junio 2026 en CST).
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: { external_id: 'c-flat', name: 'Flat', currency: 'MXN', timezone: 'America/Mexico_City', subscription_at: '2020-01-01T00:00:00Z' } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-flat', customer_external_id: 'c-flat', name: 'Solo flat', monthly_unit_amount_cents: 0, setup_unit_amount_cents: 0 } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers/c-flat/add-ons', headers: h.authHeader(),
      payload: { customer_add_on: { code: 'plataforma', name: 'Acceso plataforma', amount_cents: 500000, active_from: '2020-01-01T00:00:00Z' } },
    });

    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'flat-only' },
      payload: { invoice: {
        customer_external_id: 'c-flat',
        period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z', // jun 2026 full en CST
        metadata: { idempotency_key: 'flat-only' },
      } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { invoice: { fees: Array<{ kind: string; amount_cents: number }>; total_amount_cents: number } };
    const inv = body.invoice;
    const customerFee = inv.fees.find((f) => f.kind === 'customer_addon');
    expect(customerFee).toBeTruthy();
    expect(customerFee!.amount_cents).toBe(500000);
    // No monthly/setup fees on a zero-priced service with no units.
    expect(inv.fees.find((f) => f.kind === 'monthly')).toBeUndefined();
    expect(inv.fees.find((f) => f.kind === 'setup')).toBeUndefined();
  });

  it('terminated customer add-on (active_to before period) is excluded', async () => {
    const seed = await seedNumaris(h.prisma, h.organization);
    const ao = await h.prisma.customerAddOn.findFirstOrThrow({
      where: { code: 'reglas-10', customer: { externalId: seed.customer_external_id } },
    });
    await h.prisma.customerAddOn.update({
      where: { id: ao.id }, data: { activeTo: new Date('2020-01-01') },
    });
    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'no-flat' },
      payload: { invoice: { customer_external_id: seed.customer_external_id, metadata: { idempotency_key: 'no-flat' } } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { invoice: { fees: Array<{ kind: string }> } };
    expect(body.invoice.fees.find((f) => f.kind === 'customer_addon')).toBeUndefined();
  });
});
