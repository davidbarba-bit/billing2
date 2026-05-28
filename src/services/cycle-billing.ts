// Emisión de cycle invoice — reutilizado por el handler POST /api/v1/invoices
// y por el cron de cierre de ciclo.
//
// Idempotente por (customer_id, period_from, period_to): si ya existe una
// invoice para ese customer cubriendo exactamente ese periodo, devuelve la
// existente con `created: false` en vez de emitir un duplicado. Es lo que
// permite que el cron pueda correr cada minuto sin riesgo de doble facturación.

import type {
  Customer,
  Invoice,
  Organization,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { applicableTimezone } from './tz.js';
import { billingPeriodFor, computeCustomerInvoice, markOneOffBilled, markRemovalsBilled, markSetupsBilled, persistComputedInvoice } from './billing-engine.js';
import type { NetSuiteDispatcher } from './netsuite-dispatcher.js';

export type EmitCycleInvoiceOptions = {
  prisma: PrismaClient;
  dispatcher?: NetSuiteDispatcher;
  callbackBaseUrl?: string;
  org: Organization;
  customer: Customer;
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

// Resuelve el periodo a facturar. Sin override → usa billingPeriodFor
// (canónico, anclado al startOf-day en la tz del customer). Con override →
// respeta start/end tal cual pero calcula daysInPeriod con el MISMO
// bucketing startOf('day' UTC) que usa daysInInterval() en billing-engine.ts
// para que la fracción por unit jamás supere 1.0. Sin esta consistencia,
// un override mid-day produce daysInPeriod = 16 mientras que la fracción
// por unit cuenta 17 días → factor 1.0625 erróneo.
export function resolvePeriod(
  customer: Customer,
  tz: string,
  now: Date,
  periodOverride: { from: Date; to: Date } | null | undefined,
): { start: Date; end: Date; daysInPeriod: number } {
  if (!periodOverride) return billingPeriodFor(customer, tz, now);
  const fromBucket = DateTime.fromJSDate(periodOverride.from, { zone: 'utc' }).startOf('day');
  const toBucket = DateTime.fromJSDate(periodOverride.to, { zone: 'utc' }).plus({ seconds: 1 }).startOf('day');
  const days = Math.max(1, Math.round(toBucket.diff(fromBucket, 'days').days));
  return { start: periodOverride.from, end: periodOverride.to, daysInPeriod: days };
}

export async function emitCycleInvoiceForCustomer(opts: EmitCycleInvoiceOptions): Promise<EmitCycleInvoiceResult> {
  const { prisma, dispatcher, callbackBaseUrl, org, customer, periodOverride, idempotencyKey, metadata, log } = opts;
  const now = opts.now ?? new Date();

  const tz = applicableTimezone(customer.timezone, org.timezone);
  const period = resolvePeriod(customer, tz, now, periodOverride);

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
        include: { units: true, addOns: true },
      },
      addOns: { where: { activeTo: null } },
    },
  });
  if (!fullCustomer) throw new Error(`customer ${customer.id} not found`);

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
    periodStart: period.start,
    periodEnd: period.end,
    daysInPeriod: period.daysInPeriod,
    tz,
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
      if (fee.kind === 'removal' && fee.unitIds.length > 0) await markRemovalsBilled(tx as unknown as PrismaClient, fee.unitIds, now);
    }

    return invoice;
  });

  // Dispatch (best-effort). El cron pasa dispatcher; si no hay, skip.
  if (dispatcher && callbackBaseUrl) {
    try {
      const hydrated = await prisma.invoice.findUnique({
        where: { id: created.id },
        include: { customer: true, fees: true },
      });
      if (hydrated) {
        // Payload a NetSuite: SOLO montos netos (sin IVA). NetSuite calcula
        // los impuestos según la configuración fiscal del cliente.
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
            // v13: handle listo para usar en `entity: { id: ... }` del POST
            // de NetSuite. Si tenemos cacheado el internal id de NetSuite,
            // lo usamos directo (faster path). Si no, mandamos
            // "eid:<external_id>" para que NetSuite resuelva por externalId.
            netsuite_internal_id: hydrated.customer.netsuiteInternalId,
            netsuite_entity_handle: hydrated.customer.netsuiteInternalId
              ? hydrated.customer.netsuiteInternalId
              : `eid:${hydrated.customer.externalId}`,
          },
          billing_period: { from: hydrated.periodFrom, to: hydrated.periodTo },
          lines: hydrated.fees.map((f) => ({
            fee_id: f.id, service_id: f.serviceId,
            service_add_on_id: f.serviceAddOnId, customer_add_on_id: f.customerAddOnId,
            kind: f.kind, description: f.description, units: f.units,
            unit_amount_cents: f.unitAmountCents, amount_cents: f.amountCents,
            // v9: código NetSuite que mapea la línea a un item del catálogo.
            // null si la entidad fuente no tenía código configurado al emitir.
            netsuite_item_code: f.netsuiteItemCode,
            billed_units_detail: f.billedUnitsDetail,
          })),
          units_annex: hydrated.unitsAnnex,
          totals: { fees_amount_cents: hydrated.feesAmountCents },
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

// ---------------------------------------------------------------------------
// Preview / dry-run de la cycle invoice — v7.
//
// Computa exactamente lo que `emitCycleInvoiceForCustomer` produciría
// (mismas fees, mismo units_annex, mismo payload para NetSuite) pero **sin**
// persistir nada: no crea invoice, no crea fees, no marca units como
// facturadas, no incrementa contadores, no dispatcha. Re-ejecutable infinitas
// veces — ideal para iterar precios, units, add-ons y verificar el output
// antes de cerrar el ciclo de verdad.
//
// Parámetros:
//   - periodOverride: forza un periodo arbitrario (default: ciclo vigente
//     calculado con billingPeriodFor(reference=now)).
//   - now: simula "qué pasaría si hoy fuera X". Si no hay periodOverride,
//     se usa como reference para billingPeriodFor (te permite previsualizar
//     el ciclo que cerrará el día 1 del próximo mes). También se usa para
//     resolver el precio efectivo en pings one_off + immediate.
// ---------------------------------------------------------------------------

export type PreviewCycleInvoiceOptions = {
  prisma: PrismaClient;
  org: Organization;
  customer: Customer;
  periodOverride?: { from: Date; to: Date } | null;
  now?: Date;
};

export type PreviewCycleInvoiceResult = {
  period: { from: Date; to: Date; days_in_period: number };
  reference_now: Date;
  fees: Array<{
    kind: string;
    description: string;
    units: string;
    unit_amount_cents: number;
    precise_unit_amount: string;
    amount_cents: number;
    service_id: string | null;
    service_add_on_id: string | null;
    customer_add_on_id: string | null;
    netsuite_item_code: string | null;
    billed_units_detail: unknown;
  }>;
  fees_amount_cents: number;
  units_annex: unknown;
  netsuite_payload: {
    external_id: null;
    minilago_invoice_id: null;
    issued_at: string;
    currency: string;
    customer: {
      external_id: string;
      name: string;
      tax_identification_number: string | null;
      country: string | null;
      netsuite_internal_id: string | null;
      netsuite_entity_handle: string;
    };
    billing_period: { from: Date; to: Date };
    lines: Array<{
      fee_id: null;
      service_id: string | null;
      service_add_on_id: string | null;
      customer_add_on_id: string | null;
      kind: string;
      description: string;
      units: string;
      unit_amount_cents: number;
      amount_cents: number;
      netsuite_item_code: string | null;
      billed_units_detail: unknown;
    }>;
    units_annex: unknown;
    totals: { fees_amount_cents: number };
  };
};

export async function previewCycleInvoiceForCustomer(
  opts: PreviewCycleInvoiceOptions,
): Promise<PreviewCycleInvoiceResult> {
  const { prisma, org, customer, periodOverride } = opts;
  const now = opts.now ?? new Date();

  const tz = applicableTimezone(customer.timezone, org.timezone);
  const period = resolvePeriod(customer, tz, now, periodOverride);

  const fullCustomer = await prisma.customer.findUnique({
    where: { id: customer.id },
    include: {
      services: {
        where: { status: 'active' },
        include: { units: true, addOns: true },
      },
    },
  });
  if (!fullCustomer) throw new Error(`customer ${customer.id} not found`);

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
    periodStart: period.start,
    periodEnd: period.end,
    daysInPeriod: period.daysInPeriod,
    tz,
  });

  return {
    period: { from: period.start, to: period.end, days_in_period: period.daysInPeriod },
    reference_now: now,
    fees: computed.fees.map((f) => ({
      kind: f.kind,
      description: f.description,
      units: f.units,
      unit_amount_cents: f.unitAmountCents,
      precise_unit_amount: f.preciseUnitAmount,
      amount_cents: f.amountCents,
      service_id: f.serviceId ?? null,
      service_add_on_id: f.serviceAddOnId ?? null,
      customer_add_on_id: f.customerAddOnId ?? null,
      netsuite_item_code: f.netsuiteItemCode,
      billed_units_detail: f.billedUnitsDetail,
    })),
    fees_amount_cents: computed.feesAmountCents,
    units_annex: computed.unitsAnnex,
    netsuite_payload: {
      external_id: null,
      minilago_invoice_id: null,
      issued_at: now.toISOString(),
      currency: customer.currency,
      customer: {
        external_id: customer.externalId,
        name: customer.name,
        tax_identification_number: customer.taxIdentificationNumber,
        country: customer.country,
        netsuite_internal_id: customer.netsuiteInternalId,
        netsuite_entity_handle: customer.netsuiteInternalId
          ? customer.netsuiteInternalId
          : `eid:${customer.externalId}`,
      },
      billing_period: { from: period.start, to: period.end },
      lines: computed.fees.map((f) => ({
        fee_id: null,
        service_id: f.serviceId ?? null,
        service_add_on_id: f.serviceAddOnId ?? null,
        customer_add_on_id: f.customerAddOnId ?? null,
        kind: f.kind,
        description: f.description,
        units: f.units,
        unit_amount_cents: f.unitAmountCents,
        amount_cents: f.amountCents,
        netsuite_item_code: f.netsuiteItemCode,
        billed_units_detail: f.billedUnitsDetail,
      })),
      units_annex: computed.unitsAnnex,
      totals: { fees_amount_cents: computed.feesAmountCents },
    },
  };
}
