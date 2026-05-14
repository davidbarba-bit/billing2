// Emisión de cycle invoice — reutilizado por el handler POST /api/v1/invoices
// y por el cron de cierre de ciclo.
//
// Idempotente por (customer_id, period_from, period_to): si ya existe una
// invoice para ese customer cubriendo exactamente ese periodo, devuelve la
// existente con `created: false` en vez de emitir un duplicado. Es lo que
// permite que el cron pueda correr cada minuto sin riesgo de doble facturación.

import type { Decimal } from '@prisma/client/runtime/library';
import type {
  Customer,
  Invoice,
  Organization,
  Prisma,
  PrismaClient,
  Tax,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { applicableTimezone } from './tz.js';
import { billingPeriodFor, computeCustomerInvoice, markOneOffBilled, markSetupsBilled, persistComputedInvoice } from './billing-engine.js';
import type { NetSuiteDispatcher } from './netsuite-dispatcher.js';

export type EmitCycleInvoiceOptions = {
  prisma: PrismaClient;
  dispatcher?: NetSuiteDispatcher;
  callbackBaseUrl?: string;
  org: Organization;
  customer: Customer & { taxLinks: Array<{ tax: Tax }> };
  // Sobreescribe el periodo (override manual). Si se omite, usa el periodo
  // vigente del customer (calculado con billingPeriodFor).
  periodOverride?: { from: Date; to: Date } | null;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  log?: { error: (data: unknown, msg?: string) => void };
  now?: Date;
};

export type EmitCycleInvoiceResult = {
  invoice: Invoice;
  created: boolean;
};

export async function emitCycleInvoiceForCustomer(opts: EmitCycleInvoiceOptions): Promise<EmitCycleInvoiceResult> {
  const { prisma, dispatcher, callbackBaseUrl, org, customer, periodOverride, idempotencyKey, metadata, log } = opts;
  const now = opts.now ?? new Date();

  const tz = applicableTimezone(customer.timezone, org.timezone);
  const period = periodOverride
    ? {
        start: periodOverride.from,
        end: periodOverride.to,
        daysInPeriod: Math.max(1, Math.round(
          DateTime.fromJSDate(periodOverride.to, { zone: 'utc' }).plus({ seconds: 1 })
            .diff(DateTime.fromJSDate(periodOverride.from, { zone: 'utc' }), 'days').days,
        )),
      }
    : billingPeriodFor(customer, tz, now);

  // Idempotencia: si ya hay invoice del customer para este periodo, no
  // emitas otra. Permite que el cron sea seguro de re-correr.
  const existing = await prisma.invoice.findFirst({
    where: {
      customerId: customer.id,
      periodFrom: period.start,
      periodTo: period.end,
    },
  });
  if (existing) return { invoice: existing, created: false };

  const fullCustomer = await prisma.customer.findUnique({
    where: { id: customer.id },
    include: {
      services: {
        where: { status: 'active' },
        include: { units: true, addOns: true, taxLinks: { include: { tax: true } } },
      },
      addOns: { where: { activeTo: null } },
    },
  });
  if (!fullCustomer) throw new Error(`customer ${customer.id} not found`);

  const taxes = customer.taxLinks.map((l) => l.tax);
  const customerAddOns = await prisma.customerAddOn.findMany({
    where: {
      customerId: customer.id,
      activeFrom: { lte: period.end },
      OR: [{ activeTo: null }, { activeTo: { gte: period.start } }],
    },
  });

  const computed = computeCustomerInvoice({
    customer,
    services: fullCustomer.services,
    customerAddOns,
    taxes,
    periodStart: period.start,
    periodEnd: period.end,
    daysInPeriod: period.daysInPeriod,
  });

  const issuingDate = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(tz).startOf('day').toUTC().toJSDate();

  const created = await prisma.$transaction(async (tx) => {
    const orgUpdate = await tx.organization.update({
      where: { id: org.id },
      data: { invoiceCounter: { increment: 1 } },
      select: { invoiceCounter: true },
    });
    const sequentialId = orgUpdate.invoiceCounter;
    const invoice = await tx.invoice.create({
      data: {
        organizationId: org.id,
        customerId: customer.id,
        sequentialId,
        currency: customer.currency,
        status: 'calculated',
        externalDispatchStatus: 'pending',
        paymentStatus: 'pending',
        issuingDate,
        paymentDueDate: issuingDate,
        feesAmountCents: computed.feesAmountCents,
        taxesAmountCents: computed.taxesAmountCents,
        totalAmountCents: computed.totalAmountCents,
        periodFrom: period.start,
        periodTo: period.end,
        unitsAnnex: computed.unitsAnnex as object,
        metadata: { ...(metadata ?? {}), ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) } as object,
        idempotencyKey: idempotencyKey ?? null,
      },
    });

    await persistComputedInvoice(tx, invoice.id, computed);

    for (const fee of computed.fees) {
      if (fee.kind === 'setup' && fee.unitIds.length > 0) await markSetupsBilled(tx as unknown as PrismaClient, fee.unitIds, now);
      if (fee.kind === 'one_off' && fee.unitIds.length > 0) await markOneOffBilled(tx as unknown as PrismaClient, fee.unitIds, now);
    }

    for (const { tax, amountCents } of computed.appliedTaxes) {
      await tx.appliedTax.create({
        data: {
          invoiceId: invoice.id,
          taxId: tax.id,
          taxName: tax.name,
          taxCode: tax.code,
          taxRate: tax.rate as unknown as Decimal,
          taxDescription: tax.description,
          amountCents,
          amountCurrency: customer.currency,
          feesAmountCents: computed.feesAmountCents,
        },
      });
    }

    return invoice;
  });

  // Dispatch (best-effort). El cron pasa dispatcher; si no hay, skip.
  if (dispatcher && callbackBaseUrl) {
    try {
      const hydrated = await prisma.invoice.findUnique({
        where: { id: created.id },
        include: {
          customer: { include: { organization: true, taxLinks: { include: { tax: true } } } },
          fees: true,
        },
      });
      if (hydrated) {
        const dispatchPayload = {
          external_id: hydrated.id,
          minilago_invoice_id: hydrated.id,
          issued_at: hydrated.createdAt.toISOString(),
          currency: hydrated.currency,
          customer: {
            external_id: hydrated.customer.externalId,
            name: hydrated.customer.name,
            tax_identification_number: hydrated.customer.taxIdentificationNumber,
            country: hydrated.customer.country,
            tax_codes: hydrated.customer.taxLinks.map((l) => l.tax.code),
          },
          billing_period: { from: hydrated.periodFrom, to: hydrated.periodTo },
          lines: hydrated.fees.map((f) => ({
            fee_id: f.id, service_id: f.serviceId,
            service_add_on_id: f.serviceAddOnId, customer_add_on_id: f.customerAddOnId,
            kind: f.kind, description: f.description, units: f.units,
            unit_amount_cents: f.unitAmountCents, amount_cents: f.amountCents,
            taxes_amount_cents: f.taxesAmountCents, total_amount_cents: f.totalAmountCents,
            billed_units_detail: f.billedUnitsDetail,
          })),
          units_annex: hydrated.unitsAnnex,
          totals: {
            fees_amount_cents: hydrated.feesAmountCents,
            taxes_amount_cents: hydrated.taxesAmountCents,
            total_amount_cents: hydrated.totalAmountCents,
          },
          metadata: hydrated.metadata ?? {},
          callback_url: `${callbackBaseUrl}/api/v1/invoices/${hydrated.id}/external-confirm`,
        };
        const result = await dispatcher.dispatch(org, dispatchPayload, 'invoice');
        await prisma.invoice.update({
          where: { id: hydrated.id },
          data: result.status === 'accepted'
            ? { externalDispatchStatus: 'dispatched', netsuiteDispatchId: result.netsuiteInternalId ?? null }
            : { externalDispatchStatus: 'failed', externalDispatchError: result.error ?? 'dispatch_failed' },
        });
      }
    } catch (err) {
      log?.error({ err }, 'cycle invoice dispatch failed');
      await prisma.invoice.update({
        where: { id: created.id },
        data: { externalDispatchStatus: 'failed', externalDispatchError: err instanceof Error ? err.message : String(err) },
      }).catch(() => undefined);
    }
  }

  const final = await prisma.invoice.findUniqueOrThrow({ where: { id: created.id } });
  return { invoice: final, created: true };
}

// Helper para avanzar el periodo del customer al siguiente ciclo después de
// haber emitido la cycle invoice del actual. Usado por el cron.
//
// El siguiente periodo empieza 1 segundo después del fin del actual (que
// suele ser X 23:59:59) → X+1 00:00:00, alineado por construcción. Eso es
// más simple y robusto que re-llamar billingPeriodFor (que requiere
// reference dentro del nuevo periodo en su tz, y eso confunde con offsets).
export async function rollCustomerPeriodForward(
  prisma: PrismaClient,
  customer: Customer,
  _tz: string,
): Promise<void> {
  if (!customer.currentBillingPeriodEndingAt) return;
  const nextStart = new Date(customer.currentBillingPeriodEndingAt.getTime() + 1000);
  const nextEnd = DateTime.fromJSDate(nextStart, { zone: 'utc' })
    .plus({ months: customer.billingPeriodMonths })
    .minus({ seconds: 1 })
    .toUTC()
    .toJSDate();
  await prisma.customer.update({
    where: { id: customer.id },
    data: {
      currentBillingPeriodStartedAt: nextStart,
      currentBillingPeriodEndingAt: nextEnd,
    },
  });
}

export async function activatePendingCustomerInline(
  prisma: PrismaClient,
  customer: Customer,
  tz: string,
  now: Date = new Date(),
): Promise<void> {
  if (customer.status !== 'pending' || customer.subscriptionAt > now) return;
  const period = billingPeriodFor(customer, tz, now);
  await prisma.customer.update({
    where: { id: customer.id },
    data: {
      status: 'active',
      startedAt: customer.subscriptionAt,
      currentBillingPeriodStartedAt: customer.subscriptionAt,
      currentBillingPeriodEndingAt: period.end,
    },
  });
}

// Helper para que el cron pueda usar Prisma transaction-style markings.
export type Tx = Prisma.TransactionClient;
