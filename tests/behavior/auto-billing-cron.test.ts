// Cron de cierre de ciclo — verifica que el sistema factura
// automáticamente sin que nadie externo dispare nada.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { createCustomerDirect } from '../helpers/factories.js';
import { tickCycleBilling } from '../../src/cron/cycle-billing.js';
import { FakeNetSuiteDispatcher } from '../../src/services/netsuite-dispatcher.js';

describe('cron — auto-billing on cycle close', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  const cronOpts = () => ({
    prisma: h.prisma,
    dispatcher: new FakeNetSuiteDispatcher(),
    callbackBaseUrl: 'http://localhost:3000',
    log: { info: () => undefined, error: () => undefined },
  });

  it('emite cycle invoice cuando el periodo del customer venció', async () => {
    // Customer con periodo que ya terminó hace 1 segundo.
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'auto-1', name: 'Auto 1', currency: 'MXN',
      timezone: 'America/Mexico_City',
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-a1', customer_external_id: 'auto-1', name: 'S', pricing_model: 'recurring', monthly_unit_amount_cents: 10000 } },
    });
    // Una unit activa todo el mes pasado.
    const lastMonth = new Date('2026-04-01T00:00:00Z');
    const c = await h.prisma.customer.findUniqueOrThrow({ where: { organizationId_externalId: { organizationId: h.organization.id, externalId: 'auto-1' } } });
    const svc = await h.prisma.service.findUniqueOrThrow({ where: { organizationId_code: { organizationId: h.organization.id, code: 's-a1' } } });
    await h.prisma.unit.create({
      data: { serviceId: svc.id, externalId: 'u1', activeFrom: lastMonth, activeTo: null },
    });
    // Mover el periodo del customer al pasado para que ya esté vencido.
    await h.prisma.customer.update({
      where: { id: c.id },
      data: {
        currentBillingPeriodStartedAt: lastMonth,
        currentBillingPeriodEndingAt: new Date('2026-04-30T23:59:59Z'),
        subscriptionAt: lastMonth,
      },
    });

    const before = await h.prisma.invoice.count({ where: { customerId: c.id } });
    expect(before).toBe(0);

    const summary = await tickCycleBilling(cronOpts(), new Date('2026-05-01T01:00:00Z'));

    expect(summary.invoicesEmitted).toBe(1);
    expect(summary.rolledOver).toBe(1);

    const invoices = await h.prisma.invoice.findMany({ where: { customerId: c.id } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.feesAmountCents).toBeGreaterThan(0);

    // Period del customer debe haber avanzado a mayo.
    const refreshed = await h.prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(refreshed.currentBillingPeriodStartedAt!.toISOString().slice(0, 10)).toBe('2026-05-01');
  });

  it('re-correr el cron no genera invoice duplicada (idempotente)', async () => {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'auto-2', name: 'Auto 2', currency: 'MXN',
      timezone: 'America/Mexico_City',
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-a2', customer_external_id: 'auto-2', name: 'S', pricing_model: 'recurring', monthly_unit_amount_cents: 5000 } },
    });
    const c = await h.prisma.customer.findUniqueOrThrow({ where: { organizationId_externalId: { organizationId: h.organization.id, externalId: 'auto-2' } } });
    const svc = await h.prisma.service.findUniqueOrThrow({ where: { organizationId_code: { organizationId: h.organization.id, code: 's-a2' } } });
    await h.prisma.unit.create({ data: { serviceId: svc.id, externalId: 'u2', activeFrom: new Date('2026-04-01T00:00:00Z'), activeTo: null } });
    await h.prisma.customer.update({
      where: { id: c.id },
      data: {
        currentBillingPeriodStartedAt: new Date('2026-04-01T00:00:00Z'),
        currentBillingPeriodEndingAt: new Date('2026-04-30T23:59:59Z'),
        subscriptionAt: new Date('2026-04-01T00:00:00Z'),
      },
    });

    // 1ª pasada: emite.
    const s1 = await tickCycleBilling(cronOpts(), new Date('2026-05-01T01:00:00Z'));
    expect(s1.invoicesEmitted).toBe(1);

    // Mover el periodo de vuelta al pasado para simular que el cron se re-ejecuta
    // sin que haya pasado tiempo nuevo (escenario realista: cron corre cada minuto
    // y el periodo aún no se ha actualizado por una race condition o re-deploy).
    // En este caso el findFirst encontrará la invoice y no creará otra.
    await h.prisma.customer.update({
      where: { id: c.id },
      data: {
        currentBillingPeriodStartedAt: new Date('2026-04-01T00:00:00Z'),
        currentBillingPeriodEndingAt: new Date('2026-04-30T23:59:59Z'),
      },
    });
    const s2 = await tickCycleBilling(cronOpts(), new Date('2026-05-01T01:00:00Z'));
    expect(s2.invoicesEmitted).toBe(0);
    expect(s2.invoicesSkippedAsDuplicate).toBe(1);

    const total = await h.prisma.invoice.count({ where: { customerId: c.id } });
    expect(total).toBe(1);
  });

  it('activa customers pending cuyo subscription_at ya pasó', async () => {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'pending-1', name: 'Pending', currency: 'MXN',
      timezone: 'America/Mexico_City',
      subscriptionAt: new Date('2099-01-01T00:00:00Z'),
      status: 'pending',
    });

    const c = await h.prisma.customer.findUniqueOrThrow({
      where: { organizationId_externalId: { organizationId: h.organization.id, externalId: 'pending-1' } },
    });
    expect(c.status).toBe('pending');

    // Mover subscription_at al pasado.
    await h.prisma.customer.update({
      where: { id: c.id },
      data: { subscriptionAt: new Date('2026-04-01T00:00:00Z') },
    });

    const summary = await tickCycleBilling(cronOpts(), new Date('2026-04-02T00:00:00Z'));
    expect(summary.activated).toBe(1);

    const refreshed = await h.prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(refreshed.status).toBe('active');
    expect(refreshed.currentBillingPeriodStartedAt).not.toBeNull();
  });
});
