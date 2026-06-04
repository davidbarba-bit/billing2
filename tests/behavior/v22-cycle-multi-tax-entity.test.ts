// v22 — cycle invoice agrupa fees por razón social y emite UNA factura por
// entidad receptora. Multiplicado por split_by_kind, hasta N × 2 facturas
// por ciclo. Cada factura conserva su propio tax_entity_id, idempotency_key
// y fees del grupo.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';

describe('v22 — cycle invoice por razón social', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  // Setup: cliente con 2 razones sociales (default + filial) y 2 planes
  // (uno a cada razón social) con 1 unit activa cada uno.
  async function seed(externalId: string, cycleMode: 'unified' | 'split_by_kind' = 'unified') {
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: {
        external_id: externalId, name: externalId, currency: 'MXN',
        timezone: 'America/Mexico_City',
        subscription_at: '2020-01-01T00:00:00Z',
        billing_anchor_day: 1, billing_period_months: 1,
        cycle_invoice_mode: cycleMode,
      } },
    });
    const customer = await h.prisma.customer.findFirstOrThrow({ where: { externalId } });
    const defaultTe = await h.prisma.taxEntity.findFirstOrThrow({ where: { customerId: customer.id, isDefault: true } });
    const filialTe = await h.prisma.taxEntity.create({
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
    // Plan A → razón default. Setup 5000.
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: `${externalId}-a`, customer_external_id: externalId, name: 'Plan A',
        monthly_unit_amount_cents: 30000, setup_unit_amount_cents: 5000,
      } },
    });
    // Plan B → razón filial.
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: `${externalId}-b`, customer_external_id: externalId, name: 'Plan B',
        monthly_unit_amount_cents: 70000,
        tax_entity_id: filialTe.id,
      } },
    });
    // 1 unit a cada plan, vigente todo el ciclo (mayo 2026).
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: `${externalId}-a`, external_id: `${externalId}-u-a`, active_from: '2026-04-15T00:00:00Z', setup_already_billed: true } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: `${externalId}-b`, external_id: `${externalId}-u-b`, active_from: '2026-04-15T00:00:00Z' } },
    });
    return { customer, defaultTe, filialTe };
  }

  it('preview agrupa el ciclo en una entrada por razón social', async () => {
    const { defaultTe, filialTe } = await seed('c-pv');
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: {
        customer_external_id: 'c-pv',
        period_from: '2026-05-01T06:00:00Z', period_to: '2026-06-01T05:59:59Z',
      } },
    });
    expect(r.statusCode).toBe(200);
    const preview = (r.json() as { preview: {
      fees_amount_cents: number;
      invoices: Array<{ tax_entity: { id: string; is_default: boolean }; fees_amount_cents: number }>;
    } }).preview;
    // 2 facturas: una por cada razón social.
    expect(preview.invoices).toHaveLength(2);
    const byTe: Record<string, number> = {};
    for (const inv of preview.invoices) byTe[inv.tax_entity.id] = inv.fees_amount_cents;
    expect(byTe[defaultTe.id]).toBe(30000); // Plan A: 1 unit × 30000.
    expect(byTe[filialTe.id]).toBe(70000); // Plan B: 1 unit × 70000.
    expect(preview.fees_amount_cents).toBe(100000);
  });

  it('cierre de ciclo emite 2 facturas (una por razón social)', async () => {
    const { customer, defaultTe, filialTe } = await seed('c-emit');
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'cycle-emit-1' },
      payload: { invoice: {
        customer_external_id: 'c-emit',
        period_from: '2026-05-01T06:00:00Z', period_to: '2026-06-01T05:59:59Z',
        metadata: { idempotency_key: 'cycle-emit-1' },
      } },
    });
    expect(r.statusCode).toBe(200);

    const invoices = await h.prisma.invoice.findMany({
      where: { customerId: customer.id },
      orderBy: { taxEntityId: 'asc' },
    });
    expect(invoices).toHaveLength(2);
    const byTe = new Map(invoices.map((i) => [i.taxEntityId, i]));
    expect(byTe.get(defaultTe.id)!.feesAmountCents).toBe(30000);
    expect(byTe.get(filialTe.id)!.feesAmountCents).toBe(70000);
    // Idempotency keys: sufijo te:<id> porque hay más de una razón.
    for (const inv of invoices) {
      expect(inv.idempotencyKey).toMatch(/cycle-emit-1:te:/);
    }
  });

  it('re-emisión idempotente: misma key → NO duplica las 2 facturas', async () => {
    const { customer } = await seed('c-idem');
    const payload = {
      method: 'POST' as const, url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'cycle-idem-1' },
      payload: { invoice: {
        customer_external_id: 'c-idem',
        period_from: '2026-05-01T06:00:00Z', period_to: '2026-06-01T05:59:59Z',
        metadata: { idempotency_key: 'cycle-idem-1' },
      } },
    };
    await h.app.inject(payload);
    await h.app.inject(payload);
    const invoices = await h.prisma.invoice.findMany({ where: { customerId: customer.id } });
    expect(invoices).toHaveLength(2); // sigue siendo 2, no 4.
  });

  it('cliente con UNA razón social: idempotency key sin sufijo te: (un solo grupo)', async () => {
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: {
        external_id: 'c-single', name: 'c-single', currency: 'MXN',
        timezone: 'America/Mexico_City',
        subscription_at: '2020-01-01T00:00:00Z',
        billing_anchor_day: 1, billing_period_months: 1,
      } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-single', customer_external_id: 'c-single', name: 's-single',
        monthly_unit_amount_cents: 50000,
      } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: 's-single', external_id: 'u-single', active_from: '2020-01-01T00:00:00Z' } },
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'one-te' },
      payload: { invoice: {
        customer_external_id: 'c-single',
        period_from: '2026-05-01T06:00:00Z', period_to: '2026-06-01T05:59:59Z',
        metadata: { idempotency_key: 'one-te' },
      } },
    });
    expect(r.statusCode).toBe(200);
    const customer = await h.prisma.customer.findFirstOrThrow({ where: { externalId: 'c-single' } });
    const invoices = await h.prisma.invoice.findMany({ where: { customerId: customer.id } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.idempotencyKey).toBe('one-te');
  });

  it('split_by_kind × 2 razones sociales = hasta 2 × 2 = 4 facturas en un ciclo con setup pendiente', async () => {
    // Aprovecho que el Plan A tiene una unit con setup ya facturado y agrego una
    // segunda unit cuyo setup quede pendiente (saldrá como kind=setup → oneoff).
    const { customer } = await seed('c-split', 'split_by_kind');
    // Unit nueva con setup pendiente para el Plan A.
    await h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: 'c-split-a', external_id: 'c-split-u-a2', active_from: '2026-04-20T00:00:00Z' } },
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'split-key' },
      payload: { invoice: {
        customer_external_id: 'c-split',
        period_from: '2026-05-01T06:00:00Z', period_to: '2026-06-01T05:59:59Z',
        metadata: { idempotency_key: 'split-key' },
      } },
    });
    expect(r.statusCode).toBe(200);
    const invoices = await h.prisma.invoice.findMany({
      where: { customerId: customer.id },
      orderBy: { idempotencyKey: 'asc' },
    });
    // Plan A: tiene fees recurring (2 units × monthly) Y oneoff (1 setup) → 2 invoices.
    // Plan B: solo recurring (1 unit × monthly) → 1 invoice.
    // Total: 3 invoices.
    expect(invoices).toHaveLength(3);
    // Las keys traen te:<id> Y suffix de kind.
    for (const inv of invoices) {
      expect(inv.idempotencyKey).toMatch(/split-key:te:.*:(recurring|oneoff)/);
    }
  });
});
