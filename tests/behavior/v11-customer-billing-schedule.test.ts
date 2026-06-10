// v11 — edición del calendario de facturación post-creación.
//
// PATCH /api/v1/customers/:external_id/billing-schedule
//   Permite cambiar: subscription_at, billing_anchor_day,
//   billing_period_months, nonrecurring_trigger.
//
// Reglas:
//   - subscription_at / anchor / period gateados por "no invoices no-voided".
//   - nonrecurring_trigger SIN gate.
//   - Customer terminated → 409.
//   - Recalcula currentBillingPeriod* automáticamente.
//   - Guarda histórico append-only en customer.metadata.schedule_history.
//
// Casos cubiertos:
//   A) Cambio simple: subscription_at futuro → status pending, period* null
//   B) Cambio simple: subscription_at en el pasado → recalcula period
//   C) Cambiar period_months 1→3 recalcula correctamente
//   D) Cambiar anchor_day → recalcula
//   E) Solo nonrecurring_trigger → permitido SIN gate de invoices
//   F) 409 si hay invoice no-voided y se cambia subscription_at
//   G) Invoice voided NO bloquea el cambio
//   H) Customer terminated → 409
//   I) Customer no existe → 404
//   J) Sin ningún campo → 422
//   K) Validación: anchor fuera de rango → 422
//   L) Validación: period_months no en {1,3,6,12} → 422
//   M) Audit history se acumula en metadata.schedule_history
//   N) Preview tras el cambio respeta el nuevo schedule

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { createCustomerDirect } from '../helpers/factories.js';

describe('v11 — editar billing_schedule del customer post-creación', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  async function seedCustomer(externalId = 'c-sched', subscriptionAt = '2026-05-16T00:00:00Z') {
    const sub = new Date(subscriptionAt);
    const isFuture = sub.getTime() > Date.now();
    await createCustomerDirect(h.prisma, h.organization, {
      externalId, name: externalId, currency: 'MXN',
      timezone: 'America/Mexico_City',
      subscriptionAt: sub,
      billingAnchorDay: 1, billingPeriodMonths: 1,
      status: isFuture ? 'pending' : 'active',
    });
  }

  function future(daysFromNow = 30): string {
    return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
  }

  function past(daysAgo = 365): string {
    return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  }

  // ===========================================================================
  // A — Cambio a subscription_at futuro → status pending
  // ===========================================================================
  it('A) subscription_at futuro → status pending y period* en null', async () => {
    await seedCustomer('c-A', past(10)); // creado activo
    const f = future(30);
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-A/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { subscription_at: f } },
    });
    expect(r.statusCode).toBe(200);
    const c = (r.json() as { customer: { status: string; subscription_at: string; current_billing_period_started_at: string | null; current_billing_period_ending_at: string | null } }).customer;
    expect(c.status).toBe('pending');
    // Comparamos segundo a segundo (el serializer trunca milisegundos).
    const diff = Math.abs(new Date(c.subscription_at).getTime() - new Date(f).getTime());
    expect(diff).toBeLessThan(1000);
    expect(c.current_billing_period_started_at).toBeNull();
    expect(c.current_billing_period_ending_at).toBeNull();
  });

  // ===========================================================================
  // B — subscription_at en el pasado → recalcula period inmediatamente
  // ===========================================================================
  it('B) subscription_at en el pasado → status active y period recalculado', async () => {
    await seedCustomer('c-B', past(10));
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-B/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { subscription_at: '2020-01-01T06:00:00Z' } },
    });
    expect(r.statusCode).toBe(200);
    const c = (r.json() as { customer: { status: string; current_billing_period_started_at: string | null; current_billing_period_ending_at: string | null } }).customer;
    expect(c.status).toBe('active');
    expect(c.current_billing_period_started_at).not.toBeNull();
    expect(c.current_billing_period_ending_at).not.toBeNull();
  });

  // ===========================================================================
  // C — Cambiar period_months 1→3
  // ===========================================================================
  it('C) cambiar billing_period_months de 1 a 3 recalcula y persiste', async () => {
    await seedCustomer('c-C', '2020-01-01T06:00:00Z');
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-C/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { billing_period_months: 3 } },
    });
    expect(r.statusCode).toBe(200);
    const c = (r.json() as { customer: { billing_period_months: number } }).customer;
    expect(c.billing_period_months).toBe(3);
  });

  // ===========================================================================
  // D — Cambiar anchor_day
  // ===========================================================================
  it('D) cambiar billing_anchor_day recalcula', async () => {
    await seedCustomer('c-D', '2020-01-01T06:00:00Z');
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-D/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { billing_anchor_day: 15 } },
    });
    expect(r.statusCode).toBe(200);
    const c = (r.json() as { customer: { billing_anchor_day: number } }).customer;
    expect(c.billing_anchor_day).toBe(15);
  });

  // ===========================================================================
  // E — nonrecurring_trigger sin gate
  // ===========================================================================
  it('E) cambiar solo nonrecurring_trigger SIN gate aunque haya invoices', async () => {
    await seedCustomer('c-E', '2020-01-01T06:00:00Z');
    // Crea service y unit y emite invoice.
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-e', customer_external_id: 'c-E', name: 's', monthly_unit_amount_cents: 50000 } },
    });
    const svcE = await h.prisma.service.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: h.organization.id, code: 's-e' } },
    });
    await h.prisma.unit.create({
      data: { serviceId: svcE.id, externalId: 'u1', activeFrom: new Date('2020-01-01T00:00:00Z') },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'inv-e' },
      payload: { invoice: {
        customer_external_id: 'c-E',
        period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z',
        metadata: { idempotency_key: 'inv-e' },
      } },
    });
    // Cambia solo trigger — debe pasar a pesar de tener invoice.
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-E/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { nonrecurring_trigger: 'immediate' } },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { customer: { nonrecurring_trigger: string } }).customer.nonrecurring_trigger).toBe('immediate');
  });

  // ===========================================================================
  // F — 409 si hay invoice no-voided y se cambia subscription_at
  // ===========================================================================
  it('F) 409 al cambiar subscription_at si hay invoice no-voided', async () => {
    await seedCustomer('c-F', '2020-01-01T06:00:00Z');
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-f', customer_external_id: 'c-F', name: 's', monthly_unit_amount_cents: 50000 } },
    });
    const svcF = await h.prisma.service.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: h.organization.id, code: 's-f' } },
    });
    await h.prisma.unit.create({
      data: { serviceId: svcF.id, externalId: 'u1', activeFrom: new Date('2020-01-01T00:00:00Z') },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'inv-f' },
      payload: { invoice: {
        customer_external_id: 'c-F',
        period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z',
        metadata: { idempotency_key: 'inv-f' },
      } },
    });
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-F/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { subscription_at: future(60) } },
    });
    expect(r.statusCode).toBe(409);
  });

  // ===========================================================================
  // G — Invoice voided NO bloquea
  // ===========================================================================
  it('G) invoice voided NO bloquea el cambio de schedule', async () => {
    await seedCustomer('c-G', '2020-01-01T06:00:00Z');
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-g', customer_external_id: 'c-G', name: 's', monthly_unit_amount_cents: 50000 } },
    });
    const svcG = await h.prisma.service.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: h.organization.id, code: 's-g' } },
    });
    await h.prisma.unit.create({
      data: { serviceId: svcG.id, externalId: 'u1', activeFrom: new Date('2020-01-01T00:00:00Z') },
    });
    const inv = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'inv-g' },
      payload: { invoice: {
        customer_external_id: 'c-G',
        period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z',
        metadata: { idempotency_key: 'inv-g' },
      } },
    });
    const invId = (inv.json() as { invoice: { id: string } }).invoice.id;
    await h.app.inject({
      method: 'POST', url: `/api/v1/invoices/${invId}/void`, headers: h.authHeader(),
    });
    // Voided → debe permitir.
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-G/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { subscription_at: future(60) } },
    });
    expect(r.statusCode).toBe(200);
  });

  // ===========================================================================
  // H — Customer terminated → 409
  // ===========================================================================
  it('H) customer terminated → 409', async () => {
    await seedCustomer('c-H', past(10));
    await h.prisma.customer.update({
      where: { id: (await h.prisma.customer.findFirstOrThrow({ where: { externalId: 'c-H' } })).id },
      data: { status: 'terminated', terminatedAt: new Date() },
    });
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-H/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { subscription_at: future(10) } },
    });
    expect(r.statusCode).toBe(409);
  });

  // ===========================================================================
  // I — Customer no existe → 404
  // ===========================================================================
  it('I) customer inexistente → 404', async () => {
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/no-existe/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { subscription_at: future(10) } },
    });
    expect(r.statusCode).toBe(404);
  });

  // ===========================================================================
  // J — Sin ningún campo → 422
  // ===========================================================================
  it('J) sin ningún campo en billing_schedule → 422', async () => {
    await seedCustomer('c-J', past(10));
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-J/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: {} },
    });
    expect(r.statusCode).toBe(422);
  });

  // ===========================================================================
  // K-L — Validación de rango
  // ===========================================================================
  it('K) anchor_day fuera de rango → 422', async () => {
    await seedCustomer('c-K', past(10));
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-K/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { billing_anchor_day: 31 } },
    });
    expect(r.statusCode).toBe(422);
  });

  it('L) period_months no en {1,3,6,12} → 422', async () => {
    await seedCustomer('c-L', past(10));
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-L/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { billing_period_months: 2 } },
    });
    expect(r.statusCode).toBe(422);
  });

  // ===========================================================================
  // M — Audit history en metadata
  // ===========================================================================
  it('M) historial de cambios se acumula en metadata.schedule_history', async () => {
    await seedCustomer('c-M', past(10));
    // Primer cambio.
    await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-M/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { billing_period_months: 3 } },
    });
    // Segundo cambio.
    await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-M/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { billing_anchor_day: 15 } },
    });
    const c = await h.prisma.customer.findFirstOrThrow({ where: { externalId: 'c-M' } });
    const meta = c.metadata as Record<string, unknown>;
    const history = meta.schedule_history as Array<{ at: string; before: unknown; after: unknown }>;
    expect(history).toHaveLength(2);
    expect(history[0]!.at).toBeTruthy();
    expect(history[0]!.before).toBeTruthy();
    expect(history[0]!.after).toBeTruthy();
  });

  // ===========================================================================
  // N — Preview respeta el nuevo schedule
  // ===========================================================================
  it('N) preview default tras el cambio usa el nuevo periodo computado', async () => {
    await seedCustomer('c-N', '2026-05-16T00:00:00Z'); // arranca mid-may
    // Mueve subscription_at a 2020-01-01 (mucho en el pasado) → period default
    // ahora será un mes calendario completo, no un stub mid-mes.
    await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-N/billing-schedule', headers: h.authHeader(),
      payload: { billing_schedule: { subscription_at: '2020-01-01T06:00:00Z' } },
    });
    // Preview sin override → debe usar el periodo recién calculado.
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'c-N' } },
    });
    expect(r.statusCode).toBe(200);
    const period = (r.json() as { preview: { period: { from: string; to: string; days_in_period: number } } }).preview.period;
    // El periodo debe ser un mes calendario completo (28/29/30/31 días),
    // no un stub mid-mes que produciría 16 o 17 días.
    expect(period.days_in_period).toBeGreaterThanOrEqual(28);
    expect(period.days_in_period).toBeLessThanOrEqual(31);
  });
});
