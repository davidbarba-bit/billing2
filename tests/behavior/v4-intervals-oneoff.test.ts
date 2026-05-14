// v4 — intervalos configurables + servicios one_off.
//
// Verifica:
//   - Intervalos 1, 3, 6, 12 meses se respetan en billingPeriodFor.
//   - Service one_off + customer trigger=next_cycle → la unit sale como fee
//     "one_off" en la siguiente cycle invoice, y queda marcada (no se cobra
//     dos veces).
//   - Service one_off + customer trigger=immediate → POST /events emite
//     invoice individual al instante y devuelve triggered_invoice_id.
//   - Re-ping a la misma unit YA cobrada NO emite nueva invoice.
//   - one_off no aparece en cycle invoice cuando trigger=immediate.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { billingPeriodFor } from '../../src/services/billing-engine.js';

describe('v4 — intervals + one_off', () => {
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
    // Period 2 (after first Q1): Apr 1 → Jul 1.
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
    expect(daysInPeriod).toBe(18); // May 14 → June 1
  });

  it('one_off + next_cycle: la unit sale como fee one_off en la cycle invoice', async () => {
    // Customer trigger=next_cycle (default), interval=1M, anchor=1.
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: { external_id: 'c1', name: 'C1', currency: 'MXN', timezone: 'America/Mexico_City', subscription_at: '2025-01-01T00:00:00Z' } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-oneoff', customer_external_id: 'c1', name: 'Diagnóstico', pricing_model: 'one_off', monthly_unit_amount_cents: 75000 } },
    });
    const now = Math.floor(Date.now() / 1000);
    await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: { transaction_id: 'tx-1', service_code: 's-oneoff', operation_type: 'add', unit_external_id: 'sensor-x', timestamp: now } },
    });

    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'cycle-1' },
      payload: { invoice: { customer_external_id: 'c1', metadata: { idempotency_key: 'cycle-1' } } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { invoice: { id: string; fees: Array<{ kind: string; amount_cents: number }> } };
    const oneOff = body.invoice.fees.find((f) => f.kind === 'one_off');
    expect(oneOff).toBeTruthy();
    expect(oneOff!.amount_cents).toBe(75000);

    // La unit debe quedar marcada como cobrada en DB.
    const unit = await h.prisma.unit.findFirstOrThrow({ where: { externalId: 'sensor-x' } });
    expect(unit.oneoffBilledAt).not.toBeNull();

    // Idempotencia: una 2ª llamada con misma config retorna la MISMA invoice
    // (no crea un duplicado). Eso garantiza que el cron pueda re-correr.
    const r2 = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'cycle-2-different-key' },
      payload: { invoice: { customer_external_id: 'c1', metadata: { idempotency_key: 'cycle-2-different-key' } } },
    });
    const body2 = r2.json() as { invoice: { id: string } };
    expect(body2.invoice.id).toBe(body.invoice.id);
  });

  it('one_off + immediate: POST /events emite invoice individual', async () => {
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: { external_id: 'c2', name: 'C2', currency: 'MXN', timezone: 'America/Mexico_City', nonrecurring_trigger: 'immediate' } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's-imm', customer_external_id: 'c2', name: 'Imm', pricing_model: 'one_off', monthly_unit_amount_cents: 30000 } },
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
    const invBody = invRes.json() as { invoice: { fees: Array<{ kind: string; amount_cents: number }>; fees_amount_cents: number } };
    expect(invBody.invoice.fees_amount_cents).toBe(30000);
    expect(invBody.invoice.fees).toHaveLength(1);
    expect(invBody.invoice.fees[0]!.kind).toBe('one_off');

    // Re-ping de la misma unit no debe disparar nueva invoice.
    const r2 = await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: { transaction_id: 'tx-imm-2', service_code: 's-imm', operation_type: 'add', unit_external_id: 'u-1', timestamp: Math.floor(Date.now()/1000) } },
    });
    const body2 = r2.json() as { triggered_invoice_id?: string };
    expect(body2.triggered_invoice_id).toBeUndefined();
  });

  it('one_off + immediate: la cycle invoice NO incluye one_offs (esos fueron a invoice individual)', async () => {
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: { external_id: 'c3', name: 'C3', currency: 'MXN', timezone: 'America/Mexico_City', nonrecurring_trigger: 'immediate' } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's3-imm', customer_external_id: 'c3', name: 'Imm', pricing_model: 'one_off', monthly_unit_amount_cents: 10000 } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: { transaction_id: 'tx-3', service_code: 's3-imm', operation_type: 'add', unit_external_id: 'u-x', timestamp: Math.floor(Date.now()/1000) } },
    });

    // Cycle invoice del customer → no debería tener fees (no hay services recurring ni addons).
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'c3-cycle' },
      payload: { invoice: { customer_external_id: 'c3', metadata: { idempotency_key: 'c3-cycle' } } },
    });
    const inv = (r.json() as { invoice: { fees: Array<{ kind: string }>; total_amount_cents: number } }).invoice;
    expect(inv.fees.find((f) => f.kind === 'one_off')).toBeUndefined();
    expect(inv.total_amount_cents).toBe(0);
  });

  it('rechaza service one_off con setup_unit_amount_cents > 0', async () => {
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: { external_id: 'c4', name: 'C4', currency: 'MXN' } },
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 's4', customer_external_id: 'c4', name: 'Bad', pricing_model: 'one_off', monthly_unit_amount_cents: 5000, setup_unit_amount_cents: 100 } },
    });
    expect(r.statusCode).toBe(422);
  });

  it('rechaza intervalos fuera de {1,3,6,12}', async () => {
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: { external_id: 'c5', name: 'C5', currency: 'MXN', billing_period_months: 4 } },
    });
    expect(r.statusCode).toBe(422);
  });
});
