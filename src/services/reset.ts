// Hard reset for a single organization. Wipes ALL operational data rows for
// the org but **preserves the organization row** (including api_key and
// NetSuite credentials). Cuestionarios de migración (MigrationQuestionnaire)
// son globales y no se tocan. Counters se resetean a 0.

import type { PrismaClient } from '@prisma/client';

export type ResetSummary = {
  organization_slug: string;
  cleared: {
    customers: number;
    services: number;
    service_add_ons: number;
    customer_add_ons: number;
    units: number;
    events: number;
    invoices: number;
    fees: number;
    credit_notes: number;
    idempotency_records: number;
    catalog_events: number;
    catalog_event_occurrences: number;
    customer_catalog_event_pricings: number;
    tax_entities: number;
  };
};

export async function resetOrganizationData(
  prisma: PrismaClient,
  organizationId: string,
): Promise<ResetSummary> {
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.findUnique({ where: { id: organizationId } });
    if (!org) throw new Error(`organization ${organizationId} not found`);

    const [
      customers, services, serviceAddOns, customerAddOns, units, events,
      invoices, fees, cns, idemRecs, catalogEvents, catalogEventOccurrences,
      customerCatalogEventPricings, taxEntities,
    ] = await Promise.all([
      tx.customer.count({ where: { organizationId } }),
      tx.service.count({ where: { organizationId } }),
      tx.serviceAddOn.count({ where: { service: { organizationId } } }),
      tx.customerAddOn.count({ where: { customer: { organizationId } } }),
      tx.unit.count({ where: { service: { organizationId } } }),
      tx.eventLog.count({ where: { organizationId } }),
      tx.invoice.count({ where: { organizationId } }),
      tx.fee.count({ where: { invoice: { organizationId } } }),
      tx.creditNote.count({ where: { organizationId } }),
      tx.idempotencyRecord.count({ where: { organizationId } }),
      tx.catalogEvent.count({ where: { organizationId } }),
      tx.catalogEventOccurrence.count({ where: { organizationId } }),
      tx.customerCatalogEventPricing.count({ where: { organizationId } }),
      tx.taxEntity.count({ where: { organizationId } }),
    ]);

    await tx.idempotencyRecord.deleteMany({ where: { organizationId } });
    await tx.creditNoteItem.deleteMany({ where: { creditNote: { organizationId } } });
    await tx.creditNote.deleteMany({ where: { organizationId } });
    await tx.fee.deleteMany({ where: { invoice: { organizationId } } });
    await tx.invoice.deleteMany({ where: { organizationId } });
    await tx.eventLog.deleteMany({ where: { organizationId } });
    await tx.catalogEventOccurrence.deleteMany({ where: { organizationId } });
    await tx.customerCatalogEventPricing.deleteMany({ where: { organizationId } });
    await tx.catalogEvent.deleteMany({ where: { organizationId } });
    await tx.unit.deleteMany({ where: { service: { organizationId } } });
    await tx.serviceAddOn.deleteMany({ where: { service: { organizationId } } });
    await tx.customerAddOn.deleteMany({ where: { customer: { organizationId } } });
    await tx.service.deleteMany({ where: { organizationId } });
    await tx.taxEntity.deleteMany({ where: { organizationId } });
    await tx.customer.deleteMany({ where: { organizationId } });

    await tx.organization.update({
      where: { id: organizationId },
      data: { customerCounter: 0, invoiceCounter: 0, creditNoteCounter: 0 },
    });

    return {
      organization_slug: org.slug,
      cleared: {
        customers,
        services,
        service_add_ons: serviceAddOns,
        customer_add_ons: customerAddOns,
        units,
        events,
        invoices,
        fees,
        credit_notes: cns,
        idempotency_records: idemRecs,
        catalog_events: catalogEvents,
        catalog_event_occurrences: catalogEventOccurrences,
        customer_catalog_event_pricings: customerCatalogEventPricings,
        tax_entities: taxEntities,
      },
    };
  });
}
