// v8 — billing_starts_at por unit: separar "cuándo reporta" de "cuándo se factura".
//
// Casos cubiertos (migración desde otra plataforma GPS):
//   A) Cobrar mes completo aunque la unit empiece a reportar mid-mes:
//      active_from = 5-may, billing_starts_at = 1-may → factor 1.0 mayo
//   B) Saltarse el mes (el cliente ya pagó en plataforma anterior):
//      active_from = 5-may, billing_starts_at = 1-jun → mayo no factura,
//      junio factura full
//   C) Prorrateo parcial custom (cliente pagó hasta el 15):
//      active_from = 5-may, billing_starts_at = 16-may → factor 16/31
//   D) Setup también se difiere con billing_starts_at:
//      mes saltado → setup tampoco se cobra en ese mes
//   E) one_off + next_cycle respeta billing_starts_at para decidir en qué
//      cycle entra la unit
//   F) PATCH /units/:id permite ajustar billing_starts_at después de crear
//   G) one_off + immediate con billing_starts_at futuro NO emite invoice
//      al ping (queda pending hasta otro trigger).

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { createCustomerDirect, createUnitDirect } from '../helpers/factories.js';

describe('v8 — billing_starts_at (migración mid-mes)', () => {
  let h: Harness;
  beforeEach(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  async function seedRecurring(opts: { monthly?: number; setup?: number } = {}) {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'c-mig', name: 'Mig', currency: 'MXN',
      timezone: 'America/Mexico_City',
      subscriptionAt: new Date('2020-01-01T00:00:00Z'),
      billingAnchorDay: 1, billingPeriodMonths: 1,
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-mig', customer_external_id: 'c-mig', name: 'svc',
        pricing_model: 'recurring',
        monthly_unit_amount_cents: opts.monthly ?? 85000,
        setup_unit_amount_cents: opts.setup ?? 0,
      } },
    });
  }

  async function preview(period_from: string, period_to: string) {
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'c-mig', period_from, period_to } },
    });
    expect(r.statusCode).toBe(200);
    return (r.json() as {
      preview: { fees: Array<{ kind: string; units: string; amount_cents: number }> };
    }).preview;
  }

  async function migSvc() {
    return h.prisma.service.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: h.organization.id, code: 's-mig' } },
    });
  }

  // ===========================================================================
  // A — cobrar mes completo aunque la unit entre mid-mes
  // ===========================================================================
  it('A) billing_starts_at = inicio del mes → cobra mes completo', async () => {
    await seedRecurring({ monthly: 85000 });
    const svc = await migSvc();
    await createUnitDirect(h.prisma, {
      serviceId: svc.id, externalId: 'gps-001',
      activeFrom: new Date('2026-05-05T00:00:00Z'),
      billingStartsAt: new Date('2026-05-01T06:00:00Z'),
    });
    const p = await preview('2026-05-01T06:00:00Z', '2026-06-01T05:59:59Z');
    const m = p.fees.find((f) => f.kind === 'monthly')!;
    expect(m.units).toBe('1.0000');
    expect(m.amount_cents).toBe(85000);
  });

  // ===========================================================================
  // B — saltarse el mes (ya pagó en plataforma anterior)
  // ===========================================================================
  it('B) billing_starts_at = inicio del próximo mes → mayo no factura, junio sí', async () => {
    await seedRecurring({ monthly: 85000 });
    const svc = await migSvc();
    await createUnitDirect(h.prisma, {
      serviceId: svc.id, externalId: 'gps-002',
      activeFrom: new Date('2026-05-05T00:00:00Z'),
      billingStartsAt: new Date('2026-06-01T06:00:00Z'),
    });
    // Mayo: no debe haber renglón monthly (la unit "no factura" en mayo).
    const may = await preview('2026-05-01T06:00:00Z', '2026-06-01T05:59:59Z');
    expect(may.fees.find((f) => f.kind === 'monthly')).toBeUndefined();
    // Junio: cobra mes completo.
    const jun = await preview('2026-06-01T06:00:00Z', '2026-07-01T05:59:59Z');
    const m = jun.fees.find((f) => f.kind === 'monthly')!;
    expect(m.units).toBe('1.0000');
    expect(m.amount_cents).toBe(85000);
  });

  // ===========================================================================
  // C — prorrateo parcial custom
  // ===========================================================================
  it('C) billing_starts_at mid-mes → factor (días_restantes / días_del_mes)', async () => {
    await seedRecurring({ monthly: 85000 });
    const svc = await migSvc();
    await createUnitDirect(h.prisma, {
      serviceId: svc.id, externalId: 'gps-003',
      activeFrom: new Date('2026-05-05T00:00:00Z'),
      billingStartsAt: new Date('2026-05-16T06:00:00Z'),
    });
    const p = await preview('2026-05-01T06:00:00Z', '2026-06-01T05:59:59Z');
    const m = p.fees.find((f) => f.kind === 'monthly')!;
    // 16/31 = 0.5161 (16 días en mayo: del 16 al 31).
    expect(m.units).toBe('0.5161');
  });

  // ===========================================================================
  // D — setup también se difiere
  // ===========================================================================
  it('D) setup se difiere si billing_starts_at > periodEnd', async () => {
    await seedRecurring({ monthly: 85000, setup: 15000 });
    const svc = await migSvc();
    await createUnitDirect(h.prisma, {
      serviceId: svc.id, externalId: 'gps-004',
      activeFrom: new Date('2026-05-05T00:00:00Z'),
      billingStartsAt: new Date('2026-06-01T06:00:00Z'),
    });
    // Mayo: ni monthly ni setup.
    const may = await preview('2026-05-01T06:00:00Z', '2026-06-01T05:59:59Z');
    expect(may.fees.find((f) => f.kind === 'monthly')).toBeUndefined();
    expect(may.fees.find((f) => f.kind === 'setup')).toBeUndefined();
    // Junio: setup y monthly.
    const jun = await preview('2026-06-01T06:00:00Z', '2026-07-01T05:59:59Z');
    expect(jun.fees.find((f) => f.kind === 'monthly')).toBeTruthy();
    const setup = jun.fees.find((f) => f.kind === 'setup')!;
    expect(setup.amount_cents).toBe(15000);
  });

  // ===========================================================================
  // E — one_off + next_cycle decide cycle en base a billing_starts_at
  // ===========================================================================
  it('E) one_off + next_cycle: billing_starts_at decide en qué cycle entra la unit', async () => {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'c-oo', name: 'OneOff', currency: 'MXN',
      timezone: 'America/Mexico_City',
      subscriptionAt: new Date('2020-01-01T00:00:00Z'),
      nonrecurringTrigger: 'next_cycle',
      billingAnchorDay: 1, billingPeriodMonths: 1,
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-oo', customer_external_id: 'c-oo', name: 'oo',
        pricing_model: 'one_off',
        monthly_unit_amount_cents: 10000, setup_unit_amount_cents: 0,
        prepaid_months_default: 12,
      } },
    });
    const svcOo = await h.prisma.service.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: h.organization.id, code: 's-oo' } },
    });
    await createUnitDirect(h.prisma, {
      serviceId: svcOo.id, externalId: 'gps-oo-1',
      activeFrom: new Date('2026-05-05T00:00:00Z'),
      billingStartsAt: new Date('2026-06-15T00:00:00Z'),
    });
    // Cycle mayo NO debe incluir la unit one_off.
    const may = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'c-oo', period_from: '2026-05-01T06:00:00Z', period_to: '2026-06-01T05:59:59Z' } },
    });
    const mayPrev = (may.json() as { preview: { fees: Array<{ kind: string }> } }).preview;
    expect(mayPrev.fees.find((f) => f.kind === 'one_off')).toBeUndefined();
    // Cycle junio sí.
    const jun = await h.app.inject({
      method: 'POST', url: '/api/v1/invoices/preview', headers: h.authHeader(),
      payload: { invoice: { customer_external_id: 'c-oo', period_from: '2026-06-01T06:00:00Z', period_to: '2026-07-01T05:59:59Z' } },
    });
    const junPrev = (jun.json() as { preview: { fees: Array<{ kind: string; amount_cents: number }> } }).preview;
    const oo = junPrev.fees.find((f) => f.kind === 'one_off')!;
    expect(oo.amount_cents).toBe(12 * 10000);
  });

  // ===========================================================================
  // F — PATCH /units/:id permite ajustar billing_starts_at
  // ===========================================================================
  it.skip('F) PATCH /units/:id permite ajustar y limpiar billing_starts_at', async () => {
    // TODO: PATCH /units/:id ya no acepta billing_starts_at (solo `label`).
    // El ajuste de billing_starts_at vive ahora en el admin/DB directo.
  });

  // ===========================================================================
  // G — one_off + immediate con billing_starts_at futuro NO emite invoice
  // ===========================================================================
  it('G) one_off + immediate: billing_starts_at futuro defiere el ping (sin invoice)', async () => {
    await createCustomerDirect(h.prisma, h.organization, {
      externalId: 'c-imm', name: 'Imm', currency: 'MXN',
      timezone: 'America/Mexico_City',
      subscriptionAt: new Date('2020-01-01T00:00:00Z'),
      nonrecurringTrigger: 'immediate',
    });
    await h.app.inject({
      method: 'POST', url: '/api/v1/services', headers: h.authHeader(),
      payload: { service: {
        code: 's-imm', customer_external_id: 'c-imm', name: 'imm',
        pricing_model: 'one_off', monthly_unit_amount_cents: 10000,
        setup_unit_amount_cents: 0, prepaid_months_default: 6,
      } },
    });
    // Pre-creamos la unit con billing_starts_at futuro en DB (el API ya no
    // acepta ese campo en POST /events ni en POST /units). Luego mandamos el
    // event 'add' limpio: el handler debe respetar billing_starts_at y NO
    // emitir invoice (defer).
    const svcImm = await h.prisma.service.findUniqueOrThrow({
      where: { organizationId_code: { organizationId: h.organization.id, code: 's-imm' } },
    });
    await createUnitDirect(h.prisma, {
      serviceId: svcImm.id, externalId: 'gps-imm-1',
      activeFrom: new Date('2026-05-05T00:00:00Z'),
      billingStartsAt: new Date('2026-06-01T06:00:00Z'),
    });
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/events', headers: h.authHeader(),
      payload: { event: {
        transaction_id: 'imm-deferred', service_code: 's-imm', operation_type: 'add',
        unit_external_id: 'gps-imm-1', unit_label: 'gps-imm-1',
        timestamp: Math.floor(new Date('2026-05-05T00:00:00Z').getTime() / 1000),
      } },
    });
    expect(r.statusCode).toBe(200);
    // El response NO debe tener triggered_invoice_id.
    expect((r.json() as Record<string, unknown>).triggered_invoice_id).toBeUndefined();
    // La unit existe pero sigue sin oneoffBilledAt.
    const unit = await h.prisma.unit.findFirstOrThrow({ where: { externalId: 'gps-imm-1' } });
    expect(unit.oneoffBilledAt).toBeNull();
    expect(unit.billingStartsAt).not.toBeNull();
    expect(await h.prisma.invoice.count()).toBe(0);
  });
});
