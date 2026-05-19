// v15 — billing_anchor_month: alinea ciclos multi-mes a un mes calendario
// específico (independiente de subscription_at).
//
// Casos cubiertos:
//   A) Trimestral anchor_month=1: cycles Ene-Mar, Abr-Jun, Jul-Sep, Oct-Dic.
//   B) Trimestral anchor_month=7: cycles Jul-Sep como primer ciclo (si
//      subscription < Jul), o stub hasta Jul si subscription = mid-mayo.
//   C) Anual anchor_month=4: año fiscal Abr-Mar.
//   D) Semestral anchor_month=7: Jul-Dic, Ene-Jun.
//   E) PATCH /billing-schedule acepta anchor_month.
//   F) Validación: anchor_month con period_months=1 → 422.
//   G) Validación: anchor_month fuera de 1..12 → 422.
//   H) Backward compat: customer sin anchor_month preserva comportamiento legacy.
//   I) Gate: cambiar anchor_month con invoices existentes → 409.
//   J) Realineación: cambiar anchor_month en cliente trimestral existente.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { billingPeriodFor } from '../../src/services/billing-engine.js';

// Helper: convierte una Date UTC al día calendar en la tz especificada.
// Necesario porque las dates del engine vienen en UTC pero los ciclos están
// alineados a la tz del customer (ej. end = 30-abr 23:59:59 CST = 1-may UTC).
function ymdInTz(d: Date, tz: string): string {
  return DateTime.fromJSDate(d, { zone: 'utc' }).setZone(tz).toFormat('yyyy-LL-dd');
}

describe('v15 — billing_anchor_month', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  // Util: build temp customer for direct engine tests.
  function mkCustomer(opts: { subscriptionAt: string; periodMonths: number; anchorDay?: number; anchorMonth?: number | null }) {
    return {
      billingPeriodMonths: opts.periodMonths,
      billingAnchorDay: opts.anchorDay ?? 1,
      billingAnchorMonth: opts.anchorMonth ?? null,
      subscriptionAt: new Date(opts.subscriptionAt),
    } as unknown as import('@prisma/client').Customer;
  }

  // ===========================================================================
  // A) Trimestral anchor_month=1 → Ene/Abr/Jul/Oct
  // ===========================================================================
  it('A) trimestral con anchor_month=1, suscrito feb-1 → primer ciclo stub hasta abr-1', () => {
    const c = mkCustomer({ subscriptionAt: '2026-02-01T06:00:00Z', periodMonths: 3, anchorMonth: 1 });
    // Referencia mar-15 → debería caer en stub Feb-Abr.
    const p = billingPeriodFor(c, 'America/Mexico_City', new Date('2026-03-15T06:00:00Z'));
    expect(ymdInTz(p.start, "America/Mexico_City")).toBe('2026-02-01');
    expect(ymdInTz(p.end, "America/Mexico_City")).toBe('2026-03-31');
    // Después de abr-1, ciclo regular Abr-Jun.
    const p2 = billingPeriodFor(c, 'America/Mexico_City', new Date('2026-05-15T06:00:00Z'));
    expect(ymdInTz(p2.start, "America/Mexico_City")).toBe('2026-04-01');
    expect(ymdInTz(p2.end, "America/Mexico_City")).toBe('2026-06-30');
    // Referencia ago-1 → ciclo Jul-Sep.
    const p3 = billingPeriodFor(c, 'America/Mexico_City', new Date('2026-08-15T06:00:00Z'));
    expect(ymdInTz(p3.start, "America/Mexico_City")).toBe('2026-07-01');
    expect(ymdInTz(p3.end, "America/Mexico_City")).toBe('2026-09-30');
  });

  // ===========================================================================
  // B) Trimestral anchor_month=7 con subscripción may-15 → stub may-jul + cycles
  // ===========================================================================
  it('B) trimestral anchor_month=7, suscrito may-15 → stub hasta jul-1', () => {
    const c = mkCustomer({ subscriptionAt: '2026-05-15T06:00:00Z', periodMonths: 3, anchorMonth: 7 });
    // Stub abarca may-15 a jun-30.
    const p = billingPeriodFor(c, 'America/Mexico_City', new Date('2026-06-15T06:00:00Z'));
    expect(ymdInTz(p.start, "America/Mexico_City")).toBe('2026-05-15');
    expect(ymdInTz(p.end, "America/Mexico_City")).toBe('2026-06-30');
    // Después de jul-1, regular Jul-Sep.
    const p2 = billingPeriodFor(c, 'America/Mexico_City', new Date('2026-08-15T06:00:00Z'));
    expect(ymdInTz(p2.start, "America/Mexico_City")).toBe('2026-07-01');
    expect(ymdInTz(p2.end, "America/Mexico_City")).toBe('2026-09-30');
  });

  // ===========================================================================
  // C) Anual anchor_month=4 → año fiscal Abr-Mar
  // ===========================================================================
  it('C) anual con anchor_month=4 → ciclos Abr-Mar (año fiscal)', () => {
    const c = mkCustomer({ subscriptionAt: '2020-01-01T06:00:00Z', periodMonths: 12, anchorMonth: 4 });
    // Ref jul-2026 → ciclo Abr 2026 - Mar 2027.
    const p = billingPeriodFor(c, 'America/Mexico_City', new Date('2026-07-15T06:00:00Z'));
    expect(ymdInTz(p.start, "America/Mexico_City")).toBe('2026-04-01');
    expect(ymdInTz(p.end, "America/Mexico_City")).toBe('2027-03-31');
    // Ref feb-2027 → mismo ciclo (Abr 2026 - Mar 2027).
    const p2 = billingPeriodFor(c, 'America/Mexico_City', new Date('2027-02-15T06:00:00Z'));
    expect(ymdInTz(p2.start, "America/Mexico_City")).toBe('2026-04-01');
    expect(ymdInTz(p2.end, "America/Mexico_City")).toBe('2027-03-31');
  });

  // ===========================================================================
  // D) Semestral anchor_month=7 → Jul-Dic, Ene-Jun
  // ===========================================================================
  it('D) semestral con anchor_month=7 → cycles Jul-Dic y Ene-Jun', () => {
    const c = mkCustomer({ subscriptionAt: '2020-01-01T06:00:00Z', periodMonths: 6, anchorMonth: 7 });
    // Ref oct-2026 → Jul-Dic 2026.
    const p = billingPeriodFor(c, 'America/Mexico_City', new Date('2026-10-15T06:00:00Z'));
    expect(ymdInTz(p.start, "America/Mexico_City")).toBe('2026-07-01');
    expect(ymdInTz(p.end, "America/Mexico_City")).toBe('2026-12-31');
    // Ref mar-2027 → Ene-Jun 2027.
    const p2 = billingPeriodFor(c, 'America/Mexico_City', new Date('2027-03-15T06:00:00Z'));
    expect(ymdInTz(p2.start, "America/Mexico_City")).toBe('2027-01-01');
    expect(ymdInTz(p2.end, "America/Mexico_City")).toBe('2027-06-30');
  });

  // ===========================================================================
  // E) PATCH /billing-schedule acepta anchor_month
  // ===========================================================================
  it('E) PATCH /billing-schedule setea anchor_month y se serializa', async () => {
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: {
        external_id: 'c-E', name: 'C', currency: 'MXN',
        timezone: 'America/Mexico_City', subscription_at: '2026-02-01T06:00:00Z',
        billing_period_months: 3, billing_anchor_day: 1,
      } },
    });
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-E/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { billing_anchor_month: 1 } },
    });
    expect(r.statusCode).toBe(200);
    const c = (r.json() as { customer: { billing_anchor_month: number } }).customer;
    expect(c.billing_anchor_month).toBe(1);
  });

  // ===========================================================================
  // F) Monthly + anchor_month → 422
  // ===========================================================================
  it('F) monthly + anchor_month → 422 not_applicable_to_monthly', async () => {
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: {
        external_id: 'c-F', name: 'C', currency: 'MXN', timezone: 'America/Mexico_City',
        subscription_at: '2020-01-01T00:00:00Z', billing_period_months: 1, billing_anchor_day: 1,
      } },
    });
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-F/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { billing_anchor_month: 4 } },
    });
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain('not_applicable_to_monthly');
  });

  // ===========================================================================
  // G) anchor_month fuera de 1..12 → 422
  // ===========================================================================
  it('G) anchor_month=13 → 422 must_be_1_to_12', async () => {
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: {
        external_id: 'c-G', name: 'C', currency: 'MXN', timezone: 'America/Mexico_City',
        subscription_at: '2020-01-01T00:00:00Z', billing_period_months: 3, billing_anchor_day: 1,
      } },
    });
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-G/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { billing_anchor_month: 13 } },
    });
    expect(r.statusCode).toBe(422);
  });

  // ===========================================================================
  // H) Backward compat: customer sin anchor_month preserva legacy
  // ===========================================================================
  it('H) sin anchor_month: comportamiento legacy (anclado a subscription_at)', () => {
    // Trimestral suscrito feb-1, SIN anchor_month → cycles feb-abr, may-jul, etc.
    const c = mkCustomer({ subscriptionAt: '2026-02-01T06:00:00Z', periodMonths: 3, anchorMonth: null });
    const p = billingPeriodFor(c, 'America/Mexico_City', new Date('2026-03-15T06:00:00Z'));
    expect(ymdInTz(p.start, "America/Mexico_City")).toBe('2026-02-01');
    expect(ymdInTz(p.end, "America/Mexico_City")).toBe('2026-04-30');
  });

  // ===========================================================================
  // I) Gate: cambiar anchor_month con invoices existentes → 409
  // ===========================================================================
  it('I) cambiar anchor_month con invoice no-voided → 409', async () => {
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: {
        external_id: 'c-I', name: 'C', currency: 'MXN', timezone: 'America/Mexico_City',
        subscription_at: '2020-01-01T06:00:00Z', billing_period_months: 3, billing_anchor_day: 1,
      } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-i', customer_external_id: 'c-I', name: 'svc', monthly_unit_amount_cents: 50000 } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: 's-i', external_id: 'u1', active_from: '2020-01-01T00:00:00Z' } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'inv-i' },
      payload: { invoice: {
        customer_external_id: 'c-I',
        period_from: '2026-01-01T06:00:00Z', period_to: '2026-03-31T05:59:59Z',
        metadata: { idempotency_key: 'inv-i' },
      } },
    });
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-I/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { billing_anchor_month: 1 } },
    });
    expect(r.statusCode).toBe(409);
  });

  // ===========================================================================
  // J) Realinear: cambiar anchor_month → currentBillingPeriod recalculado
  // ===========================================================================
  it('J) realinear: anchor_month=1 sobre cliente trimestral preserva semántica', async () => {
    // Cliente trimestral suscrito feb-1 sin anchor_month → cycles feb-abr.
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: {
        external_id: 'c-J', name: 'C', currency: 'MXN', timezone: 'America/Mexico_City',
        subscription_at: '2026-02-01T06:00:00Z', billing_period_months: 3, billing_anchor_day: 1,
      } },
    });
    // PATCH anchor_month=1 → realinea a Ene/Abr/Jul/Oct.
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-J/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { billing_anchor_month: 1 } },
    });
    expect(r.statusCode).toBe(200);
    // Preview con override: ciclo abr-jun.
    const p = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: {
        customer_external_id: 'c-J',
        period_from: '2026-04-01T06:00:00Z', period_to: '2026-06-30T23:59:59Z',
      } },
    });
    expect(p.statusCode).toBe(200);
  });
});
