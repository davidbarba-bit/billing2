// Invoice routes (Numaris-native).
//
// POST /api/v1/invoices
//   {
//     "invoice": {
//       "service_code": "...",      // service to invoice
//       "period_from": "...",       // optional override of current period
//       "period_to": "...",         // optional override
//       "metadata": { "idempotency_key": "..." }
//     }
//   }
//
// Idempotent via header `Idempotency-Key` + metadata.idempotency_key (must
// match if both present). Caller-driven: the cron does NOT auto-emit.

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { DateTime } from 'luxon';
import { buildAuthHook, requireOrg } from '../auth.js';
import { ApiError, notFound, validation } from '../errors.js';
import { applicableTimezone, isoDateIn } from '../services/tz.js';
import { billingPeriodFor, computeInvoiceLines, markSetupsBilled } from '../services/billing-engine.js';
import { hashRequestBody, IdempotencyConflictError, lookupIdempotent, recordIdempotent } from '../services/idempotency.js';
import { serializeInvoice, type InvoiceWithRelations } from '../serializers/invoice.js';
import type { AppConfig } from '../config.js';
import type { NetSuiteDispatcher } from '../services/netsuite-dispatcher.js';

type InvoicePayload = {
  service_code?: string;
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
      if (!payload?.service_code) throw validation({ service_code: ['value_is_mandatory'] });

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

      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: payload.service_code } },
        include: {
          customer: { include: { organization: true, taxLinks: { include: { tax: true } } } },
          taxLinks: { include: { tax: true } },
          units: true,
          addOns: true,
        },
      });
      if (!service) throw notFound('service');

      // Resolve tax stack: service-level if set, customer-level fallback.
      const taxes = service.taxLinks.length > 0
        ? service.taxLinks.map((l) => l.tax)
        : service.customer.taxLinks.map((l) => l.tax);

      const tz = applicableTimezone(service.customer.timezone, org.timezone);
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
        : billingPeriodFor(service, tz, now);

      const computed = computeInvoiceLines({
        service,
        periodStart: period.start,
        periodEnd: period.end,
        daysInPeriod: period.daysInPeriod,
        units: service.units,
        addOns: service.addOns,
        taxes,
      });

      const issuingDate = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(tz).startOf('day').toUTC().toJSDate();

      const created = await prisma.$transaction(async (tx) => {
        const orgUpdate = await tx.organization.update({
          where: { id: org.id },
          data: { invoiceCounter: { increment: 1 } },
          select: { invoiceCounter: true },
        });
        const sequentialId = orgUpdate.invoiceCounter;

        // Build units annex with fee.id placeholder; we replace them after
        // fees are created. To keep this simple we store annex as JSON with
        // `kind` (no fee.id since the fee row gives that context already).
        const invoice = await tx.invoice.create({
          data: {
            organizationId: org.id,
            customerId: service.customerId,
            serviceId: service.id,
            sequentialId,
            currency: service.currency,
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
              serviceId: service.id,
              addOnId: fee.addOnId ?? null,
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
          // Stamp setup_billed_at for the units this setup fee captures.
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
              amountCurrency: service.currency,
              feesAmountCents: computed.feesAmountCents,
            },
          });
        }

        return invoice;
      });

      // Dispatch to NetSuite (fake or real depending on flag).
      const hydrated = await loadInvoice(prisma, created.id);
      try {
        const dispatchPayload = buildDispatchPayload(hydrated, taxes.map((t) => t.code), opts.callbackBaseUrl);
        const result = await opts.dispatcher.dispatch(org, dispatchPayload, 'invoice');
        await prisma.invoice.update({
          where: { id: hydrated.id },
          data: result.status === 'accepted'
            ? {
                externalDispatchStatus: 'dispatched',
                netsuiteDispatchId: result.netsuiteInternalId ?? null,
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
          data: {
            externalDispatchStatus: 'failed',
            externalDispatchError: err instanceof Error ? err.message : String(err),
          },
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
      const q = request.query as { per_page?: string; page?: string; customer_external_id?: string; service_code?: string; status?: string };
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
      if (q.service_code) {
        const s = await prisma.service.findUnique({
          where: { organizationId_code: { organizationId: org.id, code: q.service_code } },
        });
        if (!s) {
          reply.send({ invoices: [], meta: emptyMeta(page) });
          return;
        }
        where.serviceId = s.id;
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

// Re-export for tests.
export { loadInvoice };
export type _Unused = typeof isoDateIn;
