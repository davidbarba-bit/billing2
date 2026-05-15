// v8 — proration de mensualidad por DÍAS DEL MES CALENDARIO.
//
// monthly_unit_amount_cents = renta de UN MES CALENDARIO COMPLETO.
// Factor por unit = Σ (días activos en mes X) / (días del mes X).
// Aplica a 'monthly', 'service_addon' y 'customer_addon'.
//
// Verifica:
//   - Mes completo (1-may → 31-may) → factor 1.0000 → renta entera
//   - Stub (15-may → 1-jun) → factor 17/31 = 0.5484 → renta parcial
//   - 3-month cycle (1-jun → 1-sep) → factor 3.0000 → 3 × renta
//   - Unit mid-month (15-may → 31-may) → factor 17/31 (no 1.0)
//   - Distintos meses (feb 28 vs mar 31) → factor depende del mes
//   - customer_addon flat también prorratea con la misma regla
//   - Multi-month: 15-jun → 15-ago → factor 16/30 + 1.0 + 15/31

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { calendarMonthFraction } from '../../src/services/billing-engine.js';

describe('v8 — calendar-month proration', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  // -------- helpers --------
  async function seedCustomerWithService(opts: {
    monthly?: number; subscriptionAt?: string;
  } = {}) {
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: {
        external_id: 'c-v8', name: 'C8', currency: 'MXN',
        timezone: 'America/Mexico_City',
        subscription_at: opts.subscriptionAt ?? '2020-01-01T00:00:00Z',
        billing_anchor_day: 1, billing_period_months: 1,
      } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-v8', customer_external_id: 'c-v8', name: 'svc',
        pricing_model: 'recurring',
        monthly_unit_amount_cents: opts.monthly ?? 85000,
        setup_unit_amount_cents: 0,
      } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'seed', service_code: 's-v8', operation_type: 'add',
        unit_external_id: 'u-1', unit_label: 'u-1',
        timestamp: Math.floor(new Date('2020-01-01T00:00:00Z').getTime() / 1000),
      } },
    });
  }

  async function preview(period_from: string, period_to: string) {
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'c-v8', period_from, period_to } },
    });
    expect(r.statusCode).toBe(200);
    return (r.json() as {
      preview: { fees: Array<{ kind: string; units: string; amount_cents: number }> };
    }).preview;
  }

  // ===========================================================================
  // Unit-level: calendarMonthFraction helper.
  // ===========================================================================

  it('calendarMonthFraction: mes calendario completo en tz → 1.0', () => {
    // 1-may 00:00 CST → 31-may 23:59:59 CST (= 1-jun 06:00 UTC menos 1s).
    const from = new Date('2026-05-01T06:00:00Z');
    const to = new Date('2026-06-01T05:59:59Z');
    expect(calendarMonthFraction(from, to, 'America/Mexico_City')).toBeCloseTo(1.0, 4);
  });

  it('calendarMonthFraction: stub 15→1 sobre mes de 31 días → 17/31', () => {
    const from = new Date('2026-05-15T06:00:00Z');
    const to = new Date('2026-06-01T05:59:59Z');
    const f = calendarMonthFraction(from, to, 'America/Mexico_City');
    expect(f).toBeCloseTo(17 / 31, 4);
  });

  it('calendarMonthFraction: 3 meses completos → 3.0', () => {
    const from = new Date('2026-06-01T06:00:00Z');
    const to = new Date('2026-09-01T05:59:59Z');
    const f = calendarMonthFraction(from, to, 'America/Mexico_City');
    expect(f).toBeCloseTo(3.0, 4);
  });

  it('calendarMonthFraction: 15-jun → 15-ago = 16/30 + 1.0 + 15/31', () => {
    const from = new Date('2026-06-15T06:00:00Z'); // 15-jun 00:00 CST
    const to = new Date('2026-08-16T05:59:59Z');   // 15-ago 23:59:59 CST
    const f = calendarMonthFraction(from, to, 'America/Mexico_City');
    expect(f).toBeCloseTo(16 / 30 + 1.0 + 15 / 31, 4);
  });

  it('calendarMonthFraction: febrero (28) vs marzo (31)', () => {
    // 1-feb 00:00 CST → 28-feb 23:59:59 CST (no es año bisiesto: 2026)
    const feb = calendarMonthFraction(
      new Date('2026-02-01T06:00:00Z'),
      new Date('2026-03-01T05:59:59Z'),
      'America/Mexico_City',
    );
    expect(feb).toBeCloseTo(1.0, 4);
    // Mismos 28 días pero en marzo → 28/31
    const marPartial = calendarMonthFraction(
      new Date('2026-03-01T06:00:00Z'),
      new Date('2026-03-29T05:59:59Z'),
      'America/Mexico_City',
    );
    expect(marPartial).toBeCloseTo(28 / 31, 4);
  });

  // ===========================================================================
  // End-to-end via /preview.
  // ===========================================================================

  it('mes completo (mayo full) cobra renta entera', async () => {
    await seedCustomerWithService({ monthly: 85000 });
    const p = await preview('2026-05-01T06:00:00Z', '2026-06-01T05:59:59Z');
    const m = p.fees.find((f) => f.kind === 'monthly')!;
    expect(m.units).toBe('1.0000');
    expect(m.amount_cents).toBe(85000);
  });

  it('stub period (15-may → 1-jun) prorratea por 17/31 de mayo', async () => {
    await seedCustomerWithService({ monthly: 85000, subscriptionAt: '2026-05-15T18:37:00Z' });
    const p = await preview('2026-05-15T06:00:00Z', '2026-06-01T05:59:59Z');
    const m = p.fees.find((f) => f.kind === 'monthly')!;
    // 17/31 = 0.5484 (truncado a 4 dec por fraction4).
    expect(m.units).toBe('0.5484');
    // 0.5484 × 85000 = 46,614 (engine usa fracción truncada).
    expect(m.amount_cents).toBe(46614);
  });

  it('cycle de 3 meses cobra 3 × renta mensual', async () => {
    await seedCustomerWithService({ monthly: 85000 });
    const p = await preview('2026-06-01T06:00:00Z', '2026-09-01T05:59:59Z');
    const m = p.fees.find((f) => f.kind === 'monthly')!;
    expect(m.units).toBe('3.0000');
    expect(m.amount_cents).toBe(85000 * 3);
  });

  it('customer_addon flat también prorratea por mes calendario', async () => {
    await seedCustomerWithService({ monthly: 0 });
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers/c-v8/add-ons', headers: h.authHeader(),
      payload: { customer_add_on: {
        code: 'plat', name: 'Plataforma', amount_cents: 500000,
        active_from: '2020-01-01T00:00:00Z',
      } },
    });
    // Stub mayo (17 días) → 500000 × 17/31.
    const stub = await preview('2026-05-15T06:00:00Z', '2026-06-01T05:59:59Z');
    const stubFee = stub.fees.find((f) => f.kind === 'customer_addon')!;
    expect(stubFee.amount_cents).toBe(Math.round(500000 * 17 / 31));
    // Mes completo → 500000 íntegro.
    const full = await preview('2026-06-01T06:00:00Z', '2026-07-01T05:59:59Z');
    const fullFee = full.fees.find((f) => f.kind === 'customer_addon')!;
    expect(fullFee.amount_cents).toBe(500000);
  });

  it('unit añadida a mediados del mes prorratea solo los días activos', async () => {
    await seedCustomerWithService({ monthly: 85000 });
    // Agrega una segunda unit el 15 de junio (cycle 1-jun → 1-jul).
    await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'mid-month', service_code: 's-v8', operation_type: 'add',
        unit_external_id: 'u-2', unit_label: 'u-2',
        timestamp: Math.floor(new Date('2026-06-15T06:00:00Z').getTime() / 1000),
      } },
    });
    const p = await preview('2026-06-01T06:00:00Z', '2026-07-01T05:59:59Z');
    const m = p.fees.find((f) => f.kind === 'monthly')!;
    // Unit 1: full junio = "1.0000"; Unit 2: 15-jun → 1-jul = 16/30 = "0.5333"
    // Total factor (sumando strings truncados) = 1.5333.
    expect(m.units).toBe('1.5333');
    // 1.5333 × 85000 ≈ 130,330.5 → bankers/float ronda a 130331.
    expect(m.amount_cents).toBe(130331);
  });
});
