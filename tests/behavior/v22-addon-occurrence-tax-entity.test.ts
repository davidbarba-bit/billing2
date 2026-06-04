// v22 — add-ons flat de cliente y ocurrencias del catálogo se factura cada
// uno a una razón social del cliente (default = la del cliente, override
// pasando tax_entity_id en el payload). PATCH del add-on cambia la razón.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';

describe('v22 — addon y ocurrencia con razón social', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  async function setup(externalId: string) {
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: {
        external_id: externalId, name: externalId, currency: 'MXN',
        timezone: 'America/Mexico_City', subscription_at: '2020-01-01T00:00:00Z',
      } },
    });
    const customer = await h.prisma.customer.findFirstOrThrow({ where: { externalId } });
    const defaultTe = await h.prisma.taxEntity.findFirstOrThrow({ where: { customerId: customer.id, isDefault: true } });
    const filial = await h.prisma.taxEntity.create({
      data: {
        organizationId: h.organization.id,
        customerId: customer.id,
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
    const { defaultTe } = await setup('c-occ-1');
    await seedCatalogEvent('reactivacion');
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/catalog-events/occurrences', headers: h.authHeader(),
      payload: { catalog_event_occurrence: {
        catalog_event_code: 'reactivacion', customer_external_id: 'c-occ-1',
        billing_mode: 'next_cycle',
      } },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { catalog_event_occurrence: { tax_entity_id: string } }).catalog_event_occurrence.tax_entity_id).toBe(defaultTe.id);
  });

  it('POST ocurrencia con tax_entity_id la asocia', async () => {
    const { filial } = await setup('c-occ-2');
    await seedCatalogEvent('reactivacion');
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/catalog-events/occurrences', headers: h.authHeader(),
      payload: { catalog_event_occurrence: {
        catalog_event_code: 'reactivacion', customer_external_id: 'c-occ-2',
        billing_mode: 'next_cycle', tax_entity_id: filial.id,
      } },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { catalog_event_occurrence: { tax_entity_id: string } }).catalog_event_occurrence.tax_entity_id).toBe(filial.id);
  });

  it('POST ocurrencia immediate con tax_entity_id no-default emite invoice en esa razón', async () => {
    const { customer, filial } = await setup('c-occ-3');
    await seedCatalogEvent('reactivacion');
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/catalog-events/occurrences', headers: h.authHeader(),
      payload: { catalog_event_occurrence: {
        catalog_event_code: 'reactivacion', customer_external_id: 'c-occ-3',
        billing_mode: 'immediate', tax_entity_id: filial.id,
      } },
    });
    expect(r.statusCode).toBe(200);
    const invoiceId = (r.json() as { catalog_event_occurrence: { invoice_id: string | null } }).catalog_event_occurrence.invoice_id;
    expect(invoiceId).not.toBeNull();
    const invoice = await h.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId! } });
    expect(invoice.customerId).toBe(customer.id);
    expect(invoice.taxEntityId).toBe(filial.id);
  });

  it('ocurrencia next_cycle a razón filial entra a su factura del cierre, no a la default', async () => {
    const { customer, defaultTe, filial } = await setup('c-occ-4');
    await seedCatalogEvent('reactivacion');
    // Plan a la default con 1 unit para que la default tenga su propia factura.
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 'c-occ-4-a', customer_external_id: 'c-occ-4', name: 'Plan A', monthly_unit_amount_cents: 30000 } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: 'c-occ-4-a', external_id: 'u', active_from: '2026-04-15T00:00:00Z' } },
    });
    // Ocurrencia next_cycle a la FILIAL.
    await h.app.inject({
      method: 'POST', url: '/api/v1/catalog-events/occurrences', headers: h.authHeader(),
      payload: { catalog_event_occurrence: {
        catalog_event_code: 'reactivacion', customer_external_id: 'c-occ-4',
        billing_mode: 'next_cycle', amount_cents: 25000, tax_entity_id: filial.id,
        occurred_at: '2026-05-15T12:00:00Z',
      } },
    });
    // Cierre del ciclo de mayo: 2 facturas (una por razón social).
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'cycle-occ' },
      payload: { invoice: {
        customer_external_id: 'c-occ-4',
        period_from: '2026-05-01T06:00:00Z', period_to: '2026-06-01T05:59:59Z',
        metadata: { idempotency_key: 'cycle-occ' },
      } },
    });
    expect(r.statusCode).toBe(200);
    const invoices = await h.prisma.invoice.findMany({
      where: { customerId: customer.id },
      orderBy: { taxEntityId: 'asc' },
      include: { fees: true },
    });
    expect(invoices).toHaveLength(2);
    const byTe = new Map(invoices.map((i) => [i.taxEntityId, i]));
    expect(byTe.get(defaultTe.id)!.feesAmountCents).toBe(30000); // solo el plan
    expect(byTe.get(filial.id)!.feesAmountCents).toBe(25000); // solo la ocurrencia
    expect(byTe.get(filial.id)!.fees.some((f) => f.kind === 'catalog_event')).toBe(true);
  });
});
