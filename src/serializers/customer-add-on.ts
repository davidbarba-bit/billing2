// CustomerAddOn serializer — flat recurring modifier on a customer.

import type { CustomerAddOn } from '@prisma/client';
import { isoUtc } from '../services/tz.js';

export function serializeCustomerAddOn(addOn: CustomerAddOn) {
  return {
    customer_add_on: {
      id: addOn.id,
      customer_id: addOn.customerId,
      // v22: razón social a la que se factura este add-on flat.
      tax_entity_id: addOn.taxEntityId,
      code: addOn.code,
      name: addOn.name,
      description: addOn.description ?? null,
      pricing_type: 'flat_monthly',
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
