// Add-on serializer matching fixtures 09a / 09b / 10 / 10b.

import type { AddOn } from '@prisma/client';
import { isoUtc } from '../services/tz.js';

export function serializeAddOn(addOn: AddOn, options: { includeDeletedAt?: boolean } = {}) {
  const data: Record<string, unknown> = {
    lago_id: addOn.id,
    name: addOn.name,
    invoice_display_name: addOn.invoiceDisplayName ?? null,
    code: addOn.code,
    amount_cents: addOn.amountCents,
    amount_currency: addOn.amountCurrency,
    created_at: isoUtc(addOn.createdAt),
    description: addOn.description ?? '',
    taxes: [],
  };
  if (options.includeDeletedAt && addOn.deletedAt) {
    data.deleted_at = isoUtc(addOn.deletedAt);
  }
  return { add_on: data };
}
