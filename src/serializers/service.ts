// Service serializer (v5 — sin tax stack, NetSuite calcula impuestos).

import type { Service } from '@prisma/client';
import { isoUtc } from '../services/tz.js';

export type ServiceWithLinks = Service;

export function serializeService(service: ServiceWithLinks) {
  return {
    service: {
      id: service.id,
      code: service.code,
      name: service.name,
      description: service.description ?? null,
      customer_id: service.customerId,
      currency: service.currency,
      pricing_model: service.pricingModel,
      monthly_unit_amount_cents: service.monthlyUnitAmountCents,
      setup_unit_amount_cents: service.setupUnitAmountCents,
      prepaid_months_default: service.prepaidMonthsDefault ?? null,
      status: service.status,
      terminated_at: service.terminatedAt ? isoUtc(service.terminatedAt) : null,
      metadata: service.metadata ?? {},
      created_at: isoUtc(service.createdAt),
      updated_at: isoUtc(service.updatedAt),
    },
  };
}
