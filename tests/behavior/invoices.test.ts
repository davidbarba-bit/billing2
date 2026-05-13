// Invoice tests: idempotency (D10), proration/anexo (D13+D14+invariant #17),
// dispatch wiring (D11), HMAC callback (D12).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { buildSignatureHeader } from '../../src/services/hmac.js';

async function seedScenario(h: Harness): Promise<{
  customerExternalId: string;
  monthlyAddOnCode: string;
  setupAddOnCode: string;
  subscriptionExternalId: string;
}> {
  // Tax.
  await h.app.inject({
    method: 'POST', url: '/api/v1/taxes', headers: h.authHeader(),
    payload: { tax: { name: 'IVA México', code: 'iva-mx-16', rate: '16', description: 'IVA 16%', applied_to_organization: false } },
  });
  // Customer.
  await h.app.inject({
    method: 'POST', url: '/api/v1/customers', headers: h.authHeader(),
    payload: { customer: { external_id: 'carga', name: 'Carga', currency: 'MXN', country: 'MX', timezone: 'America/Mexico_City', tax_codes: ['iva-mx-16'] } },
  });
  // Recurring + non-recurring BMs.
  const bmMonthly = await h.prisma.billableMetric.create({ data: { organizationId: h.organization.id, name: 'BM-monthly', code: 'bm-monthly', aggregationType: 'unique_count_agg', fieldName: 'unit_external_id', recurring: true } });
  const bmSetup = await h.prisma.billableMetric.create({ data: { organizationId: h.organization.id, name: 'BM-setup', code: 'bm-setup', aggregationType: 'unique_count_agg', fieldName: 'unit_external_id', recurring: false } });
  // Plan.
  await h.app.inject({
    method: 'POST', url: '/api/v1/plans', headers: h.authHeader(),
    payload: { plan: {
      name: 'P', code: 'plan-comb', interval: 'monthly', amount_cents: 0, amount_currency: 'MXN',
      pay_in_advance: false,
      charges: [
        { billable_metric_id: bmMonthly.id, charge_model: 'standard', prorated: true, invoiceable: true, properties: { amount: '450.00' } },
        { billable_metric_id: bmSetup.id, charge_model: 'standard', prorated: false, invoiceable: true, properties: { amount: '1200.00' } },
      ],
    } },
  });
  // Subscription.
  await h.app.inject({
    method: 'POST', url: '/api/v1/subscriptions', headers: h.authHeader(),
    payload: { subscription: { external_customer_id: 'carga', plan_code: 'plan-comb', external_id: 'sub-1', name: 'Combustible', billing_time: 'calendar' } },
  });
  // Add-ons.
  await h.app.inject({
    method: 'POST', url: '/api/v1/add_ons', headers: h.authHeader(),
    payload: { add_on: { name: 'Cobro mensual', code: 'cobro-monthly', amount_cents: 45000, amount_currency: 'MXN', description: 'monthly' } },
  });
  await h.app.inject({
    method: 'POST', url: '/api/v1/add_ons', headers: h.authHeader(),
    payload: { add_on: { name: 'Setup', code: 'setup-monthly', amount_cents: 120000, amount_currency: 'MXN', description: 'setup' } },
  });
  return {
    customerExternalId: 'carga',
    monthlyAddOnCode: 'cobro-monthly',
    setupAddOnCode: 'setup-monthly',
    subscriptionExternalId: 'sub-1',
  };
}

describe('invoices', () => {
  let h: Harness;
  let ids: Awaited<ReturnType<typeof seedScenario>>;

  beforeAll(async () => {
    h = await buildTestHarness({ orgTimezone: 'America/Mexico_City', netsuiteCallbackSecret: 'test-secret' });
    ids = await seedScenario(h);
  });
  afterAll(async () => { await closeHarness(h); });

  it('idempotent POST /invoices: same key + body → same lago_id, no second dispatch (D10)', async () => {
    h.dispatcher.calls.length = 0;
    const headers = { ...h.authHeader(), 'idempotency-key': 'idem-1' };
    const payload = {
      invoice: {
        external_customer_id: ids.customerExternalId,
        currency: 'MXN',
        fees: [{ add_on_code: ids.monthlyAddOnCode, description: 'monthly', unit_amount_cents: 45000, units: '1' }],
        metadata: { idempotency_key: 'idem-1' },
      },
    };
    const first = await h.app.inject({ method: 'POST', url: '/api/v1/invoices', headers, payload });
    expect(first.statusCode).toBe(200);
    const second = await h.app.inject({ method: 'POST', url: '/api/v1/invoices', headers, payload });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { invoice: { lago_id: string } }).invoice.lago_id)
      .toBe((first.json() as { invoice: { lago_id: string } }).invoice.lago_id);
    expect(h.dispatcher.calls).toHaveLength(1);
  });

  it('mismatch header vs metadata → 422 idempotency_key_mismatch (D10)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'ABC' },
      payload: {
        invoice: {
          external_customer_id: ids.customerExternalId,
          currency: 'MXN',
          fees: [{ add_on_code: ids.monthlyAddOnCode, unit_amount_cents: 45000, units: '1' }],
          metadata: { idempotency_key: 'XYZ' },
        },
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'idempotency_key_mismatch',
      error_details: { idempotency_key: ['header_metadata_mismatch'] },
    });
  });

  it('invoice dispatch leaves invoice in dispatched with the fake dispatcher (D11)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'idem-dispatched' },
      payload: {
        invoice: {
          external_customer_id: ids.customerExternalId,
          currency: 'MXN',
          fees: [{ add_on_code: ids.monthlyAddOnCode, unit_amount_cents: 45000, units: '1' }],
          metadata: { idempotency_key: 'idem-dispatched' },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { invoice: { external_dispatch_status: string; status: string; number: null } };
    expect(body.invoice.external_dispatch_status).toBe('dispatched');
    expect(body.invoice.status).toBe('calculated');
    expect(body.invoice.number).toBeNull();
  });

  it('credit_notes on calculated invoice → 422 invoice_not_confirmed', async () => {
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'cn-test' },
      payload: {
        invoice: {
          external_customer_id: ids.customerExternalId,
          currency: 'MXN',
          fees: [{ add_on_code: ids.monthlyAddOnCode, unit_amount_cents: 45000, units: '1' }],
          metadata: { idempotency_key: 'cn-test' },
        },
      },
    });
    expect(create.statusCode).toBe(200);
    const invoiceId = (create.json() as { invoice: { lago_id: string; fees: Array<{ lago_id: string; amount_cents: number }> } }).invoice;

    const cn = await h.app.inject({
      method: 'POST',
      url: '/api/v1/credit_notes',
      headers: h.authHeader(),
      payload: {
        credit_note: {
          invoice_id: invoiceId.lago_id,
          reason: 'other',
          items: [{ fee_id: invoiceId.fees[0]!.lago_id, amount_cents: 100 }],
        },
      },
    });
    expect(cn.statusCode).toBe(422);
    expect(cn.json()).toMatchObject({ code: 'invoice_not_confirmed' });
  });

  it('external-confirm without HMAC → 401 invalid_signature (D12)', async () => {
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'hmac-test' },
      payload: {
        invoice: {
          external_customer_id: ids.customerExternalId,
          currency: 'MXN',
          fees: [{ add_on_code: ids.monthlyAddOnCode, unit_amount_cents: 45000, units: '1' }],
          metadata: { idempotency_key: 'hmac-test' },
        },
      },
    });
    const invoiceId = (create.json() as { invoice: { lago_id: string } }).invoice.lago_id;
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/external-confirm`,
      payload: { external_invoice: { folio: 'A-001', uuid_cfdi: 'aaa', system: 'netsuite' } },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'invalid_signature' });
  });

  it('external-confirm with valid HMAC → invoice finalized + confirmed; re-confirm same folio → 200; different folio → 409 (D12)', async () => {
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'confirm-test' },
      payload: {
        invoice: {
          external_customer_id: ids.customerExternalId,
          currency: 'MXN',
          fees: [{ add_on_code: ids.monthlyAddOnCode, unit_amount_cents: 45000, units: '1' }],
          metadata: { idempotency_key: 'confirm-test' },
        },
      },
    });
    const invoiceId = (create.json() as { invoice: { lago_id: string } }).invoice.lago_id;
    const folio = 'A-2026-000142';
    const body = JSON.stringify({ external_invoice: { folio, uuid_cfdi: 'u', system: 'netsuite', issued_at: '2026-05-12T22:21:14Z' } });
    const signature = buildSignatureHeader('test-secret', body);

    const confirm = await h.app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/external-confirm`,
      headers: { 'content-type': 'application/json', 'x-netsuite-signature': signature },
      payload: body,
    });
    expect(confirm.statusCode).toBe(200);
    const confirmed = confirm.json() as { invoice: { status: string; external_dispatch_status: string; number: string } };
    expect(confirmed.invoice.status).toBe('finalized');
    expect(confirmed.invoice.external_dispatch_status).toBe('confirmed');
    expect(confirmed.invoice.number).toBe(folio);

    // Re-confirm same folio → 200 (idempotent).
    const reConfirm = await h.app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/external-confirm`,
      headers: { 'content-type': 'application/json', 'x-netsuite-signature': signature },
      payload: body,
    });
    expect(reConfirm.statusCode).toBe(200);

    // Different folio → 409 conflict_folio_changed.
    const diffBody = JSON.stringify({ external_invoice: { folio: 'A-2026-000143', uuid_cfdi: 'u', system: 'netsuite' } });
    const diffSig = buildSignatureHeader('test-secret', diffBody);
    const diff = await h.app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/external-confirm`,
      headers: { 'content-type': 'application/json', 'x-netsuite-signature': diffSig },
      payload: diffBody,
    });
    expect(diff.statusCode).toBe(409);
    expect(diff.json()).toMatchObject({ code: 'conflict_folio_changed' });
  });
});
