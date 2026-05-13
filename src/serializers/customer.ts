// Customer serializer matching fixtures 01a/02 — note the mini-Lago
// divergences from Lago Cloud documented in §"Divergencias" of the spec:
//   - `customer.timezone` echoes the value the client sent (Lago Cloud
//     returns `null`).
//   - `customer.applicable_timezone` = customer.tz || org.tz || "UTC".
//   - `customer.metadata` is always an object (Lago Cloud returns `[]`).

import type { Customer, Organization, Tax } from '@prisma/client';
import { applicableTimezone, isoUtc } from '../services/tz.js';
import { serializeTax, type TaxCounters } from './tax.js';

export type CustomerWithLinks = Customer & {
  organization: Organization;
  taxLinks: Array<{ tax: Tax }>;
};

export function serializeCustomer(
  customer: CustomerWithLinks,
  taxCounters: Map<string, TaxCounters>,
) {
  const taxes = customer.taxLinks.map(({ tax }) =>
    serializeTax(tax, taxCounters.get(tax.id) ?? emptyCounters()),
  );
  return {
    customer: {
      lago_id: customer.id,
      external_id: customer.externalId,
      name: customer.name,
      firstname: customer.firstname ?? null,
      lastname: customer.lastname ?? null,
      customer_type: customer.customerType ?? null,
      sequential_id: customer.sequentialId,
      slug: customer.slug,
      created_at: isoUtc(customer.createdAt),
      updated_at: isoUtc(customer.updatedAt),
      country: customer.country ?? null,
      address_line1: customer.addressLine1 ?? null,
      address_line2: customer.addressLine2 ?? null,
      state: customer.state ?? null,
      zipcode: customer.zipcode ?? null,
      email: customer.email ?? null,
      city: customer.city ?? null,
      url: customer.url ?? null,
      phone: customer.phone ?? null,
      logo_url: customer.logoUrl ?? null,
      legal_name: customer.legalName ?? null,
      legal_number: customer.legalNumber ?? null,
      currency: customer.currency,
      tax_identification_number: customer.taxIdentificationNumber ?? null,
      timezone: customer.timezone ?? null,
      applicable_timezone: applicableTimezone(customer.timezone, customer.organization.timezone),
      net_payment_term: customer.netPaymentTerm ?? null,
      external_salesforce_id: customer.externalSalesforceId ?? null,
      finalize_zero_amount_invoice: customer.finalizeZeroAmountInvoice,
      billing_configuration: {
        invoice_grace_period: null,
        payment_provider: null,
        payment_provider_code: null,
        document_locale: null,
      },
      shipping_address: {
        address_line1: customer.shippingAddressLine1 ?? null,
        address_line2: customer.shippingAddressLine2 ?? null,
        city: customer.shippingCity ?? null,
        zipcode: customer.shippingZipcode ?? null,
        state: customer.shippingState ?? null,
        country: customer.shippingCountry ?? null,
      },
      metadata: customer.metadata ?? {},
      taxes,
      integration_customers: [],
    },
  };
}

// Reduced shape used when an invoice embeds its customer.
export function serializeEmbeddedCustomerForInvoice(customer: CustomerWithLinks) {
  return {
    lago_id: customer.id,
    external_id: customer.externalId,
    name: customer.name,
    currency: customer.currency,
    tax_identification_number: customer.taxIdentificationNumber ?? null,
    timezone: customer.timezone ?? null,
    applicable_timezone: applicableTimezone(customer.timezone, customer.organization.timezone),
  };
}

// Reduced shape used when a credit_note embeds its customer.
export function serializeEmbeddedCustomerForCreditNote(customer: CustomerWithLinks) {
  return {
    lago_id: customer.id,
    external_id: customer.externalId,
    name: customer.name,
    email: customer.email ?? null,
    currency: customer.currency,
  };
}

function emptyCounters(): TaxCounters {
  return {
    add_ons_count: 0,
    customers_count: 0,
    plans_count: 0,
    charges_count: 0,
    commitments_count: 0,
  };
}
