// Build the JSON payload that mini-Lago POSTs to NetSuite (endpoint #14).
// Matches fixture 14-netsuite-dispatch.request.synthetic.json shape.

import type { Customer, Fee, Invoice, Organization } from '@prisma/client';
import { isoUtc } from './tz.js';

type FeeWithDetail = Fee & { billedUnitsDetail: unknown };

export type DispatchInput = {
  organization: Organization;
  customer: Customer;
  invoice: Invoice;
  fees: FeeWithDetail[];
  unitsAnnex: Array<{ external_id: string; label: string | null; fees: unknown[] }>;
  customerTaxCodes: string[];
  monthKey: string;
  timezone: string;
  callbackUrl: string;
};

export function buildInvoiceDispatchPayload(input: DispatchInput): Record<string, unknown> {
  const { invoice, customer, fees, unitsAnnex, monthKey, timezone, callbackUrl } = input;
  return {
    external_id: invoice.id,
    minilago_invoice_lago_id: invoice.id,
    issued_at: isoUtc(invoice.createdAt),
    currency: invoice.currency,
    customer: {
      external_id: customer.externalId,
      name: customer.name,
      tax_identification_number: customer.taxIdentificationNumber ?? null,
      country: customer.country ?? null,
      tax_codes: input.customerTaxCodes,
    },
    billing_period: {
      from: invoice.metadata && typeof invoice.metadata === 'object' && 'billing_period_from' in invoice.metadata
        ? (invoice.metadata as Record<string, unknown>).billing_period_from
        : null,
      to: invoice.metadata && typeof invoice.metadata === 'object' && 'billing_period_to' in invoice.metadata
        ? (invoice.metadata as Record<string, unknown>).billing_period_to
        : null,
      month_key: monthKey,
      timezone,
    },
    lines: fees.map((fee) => ({
      fee_lago_id: fee.id,
      item_code: fee.itemCode,
      item_name: fee.itemName,
      description: fee.description ?? '',
      units: fee.units,
      unit_amount_cents: Math.round(Number(fee.preciseUnitAmount) * 100),
      amount_cents: fee.amountCents,
      taxes_amount_cents: fee.taxesAmountCents,
      taxes_rate: Number(fee.taxesRate),
      total_amount_cents: fee.totalAmountCents,
      billed_units_detail: fee.billedUnitsDetail ?? [],
    })),
    units_annex: unitsAnnex,
    totals: {
      fees_amount_cents: invoice.feesAmountCents,
      taxes_amount_cents: invoice.taxesAmountCents,
      total_amount_cents: invoice.totalAmountCents,
    },
    metadata: invoice.metadata ?? {},
    callback_url: callbackUrl,
  };
}
