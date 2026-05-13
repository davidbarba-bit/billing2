// Tests for #9 / #9b / #9c / #10 / #10b — add-ons CRUD + find (invariant #14, D6).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';

describe('add-ons CRUD', () => {
  let h: Harness;
  beforeAll(async () => { h = await buildTestHarness(); });
  afterAll(async () => { await closeHarness(h); });

  async function createAddOn(code: string, amount = 45000) {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/add_ons',
      headers: h.authHeader(),
      payload: {
        add_on: { name: code, code, description: '', amount_cents: amount, amount_currency: 'MXN' },
      },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { add_on: { lago_id: string; code: string } };
  }

  it('POST rejects amount_cents <= 0', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/add_ons',
      headers: h.authHeader(),
      payload: { add_on: { name: 'bad', code: 'bad-zero', amount_cents: 0, amount_currency: 'MXN' } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error_details: { amount_cents: ['must_be_greater_than_zero'] },
    });
  });

  it('PATCH refuses to mutate `code` (immutable)', async () => {
    await createAddOn('cobro-1');
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/v1/add_ons/cobro-1',
      headers: h.authHeader(),
      payload: { add_on: { code: 'renamed' } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error_details: { code: ['immutable'] },
    });
  });

  it('DELETE returns 409 if add-on has fees (D6 + invariante #14)', async () => {
    const addOn = await createAddOn('cobro-with-fees');

    // Persist an invoice + fee referring to the add-on so DELETE refuses.
    const customer = await h.prisma.customer.create({
      data: { organizationId: h.organization.id, externalId: 'cust-d6', name: 'd6', sequentialId: 1, slug: 'X-001', currency: 'MXN' },
    });
    const invoice = await h.prisma.invoice.create({
      data: {
        organizationId: h.organization.id,
        customerId: customer.id,
        sequentialId: 1,
        currency: 'MXN',
        issuingDate: new Date(),
        paymentDueDate: new Date(),
      },
    });
    await h.prisma.fee.create({
      data: {
        invoiceId: invoice.id,
        addOnId: addOn.add_on.lago_id,
        itemType: 'add_on',
        itemCode: addOn.add_on.code,
        itemName: 'fee',
        itemLagoItemId: addOn.add_on.lago_id,
        itemClassType: 'AddOn',
        amountCents: 100,
        amountCurrency: 'MXN',
        totalAmountCents: 100,
        units: '1.0000',
        preciseUnitAmount: '1.00',
      },
    });

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/add_ons/${addOn.add_on.code}`,
      headers: h.authHeader(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'add_on_referenced_by_fees',
      error_details: { add_on: ['referenced_by_fees'] },
    });
  });

  it('findAll has meta with current_page/next_page/prev_page/total_pages/total_count (invariante #2)', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/add_ons?per_page=10&page=1',
      headers: h.authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { meta: Record<string, unknown> };
    expect(body.meta).toMatchObject({
      current_page: 1,
      prev_page: null,
    });
    expect(Object.keys(body.meta).sort()).toEqual(
      ['current_page', 'next_page', 'prev_page', 'total_count', 'total_pages'].sort(),
    );
  });
});
