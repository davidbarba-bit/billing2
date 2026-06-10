// v4/v6 — intervalos configurables + servicios one_off prepagados.
//
// Verifica:
//   - Intervalos 1, 3, 6, 12 meses se respetan en billingPeriodFor.
//   - Service one_off con setup + prepaid_months_default = 48:
//     * next_cycle: 1ª unit nueva en el periodo → cycle invoice tiene
//       1 línea de setup + 1 línea de 48 meses × $X.
//     * immediate: POST /events emite invoice individual al instante con
//       2 líneas (setup + 48 meses × $X).
//   - Múltiples units one-off en next_cycle → cada unit aporta su PAR de
//     renglones (setup + mensualidades con su N propio).
//   - Override de prepaid_months por unit (override del default del service).
//   - Re-ping de unit ya cobrada NO duplica.
//   - Cobro falla si prepaid_months no está ni en la unit ni en el service.
//   - Intervalo fuera de {1,3,6,12} rechazado.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { createCustomerDirect, createUnitDirect } from '../helpers/factories.js';
import { billingPeriodFor } from '../../src/services/billing-engine.js';

describe('v6 — intervals + one_off prepagado (setup + N meses)', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  it('billingPeriodFor respeta intervalo 3M', () => {
    const customer = {
      billingPeriodMonths: 3,
      billingAnchorDay: 1,
      subscriptionAt: new Date('2026-01-01T00:00:00Z'),
    } as unknown as import('@prisma/client').Customer;
    const ref = new Date('2026-04-15T00:00:00Z');
    const { start, end } = billingPeriodFor(customer, 'UTC', ref);
    expect(start.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(end.toISOString().slice(0, 10)).toBe('2026-06-30');
  });

  it('billingPeriodFor crea stub primer periodo si subscription_at no cae en anchor', () => {
    const customer = {
      billingPeriodMonths: 1,
      billingAnchorDay: 1,
      subscriptionAt: new Date('2026-05-14T00:00:00Z'),
    } as unknown as import('@prisma/client').Customer;
    const ref = new Date('2026-05-20T00:00:00Z');
    const { start, end, daysInPeriod } = billingPeriodFor(customer, 'UTC', ref);
    expect(start.toISOString().slice(0, 10)).toBe('2026-05-14');
    expect(end.toISOString().slice(0, 10)).toBe('2026-05-31');
    expect(daysInPeriod).toBe(18);
  });

  it('one_off + next_cycle: 1 unit con 48 meses prepagados + setup → cycle invoice tiene 2 fees', async () => {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'c1', name: 'C1', currency: 'MXN', timezone: 'America/Mexico_City',
      subscriptionAt: new Date('2025-01-01T00:00:00Z'),
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-oneoff', customer_external_id: 'c1', name: 'Servicio Combustible',
        pricing_model: 'one_off',
        monthly_unit_amount_cents: 10000,   // $100/mes
        setup_unit_amount_cents: 150000,    // $1,500 setup
        prepaid_months_default: 48,
      } },
    });
    const now = Math.floor(Date.now() / 1000);
    await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: { transaction_id: 'tx-1', service_code: 's-oneoff', operation_type: 'add', unit_external_id: 'camion-001', unit_label: 'Camión 001', timestamp: now } },
    });

    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'cycle-1' },
      payload: { invoice: { customer_external_id: 'c1', metadata: { idempotency_key: 'cycle-1' } } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { invoice: { fees: Array<{ kind: string; units: string; amount_cents: number; description: string }>; fees_amount_cents: number } };

    // Esperamos 2 fees: setup ($1,500) + mensualidades (48 × $100 = $4,800).
    const setupFee = body.invoice.fees.find((f) => f.kind === 'setup');
    const monthlyFee = body.invoice.fees.find((f) => f.kind === 'one_off');
    expect(setupFee).toBeTruthy();
    expect(setupFee!.amount_cents).toBe(150000);
    expect(setupFee!.units).toBe('1.0000');
    expect(monthlyFee).toBeTruthy();
    expect(monthlyFee!.amount_cents).toBe(48 * 10000);
    expect(monthlyFee!.units).toBe('48.0000');
    expect(body.invoice.fees_amount_cents).toBe(150000 + 48 * 10000); // $6,300

    // La unit debe quedar marcada como cobrada.
    const unit = await h.prisma.unit.findFirstOrThrow({ where: { externalId: 'camion-001' } });
    expect(unit.oneoffBilledAt).not.toBeNull();
  });

  it('one_off + next_cycle: 3 units distintas → 6 fees (par setup+mensualidad por unit, una con N propio)', async () => {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'cM', name: 'Multi', currency: 'MXN',
      subscriptionAt: new Date('2025-01-01T00:00:00Z'),
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-multi', customer_external_id: 'cM', name: 'Combustible',
        pricing_model: 'one_off', monthly_unit_amount_cents: 10000,
        setup_unit_amount_cents: 150000, prepaid_months_default: 48,
      } },
    });
    const now = Math.floor(Date.now() / 1000);
    const svcMulti = await h.prisma.service.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: h.organization.id, code: 's-multi' } },
    });
    // Unit A: usa default 48 meses → seguimos detonando con POST /events.
    await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: { transaction_id: 'tx-a', service_code: 's-multi', operation_type: 'add', unit_external_id: 'u-A', timestamp: now } },
    });
    // Unit B: override 60 meses → pre-creamos en DB con prepaidMonths, luego event sin override.
    await createUnitDirect(h.prisma, {
      serviceId: svcMulti.id, externalId: 'u-B', prepaidMonths: 60,
      activeFrom: new Date(now * 1000),
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: { transaction_id: 'tx-b', service_code: 's-multi', operation_type: 'add', unit_external_id: 'u-B', timestamp: now } },
    });
    // Unit C: override 24 meses → mismo patrón.
    await createUnitDirect(h.prisma, {
      serviceId: svcMulti.id, externalId: 'u-C', prepaidMonths: 24,
      activeFrom: new Date(now * 1000),
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: { transaction_id: 'tx-c', service_code: 's-multi', operation_type: 'add', unit_external_id: 'u-C', timestamp: now } },
    });

    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'multi-1' },
      payload: { invoice: { customer_external_id: 'cM', metadata: { idempotency_key: 'multi-1' } } },
    });
    expect(r.statusCode).toBe(200);
    const inv = (r.json() as { invoice: { fees: Array<{ kind: string; units: string; amount_cents: number }>; fees_amount_cents: number } }).invoice;

    // 3 setups + 3 mensualidades = 6 fees.
    const setupFees = inv.fees.filter((f) => f.kind === 'setup');
    const monthlyFees = inv.fees.filter((f) => f.kind === 'one_off');
    expect(setupFees).toHaveLength(3);
    expect(monthlyFees).toHaveLength(3);

    // Cada setup es $1,500.
    for (const f of setupFees) expect(f.amount_cents).toBe(150000);

    // Mensualidades: 48m, 60m, 24m (sorted by unit external_id).
    const months = monthlyFees.map((f) => Number(f.units)).sort((a, b) => a - b);
    expect(months).toEqual([24, 48, 60]);

    // Total: 3 × 1500 + (48 + 60 + 24) × 100 = 4,500 + 13,200 = 17,700 ($177.00 × 100)
    expect(inv.fees_amount_cents).toBe(3 * 150000 + (48 + 60 + 24) * 10000);
  });

  it('one_off + immediate: POST /events emite invoice individual con 2 fees', async () => {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'c2', name: 'C2', currency: 'MXN', nonrecurringTrigger: 'immediate',
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-imm', customer_external_id: 'c2', name: 'Imm',
        pricing_model: 'one_off', monthly_unit_amount_cents: 10000,
        setup_unit_amount_cents: 150000, prepaid_months_default: 48,
      } },
    });

    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: { transaction_id: 'tx-imm-1', service_code: 's-imm', operation_type: 'add', unit_external_id: 'u-1', timestamp: Math.floor(Date.now()/1000) } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { triggered_invoice_id?: string };
    expect(body.triggered_invoice_id).toBeTruthy();

    const invRes = await h.app.inject({
      method: 'GET', url: `/api/v1/invoices/${body.triggered_invoice_id}`,
      headers: h.authHeader(),
    });
    const inv = (invRes.json() as { invoice: { fees: Array<{ kind: string; units: string; amount_cents: number }>; fees_amount_cents: number } }).invoice;

    expect(inv.fees).toHaveLength(2);
    const setupFee = inv.fees.find((f) => f.kind === 'setup');
    const monthlyFee = inv.fees.find((f) => f.kind === 'one_off');
    expect(setupFee?.amount_cents).toBe(150000);
    expect(monthlyFee?.amount_cents).toBe(48 * 10000);
    expect(monthlyFee?.units).toBe('48.0000');
    expect(inv.fees_amount_cents).toBe(150000 + 48 * 10000); // $6,300

    // Re-ping no duplica.
    const r2 = await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: { transaction_id: 'tx-imm-2', service_code: 's-imm', operation_type: 'add', unit_external_id: 'u-1', timestamp: Math.floor(Date.now()/1000) } },
    });
    const body2 = r2.json() as { triggered_invoice_id?: string };
    expect(body2.triggered_invoice_id).toBeUndefined();
  });

  it('one_off + immediate: el override de prepaid_months en la unit usa ese valor', async () => {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'cO', name: 'Override', currency: 'MXN', nonrecurringTrigger: 'immediate',
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-ov', customer_external_id: 'cO', name: 'Ov',
        pricing_model: 'one_off', monthly_unit_amount_cents: 10000,
        setup_unit_amount_cents: 0, prepaid_months_default: 48,
      } },
    });

    // El API ya no acepta prepaid_months en el event; pre-creamos la unit con
    // el override (72) en DB y luego mandamos el evento limpio.
    const svcOv = await h.prisma.service.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: h.organization.id, code: 's-ov' } },
    });
    await createUnitDirect(h.prisma, {
      serviceId: svcOv.id, externalId: 'u-ov', prepaidMonths: 72,
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: { transaction_id: 'tx-ov', service_code: 's-ov', operation_type: 'add', unit_external_id: 'u-ov', timestamp: Math.floor(Date.now()/1000) } },
    });
    expect(r.statusCode).toBe(200);
    const invId = (r.json() as { triggered_invoice_id: string }).triggered_invoice_id;

    const inv = (await h.app.inject({ method: 'GET', url: `/api/v1/invoices/${invId}`, headers: h.authHeader() })).json() as { invoice: { fees: Array<{ kind: string; units: string; amount_cents: number }> } };
    const monthlyFee = inv.invoice.fees.find((f) => f.kind === 'one_off');
    expect(monthlyFee?.units).toBe('72.0000');
    expect(monthlyFee?.amount_cents).toBe(72 * 10000); // $7,200
  });

  it('error si prepaid_months no está definido ni en service ni en unit', async () => {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'cErr', name: 'E', currency: 'MXN', nonrecurringTrigger: 'immediate',
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-err', customer_external_id: 'cErr', name: 'Err', pricing_model: 'one_off', monthly_unit_amount_cents: 5000 } },
    });
    // Unit sin prepaid_months y service sin default → error al facturar.
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: { transaction_id: 'tx-err', service_code: 's-err', operation_type: 'add', unit_external_id: 'u-err', timestamp: Math.floor(Date.now()/1000) } },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rechaza intervalos fuera de {1,3,6,12}', async () => {
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: { external_id: 'c5', name: 'C5', currency: 'MXN', billing_period_months: 4 } },
    });
    expect(r.statusCode).toBe(422);
  });

  it('rechaza prepaid_months_default en service recurring', async () => {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'cR', name: 'R', currency: 'MXN',
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-rec', customer_external_id: 'cR', name: 'Rec', pricing_model: 'recurring', monthly_unit_amount_cents: 1000, prepaid_months_default: 12 } },
    });
    expect(r.statusCode).toBe(422);
  });
});
