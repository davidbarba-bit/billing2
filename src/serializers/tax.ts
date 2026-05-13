// Tax serializer matching the Lago wire shape captured in fixture 03.

import type { Tax } from '@prisma/client';
import { isoUtc } from '../services/tz.js';

export type TaxCounters = {
  add_ons_count: number;
  customers_count: number;
  plans_count: number;
  charges_count: number;
  commitments_count: number;
};

export function serializeTax(tax: Tax, counters: TaxCounters) {
  return {
    lago_id: tax.id,
    name: tax.name,
    code: tax.code,
    rate: Number(tax.rate),
    description: tax.description ?? null,
    applied_to_organization: tax.appliedToOrganization,
    add_ons_count: counters.add_ons_count,
    customers_count: counters.customers_count,
    plans_count: counters.plans_count,
    charges_count: counters.charges_count,
    commitments_count: counters.commitments_count,
    created_at: isoUtc(tax.createdAt),
  };
}
