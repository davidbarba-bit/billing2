// Credit note serializer.

import type { CreditNote, CreditNoteAppliedTax, CreditNoteItem, Fee, Invoice } from '@prisma/client';
import { DateTime } from 'luxon';
import { isoUtc } from '../services/tz.js';
import type { CustomerWithLinks } from './customer.js';
import { serializeEmbeddedCustomer } from './customer.js';
import { serializeInvoiceEmbedded, type InvoiceWithRelations } from './invoice.js';

export type CreditNoteWithRelations = CreditNote & {
  customer: CustomerWithLinks;
  invoice: Invoice & {
    customer: CustomerWithLinks;
    fees: Fee[];
    appliedTaxes: import('@prisma/client').AppliedTax[];
  };
  items: (CreditNoteItem & { fee: Fee })[];
  appliedTaxes: CreditNoteAppliedTax[];
};

export function serializeCreditNote(cn: CreditNoteWithRelations) {
  const externalCN = cn.externalCreditNoteFolio
    ? {
        folio: cn.externalCreditNoteFolio,
        uuid_cfdi: cn.externalCreditNoteUuidCfdi,
        system: cn.externalCreditNoteSystem,
        netsuite_internal_id: cn.externalCreditNoteNetsuiteId,
        pdf_url: cn.externalCreditNotePdfUrl,
        xml_url: cn.externalCreditNoteXmlUrl,
        issued_at: cn.externalCreditNoteIssuedAt ? isoUtc(cn.externalCreditNoteIssuedAt) : null,
        confirmed_at: cn.externalCreditNoteConfirmedAt ? isoUtc(cn.externalCreditNoteConfirmedAt) : null,
      }
    : null;

  return {
    credit_note: {
      id: cn.id,
      sequential_id: cn.sequentialId,
      number: cn.number ?? null,
      invoice_id: cn.invoiceId,
      customer_id: cn.customerId,
      status: cn.status,
      external_dispatch_status: cn.externalDispatchStatus,
      credit_status: cn.creditStatus,
      refund_status: cn.refundStatus ?? null,
      reason: cn.reason,
      description: cn.description ?? '',
      currency: cn.currency,
      total_amount_cents: cn.totalAmountCents,
      taxes_amount_cents: cn.taxesAmountCents,
      sub_total_excluding_taxes_amount_cents: cn.subTotalExcludingTaxesAmountCents,
      balance_amount_cents: cn.balanceAmountCents,
      credit_amount_cents: cn.creditAmountCents,
      refund_amount_cents: cn.refundAmountCents,
      taxes_rate: Number(cn.taxesRate),
      issuing_date: DateTime.fromJSDate(cn.issuingDate, { zone: 'utc' }).toFormat('yyyy-LL-dd'),
      idempotency_marker: cn.idempotencyMarker ?? null,
      customer: serializeEmbeddedCustomer(cn.customer),
      invoice: serializeInvoiceEmbedded(cn.invoice as InvoiceWithRelations),
      items: cn.items.map((it) => ({
        id: it.id,
        fee_id: it.feeId,
        amount_cents: it.amountCents,
        amount_currency: it.amountCurrency,
        fee: {
          id: it.fee.id,
          kind: it.fee.kind,
          description: it.fee.description ?? '',
          units: it.fee.units,
          amount_cents: it.fee.amountCents,
          total_amount_cents: it.fee.totalAmountCents,
        },
      })),
      applied_taxes: cn.appliedTaxes.map((t) => ({
        id: t.id,
        tax_id: t.taxId,
        tax_name: t.taxName,
        tax_code: t.taxCode,
        tax_rate: Number(t.taxRate),
        amount_cents: t.amountCents,
        amount_currency: t.amountCurrency,
        base_amount_cents: t.baseAmountCents,
      })),
      external_credit_note: externalCN,
      created_at: isoUtc(cn.createdAt),
      updated_at: isoUtc(cn.updatedAt),
    },
  };
}
