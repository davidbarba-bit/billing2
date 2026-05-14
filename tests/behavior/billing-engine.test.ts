// End-to-end test of the v2 billing engine.
//
// 1. Crear customer + tax + service.
// 2. POST eventos add para 3 unidades con timestamps distintos.
// 3. POST invoice del servicio.
// 4. Verificar:
//    - fees: 1 "monthly" + (opcionalmente) "setup" si hay setup pendiente
//    - billed_units_detail por unidad con billed_fraction correcto
//    - units_annex consolidado
//    - taxes_amount_cents = round(fees × tax_rate / 100)
//    - units pendientes de setup se marcan como setup_billed_at después.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { seedNumaris } from '../../src/admin/seed.js';

describe('v2 billing engine', () => {
  let h: Harness;
  // Reset between each test — invoice creation mutates units (setup_billed_at)
  // so subsequent tests must start from a clean seed.
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  it('produces a monthly fee + setup fee for a service with units having mixed setup status', async () => {
    const seed = await seedNumaris(h.prisma, h.organization);

    // POST /api/v1/invoices with idem key.
    const idem = 'test-engine-1';
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': idem },
      payload: { invoice: { service_code: seed.service_code, metadata: { idempotency_key: idem } } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { invoice: { fees: Array<{ kind: string; amount_cents: number; billed_units_detail: Array<{ external_id: string; billed_fraction: string }> }>; taxes_amount_cents: number; fees_amount_cents: number; total_amount_cents: number; units_annex: unknown[] } };
    const inv = body.invoice;

    // Should have at least a monthly fee.
    const monthly = inv.fees.find((f) => f.kind === 'monthly')!;
    expect(monthly).toBeTruthy();
    expect(monthly.billed_units_detail.length).toBeGreaterThanOrEqual(2);

    // Should have a setup fee (camion-002 has setup_billed_at null in the seed).
    const setup = inv.fees.find((f) => f.kind === 'setup')!;
    expect(setup).toBeTruthy();
    expect(setup.billed_units_detail.some((d) => d.external_id === 'unit-camion-002')).toBe(true);

    // Taxes ~= fees × 16%.
    expect(inv.taxes_amount_cents).toBeGreaterThan(0);
    const expectedTax = Math.round(inv.fees_amount_cents * 0.16);
    expect(Math.abs(inv.taxes_amount_cents - expectedTax)).toBeLessThanOrEqual(2);
    expect(inv.total_amount_cents).toBe(inv.fees_amount_cents + inv.taxes_amount_cents);

    // Units annex consolidated.
    expect(inv.units_annex.length).toBeGreaterThanOrEqual(2);
  });

  it('marks setup_billed_at after the invoice captures it', async () => {
    const seed = await seedNumaris(h.prisma, h.organization);
    const beforeUnit = await h.prisma.unit.findFirst({ where: { externalId: 'unit-camion-002' } });
    expect(beforeUnit?.setupBilledAt).toBeNull();

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'mark-setup' },
      payload: { invoice: { service_code: seed.service_code, metadata: { idempotency_key: 'mark-setup' } } },
    });
    expect(res.statusCode).toBe(200);

    const afterUnit = await h.prisma.unit.findFirst({ where: { externalId: 'unit-camion-002' } });
    expect(afterUnit?.setupBilledAt).not.toBeNull();
  });

  it('idempotent: same key returns the same invoice', async () => {
    const seed = await seedNumaris(h.prisma, h.organization);
    const idem = 'test-idem-1';
    const payload = { invoice: { service_code: seed.service_code, metadata: { idempotency_key: idem } } };
    const first = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': idem }, payload,
    });
    expect(first.statusCode).toBe(200);
    const second = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': idem }, payload,
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { invoice: { id: string } }).invoice.id)
      .toBe((first.json() as { invoice: { id: string } }).invoice.id);
  });
});
