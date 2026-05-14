// Seed Numaris scenario for the v2 model.
//
// Creates:
//   - IVA MX 16% tax.
//   - Customer `carga-express-mx` (CDMX timezone) with the tax applied.
//   - Service `combustible-carga-express-mx`:
//       monthly_unit_amount_cents = 45000  (MX$450.00 por unidad activa)
//       setup_unit_amount_cents   = 120000 (MX$1200.00 por instalación)
//       billing_time              = "calendar"
//   - 3 units with overlapping intervals so proration is non-trivial:
//       - camion-001: full month → 1.0000
//       - camion-002: added mid-period → ~0.61
//       - camion-003: removed near end → ~0.93
//   - 1 unit (camion-002) with setup_billed_at = null → next invoice
//     includes a one-off setup fee.

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
      },
    });
    await prisma.customerTaxLink.create({ data: { customerId: customer.id, taxId: tax.id } });
  }

  const now = DateTime.now().setZone(tz);
  const periodStart = now.startOf('month');
  const periodEnd = periodStart.plus({ months: 1 }).minus({ seconds: 1 });

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
        description: 'MX$450.00 por unidad activa / mes + setup MX$1200.00 por instalación',
        currency: 'MXN',
        monthlyUnitAmountCents: 45000,
        setupUnitAmountCents: 120000,
        status: 'active',
        billingTime: 'calendar',
        subscriptionAt: periodStart.toUTC().toJSDate(),
        startedAt: periodStart.toUTC().toJSDate(),
        currentBillingPeriodStartedAt: periodStart.toUTC().toJSDate(),
        currentBillingPeriodEndingAt: periodEnd.toUTC().toJSDate(),
      },
    });
  }

  // Build 3 unidades materializadas, con timestamps que rinden prorrateo
  // no-trivial. camion-002 keeps `setup_billed_at: null` so the next
  // invoice picks up its setup fee.
  const startMs = periodStart.toUTC().toJSDate().getTime();
  const endMs = periodEnd.toUTC().toJSDate().getTime();
  const length = endMs - startMs;
  const midPeriod = new Date(startMs + Math.floor(length * 12 / 31));
  const lateExit = new Date(startMs + Math.floor(length * 30 / 31));

  const unitsData: Array<{
    externalId: string;
    label: string;
    activeFrom: Date;
    activeTo: Date | null;
    setupBilledAt: Date | null;
  }> = [
    {
      externalId: 'unit-camion-001',
      label: 'Camión 001 — Placas ABC-123',
      activeFrom: periodStart.toUTC().toJSDate(),
      activeTo: null,
      setupBilledAt: new Date(periodStart.toUTC().toJSDate().getTime() - 86400_000), // ya cobrado antes
    },
    {
      externalId: 'unit-camion-002',
      label: 'Camión 002 — Placas DEF-456',
      activeFrom: midPeriod,
      activeTo: null,
      setupBilledAt: null, // setup pendiente — saldrá en próxima factura
    },
    {
      externalId: 'unit-camion-003',
      label: 'Camión 003 — Placas GHI-789',
      activeFrom: new Date(periodStart.toUTC().toJSDate().getTime() - 30 * 86400_000),
      activeTo: lateExit,
      setupBilledAt: new Date(periodStart.toUTC().toJSDate().getTime() - 60 * 86400_000),
    },
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
    // Audit event corresponding to the alta.
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
