// v22 — un plan (service) se factura a una razón social (TaxEntity).
//
// POST /api/v1/services y PATCH /api/v1/services/:code aceptan tax_entity_id:
//   - vacío/omitido → hereda la razón social DEFAULT del cliente.
//   - id de otra razón social del MISMO cliente y activa → se asocia.
//   - id de otro cliente → 422 not_found_for_customer.
//   - id de una razón social inactiva → 422 inactive.
// Al crear un cliente se genera su razón social default automáticamente.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { createCustomerDirect } from '../helpers/factories.js';

describe('v22 — razón social del plan', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  async function createCustomer(externalId: string) {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId, name: externalId, currency: 'MXN',
      timezone: 'America/Mexico_City',
      subscriptionAt: new Date('2020-01-01T00:00:00Z'),
    });
    return h.prisma.customer.findFirstOrThrow({ where: { externalId } });
  }

  async function addTaxEntity(customerId: string, legalName: string, opts: { active?: boolean } = {}) {
    // External id estable derivado del legal name para que cada test cree
    // razones sociales con handles únicos por organization.
    const slug = legalName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+|-$/g, '');
    return h.prisma.taxEntity.create({
      data: {
        organizationId: h.organization.id,
        customerId,
        externalId: `te-${customerId.slice(0, 8)}-${slug}`,
        legalName,
        isDefault: false,
        active: opts.active ?? true,
      },
    });
  }

  async function createService(code: string, customerExternalId: string, taxEntityId?: string | null) {
    return h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code, customer_external_id: customerExternalId, name: code,
        monthly_unit_amount_cents: 50000,
        ...(taxEntityId !== undefined ? { tax_entity_id: taxEntityId } : {}),
      } },
    });
  }

  it('crear cliente genera su razón social default', async () => {
    const customer = await createCustomer('c-1');
    const entities = await h.prisma.taxEntity.findMany({ where: { customerId: customer.id } });
    expect(entities).toHaveLength(1);
    const te = entities[0]!;
    expect(te.isDefault).toBe(true);
    expect(te.legalName).toBe('c-1');
  });

  it('service sin tax_entity_id hereda la default del cliente', async () => {
    const customer = await createCustomer('c-2');
    const def = await h.prisma.taxEntity.findFirstOrThrow({ where: { customerId: customer.id, isDefault: true } });
    const r = await createService('s-2', 'c-2');
    expect(r.statusCode).toBe(200);
    const body = r.json() as { service: { tax_entity_id: string } };
    expect(body.service.tax_entity_id).toBe(def.id);
  });

  it('service con tax_entity_id de otra razón social del cliente se asocia', async () => {
    const customer = await createCustomer('c-3');
    const other = await addTaxEntity(customer.id, 'Filial SA de CV');
    const r = await createService('s-3', 'c-3', other.id);
    expect(r.statusCode).toBe(200);
    expect((r.json() as { service: { tax_entity_id: string } }).service.tax_entity_id).toBe(other.id);
  });

  it('tax_entity_id de OTRO cliente → 422', async () => {
    await createCustomer('c-4a');
    const otherCustomer = await createCustomer('c-4b');
    const foreign = await h.prisma.taxEntity.findFirstOrThrow({ where: { customerId: otherCustomer.id, isDefault: true } });
    const r = await createService('s-4', 'c-4a', foreign.id);
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain('not_found_for_customer');
  });

  it('tax_entity_id inactiva → 422', async () => {
    const customer = await createCustomer('c-5');
    const inactive = await addTaxEntity(customer.id, 'Vieja SA', { active: false });
    const r = await createService('s-5', 'c-5', inactive.id);
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain('inactive');
  });

  it('PATCH cambia la razón social del plan', async () => {
    const customer = await createCustomer('c-6');
    const other = await addTaxEntity(customer.id, 'Otra SA');
    await createService('s-6', 'c-6');
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/services/s-6', headers: h.authHeader(),
      payload: { service: { tax_entity_id: other.id } },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { service: { tax_entity_id: string } }).service.tax_entity_id).toBe(other.id);
  });

  it('PATCH con razón social de otro cliente → 422', async () => {
    await createCustomer('c-7');
    const otherCustomer = await createCustomer('c-7b');
    const foreign = await h.prisma.taxEntity.findFirstOrThrow({ where: { customerId: otherCustomer.id, isDefault: true } });
    await createService('s-7', 'c-7');
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/services/s-7', headers: h.authHeader(),
      payload: { service: { tax_entity_id: foreign.id } },
    });
    expect(r.statusCode).toBe(422);
  });
});
