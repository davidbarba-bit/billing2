// Hard reset for a single organization. Wipes ALL data rows that belong to
// the org (customers, plans, subs, events, invoices, credit notes,
// idempotency records, etc.) but **preserves the organization row itself**
// — including its `api_key` and any NetSuite credentials. Counters
// (customer/invoice/credit_note) reset back to 0 so sequential IDs start
// from 1 again on the next create.
//
// Use cases:
//   - Reset a staging environment back to "factory new".
//   - Tear down a demo before re-running `seedNumaris`.
//   - Recover from corrupt fixture data.
//
// This is destructive. The route handler gates the call behind a separate
// auth token + body confirmation matching the org's slug.

import type { PrismaClient } from '@prisma/client';

export type ResetSummary = {
  organization_slug: string;
  cleared: {
    customers: number;
    taxes: number;
    billable_metrics: number;
    plans: number;
    add_ons: number;
    subscriptions: number;
    events: number;
    invoices: number;
    fees: number;
    credit_notes: number;
    idempotency_records: number;
    unit_labels: number;
  };
};

export async function resetOrganizationData(
  prisma: PrismaClient,
  organizationId: string,
): Promise<ResetSummary> {
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.findUnique({ where: { id: organizationId } });
    if (!org) throw new Error(`organization ${organizationId} not found`);

    // Snapshot counts before the wipe for the response.
    const [customers, taxes, bms, plans, addOns, subs, events, invoices, fees, cns, idemRecs, unitLabels] = await Promise.all([
      tx.customer.count({ where: { organizationId } }),
      tx.tax.count({ where: { organizationId } }),
      tx.billableMetric.count({ where: { organizationId } }),
      tx.plan.count({ where: { organizationId } }),
      tx.addOn.count({ where: { organizationId } }),
      tx.subscription.count({ where: { organizationId } }),
      tx.event.count({ where: { organizationId } }),
      tx.invoice.count({ where: { organizationId } }),
      tx.fee.count({ where: { invoice: { organizationId } } }),
      tx.creditNote.count({ where: { organizationId } }),
      tx.idempotencyRecord.count({ where: { organizationId } }),
      tx.unitLabel.count({ where: { customer: { organizationId } } }),
    ]);

    // Delete in dependency order. Most of these would cascade via FK
    // (onDelete: Cascade) but explicit ordering keeps the audit trail
    // readable and avoids relying on cascade behaviour for soft-delete
    // models we may add later.
    await tx.idempotencyRecord.deleteMany({ where: { organizationId } });
    await tx.creditNoteAppliedTax.deleteMany({ where: { creditNote: { organizationId } } });
    await tx.creditNoteItem.deleteMany({ where: { creditNote: { organizationId } } });
    await tx.creditNote.deleteMany({ where: { organizationId } });
    await tx.appliedTax.deleteMany({ where: { invoice: { organizationId } } });
    await tx.fee.deleteMany({ where: { invoice: { organizationId } } });
    await tx.invoice.deleteMany({ where: { organizationId } });
    await tx.unitLabel.deleteMany({ where: { customer: { organizationId } } });
    await tx.event.deleteMany({ where: { organizationId } });
    await tx.subscription.deleteMany({ where: { organizationId } });
    await tx.charge.deleteMany({ where: { plan: { organizationId } } });
    await tx.plan.deleteMany({ where: { organizationId } });
    await tx.billableMetric.deleteMany({ where: { organizationId } });
    await tx.addOnTaxLink.deleteMany({ where: { addOn: { organizationId } } });
    await tx.addOn.deleteMany({ where: { organizationId } });
    await tx.customerTaxLink.deleteMany({ where: { customer: { organizationId } } });
    await tx.tax.deleteMany({ where: { organizationId } });
    await tx.customer.deleteMany({ where: { organizationId } });

    // Reset counters; keep apiKey, slug, name, timezone, NetSuite creds.
    await tx.organization.update({
      where: { id: organizationId },
      data: { customerCounter: 0, invoiceCounter: 0, creditNoteCounter: 0 },
    });

    return {
      organization_slug: org.slug,
      cleared: {
        customers,
        taxes,
        billable_metrics: bms,
        plans,
        add_ons: addOns,
        subscriptions: subs,
        events,
        invoices,
        fees,
        credit_notes: cns,
        idempotency_records: idemRecs,
        unit_labels: unitLabels,
      },
    };
  });
}
