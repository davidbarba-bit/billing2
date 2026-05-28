// v19 — split de la cycle invoice en recurrentes vs únicos.
//
// Customer.cycle_invoice_mode = 'unified' (default) | 'split_by_kind'.
// Cuando 'split_by_kind', el cierre de ciclo emite hasta 2 invoices:
//   · Recurrentes: monthly, service_addon, customer_addon, one_off (mensualidades
//     prepagadas SON renta).
//   · Únicos: setup, removal.
//
// Casos cubiertos:
//   A) Modo unified (default): backward compat — 1 invoice con todos los kinds.
//   B) Modo split con todos los kinds: 2 invoices, cada una con sus fees.
//   C) Modo split con solo recurrentes: 1 invoice (la recurrente, sin la oneoff).
//   D) Modo split con solo únicos: 1 invoice (la oneoff).
//   E) Sequential IDs distintos: cada invoice consume su número.
//   F) metadata.cycle_invoice_kind correcto en cada invoice.
//   G) Idempotency: re-llamar el cierre no duplica las invoices.
//   H) Mensualidades prepagadas (kind=one_off) van en la recurrente, NO en únicos.
//   I) Validación: cycle_invoice_mode con valor inválido → 422.
//   J) PATCH billing-schedule acepta cycle_invoice_mode (soft field, sin gate).

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';

describe('v19 — cycle invoice split', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  async function seedCustomer(externalId: string, mode: 'unified' | 'split_by_kind' = 'unified') {
    return h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: {
        external_id: externalId, name: externalId, currency: 'MXN',
        timezone: 'America/Mexico_City', subscription_at: '2020-01-01T00:00:00Z',
        billing_anchor_day: 1, billing_period_months: 1,
        cycle_invoice_mode: mode,
      } },
    });
  }

  async function seedService(code: string, customerExt: string, opts: { monthly?: number; setup?: number; removal?: number; pricingModel?: 'recurring' | 'one_off'; prepaidMonths?: number } = {}) {
    return h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code, customer_external_id: customerExt, name: code,
        pricing_model: opts.pricingModel ?? 'recurring',
        monthly_unit_amount_cents: opts.monthly ?? 50000,
        setup_unit_amount_cents: opts.setup ?? 10000,
        removal_unit_amount_cents: opts.removal ?? 0,
        ...(opts.prepaidMonths ? { prepaid_months_default: opts.prepaidMonths } : {}),
      } },
    });
  }

  async function seedUnit(svcCode: string, extId: string, activeFrom = '2026-01-15T18:00:00Z') {
    return h.app.inject({
      method: 'POST', url: '/api/v1/units', headers: h.authHeader(),
      payload: { unit: { service_code: svcCode, external_id: extId, active_from: activeFrom } },
    });
  }

  async function emitCycle(extId: string, periodFrom = '2026-06-01T06:00:00Z', periodTo = '2026-07-01T05:59:59Z') {
    return h.app.inject({
      method: 'POST', url: '/api/v1/invoices', headers: { ...h.authHeader(), 'idempotency-key': `test:${extId}:${periodFrom}` },
      payload: { invoice: { customer_external_id: extId, period_from: periodFrom, period_to: periodTo } },
    });
  }

  // =========================================================================
  it('A) unified (default): 1 invoice con todos los kinds', async () => {
    await seedCustomer('c-A', 'unified');
    await seedService('s-A', 'c-A', { monthly: 50000, setup: 10000, removal: 5000 });
    await seedUnit('s-A', 'u-1', '2026-01-01T06:00:00Z');
    // Terminar para que también haya removal en el período.
    const u = await h.prisma.unit.findFirstOrThrow({ where: { externalId: 'u-1' } });
    await h.prisma.unit.update({ where: { id: u.id }, data: { activeTo: new Date('2026-06-15T18:00:00Z') } });

    const r = await emitCycle('c-A');
    expect(r.statusCode).toBe(200);
    const body = r.json() as { invoice: { id: string }; companion_invoice?: unknown };
    expect(body.companion_invoice).toBeUndefined();

    const fees = await h.prisma.fee.findMany({ where: { invoiceId: body.invoice.id } });
    const kinds = new Set(fees.map((f) => f.kind));
    expect(kinds.has('monthly')).toBe(true);
    expect(kinds.has('removal')).toBe(true);
    // Setup también, porque la unit no tenía setupBilledAt previo y entra al cycle.
    expect(kinds.has('setup')).toBe(true);
  });

  // =========================================================================
  it('B) split_by_kind con todos los kinds: 2 invoices con sus fees separadas', async () => {
    await seedCustomer('c-B', 'split_by_kind');
    await seedService('s-B', 'c-B', { monthly: 50000, setup: 10000, removal: 5000 });
    await seedUnit('s-B', 'u-1', '2026-01-01T06:00:00Z');
    const u = await h.prisma.unit.findFirstOrThrow({ where: { externalId: 'u-1' } });
    await h.prisma.unit.update({ where: { id: u.id }, data: { activeTo: new Date('2026-06-15T18:00:00Z') } });

    const r = await emitCycle('c-B');
    expect(r.statusCode).toBe(200);
    const body = r.json() as { invoice: { id: string; metadata: Record<string, unknown> }; companion_invoice?: { id: string; metadata: Record<string, unknown> } };
    expect(body.companion_invoice).toBeTruthy();

    // El primario debe ser 'recurring', el companion 'oneoff' (orden estable
    // del splitter: recurring primero).
    expect(body.invoice.metadata.cycle_invoice_kind).toBe('recurring');
    expect(body.companion_invoice!.metadata.cycle_invoice_kind).toBe('oneoff');

    const recFees = await h.prisma.fee.findMany({ where: { invoiceId: body.invoice.id } });
    const oneFees = await h.prisma.fee.findMany({ where: { invoiceId: body.companion_invoice!.id } });
    const recKinds = new Set(recFees.map((f) => f.kind));
    const oneKinds = new Set(oneFees.map((f) => f.kind));
    expect(recKinds.has('monthly')).toBe(true);
    expect(recKinds.has('setup')).toBe(false);
    expect(recKinds.has('removal')).toBe(false);
    expect(oneKinds.has('setup')).toBe(true);
    expect(oneKinds.has('removal')).toBe(true);
    expect(oneKinds.has('monthly')).toBe(false);
  });

  // =========================================================================
  it('C) split_by_kind con solo recurrentes (no setup/removal pendiente): 1 invoice recurring', async () => {
    await seedCustomer('c-C', 'split_by_kind');
    await seedService('s-C', 'c-C', { monthly: 50000, setup: 0 }); // sin setup
    // Pre-marcar setupBilledAt para que el cycle no tenga setup tampoco si hubiera amount.
    await seedUnit('s-C', 'u-1', '2026-01-01T06:00:00Z');

    const r = await emitCycle('c-C');
    expect(r.statusCode).toBe(200);
    const body = r.json() as { invoice: { metadata: Record<string, unknown> }; companion_invoice?: unknown };
    expect(body.companion_invoice).toBeUndefined();
    expect(body.invoice.metadata.cycle_invoice_kind).toBe('recurring');
  });

  // =========================================================================
  it('D) split_by_kind con solo únicos (sin renta del mes): 1 invoice oneoff', async () => {
    await seedCustomer('c-D', 'split_by_kind');
    await seedService('s-D', 'c-D', { monthly: 0, setup: 10000 }); // solo setup, sin renta
    await seedUnit('s-D', 'u-1', '2026-06-15T18:00:00Z');

    const r = await emitCycle('c-D');
    expect(r.statusCode).toBe(200);
    const body = r.json() as { invoice: { metadata: Record<string, unknown> }; companion_invoice?: unknown };
    expect(body.companion_invoice).toBeUndefined();
    expect(body.invoice.metadata.cycle_invoice_kind).toBe('oneoff');
  });

  // =========================================================================
  it('E) split: sequential ids distintos', async () => {
    await seedCustomer('c-E', 'split_by_kind');
    await seedService('s-E', 'c-E', { monthly: 50000, setup: 10000 });
    await seedUnit('s-E', 'u-1', '2026-01-01T06:00:00Z');

    const r = await emitCycle('c-E');
    const body = r.json() as { invoice: { id: string }; companion_invoice: { id: string } };
    const recInv = await h.prisma.invoice.findUniqueOrThrow({ where: { id: body.invoice.id } });
    const oneInv = await h.prisma.invoice.findUniqueOrThrow({ where: { id: body.companion_invoice.id } });
    expect(recInv.sequentialId).not.toBe(oneInv.sequentialId);
  });

  // =========================================================================
  it('F) metadata.cycle_invoice_kind unified en modo unified', async () => {
    await seedCustomer('c-F', 'unified');
    await seedService('s-F', 'c-F', { monthly: 50000 });
    await seedUnit('s-F', 'u-1', '2026-01-01T06:00:00Z');

    const r = await emitCycle('c-F');
    const body = r.json() as { invoice: { metadata: Record<string, unknown> } };
    expect(body.invoice.metadata.cycle_invoice_kind).toBe('unified');
  });

  // =========================================================================
  it('G) idempotencia: 2do emit del mismo periodo NO duplica las invoices', async () => {
    await seedCustomer('c-G', 'split_by_kind');
    await seedService('s-G', 'c-G', { monthly: 50000, setup: 10000 });
    await seedUnit('s-G', 'u-1', '2026-01-01T06:00:00Z');

    const r1 = await emitCycle('c-G');
    expect(r1.statusCode).toBe(200);
    const before = await h.prisma.invoice.count({ where: { customer: { externalId: 'c-G' } } });
    expect(before).toBe(2);

    const r2 = await emitCycle('c-G');
    // Idempotency-key del request es el mismo (mismo customer + mismo period).
    expect([200, 422].includes(r2.statusCode)).toBe(true);
    const after = await h.prisma.invoice.count({ where: { customer: { externalId: 'c-G' } } });
    expect(after).toBe(2);
  });

  // =========================================================================
  it('H) mensualidades prepagadas (kind=one_off) van con recurrentes', async () => {
    await seedCustomer('c-H', 'split_by_kind');
    await seedService('s-H', 'c-H', {
      pricingModel: 'one_off', monthly: 10000, setup: 5000, prepaidMonths: 12,
    });
    await seedUnit('s-H', 'u-1', '2026-06-15T18:00:00Z');

    const r = await emitCycle('c-H');
    expect(r.statusCode).toBe(200);
    const body = r.json() as { invoice: { id: string; metadata: Record<string, unknown> }; companion_invoice?: { id: string; metadata: Record<string, unknown> } };

    // Debe haber dos invoices: una con kind 'recurring' (que tiene la fee one_off=120000),
    // y otra con kind 'oneoff' (que tiene el setup=5000).
    expect(body.companion_invoice).toBeTruthy();

    const allFees = await h.prisma.fee.findMany({
      where: { invoiceId: { in: [body.invoice.id, body.companion_invoice!.id] } },
      orderBy: { kind: 'asc' },
    });
    const oneOffFee = allFees.find((f) => f.kind === 'one_off');
    const setupFee = allFees.find((f) => f.kind === 'setup');
    expect(oneOffFee).toBeTruthy();
    expect(setupFee).toBeTruthy();

    // La fee 'one_off' (mensualidades prepagadas = renta) debe estar en la recurring invoice.
    const recurringInv = body.invoice.metadata.cycle_invoice_kind === 'recurring'
      ? body.invoice
      : body.companion_invoice!;
    const oneoffInv = body.invoice.metadata.cycle_invoice_kind === 'oneoff'
      ? body.invoice
      : body.companion_invoice!;
    expect(oneOffFee!.invoiceId).toBe(recurringInv.id);
    expect(setupFee!.invoiceId).toBe(oneoffInv.id);
  });

  // =========================================================================
  it('I) cycle_invoice_mode con valor inválido → 422', async () => {
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: {
        external_id: 'c-I', name: 'c-I', currency: 'MXN',
        timezone: 'America/Mexico_City', subscription_at: '2020-01-01T00:00:00Z',
        billing_anchor_day: 1, billing_period_months: 1,
        cycle_invoice_mode: 'something_invalid',
      } },
    });
    expect(r.statusCode).toBe(422);
    expect(JSON.stringify(r.json())).toContain('must_be_unified_or_split_by_kind');
  });

  // =========================================================================
  it('J) PATCH /billing-schedule acepta cycle_invoice_mode (soft field, sin gate)', async () => {
    await seedCustomer('c-J', 'unified');
    // Aún con invoices existentes, cycle_invoice_mode no requiere gate.
    await seedService('s-J', 'c-J', { monthly: 50000 });
    await seedUnit('s-J', 'u-1', '2026-01-01T06:00:00Z');
    await emitCycle('c-J');

    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-J/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { cycle_invoice_mode: 'split_by_kind' } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { customer: { cycle_invoice_mode: string } };
    expect(body.customer.cycle_invoice_mode).toBe('split_by_kind');
  });
});
