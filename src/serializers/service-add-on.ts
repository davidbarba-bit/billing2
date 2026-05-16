// ServiceAddOn serializer — per-unit recurring modifier on a service.

import type { ServiceAddOn } from '@prisma/client';
import { isoUtc } from '../services/tz.js';

export function serializeServiceAddOn(addOn: ServiceAddOn) {
  return {
    service_add_on: {
      id: addOn.id,
      service_id: addOn.serviceId,
      code: addOn.code,
      name: addOn.name,
      description: addOn.description ?? null,
      pricing_type: 'per_unit_monthly',
      amount_cents: addOn.amountCents,
      netsuite_item_code: addOn.netsuiteItemCode ?? null,
      active_from: isoUtc(addOn.activeFrom),
      active_to: addOn.activeTo ? isoUtc(addOn.activeTo) : null,
      status: addOn.activeTo === null ? 'active' : 'terminated',
      metadata: addOn.metadata ?? {},
      created_at: isoUtc(addOn.createdAt),
      updated_at: isoUtc(addOn.updatedAt),
    },
  };
}
