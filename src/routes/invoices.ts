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
import { buildAuthHook, requireOrg } from '../auth.js';
import { ApiError, notFound, validation } from '../errors.js';
import { hashRequestBody, IdempotencyConflictError, lookupIdempotent, recordIdempotent } from '../services/idempotency.js';
import { emitCycleInvoiceForCustomer, previewCycleInvoiceForCustomer } from '../services/cycle-billing.js';
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
      });
      if (!customer) throw notFound('customer');

      const periodOverride = (payload.period_from && payload.period_to)
        ? { from: new Date(payload.period_from), to: new Date(payload.period_to) }
        : null;

      const result = await emitCycleInvoiceForCustomer({
        prisma,
        dispatcher: opts.dispatcher,
        callbackBaseUrl: opts.callbackBaseUrl,
        org,
        customer,
        periodOverride,
        idempotencyKey,
        metadata: payload.metadata ?? {},
        log: request.log,
      });

      // v19: si el customer está en modo split, el cierre puede emitir hasta
      // 2 invoices. La respuesta principal es la primera (orden estable:
      // recurrente primero, único después). El campo opcional companion_invoice
      // expone la segunda si existe — los clientes API que no la usan ignoran
      // este campo sin romperse.
      if (result.invoices.length === 0) {
        // Sin fees → no se emitió nada. Devolvemos 422 explícito para que el
        // caller distinga este caso de un duplicado idempotente.
        throw new ApiError(422, 'no_billable_items', {
          errorDetails: { invoice: ['no_fees_for_period'] },
        });
      }
      const primary = await loadInvoice(prisma, result.invoices[0]!.id);
      const responseBody = serializeInvoice(primary) as Record<string, unknown>;
      if (result.invoices.length > 1) {
        const companion = await loadInvoice(prisma, result.invoices[1]!.id);
        responseBody.companion_invoice = (serializeInvoice(companion) as { invoice: unknown }).invoice;
      }
      await recordIdempotent(prisma, org.id, '/api/v1/invoices', idempotencyKey, bodyHash, 200, responseBody);
      reply.send(responseBody);
    },
  });

  // v7: dry-run / preview. Calcula la cycle invoice SIN persistir, SIN
  // marcar units como facturadas y SIN dispatchar. Re-ejecutable infinitas
  // veces — útil para iterar precios, units, add-ons y verificar el output
  // antes de cerrar el ciclo de verdad. Acepta override de periodo y de
  // `now` (este último simula "qué pasaría si hoy fuera X" y sirve para
  // probar el cambio de precio programado).
  app.route({
    method: 'POST',
    url: '/api/v1/invoices/preview',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = (request.body ?? {}) as {
        invoice?: {
          customer_external_id?: string;
          period_from?: string;
          period_to?: string;
          now?: string;
        };
      };
      const payload = body.invoice;
      if (!payload?.customer_external_id) {
        throw validation({ customer_external_id: ['value_is_mandatory'] });
      }
      const customer = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId: payload.customer_external_id } },
      });
      if (!customer) throw notFound('customer');

      const hasFrom = typeof payload.period_from === 'string' && payload.period_from.length > 0;
      const hasTo = typeof payload.period_to === 'string' && payload.period_to.length > 0;
      if (hasFrom !== hasTo) {
        throw validation({ period: ['period_from_and_period_to_must_be_both_present_or_both_absent'] });
      }
      let periodOverride: { from: Date; to: Date } | null = null;
      if (hasFrom && hasTo) {
        const from = new Date(payload.period_from!);
        const to = new Date(payload.period_to!);
        if (Number.isNaN(from.getTime())) throw validation({ period_from: ['must_be_iso_datetime'] });
        if (Number.isNaN(to.getTime())) throw validation({ period_to: ['must_be_iso_datetime'] });
        if (to <= from) throw validation({ period_to: ['must_be_after_period_from'] });
        periodOverride = { from, to };
      }
      let now: Date | undefined;
      if (typeof payload.now === 'string' && payload.now.length > 0) {
        const n = new Date(payload.now);
        if (Number.isNaN(n.getTime())) throw validation({ now: ['must_be_iso_datetime'] });
        now = n;
      }

      const preview = await previewCycleInvoiceForCustomer({
        prisma, org, customer, periodOverride, now,
      });
      reply.send({ preview });
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
            customer: { include: { organization: true } },
            fees: true,
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
      customer: { include: { organization: true } },
      fees: true,
    },
  });
  if (!invoice) throw notFound('invoice');
  return invoice;
}

function emptyMeta(page: number) {
  return { current_page: page, next_page: null, prev_page: null, total_pages: 1, total_count: 0 };
}

export { loadInvoice };
