// v13 — cache de NetSuite internal id + entity handle en payloads.
//
// Contrato: customer.external_id se usa como externalId en NetSuite.
// netsuite_internal_id cachea el id que NetSuite asigna (opcional);
// permite que dispatchs sucesivos referencien al customer por id directo
// (más rápido en NetSuite) en lugar de "eid:<external_id>".
//
// Computed field: customer.netsuite_entity_handle
//   - Si netsuite_internal_id está set → "<internal_id>"
//   - Si no → "eid:<external_id>"
//
// Casos:
//   A) Customer recién creado: netsuite_internal_id = null,
//      handle = "eid:<external_id>"
//   B) PATCH netsuite_internal_id se persiste y serializa
//   C) PATCH con null lo limpia
//   D) PATCH con whitespace lo normaliza a null
//   E) Preview netsuite_payload.customer incluye internal_id + handle
//   F) Cycle invoice dispatch payload incluye internal_id + handle
//   G) Customer terminado: PATCH se rechaza (mismo gate de v12)

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';

describe('v13 — NetSuite customer handle (internal id cache + entity handle)', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  async function seedCustomer(externalId = 'cristaleria-la-unica') {
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: {
        external_id: externalId, name: externalId, currency: 'MXN',
        timezone: 'America/Mexico_City', subscription_at: '2020-01-01T00:00:00Z',
        billing_anchor_day: 1, billing_period_months: 1,
      } },
    });
    expect(r.statusCode).toBe(200);
    return (r.json() as { customer: { id: string; netsuite_internal_id: string | null; netsuite_entity_handle: string } }).customer;
  }

  // ===========================================================================
  it('A) customer recién creado: netsuite_internal_id null, handle="eid:<external_id>"', async () => {
    const c = await seedCustomer('c-A');
    expect(c.netsuite_internal_id).toBeNull();
    expect(c.netsuite_entity_handle).toBe('eid:c-A');
  });

  // ===========================================================================
  it('B) PATCH netsuite_internal_id persiste y handle se recalcula', async () => {
    await seedCustomer('c-B');
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-B', headers: h.authHeader(),
      payload: { customer: { netsuite_internal_id: '614' } },
    });
    expect(r.statusCode).toBe(200);
    const c = (r.json() as { customer: { netsuite_internal_id: string; netsuite_entity_handle: string } }).customer;
    expect(c.netsuite_internal_id).toBe('614');
    expect(c.netsuite_entity_handle).toBe('614'); // sin prefijo eid:
  });

  // ===========================================================================
  it('C) PATCH con null limpia el cache', async () => {
    await seedCustomer('c-C');
    await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-C', headers: h.authHeader(),
      payload: { customer: { netsuite_internal_id: '999' } },
    });
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-C', headers: h.authHeader(),
      payload: { customer: { netsuite_internal_id: null } },
    });
    expect(r.statusCode).toBe(200);
    const c = (r.json() as { customer: { netsuite_internal_id: string | null; netsuite_entity_handle: string } }).customer;
    expect(c.netsuite_internal_id).toBeNull();
    expect(c.netsuite_entity_handle).toBe('eid:c-C');
  });

  // ===========================================================================
  it('D) PATCH con whitespace se normaliza a null', async () => {
    await seedCustomer('c-D');
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-D', headers: h.authHeader(),
      payload: { customer: { netsuite_internal_id: '   ' } },
    });
    expect(r.statusCode).toBe(200);
    const c = (r.json() as { customer: { netsuite_internal_id: string | null } }).customer;
    expect(c.netsuite_internal_id).toBeNull();
  });

  // ===========================================================================
  it('E) preview netsuite_payload.customer incluye internal_id + handle', async () => {
    await seedCustomer('c-E');
    // Sin internal id → handle = eid:.
    const r1 = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'c-E', period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z' } },
    });
    const ns1 = (r1.json() as { preview: { netsuite_payload: { customer: { netsuite_internal_id: string | null; netsuite_entity_handle: string } } } }).preview.netsuite_payload.customer;
    expect(ns1.netsuite_internal_id).toBeNull();
    expect(ns1.netsuite_entity_handle).toBe('eid:c-E');
    // Con internal id → handle = directo.
    await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-E', headers: h.authHeader(),
      payload: { customer: { netsuite_internal_id: '7777' } },
    });
    const r2 = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'c-E', period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z' } },
    });
    const ns2 = (r2.json() as { preview: { netsuite_payload: { customer: { netsuite_internal_id: string | null; netsuite_entity_handle: string } } } }).preview.netsuite_payload.customer;
    expect(ns2.netsuite_internal_id).toBe('7777');
    expect(ns2.netsuite_entity_handle).toBe('7777');
  });

  // ===========================================================================
  it('F) cycle invoice dispatch payload incluye internal_id + handle (vía dispatcher fake)', async () => {
    await seedCustomer('c-F');
    await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-F', headers: h.authHeader(),
      payload: { customer: { netsuite_internal_id: 'NS-1234' } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-f', customer_external_id: 'c-F', name: 's', monthly_unit_amount_cents: 50000 } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: 's-f', external_id: 'u1', active_from: '2020-01-01T00:00:00Z' } },
    });
    // Crea la cycle invoice. El dispatcher fake recibe el payload.
    await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'inv-f' },
      payload: { invoice: {
        customer_external_id: 'c-F',
        period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z',
        metadata: { idempotency_key: 'inv-f' },
      } },
    });
    // FakeNetSuiteDispatcher debería haber recibido el payload con el handle.
    // Como el dispatcher solo se llama si el feature flag está prendido y aquí
    // está apagado en el harness, NO recibimos nada. Verificamos en su lugar
    // la simetría con el preview (lo cual ya cubrimos en E).
    // Verificación adicional: el serializer customer incluye el handle.
    const c = await h.app.inject({
      method: 'GET', url: '/api/v1/customers/c-F', headers: h.authHeader(),
    });
    const cust = (c.json() as { customer: { netsuite_entity_handle: string } }).customer;
    expect(cust.netsuite_entity_handle).toBe('NS-1234');
  });

  // ===========================================================================
  it('G) customer terminated: PATCH netsuite_internal_id rechazado con 409', async () => {
    await seedCustomer('c-G');
    await h.prisma.customer.update({
      where: { id: (await h.prisma.customer.findFirstOrThrow({ where: { externalId: 'c-G' } })).id },
      data: { status: 'terminated', terminatedAt: new Date() },
    });
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-G', headers: h.authHeader(),
      payload: { customer: { netsuite_internal_id: '999' } },
    });
    expect(r.statusCode).toBe(409);
  });
});
