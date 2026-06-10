// v21: rutas del catálogo de eventos únicos facturables (revisión de
// dispositivo, capacitación, reinstalación, etc.). El catálogo se gestiona
// desde el admin; aquí solo se exponen lecturas y la API para registrar
// ocurrencias que detonan facturación inmediata o al cierre del próximo
// ciclo.

import type { FastifyInstance } from 'fastify';
import type { Customer, PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { notFound, validation } from '../errors.js';
import {
  dispatchInvoiceInBackground,
  emitImmediateInvoice,
} from '../services/immediate-invoice.js';
import type { ComputedInvoice } from '../services/billing-engine.js';
import type { NetSuiteDispatcher } from '../services/netsuite-dispatcher.js';
import { rejectUnknownFields } from '../services/payload.js';
import { resolveTaxEntityIdForCustomer } from '../services/tax-entity.js';

// El API público acepta solo los campos comerciales de la ocurrencia. El monto
// (amount_cents) y el momento de facturación (billing_mode) se toman del
// pricing pactado del cliente para ese código de evento (tabla
// customer_catalog_event_pricing) — no del request body. La razón social
// (tax_entity_id) se resuelve al default del cliente.
const ALLOWED_FIELDS = [
  'catalog_event_code', 'customer_external_id', 'unit_external_id',
  'reference', 'occurred_at',
] as const;

type OccurrencePayload = {
  catalog_event_code?: string;
  customer_external_id?: string;
  unit_external_id?: string | null;
  reference?: string | null;
  occurred_at?: string;
};

type Deps = {
  dispatcher: NetSuiteDispatcher;
  callbackBaseUrl: string;
};

function serializeCatalogEvent(e: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  defaultAmountCents: number | null;
  netsuiteItemCode: string | null;
  active: boolean;
}): object {
  return {
    catalog_event: {
      id: e.id,
      code: e.code,
      name: e.name,
      description: e.description,
      default_amount_cents: e.defaultAmountCents,
      netsuite_item_code: e.netsuiteItemCode,
      active: e.active,
    },
  };
}

function serializeOccurrence(o: {
  id: string;
  catalogEventId: string;
  customerId: string;
  taxEntityId: string;
  unitExternalId: string | null;
  amountCents: number;
  billingMode: string;
  reference: string | null;
  occurredAt: Date;
  feeId: string | null;
  createdAt: Date;
}, invoiceId?: string | null): object {
  return {
    catalog_event_occurrence: {
      id: o.id,
      catalog_event_id: o.catalogEventId,
      customer_id: o.customerId,
      // v22: razón social a la que se factura esta ocurrencia.
      tax_entity_id: o.taxEntityId,
      unit_external_id: o.unitExternalId,
      amount_cents: o.amountCents,
      billing_mode: o.billingMode,
      reference: o.reference,
      occurred_at: o.occurredAt.toISOString(),
      fee_id: o.feeId,
      invoice_id: invoiceId ?? null,
      created_at: o.createdAt.toISOString(),
    },
  };
}

export function registerCatalogEventRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  deps: Deps,
): void {
  const authenticate = buildAuthHook(prisma);

  // GET /api/v1/catalog-events — lista del catálogo activo.
  app.route({
    method: 'GET',
    url: '/api/v1/catalog-events',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const items = await prisma.catalogEvent.findMany({
        where: { organizationId: org.id },
        orderBy: { name: 'asc' },
      });
      reply.send({
        catalog_events: items.map((e) => (serializeCatalogEvent(e) as { catalog_event: object }).catalog_event),
      });
    },
  });

  // POST /api/v1/catalog-events/occurrences — registra una ocurrencia.
  //
  // body: {
  //   catalog_event_occurrence: {
  //     catalog_event_code: string;          // (req) código del evento en el catálogo
  //     customer_external_id: string;        // (req) external_id del cliente
  //     billing_mode: 'immediate'|'next_cycle';  // (req) cuándo facturar
  //     amount_cents?: number;               // override; si no, usa default del catálogo
  //     unit_external_id?: string;           // referencia opcional a unidad
  //     reference?: string;                  // notas / id externo
  //     occurred_at?: string;                // ISO; default = now
  //   }
  // }
  app.route({
    method: 'POST',
    url: '/api/v1/catalog-events/occurrences',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = request.body as { catalog_event_occurrence?: Record<string, unknown> } | null;
      rejectUnknownFields(body?.catalog_event_occurrence, ALLOWED_FIELDS);
      const payload = body?.catalog_event_occurrence as OccurrencePayload | undefined;
      if (!payload) throw validation({ catalog_event_occurrence: ['value_is_mandatory'] });
      if (!payload.catalog_event_code) throw validation({ catalog_event_code: ['value_is_mandatory'] });
      if (!payload.customer_external_id) throw validation({ customer_external_id: ['value_is_mandatory'] });

      const event = await prisma.catalogEvent.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: payload.catalog_event_code } },
      });
      if (!event) throw notFound('catalog_event');
      if (!event.active) throw validation({ catalog_event_code: ['catalog_event_inactive'] });

      const customer = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId: payload.customer_external_id } },
      });
      if (!customer) throw notFound('customer');

      // Precio + modo vienen del pricing pactado del cliente para este evento.
      // Si no está configurado el admin debe crearlo primero (UI en customer
      // detail → "Precios de eventos facturables").
      const pricing = await prisma.customerCatalogEventPricing.findUnique({
        where: { customerId_catalogEventId: { customerId: customer.id, catalogEventId: event.id } },
      });
      if (!pricing) {
        throw validation({
          catalog_event_code: ['customer_catalog_event_pricing_not_set'],
        });
      }
      const amount = pricing.amountCents;
      const billingMode = pricing.billingMode as 'immediate' | 'next_cycle';

      const occurredAt = payload.occurred_at ? new Date(payload.occurred_at) : new Date();
      if (Number.isNaN(occurredAt.getTime())) {
        throw validation({ occurred_at: ['invalid_iso_datetime'] });
      }

      // Razón social receptora — el dev no la decide. Siempre se resuelve a la
      // default del cliente; el admin maneja multi-RFC si aplica.
      const taxEntityId = await resolveTaxEntityIdForCustomer(prisma, customer.id, null);

      const occurrence = await prisma.catalogEventOccurrence.create({
        data: {
          organizationId: org.id,
          catalogEventId: event.id,
          customerId: customer.id,
          taxEntityId,
          unitExternalId: payload.unit_external_id ?? null,
          amountCents: amount,
          billingMode,
          reference: payload.reference ?? null,
          occurredAt,
        },
      });

      // Caso 'immediate': emite invoice individual con UNA fee kind='catalog_event'
      // y la enlaza a la ocurrencia. Dispatch async post-respuesta.
      let invoiceId: string | null = null;
      if (billingMode === 'immediate') {
        const descParts = [event.name];
        if (occurrence.unitExternalId) descParts.push(occurrence.unitExternalId);
        if (occurrence.reference) descParts.push(`(${occurrence.reference})`);
        const computed: ComputedInvoice = {
          fees: [{
            kind: 'catalog_event',
            catalogEventOccurrenceId: occurrence.id,
            description: descParts.join(' — '),
            units: '1.0000',
            unitAmountCents: amount,
            preciseUnitAmount: (amount / 100).toFixed(2),
            amountCents: amount,
            netsuiteItemCode: event.netsuiteItemCode,
            billedUnitsDetail: [],
            unitIds: [],
          }],
          feesAmountCents: amount,
          unitsAnnex: [],
        };

        const result = await emitImmediateInvoice({
          prisma,
          organization: org,
          customer: customer as Customer,
          taxEntityId,
          computed,
          trigger: 'catalog_event_immediate',
          idempotencyKey: `catalog_event_immediate:${occurrence.id}`,
          metadata: { catalog_event_code: event.code, catalog_event_occurrence_id: occurrence.id },
          now: occurredAt,
        });
        invoiceId = result.invoiceId;

        if (result.created) {
          dispatchInvoiceInBackground(prisma, org.id, result.invoiceId, deps.dispatcher, deps.callbackBaseUrl, request.log);
        }
      }

      const refreshed = await prisma.catalogEventOccurrence.findUniqueOrThrow({
        where: { id: occurrence.id },
      });
      reply.send(serializeOccurrence(refreshed, invoiceId));
    },
  });

  // GET /api/v1/catalog-events/occurrences — listar ocurrencias (filtros opcionales).
  app.route({
    method: 'GET',
    url: '/api/v1/catalog-events/occurrences',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as {
        customer_external_id?: string;
        catalog_event_code?: string;
        pending?: string;
        limit?: string;
      };
      const where: import('@prisma/client').Prisma.CatalogEventOccurrenceWhereInput = {
        organizationId: org.id,
      };
      if (q.customer_external_id) {
        const cust = await prisma.customer.findUnique({
          where: { organizationId_externalId: { organizationId: org.id, externalId: q.customer_external_id } },
        });
        if (!cust) throw notFound('customer');
        where.customerId = cust.id;
      }
      if (q.catalog_event_code) {
        const evt = await prisma.catalogEvent.findUnique({
          where: { organizationId_code: { organizationId: org.id, code: q.catalog_event_code } },
        });
        if (!evt) throw notFound('catalog_event');
        where.catalogEventId = evt.id;
      }
      if (q.pending === 'true') where.feeId = null;

      const limit = Math.min(parseInt(q.limit ?? '100', 10) || 100, 500);
      const items = await prisma.catalogEventOccurrence.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        take: limit,
      });
      reply.send({
        catalog_event_occurrences: items.map((o) => (serializeOccurrence(o) as { catalog_event_occurrence: object }).catalog_event_occurrence),
      });
    },
  });
}
