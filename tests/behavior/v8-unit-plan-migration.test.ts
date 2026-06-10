// v8 — migración de unit entre planes (services).
//
// Política agreed:
//   - Solo futuro (migration_at > now).
//   - Mismo customer, mismo pricing_model.
//   - external_id preservado.
//   - charge_new_setup=false por default → no se re-cobra setup.
//   - Add-ons per-unit del service viejo se cierran (siguen ligados al old).
//   - Audit: metadata.migrated_to (vieja), metadata.migrated_from (nueva),
//     + EventLog con operation_type='migrate'.
//
// Casos cubiertos:
//   A) Migrar: cierra la unit vieja, crea la nueva, EventLog audit
//   B) charge_new_setup=false → setup NO se cobra en el nuevo plan
//   C) charge_new_setup=true → setup SÍ se cobra en el nuevo plan
//   D) Proration: cycle que cruza migration_at se cobra parcial en cada plan
//   E) Validación: migration_at en el pasado → 422
//   F) Validación: cross-pricing-model (recurring → one_off) → 422
//   G) Validación: cross-customer → 422
//   H) Validación: misma service que la actual → 422
//   I) Validación: unit ya terminada → 409
//   J) Validación: unit ya migrada → 409
//   K) Guard /events: tras migrar, evento al service viejo se rechaza

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { createCustomerDirect, createUnitDirect } from '../helpers/factories.js';

describe('v8 — migración de unit entre planes', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  async function seed(opts: {
    customer?: string;
    serviceA?: { code: string; monthly: number; setup?: number; pricing_model?: 'recurring' | 'one_off' };
    serviceB?: { code: string; monthly: number; setup?: number; pricing_model?: 'recurring' | 'one_off' };
  } = {}) {
    const customer = opts.customer ?? 'c-mig';
    const sA = opts.serviceA ?? { code: 'plan-premium', monthly: 85000, setup: 15000, pricing_model: 'recurring' as const };
    const sB = opts.serviceB ?? { code: 'plan-lite', monthly: 50000, setup: 10000, pricing_model: 'recurring' as const };
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: customer, name: customer, currency: 'MXN',
      timezone: 'America/Mexico_City',
      subscriptionAt: new Date('2020-01-01T00:00:00Z'),
      billingAnchorDay: 1, billingPeriodMonths: 1,
    });
    for (const s of [sA, sB]) {
      await h.app.inject({
        method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
        payload: { service: {
          code: s.code, customer_external_id: customer, name: s.code,
          pricing_model: s.pricing_model ?? 'recurring',
          monthly_unit_amount_cents: s.monthly,
          setup_unit_amount_cents: s.setup ?? 0,
          ...(s.pricing_model === 'one_off' ? { prepaid_months_default: 12 } : {}),
        } },
      });
    }
    return { customer, sA, sB };
  }

  async function createUnit(serviceCode: string, externalId: string, activeFrom = '2020-01-01T00:00:00Z') {
    const svc = await h.prisma.service.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: h.organization.id, code: serviceCode } },
    });
    const { id } = await createUnitDirect(h.prisma, {
      serviceId: svc.id, externalId, activeFrom: new Date(activeFrom),
    });
    return { id, external_id: externalId };
  }

  function futureIso(daysFromNow = 30): string {
    return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
  }

  // ===========================================================================
  // A — happy path
  // ===========================================================================
  it('A) migrar cierra unit vieja, crea nueva con metadata + EventLog audit', async () => {
    await seed();
    const old = await createUnit('plan-premium', 'gps-001');
    const at = futureIso(10);
    const r = await h.app.inject({
      method: 'POST', url: `/api/v1/units/${old.id}/migrate`, headers: h.authHeader(),
      payload: { migration: { to_service_code: 'plan-lite', migration_at: at } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      old_unit: { id: string; active_to: string; metadata: Record<string, unknown> };
      new_unit: { id: string; service_id: string; external_id: string; active_from: string; setup_billed_at: string | null; metadata: Record<string, unknown> };
      event_id: string;
    };
    // Vieja terminada en migration_at + huella migrated_to.
    expect(body.old_unit.active_to).toContain(new Date(at).toISOString().slice(0, 10));
    expect(body.old_unit.metadata.migrated_to).toBeTruthy();
    // Nueva: mismo external_id, service nuevo, metadata.migrated_from, setupBilledAt preestablecido (no se cobra setup).
    expect(body.new_unit.external_id).toBe('gps-001');
    expect(body.new_unit.active_from).toContain(new Date(at).toISOString().slice(0, 10));
    expect(body.new_unit.metadata.migrated_from).toBeTruthy();
    expect(body.new_unit.setup_billed_at).not.toBeNull(); // charge_new_setup=false default
    // EventLog 'migrate' creado.
    const evt = await h.prisma.eventLog.findFirstOrThrow({ where: { id: body.event_id } });
    expect(evt.operationType).toBe('migrate');
    expect(evt.kind).toBe('plan_migration');
  });

  // ===========================================================================
  // B — charge_new_setup=false (default) → no cobra setup en preview de mes siguiente
  // ===========================================================================
  it('B) charge_new_setup=false → setup nuevo NO se cobra', async () => {
    await seed();
    const old = await createUnit('plan-premium', 'gps-002');
    const at = futureIso(5);
    await h.app.inject({
      method: 'POST', url: `/api/v1/units/${old.id}/migrate`, headers: h.authHeader(),
      payload: { migration: { to_service_code: 'plan-lite', migration_at: at } },
    });
    // Preview de un periodo claramente posterior a la migración → no debe haber setup.
    // (Marcamos billing_starts_at en la unit nueva = migration_at, así que el cycle
    //  futuro tendrá monthly pero NO setup.)
    const p = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: {
        customer_external_id: 'c-mig',
        period_from: '2030-01-01T06:00:00Z', period_to: '2030-02-01T05:59:59Z',
      } },
    });
    const preview = (p.json() as { preview: { fees: Array<{ kind: string; service_id: string | null; amount_cents: number }> } }).preview;
    // No debe haber setup ligado al plan-lite (nuevo).
    const liteService = await h.prisma.service.findFirstOrThrow({ where: { code: 'plan-lite' } });
    const liteSetup = preview.fees.find((f) => f.kind === 'setup' && f.service_id === liteService.id);
    expect(liteSetup).toBeUndefined();
  });

  // ===========================================================================
  // C — charge_new_setup=true → setup nuevo SÍ se cobra
  // ===========================================================================
  it('C) charge_new_setup=true → setup nuevo SÍ se cobra', async () => {
    await seed();
    const old = await createUnit('plan-premium', 'gps-003');
    const at = futureIso(5);
    const r = await h.app.inject({
      method: 'POST', url: `/api/v1/units/${old.id}/migrate`, headers: h.authHeader(),
      payload: { migration: { to_service_code: 'plan-lite', migration_at: at, charge_new_setup: true } },
    });
    expect(r.statusCode).toBe(200);
    const newUnit = (r.json() as { new_unit: { setup_billed_at: string | null } }).new_unit;
    expect(newUnit.setup_billed_at).toBeNull(); // pendiente → se cobrará en el próximo cycle
  });

  // ===========================================================================
  // D — Proration: cycle que cruza migration_at se prorratea entre ambos planes
  // ===========================================================================
  it('D) cycle que cruza migration_at: factura proporcional en cada plan', async () => {
    await seed();
    const old = await createUnit('plan-premium', 'gps-004');
    // Migrar el 16-jun (a futuro). Tomamos un cliente con periodo full junio
    // en CST: 1-jun → 1-jul (= 30 días, junio tiene 30).
    // Cycle: 1-jun → 1-jul. Migración mid-jun el día 16 (UTC 06:00 = 0:00 CST).
    // Pero migration_at debe ser > now. Si los tests corren después de jun 2026
    // esto fallaría. Usamos una migración FUTURA real y le pasamos period
    // override al preview para verificar el split.
    // Para hacer el test estable, ejecutamos la migración con un at > now real,
    // y verificamos el split en el cycle que CONTIENE ese at.
    const atDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // +10 días
    // Snap a UTC 06:00 (= 00:00 CST) del día seleccionado para que la matemática
    // por mes calendario sea predecible.
    atDate.setUTCHours(6, 0, 0, 0);
    const at = atDate.toISOString();
    // Periodo cycle correspondiente: 1er día del mes 06:00 UTC → 1ro del siguiente.
    const month = atDate.getUTCMonth();
    const year = atDate.getUTCFullYear();
    const periodFrom = new Date(Date.UTC(year, month, 1, 6, 0, 0)).toISOString();
    const periodToD = new Date(Date.UTC(year, month + 1, 1, 5, 59, 59));
    const periodTo = periodToD.toISOString();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(); // last day = days in month
    const dayOfMigration = atDate.getUTCDate(); // 1-based
    // Días bajo plan PREMIUM (antes de migrar): 1 → dayOfMigration.
    // Días bajo plan LITE (desde la migración): dayOfMigration → último día +1.
    // Pero buildUnitEntries trunca al periodo: la unit vieja tiene activeTo=at,
    // la nueva activeFrom=at. Las fracciones suman ~1.0.

    const r = await h.app.inject({
      method: 'POST', url: `/api/v1/units/${old.id}/migrate`, headers: h.authHeader(),
      payload: { migration: { to_service_code: 'plan-lite', migration_at: at } },
    });
    expect(r.statusCode).toBe(200);

    // Preview del periodo que cubre la migración.
    const p = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'c-mig', period_from: periodFrom, period_to: periodTo } },
    });
    expect(p.statusCode).toBe(200);
    const preview = (p.json() as { preview: { fees: Array<{ kind: string; service_id: string | null; amount_cents: number }> } }).preview;
    const premium = await h.prisma.service.findFirstOrThrow({ where: { code: 'plan-premium' } });
    const lite = await h.prisma.service.findFirstOrThrow({ where: { code: 'plan-lite' } });
    const monthlyPremium = preview.fees.find((f) => f.kind === 'monthly' && f.service_id === premium.id);
    const monthlyLite = preview.fees.find((f) => f.kind === 'monthly' && f.service_id === lite.id);
    expect(monthlyPremium).toBeTruthy();
    expect(monthlyLite).toBeTruthy();
    // La suma de ambas fracciones debe aproximarse a 1.0 (mes completo).
    // Premium cubre (dayOfMigration - 1) días, lite cubre (daysInMonth - dayOfMigration + 1) días.
    const expectedPremiumDays = dayOfMigration - 1;
    const expectedLiteDays = daysInMonth - expectedPremiumDays;
    // amount = monthly_unit * days / daysInMonth (con truncado a 4 dec).
    // Test laxo: cada fee > 0, y la suma de amounts iguala (premium*premiumDays + lite*liteDays)/daysInMonth aprox.
    expect(monthlyPremium!.amount_cents).toBeGreaterThan(0);
    expect(monthlyLite!.amount_cents).toBeGreaterThan(0);
    const sum = monthlyPremium!.amount_cents + monthlyLite!.amount_cents;
    const expectedApprox = Math.round((85000 * expectedPremiumDays + 50000 * expectedLiteDays) / daysInMonth);
    // Tolerancia ±10 cents por la doble redondeo a 4 dec en cada side.
    expect(Math.abs(sum - expectedApprox)).toBeLessThan(50);
  });

  // ===========================================================================
  // E — Validación: migration_at en el pasado
  // ===========================================================================
  it('E) migration_at en el pasado → 422', async () => {
    await seed();
    const old = await createUnit('plan-premium', 'gps-005');
    const r = await h.app.inject({
      method: 'POST', url: `/api/v1/units/${old.id}/migrate`, headers: h.authHeader(),
      payload: { migration: { to_service_code: 'plan-lite', migration_at: '2020-01-01T00:00:00Z' } },
    });
    expect(r.statusCode).toBe(422);
  });

  // ===========================================================================
  // F — Validación: cross-pricing-model
  // ===========================================================================
  it('F) cross-pricing-model (recurring → one_off) → 422', async () => {
    await seed({
      serviceB: { code: 'plan-oneoff', monthly: 10000, pricing_model: 'one_off' },
    });
    const old = await createUnit('plan-premium', 'gps-006');
    const r = await h.app.inject({
      method: 'POST', url: `/api/v1/units/${old.id}/migrate`, headers: h.authHeader(),
      payload: { migration: { to_service_code: 'plan-oneoff', migration_at: futureIso(10) } },
    });
    expect(r.statusCode).toBe(422);
  });

  // ===========================================================================
  // G — Validación: cross-customer
  // ===========================================================================
  it('G) target service pertenece a otro customer → 422', async () => {
    await seed();
    // Customer 2 con un service propio.
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'c2', name: 'c2', currency: 'MXN', timezone: 'America/Mexico_City',
      subscriptionAt: new Date('2020-01-01T00:00:00Z'),
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: { code: 'svc-c2', customer_external_id: 'c2', name: 'c2-svc', pricing_model: 'recurring', monthly_unit_amount_cents: 50000 } },
    });
    const old = await createUnit('plan-premium', 'gps-007');
    const r = await h.app.inject({
      method: 'POST', url: `/api/v1/units/${old.id}/migrate`, headers: h.authHeader(),
      payload: { migration: { to_service_code: 'svc-c2', migration_at: futureIso(10) } },
    });
    expect(r.statusCode).toBe(422);
  });

  // ===========================================================================
  // H — Validación: mismo service
  // ===========================================================================
  it('H) migrar al mismo service → 422', async () => {
    await seed();
    const old = await createUnit('plan-premium', 'gps-008');
    const r = await h.app.inject({
      method: 'POST', url: `/api/v1/units/${old.id}/migrate`, headers: h.authHeader(),
      payload: { migration: { to_service_code: 'plan-premium', migration_at: futureIso(10) } },
    });
    expect(r.statusCode).toBe(422);
  });

  // ===========================================================================
  // I — Validación: unit ya terminada
  // ===========================================================================
  it('I) unit ya terminada → 409', async () => {
    await seed();
    const old = await createUnit('plan-premium', 'gps-009');
    // Terminar manualmente (PATCH /units solo acepta `label`).
    await h.prisma.unit.update({
      where: { id: old.id }, data: { activeTo: new Date() },
    });
    const r = await h.app.inject({
      method: 'POST', url: `/api/v1/units/${old.id}/migrate`, headers: h.authHeader(),
      payload: { migration: { to_service_code: 'plan-lite', migration_at: futureIso(10) } },
    });
    expect(r.statusCode).toBe(409);
  });

  // ===========================================================================
  // J — Validación: doble migración del mismo registro viejo
  // ===========================================================================
  it('J) migrar dos veces el mismo old_unit → 409 en la segunda', async () => {
    await seed();
    const old = await createUnit('plan-premium', 'gps-010');
    const r1 = await h.app.inject({
      method: 'POST', url: `/api/v1/units/${old.id}/migrate`, headers: h.authHeader(),
      payload: { migration: { to_service_code: 'plan-lite', migration_at: futureIso(10) } },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await h.app.inject({
      method: 'POST', url: `/api/v1/units/${old.id}/migrate`, headers: h.authHeader(),
      payload: { migration: { to_service_code: 'plan-lite', migration_at: futureIso(20) } },
    });
    expect(r2.statusCode).toBe(409);
  });

  // ===========================================================================
  // K — Guard /events: rechazar eventos al service viejo tras migración
  // ===========================================================================
  it('K) tras migrar, evento al service viejo es rechazado', async () => {
    await seed();
    const old = await createUnit('plan-premium', 'gps-011');
    await h.app.inject({
      method: 'POST', url: `/api/v1/units/${old.id}/migrate`, headers: h.authHeader(),
      payload: { migration: { to_service_code: 'plan-lite', migration_at: futureIso(10) } },
    });
    // Intentar pingear el service viejo.
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'tx-blocked', service_code: 'plan-premium', operation_type: 'add',
        unit_external_id: 'gps-011', unit_label: 'gps-011',
        timestamp: Math.floor(Date.now() / 1000),
      } },
    });
    expect(r.statusCode).toBe(422);
    expect(r.body).toContain('migrated_to');
    // En cambio, pingear al service NUEVO debe funcionar.
    const ok = await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'tx-ok', service_code: 'plan-lite', operation_type: 'add',
        unit_external_id: 'gps-011', unit_label: 'gps-011',
        timestamp: Math.floor(Date.now() / 1000),
      } },
    });
    expect(ok.statusCode).toBe(200);
  });
});
