// Credit note serializer matching fixture 12.

import type { CreditNote, CreditNoteAppliedTax, CreditNoteItem, Fee, Invoice } from '@prisma/client';
import { DateTime } from 'luxon';
import { isoUtc } from '../services/tz.js';
import type { CustomerWithLinks } from './customer.js';
import { serializeEmbeddedCustomerForCreditNote } from './customer.js';
import { serializeInvoiceReduced, type InvoiceWithRelations } from './invoice.js';

export type CreditNoteWithRelations = CreditNote & {
  customer: CustomerWithLinks;
  invoice: Invoice & { customer: CustomerWithLinks; fees: Fee[]; appliedTaxes: import('@prisma/client').AppliedTax[] };
  items: (CreditNoteItem & { fee: Fee })[];
  appliedTaxes: CreditNoteAppliedTax[];
};

export function serializeCreditNote(cn: CreditNoteWithRelations) {
  const externalCreditNote = cn.externalCreditNoteFolio
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
      lago_id: cn.id,
      sequential_id: cn.sequentialId,
      number: cn.number ?? null,
      external_credit_note: externalCreditNote,
      status: cn.status,
      external_dispatch_status: cn.externalDispatchStatus,
      lago_invoice_id: cn.invoiceId,
      invoice_number: cn.invoice.number ?? null,
      issuing_date: DateTime.fromJSDate(cn.issuingDate, { zone: 'utc' }).toFormat('yyyy-LL-dd'),
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
      coupons_adjustment_amount_cents: cn.couponsAdjustmentAmountCents,
      taxes_rate: Number(cn.taxesRate),
      created_at: isoUtc(cn.createdAt),
      updated_at: isoUtc(cn.updatedAt),
      file_url: cn.fileUrl ?? null,
      customer: serializeEmbeddedCustomerForCreditNote(cn.customer),
      invoice: serializeInvoiceReduced(cn.invoice as InvoiceWithRelations),
      items: cn.items.map((item) => ({
        lago_id: item.id,
        amount_cents: item.amountCents,
        amount_currency: item.amountCurrency,
        fee: {
          lago_id: item.fee.id,
          amount_cents: item.fee.amountCents,
          amount_currency: item.fee.amountCurrency,
          taxes_amount_cents: item.fee.taxesAmountCents,
          total_amount_cents: item.fee.totalAmountCents,
          units: item.fee.units,
          events_count: null,
          payment_status: item.fee.paymentStatus,
          item: {
            type: item.fee.itemType,
            code: item.fee.itemCode,
            name: item.fee.itemName,
          },
        },
      })),
      applied_taxes: cn.appliedTaxes.map((t) => ({
        lago_id: t.id,
        lago_tax_id: t.taxId,
        tax_name: t.taxName,
        tax_code: t.taxCode,
        tax_rate: Number(t.taxRate),
        tax_description: t.taxDescription ?? '',
        amount_cents: t.amountCents,
        amount_currency: t.amountCurrency,
        base_amount_cents: t.baseAmountCents,
        created_at: isoUtc(t.createdAt),
      })),
    },
  };
}
