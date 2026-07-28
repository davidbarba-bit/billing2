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
import {
  billingPeriodFor,
  computeCustomerInvoice,
  markOneOffBilled,
  markRemovalsBilled,
  markSetupsBilled,
  persistComputedInvoice,
  splitComputedInvoiceByKind,
  splitComputedInvoiceByTaxEntity,
  type ComputedInvoice,
  type CycleInvoiceKind,
} from './billing-engine.js';
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
  // v19: si el customer está en modo 'split_by_kind' el cierre de ciclo puede
  // generar hasta 2 invoices (una recurrente y una de únicos). En modo 'unified'
  // (default) siempre 1. Si no hay nada que cobrar, array vacío.
  invoices: Invoice[];
  // true si AL MENOS una invoice fue creada en este call; false si todas las
  // que debían emitirse ya existían (idempotency hit).
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

  // v21: agrega ocurrencias del catálogo de eventos pendientes (billing_mode=
  // 'next_cycle') que cayeron dentro o antes del fin de periodo. Se anexan
  // como fees kind='catalog_event'; classifyFee() las clasifica como 'oneoff'
  // para el modo split_by_kind.
  const pendingOccurrences = await prisma.catalogEventOccurrence.findMany({
    where: {
      customerId: customer.id,
      billingMode: 'next_cycle',
      feeId: null,
      occurredAt: { lte: period.end },
    },
    include: { catalogEvent: true },
    orderBy: { occurredAt: 'asc' },
  });
  for (const occ of pendingOccurrences) {
    const descParts = [occ.catalogEvent.name];
    if (occ.unitExternalId) descParts.push(occ.unitExternalId);
    if (occ.reference) descParts.push(`(${occ.reference})`);
    computed.fees.push({
      kind: 'catalog_event',
      catalogEventOccurrenceId: occ.id,
      description: descParts.join(' — '),
      units: '1.0000',
      unitAmountCents: occ.amountCents,
      preciseUnitAmount: (occ.amountCents / 100).toFixed(2),
      amountCents: occ.amountCents,
      netsuiteItemCode: occ.catalogEvent.netsuiteItemCode,
      billedUnitsDetail: [],
      unitIds: [],
    });
    computed.feesAmountCents += occ.amountCents;
  }

  // v22: primero partimos las fees por razón social (una factura por RFC); luego
  // dentro de cada grupo aplicamos el split_by_kind de v19 si el customer lo pide.
  // Resultado: hasta N razones × 2 splits invoices por ciclo (siempre con N≥1).
  const lookups = {
    serviceToTaxEntity: new Map(fullCustomer.services.map((s) => [s.id, s.taxEntityId])),
    customerAddOnToTaxEntity: new Map(customerAddOns.map((a) => [a.id, a.taxEntityId])),
    catalogOccurrenceToTaxEntity: new Map(pendingOccurrences.map((o) => [o.id, o.taxEntityId])),
  };
  const taxEntityGroups = computed.fees.length === 0
    ? []
    : splitComputedInvoiceByTaxEntity(computed, lookups);

  type CycleSplit = {
    taxEntityId: string;
    kind: 'unified' | CycleInvoiceKind;
    invoice: ComputedInvoice;
  };
  const splits: CycleSplit[] = [];
  for (const group of taxEntityGroups) {
    if (customer.cycleInvoiceMode === 'split_by_kind') {
      for (const sub of splitComputedInvoiceByKind(group.invoice)) {
        splits.push({ taxEntityId: group.taxEntityId, kind: sub.kind, invoice: sub.invoice });
      }
    } else {
      splits.push({ taxEntityId: group.taxEntityId, kind: 'unified', invoice: group.invoice });
    }
  }

  if (splits.length === 0) {
    // Nada que cobrar este ciclo — devolvemos array vacío. El cron lo interpreta
    // como "skip" (no como duplicado).
    return { invoices: [], created: false };
  }

  const issuingDate = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(tz).startOf('day').toUTC().toJSDate();
  const emittedInvoices: Invoice[] = [];
  const newlyCreatedIds = new Set<string>();
  let anyCreated = false;

  // Multi-razón / multi-kind: cada invoice del ciclo tiene un idempotency key
  // determinístico. Cuando el caller pasa un key explícito le colgamos sufijo
  // por razón social y/o por kind para que dos calls del mismo ciclo no
  // generen >1 invoice por (razón, kind). Si NO pasa key (uso interno del
  // cron), construimos uno desde (customerId, taxEntityId, periodEnd, kind).
  const needsTeSuffix = taxEntityGroups.length > 1;
  const needsKindSuffix = customer.cycleInvoiceMode === 'split_by_kind';
  for (const split of splits) {
    const baseKey = idempotencyKey ?? `cycle:${customer.id}:${period.end.getTime()}`;
    const subKey = [
      baseKey,
      needsTeSuffix ? `te:${split.taxEntityId}` : null,
      needsKindSuffix ? split.kind : null,
    ].filter(Boolean).join(':');

    const existing = await prisma.invoice.findFirst({
      where: { organizationId: org.id, idempotencyKey: subKey },
    });
    if (existing) {
      emittedInvoices.push(existing);
      continue;
    }

    const created = await prisma.$transaction(async (tx) => {
      const orgUpdate = await tx.organization.update({
        where: { id: org.id },
        data: { invoiceCounter: { increment: 1 } },
        select: { invoiceCounter: true },
      });
      const invoice = await tx.invoice.create({
        data: {
          organizationId: org.id,
          customerId: customer.id,
          taxEntityId: split.taxEntityId,
          sequentialId: orgUpdate.invoiceCounter,
          currency: customer.currency,
          status: 'calculated',
          externalDispatchStatus: 'pending',
          paymentStatus: 'pending',
          issuingDate,
          paymentDueDate: issuingDate,
          feesAmountCents: split.invoice.feesAmountCents,
          periodFrom: period.start,
          periodTo: period.end,
          unitsAnnex: split.invoice.unitsAnnex as object,
          metadata: {
            ...(metadata ?? {}),
            // 'unified' = 1 invoice con todo de esa razón social; 'recurring'/
            // 'oneoff' = sub-split v19 dentro de la razón social.
            cycle_invoice_kind: split.kind,
            idempotency_key: subKey,
          } as object,
          idempotencyKey: subKey,
        },
      });

      await persistComputedInvoice(tx, invoice.id, split.invoice);

      for (const fee of split.invoice.fees) {
        if (fee.kind === 'setup' && fee.unitIds.length > 0) await markSetupsBilled(tx as unknown as PrismaClient, fee.unitIds, now);
        if (fee.kind === 'one_off' && fee.unitIds.length > 0) await markOneOffBilled(tx as unknown as PrismaClient, fee.unitIds, now);
        if (fee.kind === 'removal' && fee.unitIds.length > 0) await markRemovalsBilled(tx as unknown as PrismaClient, fee.unitIds, now);
      }

      return invoice;
    });
    emittedInvoices.push(created);
    newlyCreatedIds.add(created.id);
    anyCreated = true;
  }

  // v19: dispatch por cada invoice creada EN ESTE CALL (skipping pre-existentes,
  // que ya fueron dispatchadas en su momento).
  if (dispatcher && callbackBaseUrl) {
    for (const created of emittedInvoices) {
      if (!newlyCreatedIds.has(created.id)) continue;
      await dispatchCycleInvoice(prisma, org, created.id, dispatcher, callbackBaseUrl, log);
    }
  }

  const final = await Promise.all(
    emittedInvoices.map((inv) => prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })),
  );
  return { invoices: final, created: anyCreated };
}

// Dispatch a NetSuite. Extraído de la lógica inline previa para reusar entre
// las 1-2 invoices generadas por split. Payload idéntico al previo; SOLO montos
// netos — NetSuite calcula impuestos según el customer.
async function dispatchCycleInvoice(
  prisma: PrismaClient,
  org: Organization,
  invoiceId: string,
  dispatcher: NetSuiteDispatcher,
  callbackBaseUrl: string,
  log: EmitCycleInvoiceOptions['log'],
): Promise<void> {
  try {
    const hydrated = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { customer: true, fees: true, taxEntity: true },
    });
    if (!hydrated) return;
    const te = hydrated.taxEntity;
    const dispatchPayload = {
      external_id: hydrated.id,
      numaris_invoice_id: hydrated.id,
      issued_at: hydrated.createdAt.toISOString(),
      currency: hydrated.currency,
      // v22/fase5: el "customer" del payload es la RAZÓN SOCIAL (NetSuite ve
      // cada razón social como un customer). El external_id estable y el
      // handle (eid:/internal) son los de la TaxEntity, no los del Customer
      // comercial. customer_external_id queda como referencia interna.
      customer: {
        external_id: te.externalId,
        name: te.legalName,
        tax_identification_number: te.taxIdentificationNumber,
        country: te.country,
        netsuite_internal_id: te.netsuiteInternalId,
        netsuite_entity_handle: te.netsuiteInternalId
          ? te.netsuiteInternalId
          : `eid:${te.externalId}`,
        customer_external_id: hydrated.customer.externalId,
      },
      billing_period: { from: hydrated.periodFrom, to: hydrated.periodTo },
      lines: hydrated.fees.map((f) => ({
        fee_id: f.id, service_id: f.serviceId,
        service_add_on_id: f.serviceAddOnId, customer_add_on_id: f.customerAddOnId,
        kind: f.kind, description: f.description, units: f.units,
        unit_amount_cents: f.unitAmountCents, amount_cents: f.amountCents,
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
  } catch (err) {
    log?.error({ err }, 'cycle invoice dispatch failed');
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { externalDispatchStatus: 'failed', externalDispatchError: err instanceof Error ? err.message : String(err) },
    }).catch(() => undefined);
  }
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

type PreviewFee = {
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
};

type PreviewNetSuitePayload = {
  external_id: null;
  numaris_invoice_id: null;
  issued_at: string;
  currency: string;
  customer: {
    external_id: string;
    name: string;
    tax_identification_number: string | null;
    country: string | null;
    netsuite_internal_id: string | null;
    netsuite_entity_handle: string;
    customer_external_id: string;
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

// v22: preview de cycle invoice.
//   - `fees`, `fees_amount_cents`, `units_annex` son los agregados de TODAS las
//     razones sociales (qué se cobraría en total al cliente este ciclo).
//   - `invoices[]` desglosa qué factura emitiría el motor por cada razón
//     social receptora — una entrada por razón social con su propio payload
//     NetSuite. La fase 3 garantiza que cada invoice tiene UNA razón social.
//   El split_by_kind de v19 NO se refleja en el preview: separa solo
//   contablemente, no cambia montos ni dispatch destino.
export type PreviewCycleInvoiceResult = {
  period: { from: Date; to: Date; days_in_period: number };
  reference_now: Date;
  fees: PreviewFee[];
  fees_amount_cents: number;
  units_annex: unknown;
  invoices: Array<{
    tax_entity: {
      id: string;
      legal_name: string;
      tax_identification_number: string | null;
      country: string | null;
      netsuite_internal_id: string | null;
      is_default: boolean;
    };
    fees: PreviewFee[];
    fees_amount_cents: number;
    units_annex: unknown;
    netsuite_payload: PreviewNetSuitePayload;
  }>;
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

  // Mismas ocurrencias pendientes que el emit (las anexamos a `computed`).
  const pendingOccurrences = await prisma.catalogEventOccurrence.findMany({
    where: {
      customerId: customer.id,
      billingMode: 'next_cycle',
      feeId: null,
      occurredAt: { lte: period.end },
    },
    include: { catalogEvent: true },
    orderBy: { occurredAt: 'asc' },
  });
  for (const occ of pendingOccurrences) {
    const descParts = [occ.catalogEvent.name];
    if (occ.unitExternalId) descParts.push(occ.unitExternalId);
    if (occ.reference) descParts.push(`(${occ.reference})`);
    computed.fees.push({
      kind: 'catalog_event',
      catalogEventOccurrenceId: occ.id,
      description: descParts.join(' — '),
      units: '1.0000',
      unitAmountCents: occ.amountCents,
      preciseUnitAmount: (occ.amountCents / 100).toFixed(2),
      amountCents: occ.amountCents,
      netsuiteItemCode: occ.catalogEvent.netsuiteItemCode,
      billedUnitsDetail: [],
      unitIds: [],
    });
    computed.feesAmountCents += occ.amountCents;
  }

  // v22: agrupa por razón social.
  const lookups = {
    serviceToTaxEntity: new Map(fullCustomer.services.map((s) => [s.id, s.taxEntityId])),
    customerAddOnToTaxEntity: new Map(customerAddOns.map((a) => [a.id, a.taxEntityId])),
    catalogOccurrenceToTaxEntity: new Map(pendingOccurrences.map((o) => [o.id, o.taxEntityId])),
  };
  const groups = computed.fees.length === 0
    ? []
    : splitComputedInvoiceByTaxEntity(computed, lookups);

  // Hidrata las razones sociales involucradas para armar el customer block del
  // payload NetSuite. Una query única en vez de N.
  const taxEntities = groups.length === 0
    ? []
    : await prisma.taxEntity.findMany({ where: { id: { in: groups.map((g) => g.taxEntityId) } } });
  const teById = new Map(taxEntities.map((te) => [te.id, te]));

  const previewInvoices = groups.map((group) => {
    const te = teById.get(group.taxEntityId)!;
    const fees: PreviewFee[] = group.invoice.fees.map((f) => ({
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
    }));
    const netsuite_payload: PreviewNetSuitePayload = {
      external_id: null,
      numaris_invoice_id: null,
      issued_at: now.toISOString(),
      currency: customer.currency,
      // v22/fase5: el customer del payload es la razón social (cada una es
      // un customer en NetSuite).
      customer: {
        external_id: te.externalId,
        name: te.legalName,
        tax_identification_number: te.taxIdentificationNumber,
        country: te.country,
        netsuite_internal_id: te.netsuiteInternalId,
        netsuite_entity_handle: te.netsuiteInternalId ?? `eid:${te.externalId}`,
        customer_external_id: customer.externalId,
      },
      billing_period: { from: period.start, to: period.end },
      lines: group.invoice.fees.map((f) => ({
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
      units_annex: group.invoice.unitsAnnex,
      totals: { fees_amount_cents: group.invoice.feesAmountCents },
    };
    return {
      tax_entity: {
        id: te.id,
        legal_name: te.legalName,
        tax_identification_number: te.taxIdentificationNumber,
        country: te.country,
        netsuite_internal_id: te.netsuiteInternalId,
        is_default: te.isDefault,
      },
      fees,
      fees_amount_cents: group.invoice.feesAmountCents,
      units_annex: group.invoice.unitsAnnex,
      netsuite_payload,
    };
  });

  // Agregados planos: misma forma para clientes con 1 razón (caso común) y
  // para los nuevos consumers programáticos que solo quieren el total.
  const aggregateFees: PreviewFee[] = computed.fees.map((f) => ({
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
  }));

  return {
    period: { from: period.start, to: period.end, days_in_period: period.daysInPeriod },
    reference_now: now,
    fees: aggregateFees,
    fees_amount_cents: computed.feesAmountCents,
    units_annex: computed.unitsAnnex,
    invoices: previewInvoices,
  };
}
