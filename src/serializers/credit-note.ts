// Credit note serializer (v5 — sin tax stack; NetSuite calcula impuestos).

import type { CreditNote, CreditNoteItem, Fee, Invoice } from '@prisma/client';
import { DateTime } from 'luxon';
import { isoUtc } from '../services/tz.js';
import type { CustomerWithLinks } from './customer.js';
import { serializeEmbeddedCustomer } from './customer.js';
import { serializeInvoiceEmbedded, type InvoiceWithRelations } from './invoice.js';

export type CreditNoteWithRelations = CreditNote & {
  customer: CustomerWithLinks;
  invoice: Invoice & { customer: CustomerWithLinks; fees: Fee[] };
  items: (CreditNoteItem & { fee: Fee })[];
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
      // v5: monto neto sin impuestos (NetSuite los calcula al emitir el CFDI).
      total_amount_cents: cn.totalAmountCents,
      balance_amount_cents: cn.balanceAmountCents,
      credit_amount_cents: cn.creditAmountCents,
      refund_amount_cents: cn.refundAmountCents,
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
        },
      })),
      external_credit_note: externalCN,
      created_at: isoUtc(cn.createdAt),
      updated_at: isoUtc(cn.updatedAt),
    },
  };
}
