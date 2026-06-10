// v12 — editar soft fields del customer post-creación.
//
// PATCH /api/v1/customers/:external_id
//   Permite cambiar campos NO billing-impacting:
//     name, email, phone, timezone, currency (con gate), metadata.
//   v22: los campos fiscales (RFC, dirección, NetSuite) ya no viven en el
//   Customer — se administran como razones sociales (TaxEntity).
//
// Reglas:
//   - Hard fields (subscription_at, anchor_day, period_months, trigger) →
//     422 use_billing_schedule_endpoint (deben ir por PATCH /:id/billing-schedule).
//   - currency con gate: 409 si hay invoices no-voided.
//   - timezone validada con IANA.
//   - customer terminated → 409.
//   - Al menos un campo soft requerido → 422 si todo vacío.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { createCustomerDirect } from '../helpers/factories.js';

describe('v12 — editar soft fields del customer', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  async function seedCustomer(externalId = 'c-soft') {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId, name: externalId, currency: 'MXN',
      timezone: 'America/Mexico_City',
      subscriptionAt: new Date('2020-01-01T00:00:00Z'),
      billingAnchorDay: 1, billingPeriodMonths: 1,
    });
  }

  it('A) edita name, email, phone', async () => {
    await seedCustomer('c-A');
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-A', headers: h.authHeader(),
      payload: { customer: {
        name: 'Nuevo Nombre',
        email: 'nuevo@example.com',
        phone: '+52 55 1234 5678',
      } },
    });
    expect(r.statusCode).toBe(200);
    const c = (r.json() as { customer: { name: string; email: string; phone: string } }).customer;
    expect(c.name).toBe('Nuevo Nombre');
    expect(c.email).toBe('nuevo@example.com');
    expect(c.phone).toBe('+52 55 1234 5678');
  });

  it('C) campos individuales: solo metadata no toca el resto', async () => {
    await seedCustomer('c-C');
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-C', headers: h.authHeader(),
      payload: { customer: { metadata: { source: 'numaris-import', batch: 42 } } },
    });
    expect(r.statusCode).toBe(200);
    const c = (r.json() as { customer: { name: string; metadata: Record<string, unknown> } }).customer;
    expect(c.name).toBe('c-C');
    expect(c.metadata.source).toBe('numaris-import');
    expect(c.metadata.batch).toBe(42);
  });

  it('D) timezone IANA inválida → 422', async () => {
    await seedCustomer('c-D');
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-D', headers: h.authHeader(),
      payload: { customer: { timezone: 'No/Existe' } },
    });
    expect(r.statusCode).toBe(422);
  });

  it('E) timezone IANA válida cambia', async () => {
    await seedCustomer('c-E');
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-E', headers: h.authHeader(),
      payload: { customer: { timezone: 'America/Tijuana' } },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { customer: { timezone: string } }).customer.timezone).toBe('America/Tijuana');
  });

  it('F) name vacío (whitespace) → 422', async () => {
    await seedCustomer('c-F');
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-F', headers: h.authHeader(),
      payload: { customer: { name: '   ' } },
    });
    expect(r.statusCode).toBe(422);
  });

  it('G) hard fields rechazados como unknown_field por PATCH /customers', async () => {
    await seedCustomer('c-G');
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-G', headers: h.authHeader(),
      payload: { customer: { subscription_at: '2027-01-01T00:00:00Z' } },
    });
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain('unknown_field');
  });

  it('H) hard + soft mixed → 422, nada se aplica', async () => {
    await seedCustomer('c-H');
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-H', headers: h.authHeader(),
      payload: { customer: { name: 'Cambio', billing_period_months: 3 } },
    });
    expect(r.statusCode).toBe(422);
    const c = await h.prisma.customer.findFirstOrThrow({ where: { externalId: 'c-H' } });
    expect(c.name).toBe('c-H'); // sin cambio (rejection antes de escribir)
  });

  it('I) currency cambia si NO hay invoices', async () => {
    await seedCustomer('c-I');
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-I', headers: h.authHeader(),
      payload: { customer: { currency: 'USD' } },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { customer: { currency: string } }).customer.currency).toBe('USD');
  });

  it('J) currency bloqueada con 409 si hay invoice no-voided', async () => {
    await seedCustomer('c-J');
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-j', customer_external_id: 'c-J', name: 's', monthly_unit_amount_cents: 50000 } },
    });
    const svcJ = await h.prisma.service.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: h.organization.id, code: 's-j' } },
    });
    await h.prisma.unit.create({
      data: { serviceId: svcJ.id, externalId: 'u1', activeFrom: new Date('2020-01-01T00:00:00Z') },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'inv-j' },
      payload: { invoice: {
        customer_external_id: 'c-J',
        period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z',
        metadata: { idempotency_key: 'inv-j' },
      } },
    });
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-J', headers: h.authHeader(),
      payload: { customer: { currency: 'USD' } },
    });
    expect(r.statusCode).toBe(409);
  });

  it('K) currency con MISMO valor: no requiere gate (idempotente)', async () => {
    await seedCustomer('c-K');
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-k', customer_external_id: 'c-K', name: 's', monthly_unit_amount_cents: 50000 } },
    });
    const svcK = await h.prisma.service.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: h.organization.id, code: 's-k' } },
    });
    await h.prisma.unit.create({
      data: { serviceId: svcK.id, externalId: 'u1', activeFrom: new Date('2020-01-01T00:00:00Z') },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'inv-k' },
      payload: { invoice: {
        customer_external_id: 'c-K',
        period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z',
        metadata: { idempotency_key: 'inv-k' },
      } },
    });
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-K', headers: h.authHeader(),
      payload: { customer: { currency: 'MXN', name: 'Renombrado' } },
    });
    expect(r.statusCode).toBe(200);
  });

  it('L) customer terminated → 409', async () => {
    await seedCustomer('c-L');
    await h.prisma.customer.update({
      where: { id: (await h.prisma.customer.findFirstOrThrow({ where: { externalId: 'c-L' } })).id },
      data: { status: 'terminated', terminatedAt: new Date() },
    });
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-L', headers: h.authHeader(),
      payload: { customer: { name: 'no-debería-pasar' } },
    });
    expect(r.statusCode).toBe(409);
  });

  it('M) customer no existe → 404', async () => {
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/no-existe', headers: h.authHeader(),
      payload: { customer: { name: 'algo' } },
    });
    expect(r.statusCode).toBe(404);
  });

  it('N) body vacío → 422', async () => {
    await seedCustomer('c-N');
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-N', headers: h.authHeader(),
      payload: { customer: {} },
    });
    expect(r.statusCode).toBe(422);
  });

  it('O) setear a null limpia los opcionales', async () => {
    await seedCustomer('c-O');
    await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-O', headers: h.authHeader(),
      payload: { customer: { email: 'algo@ex.com', phone: '555' } },
    });
    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/customers/c-O', headers: h.authHeader(),
      payload: { customer: { email: null, phone: null } },
    });
    expect(r.statusCode).toBe(200);
    const c = (r.json() as { customer: { email: string | null; phone: string | null } }).customer;
    expect(c.email).toBeNull();
    expect(c.phone).toBeNull();
  });
});
