// Service serializer (v7 — expone precio efectivo + cambio pendiente).
// `monthly_unit_amount_cents` y `setup_unit_amount_cents` reflejan el precio
// EFECTIVO AHORA (si hay un pending con effective_from <= ahora, sus valores
// ganan). `pending_price_change` describe un cambio programado a futuro;
// es null cuando no hay pending o cuando el pending ya está en vigor.

import type { Service } from '@prisma/client';
import { effectivePriceFor } from '../services/billing-engine.js';
import { isoUtc } from '../services/tz.js';

export type ServiceWithLinks = Service;

export function serializeService(service: ServiceWithLinks) {
  const now = new Date();
  const effective = effectivePriceFor(service, now);
  const pendingInFuture =
    service.pendingEffectiveFrom !== null
    && service.pendingMonthlyUnitAmountCents !== null
    && service.pendingSetupUnitAmountCents !== null
    && service.pendingEffectiveFrom > now;
  return {
    service: {
      id: service.id,
      code: service.code,
      name: service.name,
      description: service.description ?? null,
      customer_id: service.customerId,
      currency: service.currency,
      pricing_model: service.pricingModel,
      monthly_unit_amount_cents: effective.monthlyUnitAmountCents,
      setup_unit_amount_cents: effective.setupUnitAmountCents,
      // v17: cargo de baja per-unit. No tiene mecanismo de pending (siempre
      // refleja el valor "vigente"); cambia con PATCH /api/v1/services/:code.
      removal_unit_amount_cents: service.removalUnitAmountCents,
      // v18: modo de emisión por concepto.
      setup_billing_mode: service.setupBillingMode,
      removal_billing_mode: service.removalBillingMode,
      pending_price_change: pendingInFuture
        ? {
            monthly_unit_amount_cents: service.pendingMonthlyUnitAmountCents!,
            setup_unit_amount_cents: service.pendingSetupUnitAmountCents!,
            effective_from: isoUtc(service.pendingEffectiveFrom!),
          }
        : null,
      prepaid_months_default: service.prepaidMonthsDefault ?? null,
      // v9: códigos NetSuite por kind de fee. monthly mapea tanto a fees
      // kind=monthly (recurring) como a fees kind=one_off (mensualidades
      // prepagadas) — es la misma "renta mensual" conceptual.
      netsuite_monthly_item_code: service.netsuiteMonthlyItemCode ?? null,
      netsuite_setup_item_code: service.netsuiteSetupItemCode ?? null,
      netsuite_removal_item_code: service.netsuiteRemovalItemCode ?? null,
      status: service.status,
      terminated_at: service.terminatedAt ? isoUtc(service.terminatedAt) : null,
      metadata: service.metadata ?? {},
      created_at: isoUtc(service.createdAt),
      updated_at: isoUtc(service.updatedAt),
    },
  };
}
