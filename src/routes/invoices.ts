// Endpoint #11: POST /api/v1/invoices (one-off with fees[].add_on_code).
// Endpoint #11b: POST /api/v1/invoices/:lago_id/void.
//
// Idempotency (D10):
//   - Header `Idempotency-Key` ↔ `metadata.idempotency_key`.
//   - Both present: must match → if not, 422 idempotency_key_mismatch.
//   - One present: copy it into the other in the response.
//   - Neither: synthesize sha256(canonical_json(body)) and expose it.
//   - Replay with same key + same body hash → cached response.
//   - Replay with same key + different body → 422
//     idempotency_key_reused_with_different_body.

import type { FastifyInstance } from 'fastify';
import type { Charge, BillableMetric, Plan, Prisma, PrismaClient, Subscription } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { DateTime } from 'luxon';
import { buildAuthHook, requireOrg } from '../auth.js';
import { ApiError, notFound, validation } from '../errors.js';
import { applicableTimezone, anniversaryBillingPeriod, calendarBillingPeriod, isoDateIn } from '../services/tz.js';
import { computeFees } from '../services/invoice-engine.js';
import { hashRequestBody, IdempotencyConflictError, lookupIdempotent, recordIdempotent } from '../services/idempotency.js';
import { bankersRound } from '../services/rounding.js';
import { serializeInvoice } from '../serializers/invoice.js';
import type { AppConfig } from '../config.js';
import type { NetSuiteDispatcher } from '../services/netsuite-dispatcher.js';
import { buildInvoiceDispatchPayload } from '../services/dispatch-payload.js';

type FeePayload = {
  add_on_code: string;
  description?: string;
  unit_amount_cents: number;
  units: string;
};

type InvoicePayload = {
  external_customer_id?: string;
  currency?: string;
  fees?: FeePayload[];
  metadata?: Record<string, unknown> & { idempotency_key?: string };
};

export function registerInvoiceRoutes(app: FastifyInstance, prisma: PrismaClient, opts: {
  config: AppConfig;
  dispatcher: NetSuiteDispatcher;
  callbackBaseUrl: string;
}): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/invoices',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = (request.body ?? {}) as { invoice?: InvoicePayload };
      const payload = body.invoice;
      if (!payload) throw validation({ invoice: ['value_is_mandatory'] });
      if (!payload.external_customer_id) {
        throw validation({ external_customer_id: ['value_is_mandatory'] });
      }
      if (!payload.fees || payload.fees.length === 0) {
        throw validation({ fees: ['value_is_mandatory'] });
      }

      // Idempotency reconciliation.
      const headerKey = request.headers['idempotency-key'];
      const headerKeyStr = Array.isArray(headerKey) ? headerKey[0] : headerKey;
      const metadataKey = payload.metadata?.idempotency_key;
      let idempotencyKey: string;
      if (headerKeyStr && metadataKey) {
        if (headerKeyStr !== metadataKey) {
          throw new ApiError(422, 'idempotency_key_mismatch', {
            errorDetails: { idempotency_key: ['header_metadata_mismatch'] },
          });
        }
        idempotencyKey = headerKeyStr;
      } else if (headerKeyStr) {
        idempotencyKey = headerKeyStr;
      } else if (metadataKey) {
        idempotencyKey = metadataKey;
      } else {
        idempotencyKey = `auto-${hashRequestBody(body)}`;
      }

      const bodyHash = hashRequestBody(body);
      try {
        const lookup = await lookupIdempotent(prisma, org.id, '/api/v1/invoices', idempotencyKey, bodyHash);
        if (lookup.kind === 'cached') {
          reply.status(lookup.status).send(lookup.body);
          return;
        }
      } catch (err) {
        if (err instanceof IdempotencyConflictError) {
          throw new ApiError(422, 'idempotency_key_reused_with_different_body', {
            errorDetails: { idempotency_key: ['reused_with_different_body'] },
          });
        }
        throw err;
      }

      const customer = await prisma.customer.findUnique({
        where: {
          organizationId_externalId: { organizationId: org.id, externalId: payload.external_customer_id },
        },
        include: { taxLinks: { include: { tax: true } }, organization: true },
      });
      if (!customer) throw notFound('customer');

      const currency = payload.currency ?? customer.currency;

      // Resolve all add-ons referenced.
      const addOnCodes = Array.from(new Set(payload.fees.map((f) => f.add_on_code)));
      const addOns = await prisma.addOn.findMany({
        where: { organizationId: org.id, code: { in: addOnCodes } },
      });
      const addOnByCode = new Map(addOns.map((a) => [a.code, a]));
      for (let i = 0; i < payload.fees.length; i++) {
        const fee = payload.fees[i]!;
        if (!addOnByCode.has(fee.add_on_code)) {
          throw validation({ [`fees[${i}].add_on_code`]: ['not_found_in_organization'] });
        }
        if (!Number.isInteger(fee.unit_amount_cents) || fee.unit_amount_cents < 0) {
          throw validation({ [`fees[${i}].unit_amount_cents`]: ['must_be_non_negative_integer'] });
        }
        if (typeof fee.units !== 'string') {
          throw validation({ [`fees[${i}].units`]: ['must_be_string_decimal'] });
        }
      }

      const tz = applicableTimezone(customer.timezone, org.timezone);
      const now = new Date();

      const subscriptions = await prisma.subscription.findMany({
        where: { customerId: customer.id, status: { in: ['active', 'pending'] } },
        include: {
          plan: {
            include: { charges: { include: { billableMetric: true }, orderBy: { createdAt: 'asc' } } },
          },
        },
      });

      const events = await prisma.event.findMany({
        where: {
          organizationId: org.id,
          externalSubscriptionId: { in: subscriptions.map((s) => s.externalId) },
        },
        orderBy: { timestamp: 'asc' },
      });

      const unitLabelRows = await prisma.unitLabel.findMany({
        where: { customerId: customer.id },
      });
      const unitLabels = new Map<string, string | null>();
      for (const row of unitLabelRows) unitLabels.set(row.unitExternalId, row.label);

      const periodFor = (sub: Subscription) => {
        if (sub.billingTime === 'calendar') {
          return calendarBillingPeriod(now, tz);
        }
        return anniversaryBillingPeriod(sub.subscriptionAt, now, tz);
      };

      const taxRatePercent = customer.taxLinks.reduce((acc, link) => acc + Number(link.tax.rate), 0);

      const resolvedFees = payload.fees.map((f) => ({ ...f, addOn: addOnByCode.get(f.add_on_code)! }));
      const { fees: computedFees, feesAmountCents } = computeFees(resolvedFees, {
        tz,
        customerCurrency: currency,
        taxRatePercent,
        subscriptions: subscriptions as (Subscription & {
          plan: Plan & { charges: Array<Charge & { billableMetric: BillableMetric }> };
        })[],
        events: events.map((e) => ({
          timestamp: e.timestamp,
          externalSubscriptionId: e.externalSubscriptionId,
          code: e.code,
          properties: e.properties as Record<string, unknown> & {
            unit_external_id?: string;
            unit_label?: string;
            operation_type?: 'add' | 'remove';
          },
        })),
        unitLabels,
        reference: now,
        periodFor,
      });

      const taxesAmountCents = bankersRound(feesAmountCents * (taxRatePercent / 100));
      const totalAmountCents = feesAmountCents + taxesAmountCents;

      const issuingDate = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(tz).startOf('day').toUTC().toJSDate();

      // Build units_annex consolidating by (external_id, label) across fees.
      const annexMap = new Map<string, { external_id: string; label: string | null; fees: Array<{ fee_lago_id: string; item_code: string; amount_cents: number }> }>();
      for (const fee of computedFees) {
        for (const d of fee.billedUnitsDetail) {
          let entry = annexMap.get(d.external_id);
          if (!entry) {
            entry = { external_id: d.external_id, label: d.label, fees: [] };
            annexMap.set(d.external_id, entry);
          }
          if (!entry.label && d.label) entry.label = d.label;
          entry.fees.push({
            fee_lago_id: '__placeholder__', // fixed up below after persistence
            item_code: fee.itemCode,
            amount_cents: d.amount_cents,
          });
        }
      }

      const monthKey = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(tz).toFormat('yyyy-LL');

      const created = await prisma.$transaction(async (tx) => {
        const orgUpdate = await tx.organization.update({
          where: { id: org.id },
          data: { invoiceCounter: { increment: 1 } },
          select: { invoiceCounter: true },
        });
        const sequentialId = orgUpdate.invoiceCounter;
        const invoice = await tx.invoice.create({
          data: {
            organizationId: org.id,
            customerId: customer.id,
            sequentialId,
            currency,
            invoiceType: 'one_off',
            status: 'calculated',
            externalDispatchStatus: 'pending',
            paymentStatus: 'pending',
            issuingDate,
            paymentDueDate: issuingDate,
            netPaymentTerm: customer.netPaymentTerm ?? 0,
            feesAmountCents,
            taxesAmountCents,
            subTotalExcludingTaxesAmountCents: feesAmountCents,
            subTotalIncludingTaxesAmountCents: totalAmountCents,
            totalAmountCents,
            unitsAnnex: [] as object,
            metadata: { ...(payload.metadata ?? {}), idempotency_key: idempotencyKey } as object,
            idempotencyKey,
          },
        });

        const persistedFees = [] as Array<{ feeId: string; itemCode: string }>;
        for (let i = 0; i < computedFees.length; i++) {
          const fee = computedFees[i]!;
          const lineTaxCents = bankersRound(fee.amountCents * (taxRatePercent / 100));
          const createdFee = await tx.fee.create({
            data: {
              invoiceId: invoice.id,
              addOnId: fee.addOnId,
              externalSubscriptionId: fee.externalSubscriptionId,
              itemType: 'add_on',
              itemCode: fee.itemCode,
              itemName: fee.itemName,
              itemInvoiceDisplayName: fee.itemInvoiceDisplayName,
              itemLagoItemId: fee.itemLagoItemId,
              itemClassType: 'AddOn',
              amountCents: fee.amountCents,
              amountCurrency: currency,
              taxesAmountCents: lineTaxCents,
              taxesRate: new Decimal(taxRatePercent) as unknown as Prisma.Decimal,
              totalAmountCents: fee.amountCents + lineTaxCents,
              units: fee.unitsStr,
              description: fee.description,
              preciseUnitAmount: fee.preciseUnitAmount,
              billedUnitsDetail: fee.billedUnitsDetail as object,
              position: i,
            },
          });
          persistedFees.push({ feeId: createdFee.id, itemCode: fee.itemCode });
        }

        // Fix up annex fee_lago_id placeholders.
        const annex: Array<{ external_id: string; label: string | null; fees: Array<{ fee_lago_id: string; item_code: string; amount_cents: number }> }> = [];
        for (const [, entry] of annexMap) {
          const fees = entry.fees.map((f) => {
            const persisted = persistedFees.find((p) => p.itemCode === f.item_code);
            return { ...f, fee_lago_id: persisted ? persisted.feeId : f.fee_lago_id };
          });
          annex.push({ ...entry, fees });
        }
        annex.sort((a, b) => (a.external_id < b.external_id ? -1 : 1));

        // Persist applied_taxes (one row per applied tax, sum across fees).
        for (const link of customer.taxLinks) {
          const tax = link.tax;
          await tx.appliedTax.create({
            data: {
              invoiceId: invoice.id,
              taxId: tax.id,
              taxName: tax.name,
              taxCode: tax.code,
              taxRate: tax.rate,
              taxDescription: tax.description,
              amountCents: taxesAmountCents,
              amountCurrency: currency,
              feesAmountCents,
            },
          });
        }

        await tx.invoice.update({
          where: { id: invoice.id },
          data: { unitsAnnex: annex as object },
        });

        return invoice;
      });

      // Dispatch to NetSuite (D11). The dispatcher decides whether to do real
      // OAuth or short-circuit when the feature flag is off.
      const hydrated = await loadInvoice(prisma, created.id);
      try {
        const callbackUrl = `${opts.callbackBaseUrl}/api/v1/invoices/${hydrated.id}/external-confirm`;
        const dispatchPayload = buildInvoiceDispatchPayload({
          organization: org,
          customer: hydrated.customer,
          invoice: hydrated,
          fees: hydrated.fees,
          unitsAnnex: hydrated.unitsAnnex as Array<{ external_id: string; label: string | null; fees: unknown[] }>,
          customerTaxCodes: customer.taxLinks.map((l) => l.tax.code),
          monthKey,
          timezone: tz,
          callbackUrl,
        });
        const result = await opts.dispatcher.dispatch(org, dispatchPayload, 'invoice');
        await prisma.invoice.update({
          where: { id: hydrated.id },
          data: result.status === 'accepted'
            ? {
                externalDispatchStatus: 'dispatched',
                netsuiteDispatchId: result.netsuiteInternalId ?? null,
                netsuiteInternalId: result.netsuiteInternalId ?? null,
              }
            : {
                externalDispatchStatus: 'failed',
                externalDispatchError: result.error ?? 'dispatch_failed',
              },
        });
      } catch (err) {
        request.log.error({ err }, 'netsuite dispatch failed');
        await prisma.invoice.update({
          where: { id: hydrated.id },
          data: { externalDispatchStatus: 'failed', externalDispatchError: err instanceof Error ? err.message : String(err) },
        });
      }

      const finalInvoice = await loadInvoice(prisma, created.id);
      const responseBody = serializeInvoice(finalInvoice);
      await recordIdempotent(prisma, org.id, '/api/v1/invoices', idempotencyKey, bodyHash, 200, responseBody);
      reply.send(responseBody);
    },
  });

  // #11b void.
  app.route({
    method: 'POST',
    url: '/api/v1/invoices/:lagoId/void',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { lagoId } = request.params as { lagoId: string };
      const invoice = await prisma.invoice.findFirst({ where: { id: lagoId, organizationId: org.id } });
      if (!invoice) throw notFound('invoice');
      if (invoice.status !== 'voided') {
        await prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'voided' } });
      }
      const hydrated = await loadInvoice(prisma, invoice.id);
      reply.send(serializeInvoice(hydrated));
    },
  });

  // GET /api/v1/invoices (paginated list, Lago-compat).
  app.route({
    method: 'GET',
    url: '/api/v1/invoices',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as { per_page?: string; page?: string; external_customer_id?: string; status?: string };
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const where: import('@prisma/client').Prisma.InvoiceWhereInput = { organizationId: org.id };
      if (q.external_customer_id) {
        const customer = await prisma.customer.findUnique({
          where: { organizationId_externalId: { organizationId: org.id, externalId: q.external_customer_id } },
        });
        if (!customer) {
          reply.send({ invoices: [], meta: { current_page: page, next_page: null, prev_page: null, total_pages: 1, total_count: 0 } });
          return;
        }
        where.customerId = customer.id;
      }
      if (q.status) where.status = q.status;
      const [items, totalCount] = await Promise.all([
        prisma.invoice.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: perPage,
          skip: (page - 1) * perPage,
          include: {
            customer: { include: { organization: true, taxLinks: { include: { tax: true } } } },
            fees: true,
            appliedTaxes: true,
          },
        }),
        prisma.invoice.count({ where }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        invoices: items.map((i) => serializeInvoice(i).invoice),
        meta: {
          current_page: page,
          next_page: page < totalPages ? page + 1 : null,
          prev_page: page > 1 ? page - 1 : null,
          total_pages: totalPages,
          total_count: totalCount,
        },
      });
    },
  });

  // GET /api/v1/invoices/:lago_id (single read, Lago-compat).
  app.route({
    method: 'GET',
    url: '/api/v1/invoices/:lagoId',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { lagoId } = request.params as { lagoId: string };
      const invoice = await prisma.invoice.findFirst({
        where: { id: lagoId, organizationId: org.id },
      });
      if (!invoice) throw notFound('invoice');
      const hydrated = await loadInvoice(prisma, invoice.id);
      reply.send(serializeInvoice(hydrated));
    },
  });
}

async function loadInvoice(prisma: PrismaClient, id: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      customer: { include: { organization: true, taxLinks: { include: { tax: true } } } },
      fees: true,
      appliedTaxes: true,
    },
  });
  if (!invoice) throw notFound('invoice');
  return invoice;
}

// Re-exported for tests that need to embed an invoice issued_at date.
export function utcIsoDateOnly(d: Date, tz: string): string {
  return isoDateIn(d, tz);
}
