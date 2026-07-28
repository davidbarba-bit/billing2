// v7 — Preview / dry-run de cycle invoice.
//
// Verifica:
//   - POST /api/v1/invoices/preview NO crea invoice, NO crea fees, NO marca
//     setupBilledAt ni oneoffBilledAt, NO incrementa invoiceCounter.
//   - Re-ejecutable infinitas veces sin efectos colaterales (idempotente por
//     ausencia de escritura).
//   - Refleja correctamente las fees que el cycle invoice real produciría.
//   - Override de `now` cambia qué precio aplica cuando hay pending_price_change.
//   - 422 si customer no existe o si period_from sin period_to.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { createCustomerDirect } from '../helpers/factories.js';

describe('v7 — preview (dry-run) de cycle invoice', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  async function seedRecurring(opts: { monthly?: number; setup?: number } = {}) {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'c-prev', name: 'Preview', currency: 'MXN',
      timezone: 'America/Mexico_City',
      subscriptionAt: new Date('2025-01-01T00:00:00Z'),
      billingAnchorDay: 1, billingPeriodMonths: 1,
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-prev', customer_external_id: 'c-prev', name: 'svc',
        pricing_model: 'recurring',
        monthly_unit_amount_cents: opts.monthly ?? 50000,
        setup_unit_amount_cents: opts.setup ?? 10000,
      } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'seed-1', service_code: 's-prev', operation_type: 'add',
        unit_external_id: 'u-1', unit_label: 'u-1',
        timestamp: Math.floor(new Date('2025-01-01T00:00:00Z').getTime() / 1000),
      } },
    });
  }

  it('preview NO crea invoice, NO crea fees, NO marca setup, NO incrementa counter', async () => {
    await seedRecurring();
    const orgBefore = await h.prisma.organization.findUniqueOrThrow({ where: { id: h.organization.id } });
    const counterBefore = orgBefore.invoiceCounter;

    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: {
        customer_external_id: 'c-prev',
        period_from: '2026-06-01T00:00:00Z', period_to: '2026-06-30T23:59:59Z',
      } },
    });
    expect(r.statusCode).toBe(200);
    const preview = (r.json() as { preview: { fees: Array<{ kind: string }>; fees_amount_cents: number } }).preview;
    expect(preview.fees.length).toBeGreaterThan(0);

    // Estado de la DB inmutable.
    const invoices = await h.prisma.invoice.count();
    const fees = await h.prisma.fee.count();
    expect(invoices).toBe(0);
    expect(fees).toBe(0);
    const unit = await h.prisma.unit.findFirstOrThrow({ where: { externalId: 'u-1' } });
    expect(unit.setupBilledAt).toBeNull();
    expect(unit.oneoffBilledAt).toBeNull();
    const orgAfter = await h.prisma.organization.findUniqueOrThrow({ where: { id: h.organization.id } });
    expect(orgAfter.invoiceCounter).toBe(counterBefore);
  });

  it('preview es repetible sin efectos colaterales acumulativos', async () => {
    await seedRecurring();
    for (let i = 0; i < 5; i++) {
      const r = await h.app.inject({
        method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
        payload: { invoice: {
          customer_external_id: 'c-prev',
          period_from: '2026-06-01T00:00:00Z', period_to: '2026-06-30T23:59:59Z',
        } },
      });
      expect(r.statusCode).toBe(200);
    }
    expect(await h.prisma.invoice.count()).toBe(0);
    expect(await h.prisma.fee.count()).toBe(0);
  });

  it('preview refleja las fees correctas (monthly + setup)', async () => {
    await seedRecurring({ monthly: 50000, setup: 10000 });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: {
        customer_external_id: 'c-prev',
        period_from: '2026-06-01T00:00:00Z', period_to: '2026-06-30T23:59:59Z',
      } },
    });
    expect(r.statusCode).toBe(200);
    // v22: preview.invoices[] desglosa por razón social. Con una sola razón
    // (caso típico) hay 1 entrada y su netsuite_payload espeja los agregados.
    const preview = (r.json() as {
      preview: {
        fees: Array<{ kind: string; unit_amount_cents: number; amount_cents: number }>;
        fees_amount_cents: number;
        invoices: Array<{ netsuite_payload: { lines: Array<{ kind: string }>; totals: { fees_amount_cents: number } } }>;
      };
    }).preview;
    const monthly = preview.fees.find((f) => f.kind === 'monthly');
    const setup = preview.fees.find((f) => f.kind === 'setup');
    expect(monthly!.unit_amount_cents).toBe(50000);
    expect(setup!.unit_amount_cents).toBe(10000);
    expect(preview.fees_amount_cents).toBe(monthly!.amount_cents + setup!.amount_cents);
    expect(preview.invoices).toHaveLength(1);
    expect(preview.invoices[0]!.netsuite_payload.totals.fees_amount_cents).toBe(preview.fees_amount_cents);
    expect(preview.invoices[0]!.netsuite_payload.lines.length).toBe(preview.fees.length);
  });

  it('preview respeta pending_price_change según el periodStart', async () => {
    await seedRecurring({ monthly: 50000 });
    // Programa cambio a $800/u efectivo 2026-06-01.
    await h.app.inject({
      method: 'PUT', url: '/api/v1/services/s-prev/price', headers: h.authHeader(),
      payload: { price: { monthly_unit_amount_cents: 80000, setup_unit_amount_cents: 10000, effective_from: '2026-06-01T00:00:00Z' } },
    });

    // Preview de mayo (antes del corte) → precio viejo.
    const may = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'c-prev', period_from: '2026-05-01T00:00:00Z', period_to: '2026-05-31T23:59:59Z' } },
    });
    const mayMonthly = (may.json() as { preview: { fees: Array<{ kind: string; unit_amount_cents: number }> } }).preview.fees.find((f) => f.kind === 'monthly')!;
    expect(mayMonthly.unit_amount_cents).toBe(50000);

    // Preview de junio (on-or-after) → precio nuevo.
    const jun = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'c-prev', period_from: '2026-06-01T00:00:00Z', period_to: '2026-06-30T23:59:59Z' } },
    });
    const junMonthly = (jun.json() as { preview: { fees: Array<{ kind: string; unit_amount_cents: number }> } }).preview.fees.find((f) => f.kind === 'monthly')!;
    expect(junMonthly.unit_amount_cents).toBe(80000);
  });

  it('preview sin period_from/period_to usa el ciclo vigente del customer', async () => {
    await seedRecurring();
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'c-prev' } },
    });
    expect(r.statusCode).toBe(200);
    const preview = (r.json() as { preview: { period: { from: string; to: string } } }).preview;
    expect(typeof preview.period.from).toBe('string');
    expect(typeof preview.period.to).toBe('string');
  });

  it('422 si solo period_from (sin period_to)', async () => {
    await seedRecurring();
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'c-prev', period_from: '2026-06-01T00:00:00Z' } },
    });
    expect(r.statusCode).toBe(422);
  });

  it('404 si customer no existe', async () => {
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'no-existe' } },
    });
    expect(r.statusCode).toBe(404);
  });

  it('override de stub period prorratea por días del mes calendario (v8)', async () => {
    // Bajo v8 la mensualidad se calcula como Σ días_activos_en_mes_X /
    // días_del_mes_X. Un stub del 15-may al 1-jun (16 días bucketeados en
    // CST) sobre un mes de 31 días = factor 16/31 ≈ 0.5161.
    await seedRecurring({ monthly: 85000 });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: {
        customer_external_id: 'c-prev',
        // Override mid-day a propósito.
        period_from: '2026-05-15T18:37:00Z',
        period_to: '2026-06-01T05:59:00Z',
      } },
    });
    expect(r.statusCode).toBe(200);
    const preview = (r.json() as { preview: {
      fees: Array<{ kind: string; units: string; amount_cents: number }>;
    } }).preview;
    const monthly = preview.fees.find((f) => f.kind === 'monthly');
    expect(monthly!.units).toBe('0.5161');
    // 0.5161 × 85000 = 43,868.5 → bankers (half-to-even) = 43868.
    expect(monthly!.amount_cents).toBe(43868);
  });

  it('payload de NetSuite tiene la forma esperada (sin IDs persistidos)', async () => {
    await seedRecurring();
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'c-prev', period_from: '2026-06-01T00:00:00Z', period_to: '2026-06-30T23:59:59Z' } },
    });
    // v22: el payload vive bajo invoices[i].netsuite_payload (uno por razón social).
    const ns = (r.json() as { preview: { invoices: Array<{ netsuite_payload: {
      external_id: null; numaris_invoice_id: null;
      customer: { external_id: string };
      billing_period: { from: string; to: string };
      lines: Array<{ fee_id: null; kind: string }>;
    } }> } }).preview.invoices[0]!.netsuite_payload;
    expect(ns.external_id).toBeNull();
    expect(ns.numaris_invoice_id).toBeNull();
    expect(ns.customer.external_id).toBe('c-prev');
    expect(ns.lines.every((l) => l.fee_id === null)).toBe(true);
  });
});
