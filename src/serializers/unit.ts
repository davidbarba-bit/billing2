// Unit serializer.

import type { Unit } from '@prisma/client';
import { isoUtc } from '../services/tz.js';

export function serializeUnit(unit: Unit) {
  return {
    unit: {
      id: unit.id,
      service_id: unit.serviceId,
      external_id: unit.externalId,
      label: unit.label ?? null,
      active_from: isoUtc(unit.activeFrom),
      active_to: unit.activeTo ? isoUtc(unit.activeTo) : null,
      // v8: billing_starts_at sobrescribe active_from solo para cálculos
      // de facturación. null → motor usa active_from.
      billing_starts_at: unit.billingStartsAt ? isoUtc(unit.billingStartsAt) : null,
      setup_billed_at: unit.setupBilledAt ? isoUtc(unit.setupBilledAt) : null,
      oneoff_billed_at: unit.oneoffBilledAt ? isoUtc(unit.oneoffBilledAt) : null,
      prepaid_months: unit.prepaidMonths ?? null,
      metadata: unit.metadata ?? {},
      status: unit.activeTo === null ? 'active' : 'terminated',
      created_at: isoUtc(unit.createdAt),
      updated_at: isoUtc(unit.updatedAt),
    },
  };
}
