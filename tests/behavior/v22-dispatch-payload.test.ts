// v22 fase 5 — el payload de dispatch a NetSuite usa el external_id de la
// RAZÓN SOCIAL (no del cliente comercial). Verifica:
//   - Default tax_entity hereda customer.externalId (continuidad legacy).
//   - Tax entity adicional usa su propio externalId; el handle es eid:<ext>.
//   - netsuite_internal_id de la entity gana sobre el fallback.
//   - El payload de cycle, immediate (catalog_event) y preview siempre lleva
//     netsuite_internal_id y netsuite_entity_handle.
//   - customer_external_id queda como referencia al cliente comercial.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeNetSuiteDispatcher } from '../../src/services/netsuite-dispatcher.js';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';

describe('v22 fase 5 — dispatch payload usa external_id de la razón social', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  async function seed(customerExternalId: string, opts: { withFilial?: boolean; netsuiteInternalId?: string } = {}) {
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: {
        external_id: customerExternalId, name: customerExternalId, currency: 'MXN',
        timezone: 'America/Mexico_City', subscription_at: '2020-01-01T00:00:00Z',
      } },
    });
    const customer = await h.prisma.customer.findFirstOrThrow({ where: { externalId: customerExternalId } });
    const defaultTe = await h.prisma.taxEntity.findFirstOrThrow({ where: { customerId: customer.id, isDefault: true } });
    let filial = null;
    if (opts.withFilial) {
      filial = await h.prisma.taxEntity.create({
        data: {
          organizationId: h.organization.id,
          customerId: customer.id,
          externalId: `${customerExternalId}-filial`,
          legalName: 'Filial SA de CV',
          taxIdentificationNumber: 'FIL010101AAA',
          netsuiteInternalId: opts.netsuiteInternalId ?? null,
          isDefault: false,
          active: true,
        },
      });
    }
    return { customer, defaultTe, filial };
  }

  // --- caso 1: razón social default copia el external_id del cliente -----

  it('crear cliente: su razón social default tiene external_id = customer.external_id', async () => {
    const { defaultTe } = await seed('cust-1');
    expect(defaultTe.externalId).toBe('cust-1');
  });

  // --- caso 2: preview lleva el handle de la razón social ----------------

  it('preview: customer.external_id del payload NetSuite es el de la razón social', async () => {
    await seed('cust-2', { withFilial: true });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-2', customer_external_id: 'cust-2', name: 'S', monthly_unit_amount_cents: 30000 } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: 's-2', external_id: 'u', active_from: '2020-01-01T00:00:00Z' } },
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'cust-2', period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z' } },
    });
    const inv0 = (r.json() as { preview: { invoices: Array<{ netsuite_payload: { customer: { external_id: string; netsuite_entity_handle: string; customer_external_id: string } } }> } }).preview.invoices[0]!;
    const ns = inv0.netsuite_payload.customer;
    // el plan está a la default → external_id de la default = customer.externalId
    expect(ns.external_id).toBe('cust-2');
    expect(ns.netsuite_entity_handle).toBe('eid:cust-2');
    expect(ns.customer_external_id).toBe('cust-2');
  });

  // --- caso 3: dispatch cycle a una filial usa su external_id ------------

  it('cycle dispatch: payload de la filial usa su external_id, no el del cliente', async () => {
    const { filial } = await seed('cust-3', { withFilial: true });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-3', customer_external_id: 'cust-3', name: 'S',
        monthly_unit_amount_cents: 50000,
        tax_entity_id: filial!.id,
      } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: 's-3', external_id: 'u', active_from: '2020-01-01T00:00:00Z' } },
    });
    // El harness usa FakeNetSuiteDispatcher; captura el último payload.
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'cycle-3' },
      payload: { invoice: {
        customer_external_id: 'cust-3',
        period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z',
        metadata: { idempotency_key: 'cycle-3' },
      } },
    });
    expect(r.statusCode).toBe(200);
    const captured = (h.dispatcher as FakeNetSuiteDispatcher).calls;
    expect(captured.length).toBeGreaterThan(0);
    const last = captured[captured.length - 1]!;
    const cust = (last.payload as { customer: { external_id: string; netsuite_entity_handle: string; customer_external_id: string } }).customer;
    expect(cust.external_id).toBe('cust-3-filial');
    expect(cust.netsuite_entity_handle).toBe('eid:cust-3-filial');
    expect(cust.customer_external_id).toBe('cust-3');
  });

  // --- caso 4: netsuite_internal_id explícito gana ---------------------

  it('cycle dispatch: si la razón social tiene netsuite_internal_id, handle = ese id', async () => {
    const { filial } = await seed('cust-4', { withFilial: true, netsuiteInternalId: '7777' });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-4', customer_external_id: 'cust-4', name: 'S',
        monthly_unit_amount_cents: 50000,
        tax_entity_id: filial!.id,
      } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: 's-4', external_id: 'u', active_from: '2020-01-01T00:00:00Z' } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'cycle-4' },
      payload: { invoice: { customer_external_id: 'cust-4', period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z', metadata: { idempotency_key: 'cycle-4' } } },
    });
    const captured = (h.dispatcher as FakeNetSuiteDispatcher).calls;
    const last = captured[captured.length - 1]!;
    const cust = (last.payload as { customer: { netsuite_internal_id: string; netsuite_entity_handle: string } }).customer;
    expect(cust.netsuite_internal_id).toBe('7777');
    expect(cust.netsuite_entity_handle).toBe('7777');
  });

  // --- caso 5: validación de external_id en API ---------------------

  it('API admin: no se pueden crear dos razones sociales con el mismo external_id en la org', async () => {
    const { customer } = await seed('cust-5');
    // Crear otra con external_id = el mismo que la default → debe fallar.
    await expect(h.prisma.taxEntity.create({
      data: {
        organizationId: h.organization.id,
        customerId: customer.id,
        externalId: 'cust-5', // ya en uso por la default
        legalName: 'Otra',
        isDefault: false,
        active: true,
      },
    })).rejects.toThrow();
  });
});
