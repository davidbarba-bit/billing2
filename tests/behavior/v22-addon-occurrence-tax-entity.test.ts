// v22 — add-ons flat de cliente y ocurrencias del catálogo se factura cada
// uno a una razón social del cliente (default = la del cliente, override
// pasando tax_entity_id en el payload). PATCH del add-on cambia la razón.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { createCustomerDirect, createCustomerCatalogEventPricing } from '../helpers/factories.js';

describe('v22 — addon y ocurrencia con razón social', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  async function setup(externalId: string) {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId, name: externalId, currency: 'MXN',
      timezone: 'America/Mexico_City',
      subscriptionAt: new Date('2020-01-01T00:00:00Z'),
    });
    const customer = await h.prisma.customer.findFirstOrThrow({ where: { externalId } });
    const defaultTe = await h.prisma.taxEntity.findFirstOrThrow({ where: { customerId: customer.id, isDefault: true } });
    const filial = await h.prisma.taxEntity.create({
      data: {
        organizationId: h.organization.id,
        customerId: customer.id,
        externalId: `${externalId}-filial`,
        legalName: `${externalId} Filial`,
        taxIdentificationNumber: 'FIL010101AAA',
        isDefault: false,
        active: true,
      },
    });
    return { customer, defaultTe, filial };
  }

  // --- customer add-ons ---------------------------------------------------

  it('POST add-on sin tax_entity_id hereda la default', async () => {
    const { defaultTe } = await setup('c-add-1');
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/customers/c-add-1/add-ons', headers: h.authHeader(),
      payload: { customer_add_on: { code: 'reglas-10', name: 'Reglas', amount_cents: 50000 } },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { customer_add_on: { tax_entity_id: string } }).customer_add_on.tax_entity_id).toBe(defaultTe.id);
  });

  it('POST add-on con tax_entity_id de otra razón social la asocia', async () => {
    const { filial } = await setup('c-add-2');
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/customers/c-add-2/add-ons', headers: h.authHeader(),
      payload: { customer_add_on: { code: 'reglas-10', name: 'Reglas', amount_cents: 50000, tax_entity_id: filial.id } },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { customer_add_on: { tax_entity_id: string } }).customer_add_on.tax_entity_id).toBe(filial.id);
  });

  it('POST add-on con tax_entity_id de OTRO cliente → 422', async () => {
    await setup('c-add-3');
    const { filial: foreign } = await setup('c-add-3-other');
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/customers/c-add-3/add-ons', headers: h.authHeader(),
      payload: { customer_add_on: { code: 'reglas-10', name: 'Reglas', amount_cents: 50000, tax_entity_id: foreign.id } },
    });
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain('not_found_for_customer');
  });

  it('PATCH cambia la razón social del add-on', async () => {
    const { filial } = await setup('c-add-4');
    const r1 = await h.app.inject({
      method: 'POST', url: '/api/v1/customers/c-add-4/add-ons', headers: h.authHeader(),
      payload: { customer_add_on: { code: 'reglas-10', name: 'Reglas', amount_cents: 50000 } },
    });
    const addOnId = (r1.json() as { customer_add_on: { id: string } }).customer_add_on.id;
    const r2 = await h.app.inject({
      method: 'PATCH', url: `/api/v1/customer-add-ons/${addOnId}`, headers: h.authHeader(),
      payload: { customer_add_on: { tax_entity_id: filial.id } },
    });
    expect(r2.statusCode).toBe(200);
    expect((r2.json() as { customer_add_on: { tax_entity_id: string } }).customer_add_on.tax_entity_id).toBe(filial.id);
  });

  // --- catalog event occurrences ------------------------------------------

  async function seedCatalogEvent(code: string) {
    // Los catalog events se crean directamente en Prisma (admin-only).
    await h.prisma.catalogEvent.create({
      data: {
        organizationId: h.organization.id,
        code, name: code,
        defaultAmountCents: 25000,
        active: true,
      },
    });
  }

  it('POST ocurrencia sin tax_entity_id hereda la default', async () => {
    const { customer, defaultTe } = await setup('c-occ-1');
    await seedCatalogEvent('reactivacion');
    // Seed pricing (precio + modo vienen del pricing pactado).
    const event = await h.prisma.catalogEvent.findFirstOrThrow({ where: { code: 'reactivacion' } });
    await createCustomerCatalogEventPricing(h.prisma, h.organization, {
      customerId: customer.id, catalogEventId: event.id,
      amountCents: 25000, billingMode: 'next_cycle',
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/catalog-events/occurrences', headers: h.authHeader(),
      payload: { catalog_event_occurrence: {
        catalog_event_code: 'reactivacion', customer_external_id: 'c-occ-1',
      } },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { catalog_event_occurrence: { tax_entity_id: string } }).catalog_event_occurrence.tax_entity_id).toBe(defaultTe.id);
  });

  it.skip('POST ocurrencia con tax_entity_id la asocia', async () => {
    // TODO: tax_entity_id ya no es parte del body de occurrences (lo resuelve el server al default).
  });

  it.skip('POST ocurrencia immediate con tax_entity_id no-default emite invoice en esa razón', async () => {
    // TODO: tax_entity_id ya no es parte del body de occurrences (lo resuelve el server al default).
  });

  it.skip('ocurrencia next_cycle a razón filial entra a su factura del cierre, no a la default', async () => {
    // TODO: tax_entity_id ya no es parte del body de occurrences (lo resuelve el server al default).
  });
});
