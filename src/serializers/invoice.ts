// Invoice serializer (Numaris-native).

import type { AppliedTax, Fee, Invoice } from '@prisma/client';
import { DateTime } from 'luxon';
import { isoUtc } from '../services/tz.js';
import type { CustomerWithLinks } from './customer.js';
import { serializeEmbeddedCustomer } from './customer.js';

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
      id: fee.id,
      service_id: fee.serviceId,
      kind: fee.kind,
      description: fee.description ?? '',
      units: fee.units,
      unit_amount_cents: fee.unitAmountCents,
      precise_unit_amount: fee.preciseUnitAmount,
      amount_cents: fee.amountCents,
      taxes_amount_cents: fee.taxesAmountCents,
      taxes_rate: Number(fee.taxesRate),
      total_amount_cents: fee.totalAmountCents,
      billed_units_detail: fee.billedUnitsDetail ?? [],
      payment_status: fee.paymentStatus,
      created_at: isoUtc(fee.createdAt),
    }));

  const appliedTaxes = invoice.appliedTaxes.map((t) => ({
    id: t.id,
    tax_id: t.taxId,
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
      id: invoice.id,
      sequential_id: invoice.sequentialId,
      number: invoice.number ?? null,
      customer_id: invoice.customerId,
      service_id: invoice.serviceId ?? null,
      issuing_date: DateTime.fromJSDate(invoice.issuingDate, { zone: 'utc' }).toFormat('yyyy-LL-dd'),
      payment_due_date: DateTime.fromJSDate(invoice.paymentDueDate, { zone: 'utc' }).toFormat('yyyy-LL-dd'),
      net_payment_term: invoice.netPaymentTerm,
      status: invoice.status,
      external_dispatch_status: invoice.externalDispatchStatus,
      external_dispatch_error: invoice.externalDispatchError ?? null,
      payment_status: invoice.paymentStatus,
      currency: invoice.currency,
      fees_amount_cents: invoice.feesAmountCents,
      taxes_amount_cents: invoice.taxesAmountCents,
      total_amount_cents: invoice.totalAmountCents,
      period_from: invoice.periodFrom ? isoUtc(invoice.periodFrom) : null,
      period_to: invoice.periodTo ? isoUtc(invoice.periodTo) : null,
      customer: serializeEmbeddedCustomer(invoice.customer),
      fees,
      units_annex: invoice.unitsAnnex ?? [],
      applied_taxes: appliedTaxes,
      external_invoice: externalInvoice,
      metadata: invoice.metadata ?? {},
      created_at: isoUtc(invoice.createdAt),
      updated_at: isoUtc(invoice.updatedAt),
    },
  };
}

export function serializeInvoiceEmbedded(invoice: InvoiceWithRelations) {
  return {
    id: invoice.id,
    number: invoice.number ?? null,
    status: invoice.status,
    external_dispatch_status: invoice.externalDispatchStatus,
    payment_status: invoice.paymentStatus,
  };
}
