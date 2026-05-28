// v18: emisión de invoices "inmediatas" — disparadas por eventos puntuales
// (instalación, baja) en lugar de por el cron de cierre de ciclo. Comparte
// la mecánica con el `one_off_immediate` que ya vivía en events.ts:
//   1. Crea Invoice con metadata.trigger marcado.
//   2. Persiste fees y units_annex.
//   3. Aplica el marcador de "ya facturado" en la unit (callback `markBilled`).
//   4. Dispatcha a NetSuite en background (no bloquea la respuesta HTTP).
//
// Idempotente: `idempotencyKey` impide que un retry del POST/PATCH produzca
// invoices duplicadas. Las funciones del engine (computeSetupImmediateInvoice,
// computeRemovalImmediateInvoice) son puras — toda la I/O vive aquí.

import type { Customer, Organization, PrismaClient } from '@prisma/client';
import type { ComputedInvoice } from './billing-engine.js';
import { persistComputedInvoice } from './billing-engine.js';
import type { NetSuiteDispatcher } from './netsuite-dispatcher.js';

export type ImmediateTrigger = 'setup_immediate' | 'removal_immediate';

export type EmitImmediateInvoiceOptions = {
  prisma: PrismaClient;
  organization: Organization;
  customer: Customer;
  computed: ComputedInvoice;
  trigger: ImmediateTrigger;
  idempotencyKey: string;
  // Callback invocado dentro de la transacción para marcar la unit como
  // facturada (ej. setupBilledAt = now). Mantiene la responsabilidad en el
  // caller; este helper no sabe qué columna actualizar.
  markBilled?: (tx: PrismaClient) => Promise<void>;
  // Metadata extra para el invoice (ej. transaction_id, source).
  metadata?: Record<string, unknown>;
  now?: Date;
};

export type EmitImmediateInvoiceResult = {
  invoiceId: string;
  created: boolean;  // false si ya existía por idempotency
};

export async function emitImmediateInvoice(
  opts: EmitImmediateInvoiceOptions,
): Promise<EmitImmediateInvoiceResult> {
  const { prisma, organization, customer, computed, trigger, idempotencyKey, markBilled, metadata, now } = opts;
  const issued = now ?? new Date();

  // Pre-flight idempotency: si ya hay invoice con este key, devolverlo.
  const existing = await prisma.invoice.findFirst({
    where: { organizationId: organization.id, idempotencyKey },
    select: { id: true },
  });
  if (existing) return { invoiceId: existing.id, created: false };

  const invoiceId = await prisma.$transaction(async (tx) => {
    // Segundo check dentro de la transacción (concurrencia).
    const dup = await tx.invoice.findFirst({
      where: { organizationId: organization.id, idempotencyKey },
      select: { id: true },
    });
    if (dup) return dup.id;

    const orgUpdate = await tx.organization.update({
      where: { id: organization.id },
      data: { invoiceCounter: { increment: 1 } },
      select: { invoiceCounter: true },
    });

    const issuingDate = new Date(issued.getFullYear(), issued.getMonth(), issued.getDate());
    const invoice = await tx.invoice.create({
      data: {
        organizationId: organization.id,
        customerId: customer.id,
        sequentialId: orgUpdate.invoiceCounter,
        currency: customer.currency,
        status: 'calculated',
        externalDispatchStatus: 'pending',
        paymentStatus: 'pending',
        issuingDate,
        paymentDueDate: issuingDate,
        feesAmountCents: computed.feesAmountCents,
        periodFrom: issued,
        periodTo: issued,
        unitsAnnex: computed.unitsAnnex as object,
        metadata: { trigger, ...(metadata ?? {}) } as object,
        idempotencyKey,
      },
    });

    await persistComputedInvoice(tx, invoice.id, computed);
    if (markBilled) await markBilled(tx as unknown as PrismaClient);
    return invoice.id;
  });

  return { invoiceId, created: true };
}

// Dispatch async (fire-and-forget) post-emisión. NO bloquea la respuesta HTTP.
// Replica el comportamiento que events.ts ya implementaba inline para
// one_off_immediate, expuesto aquí para que los nuevos triggers lo reusen.
export function dispatchInvoiceInBackground(
  prisma: PrismaClient,
  organizationId: string,
  invoiceId: string,
  dispatcher: NetSuiteDispatcher,
  callbackBaseUrl: string,
  log: { error: (data: unknown, msg?: string) => void },
): void {
  void (async () => {
    try {
      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { customer: true, fees: true },
      });
      if (!invoice) return;
      const orgRow = await prisma.organization.findUnique({ where: { id: organizationId } });
      if (!orgRow) return;
      const dispatchPayload = {
        external_id: invoice.id,
        minilago_invoice_id: invoice.id,
        issued_at: invoice.createdAt.toISOString(),
        currency: invoice.currency,
        customer: {
          external_id: invoice.customer.externalId,
          name: invoice.customer.name,
          tax_identification_number: invoice.customer.taxIdentificationNumber,
          country: invoice.customer.country,
        },
        billing_period: { from: invoice.periodFrom, to: invoice.periodTo },
        lines: invoice.fees.map((f) => ({
          fee_id: f.id, service_id: f.serviceId, kind: f.kind,
          description: f.description, units: f.units,
          unit_amount_cents: f.unitAmountCents, amount_cents: f.amountCents,
          billed_units_detail: f.billedUnitsDetail,
        })),
        units_annex: invoice.unitsAnnex,
        totals: { fees_amount_cents: invoice.feesAmountCents },
        metadata: invoice.metadata ?? {},
        callback_url: `${callbackBaseUrl}/api/v1/invoices/${invoice.id}/external-confirm`,
      };
      const result = await dispatcher.dispatch(orgRow, dispatchPayload, 'invoice');
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: result.status === 'accepted'
          ? { externalDispatchStatus: 'dispatched', netsuiteDispatchId: result.netsuiteInternalId ?? null }
          : { externalDispatchStatus: 'failed', externalDispatchError: result.error ?? 'dispatch_failed' },
      });
    } catch (err) {
      log.error({ err }, 'immediate_invoice dispatch failed');
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { externalDispatchStatus: 'failed', externalDispatchError: err instanceof Error ? err.message : String(err) },
      }).catch(() => undefined);
    }
  })();
}
