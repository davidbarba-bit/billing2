// Behavior tests for customers (#1, #2) — upsert (D1), tax_codes total
// replace (D2), metadata as object (D3), applicable_timezone (D4),
// PUT → 404 resource_not_found (invariant #11).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';

describe('customers', () => {
  let h: Harness;
  beforeAll(async () => { h = await buildTestHarness(); });
  afterAll(async () => { await closeHarness(h); });

  async function createTaxIfMissing(code = 'iva-mx-16') {
    const existing = await h.prisma.tax.findUnique({
      where: { organizationId_code: { organizationId: h.organization.id, code } },
    });
    if (existing) return;
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/taxes',
      headers: h.authHeader(),
      payload: { tax: { name: 'IVA México', code, rate: '16', description: '', applied_to_organization: false } },
    });
    expect(res.statusCode).toBe(200);
  }

  it('creates a customer with tax_codes echoed back as taxes[]', async () => {
    await createTaxIfMissing();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: h.authHeader(),
      payload: {
        customer: {
          external_id: 'cust-1',
          name: 'Carga Express MX',
          tax_identification_number: 'CEM250101AAA',
          currency: 'MXN',
          country: 'MX',
          timezone: 'America/Mexico_City',
          tax_codes: ['iva-mx-16'],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { customer: Record<string, unknown> };
    expect(body.customer.timezone).toBe('America/Mexico_City');
    expect(body.customer.applicable_timezone).toBe('America/Mexico_City');
    expect(body.customer.metadata).toEqual({});
    expect(Array.isArray(body.customer.taxes)).toBe(true);
    expect((body.customer.taxes as unknown[]).length).toBe(1);
  });

  it('upserts by external_id (D1)', async () => {
    await createTaxIfMissing();
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: h.authHeader(),
      payload: { customer: { external_id: 'cust-2', name: 'A', currency: 'MXN' } },
    });
    expect(create.statusCode).toBe(200);
    const before = create.json() as { customer: { lago_id: string; name: string } };

    const update = await h.app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: h.authHeader(),
      payload: { customer: { external_id: 'cust-2', name: 'B' } },
    });
    expect(update.statusCode).toBe(200);
    const after = update.json() as { customer: { lago_id: string; name: string } };
    expect(after.customer.lago_id).toBe(before.customer.lago_id);
    expect(after.customer.name).toBe('B');
  });

  it('tax_codes is a total replacement (D2)', async () => {
    await createTaxIfMissing();
    await h.app.inject({
      method: 'POST',
      url: '/api/v1/taxes',
      headers: h.authHeader(),
      payload: { tax: { name: 'IEPS', code: 'ieps', rate: '8' } },
    });
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: h.authHeader(),
      payload: { customer: { external_id: 'cust-3', name: 'C', currency: 'MXN', tax_codes: ['iva-mx-16', 'ieps'] } },
    });
    expect(create.statusCode).toBe(200);

    const replace = await h.app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: h.authHeader(),
      payload: { customer: { external_id: 'cust-3', tax_codes: ['ieps'] } },
    });
    expect(replace.statusCode).toBe(200);
    const after = replace.json() as { customer: { taxes: Array<{ code: string }> } };
    expect(after.customer.taxes.map((t) => t.code)).toEqual(['ieps']);
  });

  it('PUT /customers/:id → 404 resource_not_found (invariant #11)', async () => {
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/v1/customers/cust-x',
      headers: h.authHeader(),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'resource_not_found' });
  });

  it('rejects invalid IANA timezones with 422 invalid_iana', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: h.authHeader(),
      payload: { customer: { external_id: 'cust-tz', name: 'X', currency: 'MXN', timezone: 'Not/A/Zone' } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'validation_errors', error_details: { timezone: ['invalid_iana'] } });
  });
});
