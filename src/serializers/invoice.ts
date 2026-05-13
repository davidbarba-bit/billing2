// Invoice serializer matching fixture 11.

import type { AppliedTax, Fee, Invoice } from '@prisma/client';
import { DateTime } from 'luxon';
import { isoUtc } from '../services/tz.js';
import type { CustomerWithLinks } from './customer.js';
import { serializeEmbeddedCustomerForInvoice } from './customer.js';

export type InvoiceWithRelations = Invoice & {
  customer: CustomerWithLinks;
  fees: Fee[];
  appliedTaxes: AppliedTax[];
};

export function serializeInvoice(invoice: InvoiceWithRelations) {
  const externalInvoice = invoice.externalInvoiceFolio
    ? {
        folio: invoice.externalInvoiceFolio,
        uuid_cfdi: invoice.externalInvoiceUuidCfdi,
        system: invoice.externalInvoiceSystem,
        netsuite_internal_id: invoice.externalInvoiceNetsuiteInternalId,
        pdf_url: invoice.externalInvoicePdfUrl,
        xml_url: invoice.externalInvoiceXmlUrl,
        issued_at: invoice.externalInvoiceIssuedAt ? isoUtc(invoice.externalInvoiceIssuedAt) : null,
        confirmed_at: invoice.externalInvoiceConfirmedAt ? isoUtc(invoice.externalInvoiceConfirmedAt) : null,
      }
    : null;

  const fees = invoice.fees
    .sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime())
    .map((fee) => ({
      lago_id: fee.id,
      lago_invoice_id: fee.invoiceId,
      lago_subscription_id: fee.subscriptionId ?? null,
      external_subscription_id: fee.externalSubscriptionId ?? null,
      item: {
        type: fee.itemType,
        code: fee.itemCode,
        name: fee.itemName,
        invoice_display_name: fee.itemInvoiceDisplayName ?? fee.itemName,
        lago_item_id: fee.itemLagoItemId,
        item_type: fee.itemClassType,
      },
      amount_cents: fee.amountCents,
      amount_currency: fee.amountCurrency,
      taxes_amount_cents: fee.taxesAmountCents,
      taxes_rate: Number(fee.taxesRate),
      total_amount_cents: fee.totalAmountCents,
      units: fee.units,
      description: fee.description ?? '',
      precise_unit_amount: fee.preciseUnitAmount,
      billed_units_detail: fee.billedUnitsDetail ?? [],
      payment_status: fee.paymentStatus,
      created_at: isoUtc(fee.createdAt),
    }));

  const appliedTaxes = invoice.appliedTaxes.map((t) => ({
    lago_id: t.id,
    lago_invoice_id: t.invoiceId,
    lago_tax_id: t.taxId,
    tax_name: t.taxName,
    tax_code: t.taxCode,
    tax_rate: Number(t.taxRate),
    tax_description: t.taxDescription ?? '',
    amount_cents: t.amountCents,
    amount_currency: t.amountCurrency,
    fees_amount_cents: t.feesAmountCents,
    created_at: isoUtc(t.createdAt),
  }));

  return {
    invoice: {
      lago_id: invoice.id,
      sequential_id: invoice.sequentialId,
      number: invoice.number ?? null,
      external_invoice: externalInvoice,
      issuing_date: DateTime.fromJSDate(invoice.issuingDate, { zone: 'utc' }).toFormat('yyyy-LL-dd'),
      payment_due_date: DateTime.fromJSDate(invoice.paymentDueDate, { zone: 'utc' }).toFormat('yyyy-LL-dd'),
      net_payment_term: invoice.netPaymentTerm,
      invoice_type: invoice.invoiceType,
      status: invoice.status,
      external_dispatch_status: invoice.externalDispatchStatus,
      payment_status: invoice.paymentStatus,
      payment_dispute_lost_at: invoice.paymentDisputeLostAt ? isoUtc(invoice.paymentDisputeLostAt) : null,
      payment_overdue: invoice.paymentOverdue,
      currency: invoice.currency,
      fees_amount_cents: invoice.feesAmountCents,
      taxes_amount_cents: invoice.taxesAmountCents,
      progressive_billing_credit_amount_cents: invoice.progressiveBillingCreditAmountCents,
      coupons_amount_cents: invoice.couponsAmountCents,
      credit_notes_amount_cents: invoice.creditNotesAmountCents,
      sub_total_excluding_taxes_amount_cents: invoice.subTotalExcludingTaxesAmountCents,
      sub_total_including_taxes_amount_cents: invoice.subTotalIncludingTaxesAmountCents,
      total_amount_cents: invoice.totalAmountCents,
      prepaid_credit_amount_cents: invoice.prepaidCreditAmountCents,
      file_url: invoice.fileUrl ?? null,
      version_number: invoice.versionNumber,
      customer: serializeEmbeddedCustomerForInvoice(invoice.customer),
      subscriptions: [],
      fees,
      units_annex: invoice.unitsAnnex ?? [],
      credits: [],
      metadata: invoice.metadata ?? {},
      applied_taxes: appliedTaxes,
      error_details: invoice.errorDetails ?? [],
    },
  };
}

// Light shape used when embedded inside a credit note.
export function serializeInvoiceReduced(invoice: InvoiceWithRelations) {
  return {
    lago_id: invoice.id,
    payment_status: invoice.paymentStatus,
    status: invoice.status,
    external_dispatch_status: invoice.externalDispatchStatus,
    number: invoice.number ?? null,
  };
}
