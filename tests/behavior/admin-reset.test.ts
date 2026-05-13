// Tests for POST /api/v1/admin/reset.
//
// Verifies the three-layer auth gate:
//   1. Bearer scope to org.
//   2. X-Admin-Reset-Token must match env (fail-closed when unset).
//   3. Body.confirm must equal organization.slug.
//
// And the actual behaviour: data tables emptied, org row + apiKey preserved,
// counters reset to 0.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { seedNumaris } from '../../src/admin/seed.js';

describe('POST /api/v1/admin/reset', () => {
  let h: Harness;
  const RESET_TOKEN = 'test-reset-token-do-not-use';

  beforeAll(async () => {
    h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' });
    process.env.ADMIN_RESET_TOKEN = RESET_TOKEN;
  });
  afterAll(async () => {
    delete process.env.ADMIN_RESET_TOKEN;
    await closeHarness(h);
  });
  beforeEach(async () => {
    // Re-seed for every test so each starts with non-trivial data.
    await seedNumaris(h.prisma, h.organization);
  });

  it('returns 403 admin_reset_disabled when env not set', async () => {
    delete process.env.ADMIN_RESET_TOKEN;
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/admin/reset',
      headers: h.authHeader(),
      payload: { confirm: h.organization.slug },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'admin_reset_disabled' });
    process.env.ADMIN_RESET_TOKEN = RESET_TOKEN;
  });

  it('returns 403 invalid_reset_token when header missing or wrong', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/admin/reset',
      headers: h.authHeader(),
      payload: { confirm: h.organization.slug },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'invalid_reset_token' });

    const res2 = await h.app.inject({
      method: 'POST',
      url: '/api/v1/admin/reset',
      headers: { ...h.authHeader(), 'x-admin-reset-token': 'wrong' },
      payload: { confirm: h.organization.slug },
    });
    expect(res2.statusCode).toBe(403);
  });

  it('returns 422 when body.confirm does not match org.slug', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/admin/reset',
      headers: { ...h.authHeader(), 'x-admin-reset-token': RESET_TOKEN },
      payload: { confirm: 'wrong-slug' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'validation_errors',
      error_details: { confirm: ['must_equal_organization_slug'] },
    });
  });

  it('returns 401 without Bearer', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/admin/reset',
      headers: { 'x-admin-reset-token': RESET_TOKEN },
      payload: { confirm: h.organization.slug },
    });
    expect(res.statusCode).toBe(401);
  });

  it('wipes all data tables but preserves org row + apiKey', async () => {
    const apiKey = h.organization.apiKey;
    const orgId = h.organization.id;

    // Sanity: seed populated stuff.
    const before = await Promise.all([
      h.prisma.customer.count({ where: { organizationId: orgId } }),
      h.prisma.plan.count({ where: { organizationId: orgId } }),
      h.prisma.event.count({ where: { organizationId: orgId } }),
    ]);
    expect(before.every((n) => n > 0)).toBe(true);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/admin/reset',
      headers: { ...h.authHeader(), 'x-admin-reset-token': RESET_TOKEN },
      payload: { confirm: h.organization.slug },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reset: boolean; organization_slug: string; cleared: Record<string, number> };
    expect(body.reset).toBe(true);
    expect(body.organization_slug).toBe(h.organization.slug);
    expect(body.cleared.customers).toBeGreaterThan(0);
    expect(body.cleared.events).toBeGreaterThan(0);

    // Verify data is gone.
    const after = await Promise.all([
      h.prisma.customer.count({ where: { organizationId: orgId } }),
      h.prisma.plan.count({ where: { organizationId: orgId } }),
      h.prisma.billableMetric.count({ where: { organizationId: orgId } }),
      h.prisma.event.count({ where: { organizationId: orgId } }),
      h.prisma.addOn.count({ where: { organizationId: orgId } }),
      h.prisma.subscription.count({ where: { organizationId: orgId } }),
      h.prisma.tax.count({ where: { organizationId: orgId } }),
    ]);
    expect(after.every((n) => n === 0)).toBe(true);

    // Org row + apiKey survive.
    const org = await h.prisma.organization.findUnique({ where: { id: orgId } });
    expect(org).not.toBeNull();
    expect(org!.apiKey).toBe(apiKey);
    expect(org!.customerCounter).toBe(0);
    expect(org!.invoiceCounter).toBe(0);
    expect(org!.creditNoteCounter).toBe(0);
  });

  it('sequential_id starts at 1 after reset', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/admin/reset',
      headers: { ...h.authHeader(), 'x-admin-reset-token': RESET_TOKEN },
      payload: { confirm: h.organization.slug },
    });
    expect(res.statusCode).toBe(200);

    const created = await h.app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: h.authHeader(),
      payload: { customer: { external_id: 'after-reset-1', name: 'Fresh', currency: 'MXN' } },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { customer: { sequential_id: number } };
    expect(body.customer.sequential_id).toBe(1);
  });
});
