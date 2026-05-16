// v9 — códigos de producto NetSuite por kind de fee.
//
// Modelo:
//   Service: 3 códigos (monthly / setup / one_off)
//   ServiceAddOn: 1 código
//   CustomerAddOn: 1 código
//   Fee: snapshot del código al emitir (inmutable post-emisión)
//
// Casos cubiertos:
//   A) POST /services con códigos guarda y serializa
//   B) PATCH /services/:code actualiza códigos sin afectar precios
//   C) POST + PATCH /service-add-ons con netsuite_item_code
//   D) POST + PATCH /customer-add-ons con netsuite_item_code
//   E) Preview: cada fee trae su netsuite_item_code resuelto
//   F) Preview: kinds sin código configurado emiten null
//   G) Cycle invoice persistido: cada Fee tiene su netsuite_item_code snapshot
//   H) Snapshot inmutable: cambiar código en el Service no afecta Fees ya emitidas
//   I) Payload dispatch NetSuite: cada line.netsuite_item_code está presente
//   J) one_off + immediate ping: invoice usa netsuite_monthly_item_code (para
//      las mensualidades prepagadas) + netsuite_setup_item_code

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';

describe('v9 — códigos de producto NetSuite', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  async function seedCustomer(externalId = 'c-ns', nonrecurringTrigger?: 'immediate' | 'next_cycle') {
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: {
        external_id: externalId, name: externalId, currency: 'MXN',
        timezone: 'America/Mexico_City', subscription_at: '2020-01-01T00:00:00Z',
        billing_anchor_day: 1, billing_period_months: 1,
        ...(nonrecurringTrigger ? { nonrecurring_trigger: nonrecurringTrigger } : {}),
      } },
    });
  }

  // ===========================================================================
  // A — POST /services con códigos
  // ===========================================================================
  it('A) POST /services acepta y serializa los 3 códigos NetSuite', async () => {
    await seedCustomer();
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-ns', customer_external_id: 'c-ns', name: 'svc-ns',
        pricing_model: 'recurring',
        monthly_unit_amount_cents: 85000, setup_unit_amount_cents: 15000,
        netsuite_monthly_item_code: 'NS-MON',
        netsuite_setup_item_code: 'NS-SET',
      } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { service: { netsuite_monthly_item_code: string; netsuite_setup_item_code: string } };
    expect(body.service.netsuite_monthly_item_code).toBe('NS-MON');
    expect(body.service.netsuite_setup_item_code).toBe('NS-SET');
  });

  // ===========================================================================
  // B — PATCH /services/:code
  // ===========================================================================
  it('B) PATCH /services/:code actualiza códigos sin tocar precios', async () => {
    await seedCustomer();
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-ns-2', customer_external_id: 'c-ns', name: 'svc',
        pricing_model: 'recurring',
        monthly_unit_amount_cents: 50000, setup_unit_amount_cents: 0,
      } },
    });
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/services/s-ns-2', headers: h.authHeader(),
      payload: { service: { netsuite_monthly_item_code: 'NEW-CODE' } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { service: { monthly_unit_amount_cents: number; netsuite_monthly_item_code: string } };
    expect(body.service.netsuite_monthly_item_code).toBe('NEW-CODE');
    expect(body.service.monthly_unit_amount_cents).toBe(50000); // unchanged
  });

  it('B2) PATCH con string vacío limpia el código a null', async () => {
    await seedCustomer();
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-clean', customer_external_id: 'c-ns', name: 'svc',
        monthly_unit_amount_cents: 50000,
        netsuite_monthly_item_code: 'TO-CLEAR',
      } },
    });
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/services/s-clean', headers: h.authHeader(),
      payload: { service: { netsuite_monthly_item_code: '   ' } },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { service: { netsuite_monthly_item_code: string | null } }).service.netsuite_monthly_item_code).toBeNull();
  });

  // ===========================================================================
  // C — ServiceAddOn
  // ===========================================================================
  it('C) ServiceAddOn POST + PATCH netsuite_item_code', async () => {
    await seedCustomer();
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-addon', customer_external_id: 'c-ns', name: 'svc', monthly_unit_amount_cents: 50000 } },
    });
    const r1 = await h.app.inject({
      method: 'POST', url: '/api/v1/services/s-addon/add-ons', headers: h.authHeader(),
      payload: { service_add_on: { code: 'hist', name: 'hist', amount_cents: 5000, netsuite_item_code: 'NS-HIST' } },
    });
    expect(r1.statusCode).toBe(200);
    const addOn = (r1.json() as { service_add_on: { id: string; netsuite_item_code: string } }).service_add_on;
    expect(addOn.netsuite_item_code).toBe('NS-HIST');
    // PATCH
    const r2 = await h.app.inject({
      method: 'PATCH', url: `/api/v1/service-add-ons/${addOn.id}`, headers: h.authHeader(),
      payload: { service_add_on: { netsuite_item_code: 'NS-HIST-V2' } },
    });
    expect((r2.json() as { service_add_on: { netsuite_item_code: string } }).service_add_on.netsuite_item_code).toBe('NS-HIST-V2');
  });

  // ===========================================================================
  // D — CustomerAddOn
  // ===========================================================================
  it('D) CustomerAddOn POST + PATCH netsuite_item_code', async () => {
    await seedCustomer();
    const r1 = await h.app.inject({
      method: 'POST', url: '/api/v1/customers/c-ns/add-ons', headers: h.authHeader(),
      payload: { customer_add_on: { code: 'reglas', name: 'reglas', amount_cents: 50000, netsuite_item_code: 'NS-RULES' } },
    });
    expect(r1.statusCode).toBe(200);
    const addOn = (r1.json() as { customer_add_on: { id: string; netsuite_item_code: string } }).customer_add_on;
    expect(addOn.netsuite_item_code).toBe('NS-RULES');
    const r2 = await h.app.inject({
      method: 'PATCH', url: `/api/v1/customer-add-ons/${addOn.id}`, headers: h.authHeader(),
      payload: { customer_add_on: { netsuite_item_code: null } },
    });
    expect((r2.json() as { customer_add_on: { netsuite_item_code: string | null } }).customer_add_on.netsuite_item_code).toBeNull();
  });

  // ===========================================================================
  // E + F — Preview resuelve códigos (o null) por fee
  // ===========================================================================
  it('E) Preview: cada fee trae netsuite_item_code resuelto', async () => {
    await seedCustomer();
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-prev', customer_external_id: 'c-ns', name: 'svc',
        monthly_unit_amount_cents: 50000, setup_unit_amount_cents: 10000,
        netsuite_monthly_item_code: 'MON', netsuite_setup_item_code: 'SET',
      } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: 's-prev', external_id: 'u1', active_from: '2020-01-01T00:00:00Z' } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers/c-ns/add-ons', headers: h.authHeader(),
      payload: { customer_add_on: { code: 'flat', name: 'flat', amount_cents: 100000, active_from: '2020-01-01T00:00:00Z', netsuite_item_code: 'FLAT' } },
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'c-ns', period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z' } },
    });
    const preview = (r.json() as { preview: { fees: Array<{ kind: string; netsuite_item_code: string | null }> } }).preview;
    const m = preview.fees.find((f) => f.kind === 'monthly')!;
    const s = preview.fees.find((f) => f.kind === 'setup')!;
    const c = preview.fees.find((f) => f.kind === 'customer_addon')!;
    expect(m.netsuite_item_code).toBe('MON');
    expect(s.netsuite_item_code).toBe('SET');
    expect(c.netsuite_item_code).toBe('FLAT');
  });

  it('F) Preview: fees sin código → netsuite_item_code = null', async () => {
    await seedCustomer();
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-null', customer_external_id: 'c-ns', name: 'svc',
        monthly_unit_amount_cents: 50000, // sin códigos
      } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: 's-null', external_id: 'u1', active_from: '2020-01-01T00:00:00Z' } },
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'c-ns', period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z' } },
    });
    const preview = (r.json() as { preview: { fees: Array<{ kind: string; netsuite_item_code: string | null }> } }).preview;
    expect(preview.fees.find((f) => f.kind === 'monthly')!.netsuite_item_code).toBeNull();
  });

  // ===========================================================================
  // G + H — Persistencia y snapshot inmutable
  // ===========================================================================
  it('G) Cycle invoice persiste netsuite_item_code en cada Fee', async () => {
    await seedCustomer();
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-persist', customer_external_id: 'c-ns', name: 'svc',
        monthly_unit_amount_cents: 50000, setup_unit_amount_cents: 10000,
        netsuite_monthly_item_code: 'MON-X', netsuite_setup_item_code: 'SET-X',
      } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: 's-persist', external_id: 'u1', active_from: '2020-01-01T00:00:00Z' } },
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'inv-persist' },
      payload: { invoice: {
        customer_external_id: 'c-ns',
        period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z',
        metadata: { idempotency_key: 'inv-persist' },
      } },
    });
    expect(r.statusCode).toBe(200);
    const inv = (r.json() as { invoice: { id: string; fees: Array<{ kind: string; netsuite_item_code: string | null }> } }).invoice;
    expect(inv.fees.find((f) => f.kind === 'monthly')!.netsuite_item_code).toBe('MON-X');
    expect(inv.fees.find((f) => f.kind === 'setup')!.netsuite_item_code).toBe('SET-X');
  });

  it('H) Snapshot inmutable: cambiar el código en el Service NO afecta Fees ya emitidas', async () => {
    await seedCustomer();
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-snap', customer_external_id: 'c-ns', name: 'svc',
        monthly_unit_amount_cents: 50000,
        netsuite_monthly_item_code: 'ORIG',
      } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: 's-snap', external_id: 'u1', active_from: '2020-01-01T00:00:00Z' } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'inv-snap' },
      payload: { invoice: {
        customer_external_id: 'c-ns',
        period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z',
        metadata: { idempotency_key: 'inv-snap' },
      } },
    });
    // Cambia el código en el service.
    await h.app.inject({
      method: 'PATCH', url: '/api/v1/services/s-snap', headers: h.authHeader(),
      payload: { service: { netsuite_monthly_item_code: 'CHANGED' } },
    });
    // La Fee debe seguir con el código ORIGINAL.
    const svc = await h.prisma.service.findFirstOrThrow({ where: { code: 's-snap' } });
    expect(svc.netsuiteMonthlyItemCode).toBe('CHANGED');
    const fee = await h.prisma.fee.findFirstOrThrow({ where: { serviceId: svc.id, kind: 'monthly' } });
    expect(fee.netsuiteItemCode).toBe('ORIG');
  });

  // ===========================================================================
  // I — Dispatch payload contiene netsuite_item_code por line
  // ===========================================================================
  it('I) preview.netsuite_payload.lines: cada line tiene netsuite_item_code', async () => {
    await seedCustomer();
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-disp', customer_external_id: 'c-ns', name: 'svc',
        monthly_unit_amount_cents: 50000,
        netsuite_monthly_item_code: 'DISP-MON',
      } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: 's-disp', external_id: 'u1', active_from: '2020-01-01T00:00:00Z' } },
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'c-ns', period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z' } },
    });
    const ns = (r.json() as { preview: { netsuite_payload: { lines: Array<{ kind: string; netsuite_item_code: string | null }> } } }).preview.netsuite_payload;
    expect(ns.lines.find((l) => l.kind === 'monthly')!.netsuite_item_code).toBe('DISP-MON');
  });

  // ===========================================================================
  // J — one_off + immediate ping invoice
  // ===========================================================================
  it('J) one_off + immediate ping: invoice persiste setup + mensualidades (ambas con sus item codes)', async () => {
    // v10: el fee kind=one_off (mensualidades prepagadas) ahora mapea al
    // mismo netsuite_monthly_item_code que las mensualidades recurring.
    await seedCustomer('c-imm', 'immediate');
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-imm', customer_external_id: 'c-imm', name: 'imm',
        pricing_model: 'one_off',
        monthly_unit_amount_cents: 10000, setup_unit_amount_cents: 5000,
        prepaid_months_default: 12,
        netsuite_monthly_item_code: 'GPS-MONTHLY',
        netsuite_setup_item_code: 'GPS-SETUP',
      } },
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'imm-1', service_code: 's-imm', operation_type: 'add',
        unit_external_id: 'gps-1', unit_label: 'gps-1',
        timestamp: Math.floor(Date.now() / 1000),
      } },
    });
    expect(r.statusCode).toBe(200);
    const invId = (r.json() as { triggered_invoice_id?: string }).triggered_invoice_id!;
    expect(invId).toBeTruthy();
    const fees = await h.prisma.fee.findMany({ where: { invoiceId: invId } });
    expect(fees.find((f) => f.kind === 'setup')!.netsuiteItemCode).toBe('GPS-SETUP');
    expect(fees.find((f) => f.kind === 'one_off')!.netsuiteItemCode).toBe('GPS-MONTHLY');
  });
});
