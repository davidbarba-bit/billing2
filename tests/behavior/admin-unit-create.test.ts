// Regresión: alta de unidades desde el admin.
//
// El API público (POST /api/v1/units) solo acepta los campos comerciales
// (service_code, external_id, label, metadata, flags de migración legacy);
// los campos de configuración de facturación (active_from retroactivo,
// billing_starts_at, prepaid_months) los administra el admin escribiendo
// directo a BD después del alta. Estos tests cubren el bug donde el form
// admin reenviaba esos campos al API y recibía 422 unknown_field.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestHarness, type Harness } from '../helpers/server.js';
import { createCustomerDirect } from '../helpers/factories.js';

const ADMIN_AUTH = `Basic ${Buffer.from('admin:admin').toString('base64')}`;

describe('admin — alta de unidades desde el form', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await buildTestHarness();
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'c-admin', name: 'c-admin', currency: 'MXN',
      timezone: 'America/Mexico_City',
      subscriptionAt: new Date('2025-01-01T00:00:00Z'),
      billingAnchorDay: 1,
      billingPeriodMonths: 1,
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-admin', customer_external_id: 'c-admin', name: 's-admin',
        pricing_model: 'one_off',
        monthly_unit_amount_cents: 20000,
        setup_unit_amount_cents: 5000,
        prepaid_months_default: 12,
      } },
    });
  });

  afterAll(async () => {
    await h.app.close();
  });

  it('POST /admin/services/:code/units crea la unit con los campos admin', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/admin/services/s-admin/units',
      headers: { authorization: ADMIN_AUTH, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        external_id: 'u-admin-1',
        label: 'Camión 001',
        active_from: '2026-07-01T00:00:00Z',
        billing_starts_at: '2026-08-01T00:00:00Z',
        prepaid_months: '6',
      }).toString(),
    });
    // El form siempre redirige de vuelta al plan; el resultado va en el flash.
    expect(r.statusCode).toBe(302);
    const flash = r.cookies.find((c) => c.name === 'flash');
    expect(decodeURIComponent(flash?.value ?? '')).toContain('success');

    const unit = await h.prisma.unit.findFirstOrThrow({
      where: { externalId: 'u-admin-1', service: { code: 's-admin' } },
    });
    expect(unit.activeFrom.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(unit.billingStartsAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(unit.prepaidMonths).toBe(6);
    expect(unit.label).toBe('Camión 001');
  });

  it('POST /admin/customers/:externalId/units crea la unit (variante desde cliente)', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/admin/customers/c-admin/units',
      headers: { authorization: ADMIN_AUTH, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        service_code: 's-admin',
        external_id: 'u-admin-2',
        active_from: '2026-07-15T00:00:00Z',
        one_off_already_billed: '1',
      }).toString(),
    });
    expect(r.statusCode).toBe(302);
    const flash = r.cookies.find((c) => c.name === 'flash');
    expect(decodeURIComponent(flash?.value ?? '')).toContain('success');

    const unit = await h.prisma.unit.findFirstOrThrow({
      where: { externalId: 'u-admin-2', service: { code: 's-admin' } },
    });
    expect(unit.activeFrom.toISOString()).toBe('2026-07-15T00:00:00.000Z');
    // Flag legacy: el prepago ya fue cobrado afuera → gate marcado.
    expect(unit.oneoffBilledAt).not.toBeNull();
  });

  it('POST /admin/customers/new sin external_id genera slug del nombre y asigna el id de la razón social', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/admin/customers/new',
      headers: { authorization: ADMIN_AUTH, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        name: 'Aditivos y Vitaminas Mexicanas',
        currency: 'MXN',
        tax_entity_legal_name: 'Aditivos y Vitaminas Mexicanas S.A. de C.V.',
        tax_entity_external_id: '1894',
      }).toString(),
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/admin/customers/aditivos-y-vitaminas-mexicanas');

    const customer = await h.prisma.customer.findFirstOrThrow({
      where: { externalId: 'aditivos-y-vitaminas-mexicanas' },
      include: { taxEntities: true },
    });
    expect(customer.taxEntities).toHaveLength(1);
    expect(customer.taxEntities[0]!.externalId).toBe('1894');
    expect(customer.taxEntities[0]!.legalName).toBe('Aditivos y Vitaminas Mexicanas S.A. de C.V.');
    expect(customer.taxEntities[0]!.isDefault).toBe(true);
  });

  it('POST /admin/customers/new con id de razón social duplicado → 409 con mensaje claro', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/admin/customers/new',
      headers: { authorization: ADMIN_AUTH, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        name: 'Otro Cliente',
        currency: 'MXN',
        tax_entity_external_id: '1894',
      }).toString(),
    });
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain('1894');
    expect(r.body).toContain('razón social');
  });

  it('POST /admin/customers/new con nombre repetido genera slug con sufijo', async () => {
    const r = await h.app.inject({
      method: 'POST',
      url: '/admin/customers/new',
      headers: { authorization: ADMIN_AUTH, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        name: 'Aditivos y Vitaminas Mexicanas',
        currency: 'MXN',
      }).toString(),
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/admin/customers/aditivos-y-vitaminas-mexicanas-2');
  });

  it('POST /admin/units/:id/edit actualiza label y billing_starts_at directo a BD', async () => {
    const unit = await h.prisma.unit.findFirstOrThrow({ where: { externalId: 'u-admin-1' } });
    const r = await h.app.inject({
      method: 'POST',
      url: `/admin/units/${unit.id}/edit`,
      headers: { authorization: ADMIN_AUTH, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        label: 'Camión 001 renombrado',
        billing_starts_at: '2026-09-01T00:00:00Z',
      }).toString(),
    });
    expect(r.statusCode).toBe(302);
    const updated = await h.prisma.unit.findUniqueOrThrow({ where: { id: unit.id } });
    expect(updated.label).toBe('Camión 001 renombrado');
    expect(updated.billingStartsAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});
