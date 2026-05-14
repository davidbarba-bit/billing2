// Customer serializer (Numaris-native model).

import type { Customer, Organization, Tax } from '@prisma/client';
import { applicableTimezone, isoUtc } from '../services/tz.js';
import { serializeTax } from './tax.js';

export type CustomerWithLinks = Customer & {
  organization: Organization;
  taxLinks: Array<{ tax: Tax }>;
};

export function serializeCustomer(customer: CustomerWithLinks) {
  return {
    customer: {
      id: customer.id,
      external_id: customer.externalId,
      sequential_id: customer.sequentialId,
      slug: customer.slug,
      name: customer.name,
      email: customer.email ?? null,
      phone: customer.phone ?? null,
      tax_identification_number: customer.taxIdentificationNumber ?? null,
      address_line1: customer.addressLine1 ?? null,
      address_line2: customer.addressLine2 ?? null,
      state: customer.state ?? null,
      zipcode: customer.zipcode ?? null,
      city: customer.city ?? null,
      country: customer.country ?? null,
      currency: customer.currency,
      timezone: customer.timezone ?? null,
      applicable_timezone: applicableTimezone(customer.timezone, customer.organization.timezone),
      metadata: customer.metadata ?? {},
      taxes: customer.taxLinks.map(({ tax }) => serializeTax(tax).tax),
      created_at: isoUtc(customer.createdAt),
      updated_at: isoUtc(customer.updatedAt),
    },
  };
}

// Reduced embed used by invoice/credit-note responses.
export function serializeEmbeddedCustomer(customer: CustomerWithLinks) {
  return {
    id: customer.id,
    external_id: customer.externalId,
    name: customer.name,
    currency: customer.currency,
    tax_identification_number: customer.taxIdentificationNumber ?? null,
    timezone: customer.timezone ?? null,
    applicable_timezone: applicableTimezone(customer.timezone, customer.organization.timezone),
  };
}
