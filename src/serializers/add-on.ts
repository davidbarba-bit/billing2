// AddOn serializer.

import type { AddOn } from '@prisma/client';
import { isoUtc } from '../services/tz.js';

export function serializeAddOn(addOn: AddOn) {
  return {
    add_on: {
      id: addOn.id,
      service_id: addOn.serviceId,
      code: addOn.code,
      name: addOn.name,
      description: addOn.description ?? null,
      pricing_type: addOn.pricingType,
      amount_cents: addOn.amountCents,
      active_from: isoUtc(addOn.activeFrom),
      active_to: addOn.activeTo ? isoUtc(addOn.activeTo) : null,
      status: addOn.activeTo === null ? 'active' : 'terminated',
      metadata: addOn.metadata ?? {},
      created_at: isoUtc(addOn.createdAt),
      updated_at: isoUtc(addOn.updatedAt),
    },
  };
}
