// v17 — cobro de "baja" (desinstalación) per-unit.
//
// Espejo del setup fee: se cobra UNA vez por unit, en el invoice del period
// que contiene la terminación (activeTo). Migración de plan NO dispara baja.
//
// Casos cubiertos:
//   A) Recurring con removal=$50: terminar unit dispara fee 'removal' en cycle.
//   B) removal=0 (default): backward compat, no aparece fee 'removal'.
//   C) Una vez facturado, removalBilledAt seteado → segundo cycle NO duplica.
//   D) Migración de plan: removalBilledAt seteado en unit vieja al momento
//      de la migración → NO genera fee 'removal'.
//   E) Activar y terminar en el mismo cycle: setup + removal + mensualidad
//      proporcional, los tres en el mismo invoice.
//   F) One_off: removal_unit_amount_cents > 0 → 422 only_applicable_to_recurring.
//   G) NetSuite item code: el fee 'removal' lleva netsuite_removal_item_code.
//   H) PATCH /services/:code permite editar removal post-creación.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { createCustomerDirect, createUnitDirect } from '../helpers/factories.js';

describe('v17 — unit removal fee', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  async function seedCustomer(externalId = 'c-1') {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId, name: externalId, currency: 'MXN',
      timezone: 'America/Mexico_City',
      subscriptionAt: new Date('2020-01-01T00:00:00Z'),
      billingAnchorDay: 1, billingPeriodMonths: 1,
    });
  }

  async function seedService(code: string, customerExt: string, opts: { monthly?: number; setup?: number; removal?: number; nsRemoval?: string | null } = {}) {
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code, customer_external_id: customerExt, name: code,
        monthly_unit_amount_cents: opts.monthly ?? 50000,
        setup_unit_amount_cents: opts.setup ?? 10000,
        removal_unit_amount_cents: opts.removal ?? 0,
        ...(opts.nsRemoval !== undefined ? { netsuite_removal_item_code: opts.nsRemoval } : {}),
      } },
    });
    expect(r.statusCode).toBe(200);
    return r;
  }

  async function seedUnit(code: string, extId: string, activeFrom: string) {
    const svc = await h.prisma.service.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: h.organization.id, code } },
    });
    return createUnitDirect(h.prisma, {
      serviceId: svc.id, externalId: extId, activeFrom: new Date(activeFrom),
    });
  }

  async function terminateUnit(extId: string, activeTo: string) {
    const unit = await h.prisma.unit.findFirstOrThrow({ where: { externalId: extId } });
    await h.prisma.unit.update({
      where: { id: unit.id }, data: { activeTo: new Date(activeTo) },
    });
  }

  async function preview(extId: string, period_from: string, period_to: string) {
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: extId, period_from, period_to } },
    });
    expect(r.statusCode).toBe(200);
    return (r.json() as { preview: { fees: Array<{ kind: string; amount_cents: number; netsuite_item_code: string | null; description: string }> } }).preview;
  }

  // =========================================================================
  it('A) recurring con removal=5000: terminar unit dispara fee removal en cycle', async () => {
    await seedCustomer('c-A');
    await seedService('s-A', 'c-A', { removal: 5000 });
    await seedUnit('s-A', 'u-1', '2026-01-01T06:00:00Z');
    await terminateUnit('u-1', '2026-06-15T18:00:00Z');

    const p = await preview('c-A', '2026-06-01T06:00:00Z', '2026-07-01T05:59:59Z');
    const removal = p.fees.find((f) => f.kind === 'removal');
    expect(removal).toBeTruthy();
    expect(removal!.amount_cents).toBe(5000);
    expect(removal!.description).toContain('baja × 1');
  });

  // =========================================================================
  it('B) backward compat: removal=0 (default) → ningún fee removal', async () => {
    await seedCustomer('c-B');
    await seedService('s-B', 'c-B'); // sin removal
    await seedUnit('s-B', 'u-1', '2026-01-01T06:00:00Z');
    await terminateUnit('u-1', '2026-06-15T18:00:00Z');

    const p = await preview('c-B', '2026-06-01T06:00:00Z', '2026-07-01T05:59:59Z');
    expect(p.fees.find((f) => f.kind === 'removal')).toBeUndefined();
  });

  // =========================================================================
  it('C) una vez facturado removalBilledAt, segundo cycle NO duplica', async () => {
    await seedCustomer('c-C');
    await seedService('s-C', 'c-C', { removal: 5000 });
    await seedUnit('s-C', 'u-1', '2026-01-01T06:00:00Z');
    await terminateUnit('u-1', '2026-06-15T18:00:00Z');

    // Simulamos emisión exitosa marcando removalBilledAt manualmente.
    await h.prisma.unit.update({
      where: { id: (await h.prisma.unit.findFirstOrThrow({ where: { externalId: 'u-1' } })).id },
      data: { removalBilledAt: new Date('2026-07-01T06:00:00Z') },
    });

    const p = await preview('c-C', '2026-07-01T06:00:00Z', '2026-08-01T05:59:59Z');
    expect(p.fees.find((f) => f.kind === 'removal')).toBeUndefined();
  });

  // =========================================================================
  it('D) migración de plan: removalBilledAt = migrationAt en unit vieja, NO dispara fee', async () => {
    await seedCustomer('c-D');
    await seedService('s-old', 'c-D', { removal: 5000 });
    await seedService('s-new', 'c-D', { removal: 5000 });
    await seedUnit('s-old', 'u-1', '2026-01-01T06:00:00Z');

    const oldUnitBefore = await h.prisma.unit.findFirstOrThrow({ where: { externalId: 'u-1' } });

    // Migración a futuro requerida por el endpoint.
    const future = new Date(Date.now() + 60_000).toISOString();
    const r = await h.app.inject({
      method: 'POST', url: `/api/v1/units/${oldUnitBefore.id}/migrate`, headers: h.authHeader(),
      payload: { migration: { to_service_code: 's-new', migration_at: future, charge_new_setup: false } },
    });
    expect(r.statusCode).toBe(200);

    // La unit vieja debe tener removalBilledAt = migration_at.
    const oldUnitAfter = await h.prisma.unit.findUnique({ where: { id: oldUnitBefore.id } });
    expect(oldUnitAfter!.removalBilledAt).not.toBeNull();
    expect(oldUnitAfter!.activeTo).not.toBeNull();
    expect(oldUnitAfter!.removalBilledAt!.toISOString()).toBe(oldUnitAfter!.activeTo!.toISOString());

    // Preview del periodo que contiene la migración: NO debe incluir fee 'removal'.
    const p = await preview('c-D',
      new Date(new Date(future).getFullYear(), new Date(future).getMonth(), 1).toISOString(),
      new Date(new Date(future).getFullYear(), new Date(future).getMonth() + 1, 1).toISOString());
    expect(p.fees.find((f) => f.kind === 'removal')).toBeUndefined();
  });

  // =========================================================================
  it('E) activar + terminar en el mismo cycle: setup + removal + monthly proporcional', async () => {
    await seedCustomer('c-E');
    await seedService('s-E', 'c-E', { monthly: 30000, setup: 10000, removal: 5000 });
    await seedUnit('s-E', 'u-1', '2026-06-05T18:00:00Z');
    await terminateUnit('u-1', '2026-06-20T18:00:00Z');

    const p = await preview('c-E', '2026-06-01T06:00:00Z', '2026-07-01T05:59:59Z');
    expect(p.fees.find((f) => f.kind === 'setup')?.amount_cents).toBe(10000);
    expect(p.fees.find((f) => f.kind === 'removal')?.amount_cents).toBe(5000);
    const monthly = p.fees.find((f) => f.kind === 'monthly');
    expect(monthly).toBeTruthy();
    // Mensualidad proporcional: < mensualidad completa.
    expect(monthly!.amount_cents).toBeLessThan(30000);
    expect(monthly!.amount_cents).toBeGreaterThan(0);
  });

  // =========================================================================
  it('F) one_off con removal > 0 → 422 only_applicable_to_recurring', async () => {
    await seedCustomer('c-F');
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-F', customer_external_id: 'c-F', name: 's',
        pricing_model: 'one_off', monthly_unit_amount_cents: 10000,
        prepaid_months_default: 12, removal_unit_amount_cents: 5000,
      } },
    });
    expect(r.statusCode).toBe(422);
    expect(JSON.stringify(r.json())).toContain('only_applicable_to_recurring');
  });

  // =========================================================================
  it('G) netsuite_removal_item_code se propaga al fee', async () => {
    await seedCustomer('c-G');
    await seedService('s-G', 'c-G', { removal: 5000, nsRemoval: 'NS-BAJA-001' });
    await seedUnit('s-G', 'u-1', '2026-01-01T06:00:00Z');
    await terminateUnit('u-1', '2026-06-15T18:00:00Z');

    const p = await preview('c-G', '2026-06-01T06:00:00Z', '2026-07-01T05:59:59Z');
    const removal = p.fees.find((f) => f.kind === 'removal');
    expect(removal!.netsuite_item_code).toBe('NS-BAJA-001');
  });

  // =========================================================================
  it('H) PATCH /services/:code permite editar removal post-creación', async () => {
    await seedCustomer('c-H');
    await seedService('s-H', 'c-H', { removal: 0 });

    const r = await h.app.inject({
      method: 'PATCH', url: '/api/v1/services/s-H', headers: h.authHeader(),
      payload: { service: { removal_unit_amount_cents: 7500, netsuite_removal_item_code: 'NS-BAJA-X' } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { service: { removal_unit_amount_cents: number; netsuite_removal_item_code: string | null } };
    expect(body.service.removal_unit_amount_cents).toBe(7500);
    expect(body.service.netsuite_removal_item_code).toBe('NS-BAJA-X');
  });
});
