// Seed Numaris scenario (v3).
//
// Creates:
//   - IVA MX 16% tax.
//   - Customer `carga-express-mx` (CDMX, calendar billing cycle).
//   - 1 CustomerAddOn `reglas-10` flat ($1000/mes, org-wide).
//   - Service `combustible-carga-express-mx`:
//       monthly_unit_amount_cents = 45000  ($450/u/mes)
//       setup_unit_amount_cents   = 120000 ($1200/u one-off)
//     + 1 ServiceAddOn `historial-12m` per-unit ($50/u/mes).
//   - 3 units with overlapping intervals for non-trivial proration.

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

  const tax = await prisma.tax.upsert({
    where: { organizationId_code: { organizationId: org.id, code: 'iva-mx-16' } },
    create: {
      organizationId: org.id,
      name: 'IVA México',
      code: 'iva-mx-16',
      description: 'Impuesto al Valor Agregado (México) 16%',
      rate: '16',
    },
    update: {},
  });

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
        billingTime: 'calendar',
        subscriptionAt: periodStartDate,
        startedAt: periodStartDate,
        status: 'active',
        currentBillingPeriodStartedAt: periodStartDate,
        currentBillingPeriodEndingAt: periodEndDate,
      },
    });
    await prisma.customerTaxLink.create({ data: { customerId: customer.id, taxId: tax.id } });
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
        description: 'MX$450/u/mes + setup MX$1200 por instalación',
        currency: 'MXN',
        monthlyUnitAmountCents: 45000,
        setupUnitAmountCents: 120000,
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
