// Build a Map<tax_id, counters> in one round-trip for a set of tax ids.
// Counters reflect the current state of the organization (invariant #7).

import type { PrismaClient } from '@prisma/client';
import type { TaxCounters } from '../serializers/tax.js';

export async function loadTaxCounters(
  prisma: PrismaClient,
  taxIds: string[],
): Promise<Map<string, TaxCounters>> {
  if (taxIds.length === 0) return new Map();
  const [addOnLinks, customerLinks] = await Promise.all([
    prisma.addOnTaxLink.groupBy({
      by: ['taxId'],
      where: { taxId: { in: taxIds } },
      _count: { taxId: true },
    }),
    prisma.customerTaxLink.groupBy({
      by: ['taxId'],
      where: { taxId: { in: taxIds } },
      _count: { taxId: true },
    }),
  ]);

  const result = new Map<string, TaxCounters>();
  for (const id of taxIds) {
    result.set(id, {
      add_ons_count: 0,
      customers_count: 0,
      plans_count: 0,
      charges_count: 0,
      commitments_count: 0,
    });
  }
  for (const row of addOnLinks) {
    const c = result.get(row.taxId)!;
    c.add_ons_count = row._count.taxId;
  }
  for (const row of customerLinks) {
    const c = result.get(row.taxId)!;
    c.customers_count = row._count.taxId;
  }
  return result;
}
