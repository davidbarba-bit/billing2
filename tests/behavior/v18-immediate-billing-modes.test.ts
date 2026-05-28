// v18 — setup_billing_mode / removal_billing_mode = 'immediate'.
//
// Permite que el cargo de instalación o de baja se emita en una invoice
// independiente al instante en que pasa el evento, en lugar de consolidarse
// con la renta del cycle invoice. Útil para Numaris: cobrar la visita técnica
// al cliente en el mismo día de instalación + cycle invoice mensual normal.
//
// Casos cubiertos:
//   A) POST /units en service con setup_billing_mode=immediate → invoice
//      con fee kind='setup' emitida al instante, unit.setupBilledAt seteado.
//   B) Cycle invoice posterior NO incluye fee de setup (porque ya facturado).
//   C) setup_billing_mode='next_cycle' (default): backward compat, sin
//      invoice inmediata al crear la unit.
//   D) Idempotencia: re-POST con mismo external_id devuelve error, pero
//      el invoice queda con idempotencyKey 'setup-immediate:<unit_id>'.
//   E) PATCH /units con active_to en service con removal_billing_mode=immediate
//      → invoice con fee kind='removal' emitida al instante.
//   F) Cycle invoice posterior NO incluye fee de removal.
//   G) setup_already_billed=true tiene prioridad sobre immediate: NO emite.
//   H) Validación: setup_billing_mode=immediate requiere setup > 0 → 422.
//   I) Validación: removal_billing_mode=immediate requiere removal > 0 → 422.
//   J) Validación: modo immediate en pricing_model=one_off → 422.
//   K) Migración de plan con chargeNewSetup=true + new service immediate
//      → invoice de setup inmediata para la nueva unit.
//   L) PATCH service permite editar setup_billing_mode post-creación.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';

describe('v18 — immediate billing modes for setup / removal', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  async function seedCustomer(externalId = 'c-1') {
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: {
        external_id: externalId, name: externalId, currency: 'MXN',
        timezone: 'America/Mexico_City', subscription_at: '2020-01-01T00:00:00Z',
        billing_anchor_day: 1, billing_period_months: 1,
      } },
    });
  }

  async function seedService(code: string, customerExt: string, opts: {
    monthly?: number; setup?: number; removal?: number;
    setupMode?: 'next_cycle' | 'immediate';
    removalMode?: 'next_cycle' | 'immediate';
  } = {}) {
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code, customer_external_id: customerExt, name: code,
        monthly_unit_amount_cents: opts.monthly ?? 50000,
        setup_unit_amount_cents: opts.setup ?? 10000,
        removal_unit_amount_cents: opts.removal ?? 0,
        setup_billing_mode: opts.setupMode ?? 'next_cycle',
        removal_billing_mode: opts.removalMode ?? 'next_cycle',
      } },
    });
    return r;
  }

  async function createUnit(svcCode: string, extId: string, opts: { activeFrom?: string; setupAlreadyBilled?: boolean } = {}) {
    return h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: {
        service_code: svcCode, external_id: extId,
        active_from: opts.activeFrom ?? '2026-01-15T18:00:00Z',
        ...(opts.setupAlreadyBilled ? { setup_already_billed: true } : {}),
      } },
    });
  }

  async function patchUnit(id: string, patch: Record<string, unknown>) {
    return h.app.inject({
      method: 'PATCH', url: `/api/v1/units/${id}`, headers: h.authHeader(),
      payload: { unit: patch },
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

  // =========================================================================
  it('A) POST /units con setup_billing_mode=immediate emite invoice setup al instante', async () => {
    await seedCustomer('c-A');
    const sr = await seedService('s-A', 'c-A', { setup: 10000, setupMode: 'immediate' });
    expect(sr.statusCode).toBe(200);
    const r = await createUnit('s-A', 'u-1');
    expect(r.statusCode).toBe(200);
    const body = r.json() as { unit: { id: string }; triggered_invoice_id?: string };
    expect(body.triggered_invoice_id).toBeTruthy();

    // Verifica el invoice creado.
    const invoice = await h.prisma.invoice.findUniqueOrThrow({
      where: { id: body.triggered_invoice_id! },
      include: { fees: true },
    });
    expect(invoice.feesAmountCents).toBe(10000);
    expect(invoice.fees.length).toBe(1);
    expect(invoice.fees[0]!.kind).toBe('setup');
    expect(invoice.fees[0]!.amountCents).toBe(10000);
    expect((invoice.metadata as Record<string, unknown>).trigger).toBe('setup_immediate');

    // Unit quedó con setupBilledAt seteado.
    const unit = await h.prisma.unit.findUniqueOrThrow({ where: { id: body.unit.id } });
    expect(unit.setupBilledAt).not.toBeNull();
  });

  // =========================================================================
  it('B) cycle invoice posterior NO incluye fee setup (ya emitido immediate)', async () => {
    await seedCustomer('c-B');
    await seedService('s-B', 'c-B', { setup: 10000, setupMode: 'immediate' });
    await createUnit('s-B', 'u-1');

    const p = await preview('c-B', '2026-06-01T06:00:00Z', '2026-07-01T05:59:59Z');
    expect(p.fees.find((f) => f.kind === 'setup')).toBeUndefined();
    expect(p.fees.find((f) => f.kind === 'monthly')).toBeTruthy();
  });

  // =========================================================================
  it('C) default next_cycle: backward compat, sin invoice inmediata', async () => {
    await seedCustomer('c-C');
    await seedService('s-C', 'c-C', { setup: 10000 }); // setup mode default
    const r = await createUnit('s-C', 'u-1');
    const body = r.json() as { triggered_invoice_id?: string };
    expect(body.triggered_invoice_id).toBeUndefined();

    const unit = await h.prisma.unit.findFirstOrThrow({ where: { externalId: 'u-1' } });
    expect(unit.setupBilledAt).toBeNull();

    const p = await preview('c-C', '2026-06-01T06:00:00Z', '2026-07-01T05:59:59Z');
    expect(p.fees.find((f) => f.kind === 'setup')?.amount_cents).toBe(10000);
  });

  // =========================================================================
  it('D) re-POST mismo external_id rechazado (422), idempotency_key del invoice persiste', async () => {
    await seedCustomer('c-D');
    await seedService('s-D', 'c-D', { setup: 10000, setupMode: 'immediate' });
    const r1 = await createUnit('s-D', 'u-1');
    expect(r1.statusCode).toBe(200);
    const inv1 = (r1.json() as { triggered_invoice_id: string }).triggered_invoice_id;

    const r2 = await createUnit('s-D', 'u-1');
    expect(r2.statusCode).toBe(422);

    // El invoice original sigue existiendo, no se duplicó.
    const allInvoices = await h.prisma.invoice.findMany({
      where: { idempotencyKey: { startsWith: 'setup-immediate:' } },
    });
    expect(allInvoices.length).toBe(1);
    expect(allInvoices[0]!.id).toBe(inv1);
  });

  // =========================================================================
  it('E) PATCH active_to en service con removal_billing_mode=immediate → invoice removal al instante', async () => {
    await seedCustomer('c-E');
    await seedService('s-E', 'c-E', { setup: 0, removal: 5000, removalMode: 'immediate' });
    const u = await createUnit('s-E', 'u-1');
    const unitId = (u.json() as { unit: { id: string } }).unit.id;

    const r = await patchUnit(unitId, { active_to: '2026-06-20T18:00:00Z' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { triggered_invoice_id?: string };
    expect(body.triggered_invoice_id).toBeTruthy();

    const invoice = await h.prisma.invoice.findUniqueOrThrow({
      where: { id: body.triggered_invoice_id! },
      include: { fees: true },
    });
    expect(invoice.fees[0]!.kind).toBe('removal');
    expect(invoice.fees[0]!.amountCents).toBe(5000);
    expect((invoice.metadata as Record<string, unknown>).trigger).toBe('removal_immediate');

    const unit = await h.prisma.unit.findUniqueOrThrow({ where: { id: unitId } });
    expect(unit.removalBilledAt).not.toBeNull();
  });

  // =========================================================================
  it('F) cycle invoice posterior NO incluye fee removal (ya emitido immediate)', async () => {
    await seedCustomer('c-F');
    await seedService('s-F', 'c-F', { removal: 5000, removalMode: 'immediate' });
    const u = await createUnit('s-F', 'u-1');
    await patchUnit((u.json() as { unit: { id: string } }).unit.id, { active_to: '2026-06-20T18:00:00Z' });

    const p = await preview('c-F', '2026-06-01T06:00:00Z', '2026-07-01T05:59:59Z');
    expect(p.fees.find((f) => f.kind === 'removal')).toBeUndefined();
  });

  // =========================================================================
  it('G) setup_already_billed=true tiene prioridad sobre immediate, NO emite invoice', async () => {
    await seedCustomer('c-G');
    await seedService('s-G', 'c-G', { setup: 10000, setupMode: 'immediate' });
    const r = await createUnit('s-G', 'u-1', { setupAlreadyBilled: true });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { triggered_invoice_id?: string }).triggered_invoice_id).toBeUndefined();

    // No hay invoice setup-immediate en DB para esta unit.
    const unit = await h.prisma.unit.findFirstOrThrow({ where: { externalId: 'u-1' } });
    const invoices = await h.prisma.invoice.findMany({
      where: { idempotencyKey: `setup-immediate:${unit.id}` },
    });
    expect(invoices.length).toBe(0);
  });

  // =========================================================================
  it('H) validación: setup_billing_mode=immediate sin setup amount → 422', async () => {
    await seedCustomer('c-H');
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-H', customer_external_id: 'c-H', name: 's',
        monthly_unit_amount_cents: 50000,
        setup_unit_amount_cents: 0,
        setup_billing_mode: 'immediate',
      } },
    });
    expect(r.statusCode).toBe(422);
    expect(JSON.stringify(r.json())).toContain('requires_setup_unit_amount_cents_greater_than_zero');
  });

  // =========================================================================
  it('I) validación: removal_billing_mode=immediate sin removal amount → 422', async () => {
    await seedCustomer('c-I');
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-I', customer_external_id: 'c-I', name: 's',
        monthly_unit_amount_cents: 50000,
        removal_unit_amount_cents: 0,
        removal_billing_mode: 'immediate',
      } },
    });
    expect(r.statusCode).toBe(422);
    expect(JSON.stringify(r.json())).toContain('requires_removal_unit_amount_cents_greater_than_zero');
  });

  // =========================================================================
  it('J) validación: modo immediate en pricing_model=one_off → 422', async () => {
    await seedCustomer('c-J');
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-J', customer_external_id: 'c-J', name: 's',
        pricing_model: 'one_off', monthly_unit_amount_cents: 10000,
        prepaid_months_default: 12,
        setup_unit_amount_cents: 5000,
        setup_billing_mode: 'immediate',
      } },
    });
    expect(r.statusCode).toBe(422);
    expect(JSON.stringify(r.json())).toContain('only_applicable_to_recurring');
  });

  // =========================================================================
  it('K) migración con chargeNewSetup=true + new service immediate → invoice setup al instante', async () => {
    await seedCustomer('c-K');
    await seedService('s-old', 'c-K', { setup: 10000 }); // setup next_cycle
    await seedService('s-new', 'c-K', { setup: 15000, setupMode: 'immediate' });
    const u = await createUnit('s-old', 'u-1');
    const oldUnitId = (u.json() as { unit: { id: string } }).unit.id;

    const future = new Date(Date.now() + 60_000).toISOString();
    const r = await h.app.inject({
      method: 'POST', url: `/api/v1/units/${oldUnitId}/migrate`, headers: h.authHeader(),
      payload: { migration: { to_service_code: 's-new', migration_at: future, charge_new_setup: true } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { new_unit: { id: string }; triggered_invoice_id?: string };
    expect(body.triggered_invoice_id).toBeTruthy();

    const invoice = await h.prisma.invoice.findUniqueOrThrow({
      where: { id: body.triggered_invoice_id! },
      include: { fees: true },
    });
    expect(invoice.fees[0]!.kind).toBe('setup');
    expect(invoice.fees[0]!.amountCents).toBe(15000);
    expect((invoice.metadata as Record<string, unknown>).source).toBe('plan_migration');

    // La unit nueva quedó con setupBilledAt seteado.
    const newUnit = await h.prisma.unit.findUniqueOrThrow({ where: { id: body.new_unit.id } });
    expect(newUnit.setupBilledAt).not.toBeNull();
  });

  // =========================================================================
  it('L) PATCH /services/:code permite editar setup_billing_mode post-creación', async () => {
    await seedCustomer('c-L');
    await seedService('s-L', 'c-L', { setup: 10000 }); // next_cycle inicial
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/services/s-L', headers: h.authHeader(),
      payload: { service: { setup_billing_mode: 'immediate' } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { service: { setup_billing_mode: string } };
    expect(body.service.setup_billing_mode).toBe('immediate');
  });
});
