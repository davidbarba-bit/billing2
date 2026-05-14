// Service serializer (v3 — no longer owns billing cycle).

import type { Service, Tax } from '@prisma/client';
import { isoUtc } from '../services/tz.js';
import { serializeTax } from './tax.js';

export type ServiceWithLinks = Service & {
  taxLinks: Array<{ tax: Tax }>;
};

export function serializeService(service: ServiceWithLinks) {
  return {
    service: {
      id: service.id,
      code: service.code,
      name: service.name,
      description: service.description ?? null,
      customer_id: service.customerId,
      currency: service.currency,
      monthly_unit_amount_cents: service.monthlyUnitAmountCents,
      setup_unit_amount_cents: service.setupUnitAmountCents,
      status: service.status,
      terminated_at: service.terminatedAt ? isoUtc(service.terminatedAt) : null,
      metadata: service.metadata ?? {},
      taxes: service.taxLinks.map(({ tax }) => serializeTax(tax).tax),
      created_at: isoUtc(service.createdAt),
      updated_at: isoUtc(service.updatedAt),
    },
  };
}
