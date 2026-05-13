// "Seed Numaris" — recreates the scenario described in the spec:
//
//   - Tax IVA México 16%.
//   - Customer `carga-express-mx` (CDMX timezone).
//   - Billable metrics: monthly recurring + setup non-recurring.
//   - Plan `Combustible (carga-express-mx)` with two charges.
//   - Subscription `sub-carga-express-mx-combustible` calendar.
//   - Add-ons `cobro-carga-express-mx-combustible` + `setup-carga-express-mx-combustible`.
//   - Events: 3 trucks with overlapping/partial intervals so proration
//     produces non-trivial fractions:
//       * camion-001 added at period start, still active → 1.0000.
//       * camion-002 added mid-period (day 13) → partial fraction.
//       * camion-003 was active before period, removed at period end → partial fraction.

import type { Organization, PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';

export type SeedSummary = {
  customerId: string;
  customerExternalId: string;
  subscriptionId: string;
  subscriptionExternalId: string;
  invoiceCandidate: {
    monthlyAddOnCode: string;
    setupAddOnCode: string;
  };
  eventsCreated: number;
};

export async function seedNumaris(prisma: PrismaClient, org: Organization): Promise<SeedSummary> {
  const tz = org.timezone ?? 'America/Mexico_City';

  // Ensure the org has a NetSuite callback secret so the admin's
  // "simulate folio" action can sign the synthetic callback.
  if (!org.netsuiteCallbackSecret) {
    await prisma.organization.update({
      where: { id: org.id },
      data: { netsuiteCallbackSecret: 'dev-callback-secret-replace-me' },
    });
  }

  // Tax.
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

  // Customer.
  const existingCustomer = await prisma.customer.findUnique({
    where: { organizationId_externalId: { organizationId: org.id, externalId: 'carga-express-mx' } },
  });
  let customer = existingCustomer;
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

  // BMs.
  const bmMonthly = await prisma.billableMetric.upsert({
    where: { organizationId_code: { organizationId: org.id, code: 'bm-carga-express-mx-combustible' } },
    create: {
      organizationId: org.id,
      name: 'Unidades activas — Combustible',
      code: 'bm-carga-express-mx-combustible',
      aggregationType: 'unique_count_agg',
      fieldName: 'unit_external_id',
      recurring: true,
    },
    update: {},
  });
  const bmSetup = await prisma.billableMetric.upsert({
    where: { organizationId_code: { organizationId: org.id, code: 'bm-setup-carga-express-mx-combustible' } },
    create: {
      organizationId: org.id,
      name: 'Instalaciones nuevas — Combustible',
      code: 'bm-setup-carga-express-mx-combustible',
      aggregationType: 'unique_count_agg',
      fieldName: 'unit_external_id',
      recurring: false,
    },
    update: {},
  });

  // Plan.
  let plan = await prisma.plan.findUnique({
    where: { organizationId_code: { organizationId: org.id, code: 'plan-carga-express-mx-combustible' } },
  });
  if (!plan) {
    plan = await prisma.plan.create({
      data: {
        organizationId: org.id,
        name: 'Combustible (carga-express-mx)',
        code: 'plan-carga-express-mx-combustible',
        interval: 'monthly',
        amountCents: 0,
        amountCurrency: 'MXN',
        description: 'Servicio Combustible — MX$450.00 por unidad activa / mes + setup MX$1200.00 por instalación',
        billChargesMonthly: null,
      },
    });
    await prisma.charge.create({
      data: {
        planId: plan.id,
        billableMetricId: bmMonthly.id,
        chargeModel: 'standard',
        invoiceable: true,
        prorated: true,
        invoiceDisplayName: 'Servicio Combustible',
        properties: { amount: '450.00' },
      },
    });
    await prisma.charge.create({
      data: {
        planId: plan.id,
        billableMetricId: bmSetup.id,
        chargeModel: 'standard',
        invoiceable: true,
        prorated: false,
        invoiceDisplayName: 'Setup Combustible',
        properties: { amount: '1200.00' },
      },
    });
  }

  // Subscription.
  let subscription = await prisma.subscription.findUnique({
    where: {
      organizationId_externalId: {
        organizationId: org.id,
        externalId: 'sub-carga-express-mx-combustible',
      },
    },
  });
  if (!subscription) {
    const now = DateTime.now().setZone(tz);
    const periodStart = now.startOf('month');
    const periodEnd = periodStart.plus({ months: 1 }).minus({ seconds: 1 });
    subscription = await prisma.subscription.create({
      data: {
        organizationId: org.id,
        customerId: customer.id,
        planId: plan.id,
        externalId: 'sub-carga-express-mx-combustible',
        name: 'Servicio Combustible',
        status: 'active',
        billingTime: 'calendar',
        subscriptionAt: periodStart.toUTC().toJSDate(),
        startedAt: periodStart.toUTC().toJSDate(),
        currentBillingPeriodStartedAt: periodStart.toUTC().toJSDate(),
        currentBillingPeriodEndingAt: periodEnd.toUTC().toJSDate(),
      },
    });
  }

  // Add-ons.
  await prisma.addOn.upsert({
    where: { organizationId_code: { organizationId: org.id, code: 'cobro-carga-express-mx-combustible' } },
    create: {
      organizationId: org.id,
      name: 'Cobro mensual Servicio Combustible — Carga Express MX',
      code: 'cobro-carga-express-mx-combustible',
      description: 'Línea de factura mensual del servicio Combustible (qty × precio unitario) para Carga Express MX.',
      amountCents: 45000,
      amountCurrency: 'MXN',
    },
    update: {},
  });
  await prisma.addOn.upsert({
    where: { organizationId_code: { organizationId: org.id, code: 'setup-carga-express-mx-combustible' } },
    create: {
      organizationId: org.id,
      name: 'Setup Servicio Combustible — Carga Express MX',
      code: 'setup-carga-express-mx-combustible',
      description: 'Cobro one-off de instalación / setup del servicio Combustible para Carga Express MX.',
      amountCents: 120000,
      amountCurrency: 'MXN',
    },
    update: {},
  });

  // Events for 3 trucks.
  const periodStartMs = subscription.currentBillingPeriodStartedAt!.getTime();
  const periodEndMs = subscription.currentBillingPeriodEndingAt!.getTime();
  const periodLengthMs = periodEndMs - periodStartMs;
  const midPeriod = new Date(periodStartMs + Math.floor(periodLengthMs * 12 / 31));
  const lateExit = new Date(periodStartMs + Math.floor(periodLengthMs * 30 / 31));

  const eventsData: Array<{
    transactionId: string;
    timestamp: Date;
    unitId: string;
    unitLabel: string;
    op: 'add' | 'remove';
    kind: string;
  }> = [
    // Camión 001: active full month.
    {
      transactionId: 'seed-cam-001-add',
      timestamp: new Date(periodStartMs + 1000),
      unitId: 'unit-camion-001',
      unitLabel: 'Camión 001 — Placas ABC-123',
      op: 'add',
      kind: 'monthly-ping',
    },
    // Camión 002: added mid-period.
    {
      transactionId: 'seed-cam-002-add',
      timestamp: midPeriod,
      unitId: 'unit-camion-002',
      unitLabel: 'Camión 002 — Placas DEF-456',
      op: 'add',
      kind: 'monthly-ping',
    },
    // Camión 002 setup (one-off).
    {
      transactionId: 'seed-cam-002-setup',
      timestamp: midPeriod,
      unitId: 'unit-camion-002',
      unitLabel: 'Camión 002 — Placas DEF-456',
      op: 'add',
      kind: 'setup',
    },
    // Camión 003: added before period, removed late.
    {
      transactionId: 'seed-cam-003-add',
      timestamp: new Date(periodStartMs - 30 * 86_400_000),
      unitId: 'unit-camion-003',
      unitLabel: 'Camión 003 — Placas GHI-789',
      op: 'add',
      kind: 'monthly-ping',
    },
    {
      transactionId: 'seed-cam-003-remove',
      timestamp: lateExit,
      unitId: 'unit-camion-003',
      unitLabel: 'Camión 003 — Placas GHI-789',
      op: 'remove',
      kind: 'monthly-remove',
    },
  ];

  let created = 0;
  for (const ev of eventsData) {
    const isSetup = ev.kind === 'setup';
    const code = isSetup ? bmSetup.code : bmMonthly.code;
    const bmId = isSetup ? bmSetup.id : bmMonthly.id;
    const existing = await prisma.event.findUnique({
      where: { organizationId_transactionId: { organizationId: org.id, transactionId: ev.transactionId } },
    });
    if (existing) continue;
    await prisma.event.create({
      data: {
        organizationId: org.id,
        transactionId: ev.transactionId,
        externalSubscriptionId: subscription.externalId,
        subscriptionId: subscription.id,
        billableMetricId: bmId,
        code,
        timestamp: ev.timestamp,
        properties: {
          unit_external_id: ev.unitId,
          unit_label: ev.unitLabel,
          kind: ev.kind,
          operation_type: ev.op,
        } as object,
      },
    });
    await prisma.unitLabel.upsert({
      where: {
        customerId_externalSubscriptionId_unitExternalId: {
          customerId: customer.id,
          externalSubscriptionId: subscription.externalId,
          unitExternalId: ev.unitId,
        },
      },
      create: {
        customerId: customer.id,
        externalSubscriptionId: subscription.externalId,
        unitExternalId: ev.unitId,
        label: ev.unitLabel,
      },
      update: { label: ev.unitLabel },
    });
    created += 1;
  }

  return {
    customerId: customer.id,
    customerExternalId: customer.externalId,
    subscriptionId: subscription.id,
    subscriptionExternalId: subscription.externalId,
    invoiceCandidate: {
      monthlyAddOnCode: 'cobro-carga-express-mx-combustible',
      setupAddOnCode: 'setup-carga-express-mx-combustible',
    },
    eventsCreated: created,
  };
}
