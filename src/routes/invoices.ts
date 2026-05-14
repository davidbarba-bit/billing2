// Invoice routes (v3 — per Customer).
//
// POST /api/v1/invoices
//   {
//     "invoice": {
//       "customer_external_id": "...",
//       "period_from": "...",       // opcional override
//       "period_to": "...",         // opcional override
//       "metadata": { "idempotency_key": "..." }
//     }
//   }
//
// Genera UNA invoice por customer agregando fees de TODOS sus services
// activos + sus customer-level add-ons + impuestos.

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { DateTime } from 'luxon';
import { buildAuthHook, requireOrg } from '../auth.js';
import { ApiError, notFound, validation } from '../errors.js';
import { applicableTimezone } from '../services/tz.js';
import { billingPeriodFor, computeCustomerInvoice, markSetupsBilled } from '../services/billing-engine.js';
import { hashRequestBody, IdempotencyConflictError, lookupIdempotent, recordIdempotent } from '../services/idempotency.js';
import { serializeInvoice, type InvoiceWithRelations } from '../serializers/invoice.js';
import type { AppConfig } from '../config.js';
import type { NetSuiteDispatcher } from '../services/netsuite-dispatcher.js';

type InvoicePayload = {
  customer_external_id?: string;
  period_from?: string;
  period_to?: string;
  metadata?: Record<string, unknown> & { idempotency_key?: string };
};

export function registerInvoiceRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  opts: { config: AppConfig; dispatcher: NetSuiteDispatcher; callbackBaseUrl: string },
): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/invoices',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = (request.body ?? {}) as { invoice?: InvoicePayload };
      const payload = body.invoice;
      if (!payload?.customer_external_id) {
        throw validation({ customer_external_id: ['value_is_mandatory'] });
      }

      // Idempotency reconciliation.
      const headerKey = request.headers['idempotency-key'];
      const headerKeyStr = Array.isArray(headerKey) ? headerKey[0] : headerKey;
      const metaKey = payload.metadata?.idempotency_key;
      let idempotencyKey: string;
      if (headerKeyStr && metaKey) {
        if (headerKeyStr !== metaKey) {
          throw new ApiError(422, 'idempotency_key_mismatch', {
            errorDetails: { idempotency_key: ['header_metadata_mismatch'] },
          });
        }
        idempotencyKey = headerKeyStr;
      } else if (headerKeyStr) idempotencyKey = headerKeyStr;
      else if (metaKey) idempotencyKey = metaKey;
      else idempotencyKey = `auto-${hashRequestBody(body)}`;
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
        where: { organizationId_externalId: { organizationId: org.id, externalId: payload.customer_external_id } },
        include: {
          organization: true,
          taxLinks: { include: { tax: true } },
          services: {
            where: { status: 'active' },
            include: {
              units: true,
              addOns: true,
              taxLinks: { include: { tax: true } },
            },
          },
          addOns: { where: { activeTo: null } },
        },
      });
      if (!customer) throw notFound('customer');

      // Tax stack: customer-level (services don't have their own tax stack
      // in v3 — they inherit from the customer).
      const taxes = customer.taxLinks.map((l) => l.tax);

      const tz = applicableTimezone(customer.timezone, org.timezone);
      const now = new Date();
      const periodStart = payload.period_from ? new Date(payload.period_from) : null;
      const periodEnd = payload.period_to ? new Date(payload.period_to) : null;
      const period = periodStart && periodEnd
        ? {
            start: periodStart,
            end: periodEnd,
            daysInPeriod: Math.max(1, Math.round(
              DateTime.fromJSDate(periodEnd, { zone: 'utc' }).plus({ seconds: 1 }).diff(
                DateTime.fromJSDate(periodStart, { zone: 'utc' }),
                'days',
              ).days,
            )),
          }
        : billingPeriodFor(customer, tz, now);

      // Add-ons filtered down to those that overlap the period.
      const customerAddOns = await prisma.customerAddOn.findMany({
        where: {
          customerId: customer.id,
          activeFrom: { lte: period.end },
          OR: [{ activeTo: null }, { activeTo: { gte: period.start } }],
        },
      });

      const computed = computeCustomerInvoice({
        customer,
        services: customer.services,
        customerAddOns,
        taxes,
        periodStart: period.start,
        periodEnd: period.end,
        daysInPeriod: period.daysInPeriod,
      });

      const issuingDate = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(tz).startOf('day').toUTC().toJSDate();

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
            currency: customer.currency,
            status: 'calculated',
            externalDispatchStatus: 'pending',
            paymentStatus: 'pending',
            issuingDate,
            paymentDueDate: issuingDate,
            feesAmountCents: computed.feesAmountCents,
            taxesAmountCents: computed.taxesAmountCents,
            totalAmountCents: computed.totalAmountCents,
            periodFrom: period.start,
            periodTo: period.end,
            unitsAnnex: computed.unitsAnnex as object,
            metadata: { ...(payload.metadata ?? {}), idempotency_key: idempotencyKey } as object,
            idempotencyKey,
          },
        });

        for (let i = 0; i < computed.fees.length; i++) {
          const fee = computed.fees[i]!;
          await tx.fee.create({
            data: {
              invoiceId: invoice.id,
              serviceId: fee.serviceId ?? null,
              serviceAddOnId: fee.serviceAddOnId ?? null,
              customerAddOnId: fee.customerAddOnId ?? null,
              kind: fee.kind,
              description: fee.description,
              units: fee.units,
              unitAmountCents: fee.unitAmountCents,
              preciseUnitAmount: fee.preciseUnitAmount,
              amountCents: fee.amountCents,
              taxesAmountCents: fee.taxesAmountCents,
              taxesRate: new Decimal(fee.taxesRate) as unknown as Prisma.Decimal,
              totalAmountCents: fee.totalAmountCents,
              billedUnitsDetail: fee.billedUnitsDetail as object,
              position: i,
            },
          });
          if (fee.kind === 'setup' && fee.unitIds.length > 0) {
            await markSetupsBilled(tx as unknown as PrismaClient, fee.unitIds, now);
          }
        }

        for (const { tax, amountCents } of computed.appliedTaxes) {
          await tx.appliedTax.create({
            data: {
              invoiceId: invoice.id,
              taxId: tax.id,
              taxName: tax.name,
              taxCode: tax.code,
              taxRate: tax.rate,
              taxDescription: tax.description,
              amountCents,
              amountCurrency: customer.currency,
              feesAmountCents: computed.feesAmountCents,
            },
          });
        }

        return invoice;
      });

      // Dispatch to NetSuite (or short-circuit if feature flag is off).
      const hydrated = await loadInvoice(prisma, created.id);
      try {
        const dispatchPayload = buildDispatchPayload(hydrated, taxes.map((t) => t.code), opts.callbackBaseUrl);
        const result = await opts.dispatcher.dispatch(org, dispatchPayload, 'invoice');
        await prisma.invoice.update({
          where: { id: hydrated.id },
          data: result.status === 'accepted'
            ? { externalDispatchStatus: 'dispatched', netsuiteDispatchId: result.netsuiteInternalId ?? null }
            : { externalDispatchStatus: 'failed', externalDispatchError: result.error ?? 'dispatch_failed' },
        });
      } catch (err) {
        request.log.error({ err }, 'netsuite dispatch failed');
        await prisma.invoice.update({
          where: { id: hydrated.id },
          data: { externalDispatchStatus: 'failed', externalDispatchError: err instanceof Error ? err.message : String(err) },
        });
      }

      const final = await loadInvoice(prisma, created.id);
      const responseBody = serializeInvoice(final);
      await recordIdempotent(prisma, org.id, '/api/v1/invoices', idempotencyKey, bodyHash, 200, responseBody);
      reply.send(responseBody);
    },
  });

  app.route({
    method: 'GET',
    url: '/api/v1/invoices',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as { per_page?: string; page?: string; customer_external_id?: string; status?: string };
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const where: Prisma.InvoiceWhereInput = { organizationId: org.id };
      if (q.customer_external_id) {
        const c = await prisma.customer.findUnique({
          where: { organizationId_externalId: { organizationId: org.id, externalId: q.customer_external_id } },
        });
        if (!c) {
          reply.send({ invoices: [], meta: emptyMeta(page) });
          return;
        }
        where.customerId = c.id;
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

  app.route({
    method: 'GET',
    url: '/api/v1/invoices/:id',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const invoice = await prisma.invoice.findFirst({ where: { id, organizationId: org.id } });
      if (!invoice) throw notFound('invoice');
      const hydrated = await loadInvoice(prisma, invoice.id);
      reply.send(serializeInvoice(hydrated));
    },
  });

  app.route({
    method: 'POST',
    url: '/api/v1/invoices/:id/void',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const invoice = await prisma.invoice.findFirst({ where: { id, organizationId: org.id } });
      if (!invoice) throw notFound('invoice');
      if (invoice.status !== 'voided') {
        await prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'voided' } });
      }
      const hydrated = await loadInvoice(prisma, invoice.id);
      reply.send(serializeInvoice(hydrated));
    },
  });
}

async function loadInvoice(prisma: PrismaClient, id: string): Promise<InvoiceWithRelations> {
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

function buildDispatchPayload(invoice: InvoiceWithRelations, taxCodes: string[], callbackBaseUrl: string) {
  return {
    external_id: invoice.id,
    minilago_invoice_id: invoice.id,
    issued_at: invoice.createdAt.toISOString(),
    currency: invoice.currency,
    customer: {
      external_id: invoice.customer.externalId,
      name: invoice.customer.name,
      tax_identification_number: invoice.customer.taxIdentificationNumber,
      country: invoice.customer.country,
      tax_codes: taxCodes,
    },
    billing_period: { from: invoice.periodFrom, to: invoice.periodTo },
    lines: invoice.fees.map((f) => ({
      fee_id: f.id,
      service_id: f.serviceId,
      service_add_on_id: f.serviceAddOnId,
      customer_add_on_id: f.customerAddOnId,
      kind: f.kind,
      description: f.description,
      units: f.units,
      unit_amount_cents: f.unitAmountCents,
      amount_cents: f.amountCents,
      taxes_amount_cents: f.taxesAmountCents,
      total_amount_cents: f.totalAmountCents,
      billed_units_detail: f.billedUnitsDetail,
    })),
    units_annex: invoice.unitsAnnex,
    totals: {
      fees_amount_cents: invoice.feesAmountCents,
      taxes_amount_cents: invoice.taxesAmountCents,
      total_amount_cents: invoice.totalAmountCents,
    },
    metadata: invoice.metadata ?? {},
    callback_url: `${callbackBaseUrl}/api/v1/invoices/${invoice.id}/external-confirm`,
  };
}

function emptyMeta(page: number) {
  return { current_page: page, next_page: null, prev_page: null, total_pages: 1, total_count: 0 };
}

export { loadInvoice };
