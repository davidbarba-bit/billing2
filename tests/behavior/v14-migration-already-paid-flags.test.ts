// v14 — flags "ya pagado afuera" para migración desde sistemas legacy.
//
// POST /api/v1/units y POST /api/v1/events aceptan al CREATE de unit:
//   - setup_already_billed: true  → recurring: marca setupBilledAt para que
//     el motor NO incluya la unit en buildSetupFee. Mensualidad sigue normal.
//   - one_off_already_billed: true → one_off: marca oneoffBilledAt para que
//     la unit nunca entre al cycle invoice ni dispare el ping immediate.
//
// Flag enviado para el pricing_model "equivocado" se ignora silenciosamente.
//
// Casos:
//   A) Recurring + setup_already_billed: cycle invoice NO incluye setup
//      pero SÍ incluye monthly.
//   B) Recurring + setup_already_billed: setupBilledAt seteado en la DB
//      con el valor de active_from.
//   C) Recurring sin flag: cycle invoice incluye setup normal (regression).
//   D) Flag enviado a pricing_model="one_off" se ignora.
//   E) One_off + one_off_already_billed: NO entra al cycle invoice (filter).
//   F) One_off + one_off_already_billed + immediate trigger: el ping NO
//      emite invoice (oneoffBilledAt ya seteado).
//   G) POST /events crea unit con flags.
//   H) Combinado con billing_starts_at: ambos coexisten correctamente.
//   I) Flags al re-pingear unit existente se IGNORAN (no aplica al update).

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';

describe('v14 — flags "ya pagado afuera" para migración legacy', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  async function seedCustomer(externalId = 'c-mig', trigger?: 'immediate' | 'next_cycle') {
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: {
        external_id: externalId, name: externalId, currency: 'MXN',
        timezone: 'America/Mexico_City', subscription_at: '2020-01-01T00:00:00Z',
        billing_anchor_day: 1, billing_period_months: 1,
        ...(trigger ? { nonrecurring_trigger: trigger } : {}),
      } },
    });
  }

  async function preview(extId: string, period_from: string, period_to: string) {
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: extId, period_from, period_to } },
    });
    expect(r.statusCode).toBe(200);
    return (r.json() as { preview: { fees: Array<{ kind: string; amount_cents: number }> } }).preview;
  }

  // ===========================================================================
  it('A) recurring + setup_already_billed: cycle NO incluye setup, SÍ monthly', async () => {
    await seedCustomer('c-A');
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-A', customer_external_id: 'c-A', name: 's',
        monthly_unit_amount_cents: 50000, setup_unit_amount_cents: 10000,
      } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: {
        service_code: 's-A', external_id: 'u-1',
        active_from: '2020-01-01T00:00:00Z',
        setup_already_billed: true,
      } },
    });
    const p = await preview('c-A', '2026-06-01T06:00:00Z', '2026-07-01T05:59:59Z');
    expect(p.fees.find((f) => f.kind === 'monthly')).toBeTruthy();
    expect(p.fees.find((f) => f.kind === 'setup')).toBeUndefined();
  });

  // ===========================================================================
  it('B) setup_already_billed marca setupBilledAt en DB = active_from', async () => {
    await seedCustomer('c-B');
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-B', customer_external_id: 'c-B', name: 's', monthly_unit_amount_cents: 50000, setup_unit_amount_cents: 10000 } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: {
        service_code: 's-B', external_id: 'u-1',
        active_from: '2026-01-15T00:00:00Z',
        setup_already_billed: true,
      } },
    });
    const u = await h.prisma.unit.findFirstOrThrow({ where: { externalId: 'u-1' } });
    expect(u.setupBilledAt).not.toBeNull();
    expect(u.setupBilledAt!.toISOString()).toContain('2026-01-15');
  });

  // ===========================================================================
  it('C) regression: sin flag, recurring cobra setup normalmente', async () => {
    await seedCustomer('c-C');
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-C', customer_external_id: 'c-C', name: 's', monthly_unit_amount_cents: 50000, setup_unit_amount_cents: 10000 } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: 's-C', external_id: 'u-1', active_from: '2020-01-01T00:00:00Z' } },
    });
    const p = await preview('c-C', '2026-06-01T06:00:00Z', '2026-07-01T05:59:59Z');
    expect(p.fees.find((f) => f.kind === 'setup')?.amount_cents).toBe(10000);
  });

  // ===========================================================================
  it('D) setup_already_billed se ignora silenciosamente en pricing_model=one_off', async () => {
    await seedCustomer('c-D', 'next_cycle');
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-D', customer_external_id: 'c-D', name: 's',
        pricing_model: 'one_off', monthly_unit_amount_cents: 10000,
        setup_unit_amount_cents: 5000, prepaid_months_default: 12,
      } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: {
        service_code: 's-D', external_id: 'u-1',
        active_from: '2026-06-15T00:00:00Z',
        setup_already_billed: true, // se ignora porque es one_off
      } },
    });
    const u = await h.prisma.unit.findFirstOrThrow({ where: { externalId: 'u-1' } });
    expect(u.setupBilledAt).toBeNull(); // no se aplicó
    expect(u.oneoffBilledAt).toBeNull();
  });

  // ===========================================================================
  it('E) one_off_already_billed: cycle invoice NO incluye la unit', async () => {
    await seedCustomer('c-E', 'next_cycle');
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-E', customer_external_id: 'c-E', name: 's',
        pricing_model: 'one_off', monthly_unit_amount_cents: 10000,
        setup_unit_amount_cents: 5000, prepaid_months_default: 12,
      } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: {
        service_code: 's-E', external_id: 'u-1',
        active_from: '2026-06-15T00:00:00Z',
        one_off_already_billed: true,
      } },
    });
    const p = await preview('c-E', '2026-06-01T06:00:00Z', '2026-07-01T05:59:59Z');
    // NO debe haber fees one_off ni setup para esta unit.
    expect(p.fees.find((f) => f.kind === 'one_off')).toBeUndefined();
    expect(p.fees.find((f) => f.kind === 'setup')).toBeUndefined();
  });

  // ===========================================================================
  it('F) one_off + immediate + one_off_already_billed: el ping NO emite invoice', async () => {
    await seedCustomer('c-F', 'immediate');
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-F', customer_external_id: 'c-F', name: 's',
        pricing_model: 'one_off', monthly_unit_amount_cents: 10000,
        setup_unit_amount_cents: 5000, prepaid_months_default: 12,
      } },
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'tx-F', service_code: 's-F', operation_type: 'add',
        unit_external_id: 'u-1', unit_label: 'u-1',
        timestamp: Math.floor(Date.now() / 1000),
        one_off_already_billed: true,
      } },
    });
    expect(r.statusCode).toBe(200);
    // No debe haber triggered_invoice_id.
    expect((r.json() as Record<string, unknown>).triggered_invoice_id).toBeUndefined();
    // Y no debe existir invoice en la DB.
    expect(await h.prisma.invoice.count()).toBe(0);
    // Unit existe y tiene oneoffBilledAt seteado.
    const u = await h.prisma.unit.findFirstOrThrow({ where: { externalId: 'u-1' } });
    expect(u.oneoffBilledAt).not.toBeNull();
  });

  // ===========================================================================
  it('G) POST /events crea unit con flags al primer ping', async () => {
    await seedCustomer('c-G');
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-G', customer_external_id: 'c-G', name: 's', monthly_unit_amount_cents: 50000, setup_unit_amount_cents: 10000 } },
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'tx-G', service_code: 's-G', operation_type: 'add',
        unit_external_id: 'u-1',
        timestamp: Math.floor(new Date('2026-06-15T00:00:00Z').getTime() / 1000),
        setup_already_billed: true,
      } },
    });
    expect(r.statusCode).toBe(200);
    const u = await h.prisma.unit.findFirstOrThrow({ where: { externalId: 'u-1' } });
    expect(u.setupBilledAt).not.toBeNull();
  });

  // ===========================================================================
  it('H) combinación setup_already_billed + billing_starts_at coexisten', async () => {
    await seedCustomer('c-H');
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-H', customer_external_id: 'c-H', name: 's', monthly_unit_amount_cents: 50000, setup_unit_amount_cents: 10000 } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: {
        service_code: 's-H', external_id: 'u-1',
        active_from: '2026-06-15T00:00:00Z',
        billing_starts_at: '2026-07-01T06:00:00Z',
        setup_already_billed: true,
      } },
    });
    // Preview junio: nada (billing_starts_at > junio).
    const may = await preview('c-H', '2026-06-01T06:00:00Z', '2026-07-01T05:59:59Z');
    expect(may.fees.find((f) => f.kind === 'monthly')).toBeUndefined();
    expect(may.fees.find((f) => f.kind === 'setup')).toBeUndefined();
    // Preview julio: monthly sí, setup NO (porque setup_already_billed).
    const jul = await preview('c-H', '2026-07-01T06:00:00Z', '2026-08-01T05:59:59Z');
    expect(jul.fees.find((f) => f.kind === 'monthly')).toBeTruthy();
    expect(jul.fees.find((f) => f.kind === 'setup')).toBeUndefined();
  });

  // ===========================================================================
  it('I) flags al re-pingear unit existente son ignorados', async () => {
    await seedCustomer('c-I');
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-I', customer_external_id: 'c-I', name: 's', monthly_unit_amount_cents: 50000, setup_unit_amount_cents: 10000 } },
    });
    // Primer ping SIN flag.
    await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'tx-I-1', service_code: 's-I', operation_type: 'add',
        unit_external_id: 'u-1',
        timestamp: Math.floor(new Date('2026-06-01T00:00:00Z').getTime() / 1000),
      } },
    });
    // Segundo ping CON flag — debería ignorarse.
    await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'tx-I-2', service_code: 's-I', operation_type: 'add',
        unit_external_id: 'u-1',
        timestamp: Math.floor(new Date('2026-06-02T00:00:00Z').getTime() / 1000),
        setup_already_billed: true, // ignorado porque la unit ya existe
      } },
    });
    const u = await h.prisma.unit.findFirstOrThrow({ where: { externalId: 'u-1' } });
    expect(u.setupBilledAt).toBeNull(); // sigue null, no se aplicó retroactivo
  });
});
