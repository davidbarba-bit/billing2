// Crea un cliente con su configuración completa de facturación (ciclo, día
// de corte, moneda, timezone, etc.) directo en BD.
//
// Se usa desde el admin UI (POST /admin/customers/new) y desde los tests.
// El API público (POST /api/v1/customers) intencionalmente NO acepta esa
// configuración — el integrador externo solo proporciona datos comerciales
// (external_id, name, email, phone). La configuración de facturación la
// administra el equipo Numaris desde el admin, que es precisamente este
// flujo.

import type { Organization, Prisma, PrismaClient } from '@prisma/client';
import { buildCustomerSlug, slugifyName } from './slug.js';
import { applicableTimezone } from './tz.js';
import { billingPeriodFor } from './billing-engine.js';

export type CreateCustomerFullInput = {
  // ID interno del cliente en Numaris Billing (API, URLs del admin). Si se
  // omite, se genera un slug único a partir del nombre. NO viaja a NetSuite —
  // la referencia externa vive en la razón social.
  externalId?: string;
  // Identificador externo de la razón social default (el que se envía a
  // NetSuite como external id del customer). Default: el externalId del
  // cliente, editable después en el admin.
  defaultTaxEntityExternalId?: string | null;
  name: string;
  email?: string | null;
  phone?: string | null;
  currency?: string;
  timezone?: string | null;
  billingPeriodMonths?: number;
  billingAnchorDay?: number;
  billingAnchorMonth?: number | null;
  nonrecurringTrigger?: 'immediate' | 'next_cycle';
  cycleInvoiceMode?: 'unified' | 'split_by_kind';
  subscriptionAt?: Date;
  metadata?: Prisma.InputJsonValue;
};

export type CreateCustomerFullResult = { id: string; externalId: string };

export async function createCustomerFull(
  prisma: PrismaClient,
  org: Organization,
  input: CreateCustomerFullInput,
): Promise<CreateCustomerFullResult> {
  const subscriptionAt = input.subscriptionAt ?? new Date();
  const now = new Date();
  const isFuture = subscriptionAt.getTime() > now.getTime();
  const status = isFuture ? 'pending' : 'active';
  const startedAt = isFuture ? null : subscriptionAt;
  const tz = applicableTimezone(input.timezone ?? null, org.timezone);
  const billingPeriodMonths = input.billingPeriodMonths ?? 1;
  const billingAnchorDay = input.billingAnchorDay ?? 1;
  const billingAnchorMonth = input.billingAnchorMonth ?? null;

  const tempForPeriod = {
    billingPeriodMonths,
    billingAnchorDay,
    billingAnchorMonth,
    subscriptionAt,
  } as unknown as import('@prisma/client').Customer;
  const period = isFuture ? null : billingPeriodFor(tempForPeriod, tz, now);

  // Sin externalId explícito, se genera un slug único a partir del nombre
  // (aditivos-y-vitaminas, aditivos-y-vitaminas-2, ...).
  let externalId = input.externalId;
  if (!externalId) {
    const base = slugifyName(input.name);
    externalId = base;
    for (let n = 2; ; n += 1) {
      // El slug también sirve de externalId para la razón social default
      // (unique por organización), así que debe estar libre en ambas tablas.
      const [clashCustomer, clashTaxEntity] = await Promise.all([
        prisma.customer.findUnique({
          where: { organizationId_externalId: { organizationId: org.id, externalId } },
          select: { id: true },
        }),
        prisma.taxEntity.findUnique({
          where: { organizationId_externalId: { organizationId: org.id, externalId } },
          select: { id: true },
        }),
      ]);
      if (!clashCustomer && (!clashTaxEntity || input.defaultTaxEntityExternalId)) break;
      externalId = `${base}-${n}`;
    }
  }

  return prisma.$transaction(async (tx) => {
    const orgUpdated = await tx.organization.update({
      where: { id: org.id },
      data: { customerCounter: { increment: 1 } },
      select: { customerCounter: true, slug: true },
    });
    const sequentialId = orgUpdated.customerCounter;
    const created = await tx.customer.create({
      data: {
        organizationId: org.id,
        externalId,
        sequentialId,
        slug: buildCustomerSlug(orgUpdated.slug, sequentialId),
        name: input.name,
        email: input.email ?? null,
        phone: input.phone ?? null,
        currency: input.currency ?? 'MXN',
        timezone: input.timezone ?? null,
        billingPeriodMonths,
        billingAnchorDay,
        billingAnchorMonth,
        nonrecurringTrigger: input.nonrecurringTrigger ?? 'next_cycle',
        cycleInvoiceMode: input.cycleInvoiceMode ?? 'unified',
        subscriptionAt,
        startedAt,
        status,
        currentBillingPeriodStartedAt: isFuture ? null : startedAt,
        currentBillingPeriodEndingAt: period?.end ?? null,
        metadata: input.metadata ?? {},
      },
    });
    // Toda alta de cliente arranca con una razón social default. La identidad
    // fiscal se completa después en el admin (RFC, dirección, NetSuite).
    await tx.taxEntity.create({
      data: {
        organizationId: org.id,
        customerId: created.id,
        externalId: input.defaultTaxEntityExternalId ?? created.externalId,
        legalName: created.name,
        isDefault: true,
        active: true,
      },
    });
    return { id: created.id, externalId: created.externalId };
  });
}
