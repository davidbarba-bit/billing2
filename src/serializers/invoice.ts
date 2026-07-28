// Invoice serializer (v5 — sin tax stack; NetSuite calcula impuestos).

import type { Fee, Invoice } from '@prisma/client';
import { DateTime } from 'luxon';
import { isoUtc } from '../services/tz.js';
import type { CustomerWithLinks } from './customer.js';
import { serializeEmbeddedCustomer } from './customer.js';

export type InvoiceWithRelations = Invoice & {
  customer: CustomerWithLinks;
  fees: Fee[];
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
      service_add_on_id: fee.serviceAddOnId ?? null,
      customer_add_on_id: fee.customerAddOnId ?? null,
      kind: fee.kind,
      description: fee.description ?? '',
      units: fee.units,
      unit_amount_cents: fee.unitAmountCents,
      precise_unit_amount: fee.preciseUnitAmount,
      amount_cents: fee.amountCents,
      netsuite_item_code: fee.netsuiteItemCode ?? null,
      billed_units_detail: fee.billedUnitsDetail ?? [],
      payment_status: fee.paymentStatus,
      created_at: isoUtc(fee.createdAt),
    }));

  return {
    invoice: {
      id: invoice.id,
      sequential_id: invoice.sequentialId,
      number: invoice.number ?? null,
      customer_id: invoice.customerId,
      issuing_date: DateTime.fromJSDate(invoice.issuingDate, { zone: 'utc' }).toFormat('yyyy-LL-dd'),
      payment_due_date: DateTime.fromJSDate(invoice.paymentDueDate, { zone: 'utc' }).toFormat('yyyy-LL-dd'),
      net_payment_term: invoice.netPaymentTerm,
      status: invoice.status,
      external_dispatch_status: invoice.externalDispatchStatus,
      external_dispatch_error: invoice.externalDispatchError ?? null,
      payment_status: invoice.paymentStatus,
      currency: invoice.currency,
      // v5: NetSuite calcula los impuestos. Numaris Billing solo reporta
      // `fees_amount_cents` (suma neta de partidas, sin IVA). El folio fiscal
      // del CFDI con taxes incluidos llega de NetSuite vía /external-confirm.
      fees_amount_cents: invoice.feesAmountCents,
      period_from: invoice.periodFrom ? isoUtc(invoice.periodFrom) : null,
      period_to: invoice.periodTo ? isoUtc(invoice.periodTo) : null,
      customer: serializeEmbeddedCustomer(invoice.customer),
      fees,
      units_annex: invoice.unitsAnnex ?? [],
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
