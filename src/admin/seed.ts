// Seed Numaris scenario (v5).
//
// Creates:
//   - Customer `carga-express-mx` (CDMX, 1M anchor=1, trigger=next_cycle).
//   - 1 CustomerAddOn `reglas-10` flat ($1000/mes).
//   - Service `combustible-carga-express-mx` (recurring, $450/u/mes + setup $1200/u).
//     + 1 ServiceAddOn `historial-12m` per-unit ($50/u/mes).
//   - Service `instalacion-gps` (one_off, $3500/u).
//   - 3 units con intervalos sobrepuestos para prorrateo no trivial.
//
// v5: mini-Lago NO calcula impuestos — NetSuite los agrega cuando emite el CFDI.

import type { Organization, PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';

export type SeedSummary = {
  customer_external_id: string;
  service_code: string;
  units_created: number;
};

export async function seedNumaris(prisma: PrismaClient, org: Organization): Promise<SeedSummary> {
  const tz = org.timezone ?? 'America/Mexico_City';

  if (!org.netsuiteCallbackSecret) {
    await prisma.organization.update({
      where: { id: org.id },
      data: { netsuiteCallbackSecret: 'dev-callback-secret-replace-me' },
    });
  }

  const now = DateTime.now().setZone(tz);
  const periodStart = now.startOf('month');
  const periodEnd = periodStart.plus({ months: 1 }).minus({ seconds: 1 });
  const periodStartDate = periodStart.toUTC().toJSDate();
  const periodEndDate = periodEnd.toUTC().toJSDate();

  let customer = await prisma.customer.findUnique({
    where: { organizationId_externalId: { organizationId: org.id, externalId: 'carga-express-mx' } },
  });
  if (!customer) {
    const orgUpdated = await prisma.organization.update({
      where: { id: org.id },
      data: { customerCounter: { increment: 1 } },
      select: { customerCounter: true, slug: true },
    });
    customer = await prisma.customer.create({
      data: {
        organizationId: org.id,
        externalId: 'carga-express-mx',
        sequentialId: orgUpdated.customerCounter,
        slug: `${orgUpdated.slug}-${orgUpdated.customerCounter.toString().padStart(3, '0')}`,
        name: 'Carga Express MX',
        currency: 'MXN',
        country: 'MX',
        timezone: tz,
        taxIdentificationNumber: 'CEM250101AAA',
        billingPeriodMonths: 1,
        billingAnchorDay: 1,
        nonrecurringTrigger: 'next_cycle',
        subscriptionAt: periodStartDate,
        startedAt: periodStartDate,
        status: 'active',
        currentBillingPeriodStartedAt: periodStartDate,
        currentBillingPeriodEndingAt: periodEndDate,
      },
    });
  }

  // Customer-level flat add-on.
  await prisma.customerAddOn.upsert({
    where: { customerId_code: { customerId: customer.id, code: 'reglas-10' } },
    create: {
      customerId: customer.id,
      code: 'reglas-10',
      name: 'Reglas de evento 5→10',
      description: 'MX$1000 flat / mes — feature de plataforma, independiente de services o units',
      amountCents: 100000,
      netsuiteItemCode: 'NS-CUSTOMER-FLAT',
      activeFrom: periodStartDate,
    },
    update: {},
  });

  let service = await prisma.service.findUnique({
    where: { organizationId_code: { organizationId: org.id, code: 'combustible-carga-express-mx' } },
  });
  if (!service) {
    service = await prisma.service.create({
      data: {
        organizationId: org.id,
        customerId: customer.id,
        code: 'combustible-carga-express-mx',
        name: 'Servicio Combustible',
        description: 'MX$450/u/mes + setup MX$1200 por instalación. IVA lo calcula NetSuite.',
        currency: 'MXN',
        monthlyUnitAmountCents: 45000,
        setupUnitAmountCents: 120000,
        netsuiteMonthlyItemCode: 'NS-COMB-MONTHLY',
        netsuiteSetupItemCode: 'NS-COMB-SETUP',
        status: 'active',
      },
    });
  }

  // Service one_off de ejemplo (pago por adelantado, una vez por unit).
  // Modelo Numaris: la unit nueva paga upfront 48 meses de mensualidad
  // ($100/mes) + setup de instalación ($1,500). Total por unit nueva:
  // setup $1,500 + 48 × $100 = $6,300.
  let oneOffService = await prisma.service.findUnique({
    where: { organizationId_code: { organizationId: org.id, code: 'instalacion-gps' } },
  });
  if (!oneOffService) {
    oneOffService = await prisma.service.create({
      data: {
        organizationId: org.id,
        customerId: customer.id,
        code: 'instalacion-gps',
        name: 'Servicio Combustible (prepago)',
        description: 'Modelo prepago: cliente paga setup + 48 meses de mensualidad por adelantado al instalar cada unidad nueva.',
        currency: 'MXN',
        pricingModel: 'one_off',
        monthlyUnitAmountCents: 10000,   // $100/mes prepagado
        setupUnitAmountCents: 150000,    // $1,500 setup
        prepaidMonthsDefault: 48,        // 48 meses default
        netsuiteOneOffItemCode: 'NS-GPS-PREPAID',
        netsuiteSetupItemCode: 'NS-GPS-SETUP',
        status: 'active',
      },
    });
  }

  // Service-level per-unit add-on.
  await prisma.serviceAddOn.upsert({
    where: { serviceId_code: { serviceId: service.id, code: 'historial-12m' } },
    create: {
      serviceId: service.id,
      code: 'historial-12m',
      name: 'Historial 6→12 meses',
      description: 'MX$50 adicionales por unidad activa / mes',
      amountCents: 5000,
      netsuiteItemCode: 'NS-HIST-12M',
      activeFrom: periodStartDate,
    },
    update: {},
  });

  // Three units with overlapping/partial intervals.
  const startMs = periodStartDate.getTime();
  const endMs = periodEndDate.getTime();
  const length = endMs - startMs;
  const midPeriod = new Date(startMs + Math.floor(length * 12 / 31));
  const lateExit = new Date(startMs + Math.floor(length * 30 / 31));

  const unitsData: Array<{ externalId: string; label: string; activeFrom: Date; activeTo: Date | null; setupBilledAt: Date | null }> = [
    { externalId: 'unit-camion-001', label: 'Camión 001 — Placas ABC-123',
      activeFrom: periodStartDate, activeTo: null,
      setupBilledAt: new Date(startMs - 86400_000) },
    { externalId: 'unit-camion-002', label: 'Camión 002 — Placas DEF-456',
      activeFrom: midPeriod, activeTo: null,
      setupBilledAt: null }, // setup pendiente — saldrá en próxima factura
    { externalId: 'unit-camion-003', label: 'Camión 003 — Placas GHI-789',
      activeFrom: new Date(startMs - 30 * 86400_000), activeTo: lateExit,
      setupBilledAt: new Date(startMs - 60 * 86400_000) },
  ];

  let created = 0;
  for (const ud of unitsData) {
    const existing = await prisma.unit.findUnique({
      where: { serviceId_externalId: { serviceId: service.id, externalId: ud.externalId } },
    });
    if (existing) continue;
    await prisma.unit.create({
      data: {
        serviceId: service.id,
        externalId: ud.externalId,
        label: ud.label,
        activeFrom: ud.activeFrom,
        activeTo: ud.activeTo,
        setupBilledAt: ud.setupBilledAt,
      },
    });
    await prisma.eventLog.create({
      data: {
        organizationId: org.id,
        transactionId: `seed-${ud.externalId}-add`,
        serviceId: service.id,
        unitExternalId: ud.externalId,
        unitLabel: ud.label,
        operationType: 'add',
        kind: 'seed',
        timestamp: ud.activeFrom,
      },
    });
    created += 1;
  }

  return {
    customer_external_id: customer.externalId,
    service_code: service.code,
    units_created: created,
  };
}
