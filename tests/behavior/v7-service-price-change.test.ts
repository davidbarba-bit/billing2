// v7 — cambio de precio programado a vigencia desde el siguiente ciclo.
//
// Verifica:
//   - PUT /api/v1/services/:code/price programa cambio con pending_effective_from > now.
//   - Validaciones: effective_from en el pasado (422), montos negativos (422).
//   - Cliente cuyo periodo empieza ANTES de effective_from mantiene precio viejo.
//   - Cliente cuyo periodo empieza ON-OR-AFTER effective_from usa precio nuevo.
//   - Setup también se versiona junto con el mensual.
//   - DELETE /pending-price cancela si aún no entró en vigor; falla con 409 si ya.
//   - Sobreescribir un pending no vencido: reemplaza sin promover base.
//   - Programar nuevo pending cuando el anterior ya entró en vigor: promueve.
//   - one_off + next_cycle usa precio efectivo según periodStart del cycle.
//   - one_off + immediate ping usa precio efectivo al momento del ping.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { createCustomerDirect } from '../helpers/factories.js';

describe('v7 — pending price change con vigencia desde siguiente ciclo', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  // -------- helpers --------
  async function seedCustomerWithRecurringService(opts: {
    customerCode?: string;
    serviceCode?: string;
    monthly?: number;
    setup?: number;
    subscriptionAt?: string;
    anchorDay?: number;
  } = {}) {
    const customerCode = opts.customerCode ?? 'c-rec';
    const serviceCode = opts.serviceCode ?? 's-rec';
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: customerCode, name: customerCode, currency: 'MXN',
      timezone: 'America/Mexico_City',
      subscriptionAt: new Date(opts.subscriptionAt ?? '2025-01-01T00:00:00Z'),
      billingAnchorDay: opts.anchorDay ?? 1,
      billingPeriodMonths: 1,
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: serviceCode, customer_external_id: customerCode, name: serviceCode,
        pricing_model: 'recurring',
        monthly_unit_amount_cents: opts.monthly ?? 50000,
        setup_unit_amount_cents: opts.setup ?? 0,
      } },
    });
    // 1 unit activa from 2025-01-01.
    await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: `seed-${serviceCode}-1`, service_code: serviceCode,
        operation_type: 'add', unit_external_id: 'u-1', unit_label: 'u-1',
        timestamp: Math.floor(new Date('2025-01-01T00:00:00Z').getTime() / 1000),
      } },
    });
    return { customerCode, serviceCode };
  }

  // ===========================================================================
  // Endpoint validations.
  // ===========================================================================

  it('PUT /price con effective_from en el pasado → 422', async () => {
    const { serviceCode } = await seedCustomerWithRecurringService();
    const r = await h.app.inject({
      method: 'PUT', url: `/api/v1/services/${serviceCode}/price`, headers: h.authHeader(),
      payload: { price: { monthly_unit_amount_cents: 80000, setup_unit_amount_cents: 0, effective_from: '2020-01-01T00:00:00Z' } },
    });
    expect(r.statusCode).toBe(422);
  });

  it('PUT /price con monto negativo → 422', async () => {
    const { serviceCode } = await seedCustomerWithRecurringService();
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const r = await h.app.inject({
      method: 'PUT', url: `/api/v1/services/${serviceCode}/price`, headers: h.authHeader(),
      payload: { price: { monthly_unit_amount_cents: -100, setup_unit_amount_cents: 0, effective_from: future } },
    });
    expect(r.statusCode).toBe(422);
  });

  it('PUT /price con service terminado → 409', async () => {
    const { serviceCode } = await seedCustomerWithRecurringService();
    await h.app.inject({ method: 'POST', url: `/api/v1/services/${serviceCode}/terminate`, headers: h.authHeader() });
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const r = await h.app.inject({
      method: 'PUT', url: `/api/v1/services/${serviceCode}/price`, headers: h.authHeader(),
      payload: { price: { monthly_unit_amount_cents: 80000, setup_unit_amount_cents: 0, effective_from: future } },
    });
    expect(r.statusCode).toBe(409);
  });

  it('PUT /price OK programa pendiente y el serializer lo expone', async () => {
    const { serviceCode } = await seedCustomerWithRecurringService();
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const r = await h.app.inject({
      method: 'PUT', url: `/api/v1/services/${serviceCode}/price`, headers: h.authHeader(),
      payload: { price: { monthly_unit_amount_cents: 80000, setup_unit_amount_cents: 12000, effective_from: future } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { service: {
      monthly_unit_amount_cents: number; setup_unit_amount_cents: number;
      pending_price_change: { monthly_unit_amount_cents: number; setup_unit_amount_cents: number; effective_from: string } | null;
    } };
    // El "vigente ahora" sigue siendo el viejo (effective_from a 30 días).
    expect(body.service.monthly_unit_amount_cents).toBe(50000);
    expect(body.service.pending_price_change).toBeTruthy();
    expect(body.service.pending_price_change!.monthly_unit_amount_cents).toBe(80000);
    expect(body.service.pending_price_change!.setup_unit_amount_cents).toBe(12000);
  });

  // ===========================================================================
  // Behavior en cycle billing: el periodStart determina qué precio aplica.
  // ===========================================================================

  it('cliente cuyo period empieza ANTES del effective_from usa precio viejo', async () => {
    const { customerCode, serviceCode } = await seedCustomerWithRecurringService({ monthly: 50000 });
    // Programa cambio a $800/u efectivo 2026-06-01.
    await h.app.inject({
      method: 'PUT', url: `/api/v1/services/${serviceCode}/price`, headers: h.authHeader(),
      payload: { price: { monthly_unit_amount_cents: 80000, setup_unit_amount_cents: 0, effective_from: '2026-06-01T00:00:00Z' } },
    });
    // Factura periodo mayo (15→31), antes del effective_from.
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'cycle-may' },
      payload: { invoice: {
        customer_external_id: customerCode,
        period_from: '2026-05-15T00:00:00Z', period_to: '2026-05-31T23:59:59Z',
        metadata: { idempotency_key: 'cycle-may' },
      } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { invoice: { fees: Array<{ kind: string; unit_amount_cents: number }> } };
    const monthly = body.invoice.fees.find((f) => f.kind === 'monthly');
    expect(monthly!.unit_amount_cents).toBe(50000);
  });

  it('cliente cuyo period empieza ON-OR-AFTER effective_from usa precio nuevo', async () => {
    const { customerCode, serviceCode } = await seedCustomerWithRecurringService({ monthly: 50000 });
    await h.app.inject({
      method: 'PUT', url: `/api/v1/services/${serviceCode}/price`, headers: h.authHeader(),
      payload: { price: { monthly_unit_amount_cents: 80000, setup_unit_amount_cents: 0, effective_from: '2026-06-01T00:00:00Z' } },
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'cycle-jun' },
      payload: { invoice: {
        customer_external_id: customerCode,
        period_from: '2026-06-01T00:00:00Z', period_to: '2026-06-30T23:59:59Z',
        metadata: { idempotency_key: 'cycle-jun' },
      } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { invoice: { fees: Array<{ kind: string; unit_amount_cents: number }> } };
    const monthly = body.invoice.fees.find((f) => f.kind === 'monthly');
    expect(monthly!.unit_amount_cents).toBe(80000);
  });

  it('cambio aplica también al setup_unit_amount_cents (units nuevas tras el corte)', async () => {
    const { customerCode, serviceCode } = await seedCustomerWithRecurringService({ monthly: 50000, setup: 10000 });
    // Programa: nuevo monthly 80000 y nuevo setup 15000, efectivo jun 1.
    await h.app.inject({
      method: 'PUT', url: `/api/v1/services/${serviceCode}/price`, headers: h.authHeader(),
      payload: { price: { monthly_unit_amount_cents: 80000, setup_unit_amount_cents: 15000, effective_from: '2026-06-01T00:00:00Z' } },
    });
    // Agrega una unit nueva el 2026-06-05 (post-cutoff).
    await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'new-unit-after-cutoff', service_code: serviceCode,
        operation_type: 'add', unit_external_id: 'u-new', unit_label: 'u-new',
        timestamp: Math.floor(new Date('2026-06-05T00:00:00Z').getTime() / 1000),
      } },
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'cycle-jun-setup' },
      payload: { invoice: {
        customer_external_id: customerCode,
        period_from: '2026-06-01T00:00:00Z', period_to: '2026-06-30T23:59:59Z',
        metadata: { idempotency_key: 'cycle-jun-setup' },
      } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { invoice: { fees: Array<{ kind: string; unit_amount_cents: number }> } };
    const setup = body.invoice.fees.find((f) => f.kind === 'setup');
    expect(setup!.unit_amount_cents).toBe(15000);
  });

  // ===========================================================================
  // Cancel + overwrite + promote.
  // ===========================================================================

  it('DELETE /pending-price cancela cambio NO vencido', async () => {
    const { serviceCode } = await seedCustomerWithRecurringService();
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await h.app.inject({
      method: 'PUT', url: `/api/v1/services/${serviceCode}/price`, headers: h.authHeader(),
      payload: { price: { monthly_unit_amount_cents: 80000, setup_unit_amount_cents: 0, effective_from: future } },
    });
    const del = await h.app.inject({
      method: 'DELETE', url: `/api/v1/services/${serviceCode}/pending-price`, headers: h.authHeader(),
    });
    expect(del.statusCode).toBe(200);
    const body = del.json() as { service: { pending_price_change: unknown; monthly_unit_amount_cents: number } };
    expect(body.service.pending_price_change).toBeNull();
    expect(body.service.monthly_unit_amount_cents).toBe(50000);
  });

  it('DELETE /pending-price falla 409 si el cambio ya entró en vigor', async () => {
    const { serviceCode } = await seedCustomerWithRecurringService();
    // Forzamos directo en DB un pending vencido (effective_from en el pasado).
    await h.prisma.service.update({
      where: { organizationId_code: { organizationId: h.organization.id, code: serviceCode } },
      data: {
        pendingMonthlyUnitAmountCents: 80000,
        pendingSetupUnitAmountCents: 0,
        pendingEffectiveFrom: new Date('2020-01-01T00:00:00Z'),
      },
    });
    const del = await h.app.inject({
      method: 'DELETE', url: `/api/v1/services/${serviceCode}/pending-price`, headers: h.authHeader(),
    });
    expect(del.statusCode).toBe(409);
  });

  it('DELETE /pending-price falla 409 si no hay pending', async () => {
    const { serviceCode } = await seedCustomerWithRecurringService();
    const del = await h.app.inject({
      method: 'DELETE', url: `/api/v1/services/${serviceCode}/pending-price`, headers: h.authHeader(),
    });
    expect(del.statusCode).toBe(409);
  });

  it('sobreescribir pending NO vencido reemplaza valores y NO promueve base', async () => {
    const { serviceCode } = await seedCustomerWithRecurringService();
    const future1 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const future2 = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    await h.app.inject({
      method: 'PUT', url: `/api/v1/services/${serviceCode}/price`, headers: h.authHeader(),
      payload: { price: { monthly_unit_amount_cents: 80000, setup_unit_amount_cents: 0, effective_from: future1 } },
    });
    const r2 = await h.app.inject({
      method: 'PUT', url: `/api/v1/services/${serviceCode}/price`, headers: h.authHeader(),
      payload: { price: { monthly_unit_amount_cents: 90000, setup_unit_amount_cents: 5000, effective_from: future2 } },
    });
    expect(r2.statusCode).toBe(200);
    const fresh = await h.prisma.service.findFirstOrThrow({ where: { code: serviceCode } });
    expect(fresh.monthlyUnitAmountCents).toBe(50000); // base sin promover
    expect(fresh.pendingMonthlyUnitAmountCents).toBe(90000);
    expect(fresh.pendingSetupUnitAmountCents).toBe(5000);
  });

  it('programar nuevo pending cuando el anterior YA entró en vigor: promueve el anterior a base', async () => {
    const { serviceCode } = await seedCustomerWithRecurringService();
    // Forzamos pending vencido directo en DB.
    await h.prisma.service.update({
      where: { organizationId_code: { organizationId: h.organization.id, code: serviceCode } },
      data: {
        pendingMonthlyUnitAmountCents: 80000,
        pendingSetupUnitAmountCents: 10000,
        pendingEffectiveFrom: new Date('2020-01-01T00:00:00Z'),
      },
    });
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const r = await h.app.inject({
      method: 'PUT', url: `/api/v1/services/${serviceCode}/price`, headers: h.authHeader(),
      payload: { price: { monthly_unit_amount_cents: 100000, setup_unit_amount_cents: 20000, effective_from: future } },
    });
    expect(r.statusCode).toBe(200);
    const fresh = await h.prisma.service.findFirstOrThrow({ where: { code: serviceCode } });
    // Base se promovió a 80000 / 10000 (lo que era pending vencido).
    expect(fresh.monthlyUnitAmountCents).toBe(80000);
    expect(fresh.setupUnitAmountCents).toBe(10000);
    // Pending es el nuevo cambio.
    expect(fresh.pendingMonthlyUnitAmountCents).toBe(100000);
    expect(fresh.pendingSetupUnitAmountCents).toBe(20000);
  });

  // ===========================================================================
  // one_off: el cycle invoice respeta el precio efectivo según periodStart.
  // ===========================================================================

  it('one_off + next_cycle: unit creada antes del corte se factura con el precio NUEVO si el cycle empieza on-or-after effective_from', async () => {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'c-oneoff', name: 'OneOff', currency: 'MXN',
      timezone: 'America/Mexico_City',
      subscriptionAt: new Date('2025-01-01T00:00:00Z'),
      nonrecurringTrigger: 'next_cycle',
      billingAnchorDay: 1, billingPeriodMonths: 1,
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-oo', customer_external_id: 'c-oneoff', name: 'oneoff',
        pricing_model: 'one_off',
        monthly_unit_amount_cents: 10000,
        setup_unit_amount_cents: 0,
        prepaid_months_default: 12,
      } },
    });
    // Programa cambio a $200/mes efectivo 2026-06-01.
    await h.app.inject({
      method: 'PUT', url: '/api/v1/services/s-oo/price', headers: h.authHeader(),
      payload: { price: { monthly_unit_amount_cents: 20000, setup_unit_amount_cents: 0, effective_from: '2026-06-01T00:00:00Z' } },
    });
    // Unit creada el 2026-06-10 (después del corte).
    await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'oo-tx-1', service_code: 's-oo', operation_type: 'add',
        unit_external_id: 'unit-A', unit_label: 'unit-A',
        timestamp: Math.floor(new Date('2026-06-10T00:00:00Z').getTime() / 1000),
      } },
    });
    // Cycle invoice del periodo junio 2026.
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'cycle-oo-jun' },
      payload: { invoice: {
        customer_external_id: 'c-oneoff',
        period_from: '2026-06-01T00:00:00Z', period_to: '2026-06-30T23:59:59Z',
        metadata: { idempotency_key: 'cycle-oo-jun' },
      } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { invoice: { fees: Array<{ kind: string; amount_cents: number }> } };
    const oneoff = body.invoice.fees.find((f) => f.kind === 'one_off');
    // 12 meses × $200 = 24000.
    expect(oneoff!.amount_cents).toBe(12 * 20000);
  });

  it('one_off + immediate ping respeta el precio vigente al momento del ping', async () => {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'c-imm', name: 'Imm', currency: 'MXN',
      timezone: 'America/Mexico_City',
      subscriptionAt: new Date('2025-01-01T00:00:00Z'),
      nonrecurringTrigger: 'immediate',
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-imm', customer_external_id: 'c-imm', name: 'imm',
        pricing_model: 'one_off',
        monthly_unit_amount_cents: 10000, setup_unit_amount_cents: 0,
        prepaid_months_default: 6,
      } },
    });
    // Programa cambio a $200 efectivo 2026-06-01.
    await h.app.inject({
      method: 'PUT', url: '/api/v1/services/s-imm/price', headers: h.authHeader(),
      payload: { price: { monthly_unit_amount_cents: 20000, setup_unit_amount_cents: 0, effective_from: '2026-06-01T00:00:00Z' } },
    });
    // Ping ANTES del corte → precio viejo.
    const pingPre = await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'imm-pre', service_code: 's-imm', operation_type: 'add',
        unit_external_id: 'unit-pre', unit_label: 'unit-pre',
        timestamp: Math.floor(new Date('2026-05-15T00:00:00Z').getTime() / 1000),
      } },
    });
    expect(pingPre.statusCode).toBe(200);
    const idPre = (pingPre.json() as { triggered_invoice_id: string }).triggered_invoice_id;
    const invPre = await h.prisma.invoice.findUniqueOrThrow({ where: { id: idPre }, include: { fees: true } });
    expect(invPre.feesAmountCents).toBe(6 * 10000);

    // Ping DESPUÉS del corte → precio nuevo.
    const pingPost = await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'imm-post', service_code: 's-imm', operation_type: 'add',
        unit_external_id: 'unit-post', unit_label: 'unit-post',
        timestamp: Math.floor(new Date('2026-06-15T00:00:00Z').getTime() / 1000),
      } },
    });
    expect(pingPost.statusCode).toBe(200);
    const idPost = (pingPost.json() as { triggered_invoice_id: string }).triggered_invoice_id;
    const invPost = await h.prisma.invoice.findUniqueOrThrow({ where: { id: idPost }, include: { fees: true } });
    expect(invPost.feesAmountCents).toBe(6 * 20000);
  });
});
