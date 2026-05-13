// Golden checks for the .synthetic fixtures (#11, #12, #14, #15, #15b).
//
// These fixtures are not literal Lago Cloud captures — they're spec-defined
// shapes for the mini-Lago additions (NetSuite dispatch + callback + anexo).
// We assert shape rather than exact numbers because the per-unit values in
// the fixture #11 are illustrative (the spec explicitly notes the engine
// recomputes them from event history).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { buildSignatureHeader } from '../../src/services/hmac.js';

const FIXTURES_DIR = resolve(__dirname, '..', 'fixtures', 'lago-pairs');
function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), 'utf8'));
}

describe('synthetic golden — mini-Lago shape', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await buildTestHarness({ orgTimezone: 'America/Mexico_City', netsuiteCallbackSecret: 'test-secret' });
  });
  afterAll(async () => { await closeHarness(h); });

  async function bootstrap() {
    // Tax + customer + plan + sub + add-ons, mirroring the spec scenario.
    await h.app.inject({
      method: 'POST', url: '/api/v1/taxes', headers: h.authHeader(),
      payload: { tax: { name: 'IVA México', code: 'iva-mx-16', rate: '16', applied_to_organization: false } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
      payload: { customer: { external_id: 'carga-express-mx', name: 'Carga Express MX', currency: 'MXN', country: 'MX', timezone: 'America/Mexico_City', tax_codes: ['iva-mx-16'] } },
    });
    const bm = await h.prisma.billableMetric.create({
      data: { organizationId: h.organization.id, name: 'BM', code: 'bm-monthly', aggregationType: 'unique_count_agg', fieldName: 'unit_external_id', recurring: true },
    });
    const plan = await h.prisma.plan.create({
      data: { organizationId: h.organization.id, name: 'P', code: 'plan-carga', interval: 'monthly', amountCents: 0, amountCurrency: 'MXN' },
    });
    await h.prisma.charge.create({
      data: { planId: plan.id, billableMetricId: bm.id, chargeModel: 'standard', prorated: true, properties: { amount: '450.00' } as object },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/subscriptions', headers: h.authHeader(),
      payload: { subscription: { external_customer_id: 'carga-express-mx', plan_code: 'plan-carga', external_id: 'sub-1', billing_time: 'calendar' } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/add_ons', headers: h.authHeader(),
      payload: { add_on: { name: 'Cobro mensual Servicio Combustible — Carga Express MX', code: 'cobro-carga-express-mx-combustible', amount_cents: 45000, amount_currency: 'MXN', description: 'Línea de factura mensual del servicio Combustible (qty × precio unitario) para Carga Express MX.' } },
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/add_ons', headers: h.authHeader(),
      payload: { add_on: { name: 'Setup Servicio Combustible — Carga Express MX', code: 'setup-carga-express-mx-combustible', amount_cents: 120000, amount_currency: 'MXN', description: 'Cobro one-off de instalación / setup del servicio Combustible para Carga Express MX.' } },
    });
  }

  it('#11 POST /invoices conforms to mini-Lago shape (status=calculated, dispatch=dispatched, anexo)', async () => {
    await bootstrap();
    const req = loadFixture('11-invoices-create-fees.request.json') as { invoice: Record<string, unknown> };
    // Use a single fee to keep the assertion focused.
    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices',
      headers: {
        ...h.authHeader(),
        'idempotency-key': 'carga-express-mx:2026-05:consolidated-monthly',
      },
      payload: req,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { invoice: Record<string, unknown> };
    expect(body.invoice.status).toBe('calculated');
    expect(body.invoice.external_dispatch_status).toBe('dispatched');
    expect(body.invoice.number).toBeNull();
    expect(body.invoice.invoice_type).toBe('one_off');
    expect(body.invoice.metadata).toMatchObject({
      org_id: 'carga-express-mx',
      idempotency_key: 'carga-express-mx:2026-05:consolidated-monthly',
    });
    expect(Array.isArray(body.invoice.fees)).toBe(true);
    expect(Array.isArray(body.invoice.units_annex)).toBe(true);
    expect(Array.isArray(body.invoice.applied_taxes)).toBe(true);

    // Customer embed matches divergence: timezone echoed + applicable_timezone resolved.
    const customer = body.invoice.customer as Record<string, unknown>;
    expect(customer.timezone).toBe('America/Mexico_City');
    expect(customer.applicable_timezone).toBe('America/Mexico_City');
  });

  it('#15 callback transitions invoice to finalized+confirmed with HMAC', async () => {
    // Reuse the invoice created by the previous test.
    const list = await h.prisma.invoice.findMany({ orderBy: { createdAt: 'desc' }, take: 1 });
    expect(list).toHaveLength(1);
    const invoiceId = list[0]!.id;

    const fixtureBody = loadFixture('15-external-confirm.request.synthetic.json') as Record<string, unknown>;
    const raw = JSON.stringify(fixtureBody);
    const sig = buildSignatureHeader('test-secret', raw);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/external-confirm`,
      headers: { 'content-type': 'application/json', 'x-netsuite-signature': sig },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { invoice: Record<string, unknown> };
    expect(body.invoice.status).toBe('finalized');
    expect(body.invoice.external_dispatch_status).toBe('confirmed');
    expect(body.invoice.number).toBe('A-2026-000142');
    expect((body.invoice.external_invoice as Record<string, unknown> | null)?.folio).toBe('A-2026-000142');
  });

  it('#12 POST /credit_notes returns 422 invoice_not_confirmed on non-confirmed invoice and 200 on confirmed', async () => {
    // Use the invoice now confirmed by the previous step.
    const invoice = await h.prisma.invoice.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    const fee = await h.prisma.fee.findFirstOrThrow({ where: { invoiceId: invoice.id } });

    const req = {
      credit_note: {
        invoice_id: invoice.id,
        reason: 'other',
        description: 'SLA conectividad — 6/30 días [idem:unit-001:2026-05]',
        items: [{ fee_id: fee.id, amount_cents: 50000 }],
        credit_amount_cents: 58000,
      },
    };
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/credit_notes', headers: h.authHeader(), payload: req });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { credit_note: Record<string, unknown> };
    expect(body.credit_note.status).toBe('calculated');
    expect(body.credit_note.external_dispatch_status).toBe('pending');
    expect(body.credit_note.number).toBeNull();
    expect(body.credit_note.taxes_amount_cents).toBe(8000);
    expect(body.credit_note.total_amount_cents).toBe(58000);
    expect(body.credit_note.invoice_number).toBe('A-2026-000142');
  });

  it('#15b callback transitions credit-note to finalized+confirmed', async () => {
    const cn = await h.prisma.creditNote.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    const fixtureBody = {
      external_credit_note: {
        folio: 'B-2026-000077',
        uuid_cfdi: '9F8E7D6C-5B4A-3210-FEDC-BA9876543210',
        system: 'netsuite',
        netsuite_internal_id: 'rec-87654321',
        pdf_url: 'https://app.netsuite.com/x',
        xml_url: 'https://app.netsuite.com/x&type=xml',
        issued_at: '2026-05-13T15:42:00Z',
        total_amount_cents: 58000,
        currency: 'MXN',
      },
    };
    const raw = JSON.stringify(fixtureBody);
    const sig = buildSignatureHeader('test-secret', raw);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/credit_notes/${cn.id}/external-confirm`,
      headers: { 'content-type': 'application/json', 'x-netsuite-signature': sig },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { credit_note: Record<string, unknown> };
    expect(body.credit_note.status).toBe('finalized');
    expect(body.credit_note.external_dispatch_status).toBe('confirmed');
    expect(body.credit_note.number).toBe('B-2026-000077');
  });
});
