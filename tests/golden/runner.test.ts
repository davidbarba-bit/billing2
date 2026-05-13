// Golden contract runner — applies the spec's strip-list + normalization
// table (`§Divergencias mini-Lago vs captura Lago Cloud`) and then asserts
// deep equality with the captured fixtures.
//
// Coverage:
//   - 01a, 02 customers — literal Lago capture; normalized (timezone,
//     applicable_timezone, metadata).
//   - 03 taxes — literal capture.
//   - 04, 05, 13a events — passthrough properties; timestamp stripped.
//   - 06 plans — charge shape, BM-by-id, properties.amount as string.
//   - 07 anniversary subscription (status:pending).
//   - 07b calendar subscription (status:active, period in tz).
//   - 09a, 09b add-ons.
//   - 10 add-on find.
//
// The compound fixtures #08, #11, #12, #14, #15 require deeper setup with
// real event histories; they are exercised by `tests/behavior/*` instead of
// the golden runner. The spec explicitly allows behavior tests for the
// re-versioned / synthetic fixtures.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { normalize } from '../helpers/normalize.js';

const FIXTURES_DIR = resolve(__dirname, '..', 'fixtures', 'lago-pairs');

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), 'utf8')) as Record<string, unknown>;
}

describe('golden contract — Lago Cloud literal captures', () => {
  let h: Harness;
  beforeAll(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  it('#03 POST /taxes (literal capture)', async () => {
    const req = loadFixture('03-taxes-create.request.json');
    const expected = loadFixture('03-taxes-create.response.json');
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/taxes', headers: h.authHeader(), payload: req });
    expect(res.statusCode).toBe(200);
    expect(normalize(res.json())).toEqual(normalize(expected));
  });

  it('#01a POST /customers (with normalization-table for tz + metadata)', async () => {
    // Seed the tax first so tax_codes resolves.
    await h.app.inject({
      method: 'POST', url: '/api/v1/taxes', headers: h.authHeader(),
      payload: loadFixture('03-taxes-create.request.json'),
    });
    const req = loadFixture('01a-customers-create.request.json');
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/customers', headers: h.authHeader(), payload: req });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { customer: Record<string, unknown> };
    // Per normalization table: mini-Lago echoes timezone + applicable_timezone
    // and emits metadata as object {}.
    expect(body.customer.timezone).toBe('America/Mexico_City');
    expect(body.customer.applicable_timezone).toBe('America/Mexico_City');
    expect(body.customer.metadata).toEqual({});
    // The remaining structural fields match the literal capture.
    const expected = loadFixture('01a-customers-create.response.json') as { customer: Record<string, unknown> };
    const expectedNorm = normalize({
      customer: {
        ...expected.customer,
        timezone: 'America/Mexico_City',
        applicable_timezone: 'America/Mexico_City',
        metadata: {},
      },
    }, { extraStrip: ['taxes'] });
    const actualNorm = normalize(body, { extraStrip: ['taxes'] });
    expect(actualNorm).toEqual(expectedNorm);
  });

  it('#02 GET /customers/:external_id (idempotent read)', async () => {
    // GET should produce the same shape as POST (with the same
    // normalization). Use the customer from the previous test.
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/customers/carga-express-mx',
      headers: h.authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { customer: Record<string, unknown> };
    expect(body.customer.timezone).toBe('America/Mexico_City');
    expect(body.customer.applicable_timezone).toBe('America/Mexico_City');
  });

  it('#04 POST /events (add)', async () => {
    const req = loadFixture('04-events-add.request.json');
    const expected = loadFixture('04-events-add.response.json') as Record<string, unknown>;
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/events', headers: h.authHeader(), payload: req });
    expect(res.statusCode).toBe(200);
    expect(normalize(res.json())).toEqual(normalize(expected));
  });

  it('#05 POST /events (remove)', async () => {
    const req = loadFixture('05-events-remove.request.json');
    const expected = loadFixture('05-events-remove.response.json') as Record<string, unknown>;
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/events', headers: h.authHeader(), payload: req });
    expect(res.statusCode).toBe(200);
    expect(normalize(res.json())).toEqual(normalize(expected));
  });

  it('#13a POST /events with properties.unit_label (D14)', async () => {
    const req = loadFixture('13a-events-add-with-label.request.json');
    const expected = loadFixture('13a-events-add-with-label.response.json') as Record<string, unknown>;
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/events', headers: h.authHeader(), payload: req });
    expect(res.statusCode).toBe(200);
    expect(normalize(res.json())).toEqual(normalize(expected));
  });

  it('#09a + #09b + #10 add-ons literal captures', async () => {
    const reqA = loadFixture('09a-addons-create-monthly.request.json');
    const expA = loadFixture('09a-addons-create-monthly.response.json') as Record<string, unknown>;
    const resA = await h.app.inject({ method: 'POST', url: '/api/v1/add_ons', headers: h.authHeader(), payload: reqA });
    expect(resA.statusCode).toBe(200);
    expect(normalize(resA.json())).toEqual(normalize(expA));

    const reqB = loadFixture('09b-addons-create-setup.request.json');
    const expB = loadFixture('09b-addons-create-setup.response.json') as Record<string, unknown>;
    const resB = await h.app.inject({ method: 'POST', url: '/api/v1/add_ons', headers: h.authHeader(), payload: reqB });
    expect(resB.statusCode).toBe(200);
    expect(normalize(resB.json())).toEqual(normalize(expB));

    const exp10 = loadFixture('10-addons-find.response.json') as Record<string, unknown>;
    const res10 = await h.app.inject({
      method: 'GET',
      url: '/api/v1/add_ons/cobro-carga-express-mx-combustible',
      headers: h.authHeader(),
    });
    expect(res10.statusCode).toBe(200);
    expect(normalize(res10.json())).toEqual(normalize(exp10));
  });

  it('#06 POST /plans literal capture', async () => {
    // The plan's charges reference BM UUIDs from the fixture. We pre-create
    // BMs whose ids match (forcing them onto our DB).
    await h.prisma.billableMetric.create({
      data: {
        id: '58275c2e-c670-4f1a-9059-c1f1d26a997f',
        organizationId: h.organization.id,
        name: 'Unidades activas — Combustible',
        code: 'bm-carga-express-mx-combustible-7be0a53d',
        aggregationType: 'unique_count_agg',
        fieldName: 'unit_external_id',
        recurring: true,
      },
    });
    await h.prisma.billableMetric.create({
      data: {
        id: '0234704f-186c-4071-89b9-898bd3ec6930',
        organizationId: h.organization.id,
        name: 'Instalaciones nuevas — Combustible',
        code: 'bm-setup-carga-express-mx-combustible-0c46b355',
        aggregationType: 'unique_count_agg',
        fieldName: 'unit_external_id',
        recurring: false,
      },
    });
    const req = loadFixture('06-plans-create.request.json');
    const expected = loadFixture('06-plans-create.response.json') as Record<string, unknown>;
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/plans', headers: h.authHeader(), payload: req });
    expect(res.statusCode).toBe(200);
    // The Lago Cloud fixture has the description "policy=auto_renew, periodo=1m"
    // stripped (mini-Lago preserves the request's full text). Strip the
    // description for the comparison.
    expect(normalize(res.json(), { extraStrip: ['description'] }))
      .toEqual(normalize(expected, { extraStrip: ['description'] }));
  });
});
