// Tax serializer (Numaris-native — no counters; simpler than the original
// Lago shape).

import type { Tax } from '@prisma/client';
import { isoUtc } from '../services/tz.js';

export function serializeTax(tax: Tax) {
  return {
    tax: {
      id: tax.id,
      code: tax.code,
      name: tax.name,
      description: tax.description ?? null,
      rate: Number(tax.rate),
      created_at: isoUtc(tax.createdAt),
      updated_at: isoUtc(tax.updatedAt),
    },
  };
}
