// Event log route — append-only with side effects on the Unit table.
//
// POST /api/v1/events
//   {
//     "event": {
//       "transaction_id": "...",  // unique per org (retry-safe)
//       "service_code": "...",
//       "operation_type": "add" | "remove",
//       "unit_external_id": "...",
//       "unit_label": "...",      // optional; persisted on the Unit row
//       "timestamp": 1747080000,  // Unix epoch in seconds (rejects ISO)
//       "kind": "...",            // free-text
//       "properties": { ... }     // passthrough JSON blob
//     }
//   }
//
// `add`    → upserts the Unit (creates if absent; clears activeTo if already
//            present and previously terminated).
// `remove` → sets Unit.activeTo to the event timestamp.

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { notFound, validation } from '../errors.js';
import { serializeEvent } from '../serializers/event.js';

type EventPayload = {
  transaction_id?: string;
  service_code?: string;
  operation_type?: 'add' | 'remove';
  unit_external_id?: string;
  unit_label?: string | null;
  timestamp?: number | string;
  kind?: string | null;
  properties?: Record<string, unknown>;
};

export function registerEventRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/events',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = request.body as { event?: EventPayload } | null;
      const payload = body?.event;
      if (!payload) throw validation({ event: ['value_is_mandatory'] });
      if (!payload.transaction_id) throw validation({ transaction_id: ['value_is_mandatory'] });
      if (!payload.service_code) throw validation({ service_code: ['value_is_mandatory'] });
      if (!payload.unit_external_id) throw validation({ unit_external_id: ['value_is_mandatory'] });
      const op = payload.operation_type;
      if (op !== 'add' && op !== 'remove') {
        throw validation({ operation_type: ['value_is_invalid'] });
      }
      if (payload.timestamp === undefined || payload.timestamp === null) {
        throw validation({ timestamp: ['value_is_mandatory'] });
      }
      if (typeof payload.timestamp !== 'number') {
        throw validation({ timestamp: ['must_be_unix_epoch_seconds'] });
      }
      if (!Number.isFinite(payload.timestamp) || payload.timestamp <= 0) {
        throw validation({ timestamp: ['must_be_unix_epoch_seconds'] });
      }

      const existing = await prisma.eventLog.findUnique({
        where: { organizationId_transactionId: { organizationId: org.id, transactionId: payload.transaction_id } },
      });
      if (existing) throw validation({ transaction_id: ['value_already_exist'] });

      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: payload.service_code } },
      });
      if (!service) throw notFound('service');

      const timestamp = new Date(payload.timestamp * 1000);

      const event = await prisma.$transaction(async (tx) => {
        // Materialise: ensure unit exists; mutate active_from/to as needed.
        const unit = await tx.unit.upsert({
          where: { serviceId_externalId: { serviceId: service.id, externalId: payload.unit_external_id! } },
          create: {
            serviceId: service.id,
            externalId: payload.unit_external_id!,
            label: payload.unit_label ?? null,
            activeFrom: op === 'add' ? timestamp : timestamp,
            activeTo: op === 'remove' ? timestamp : null,
          },
          update: op === 'add'
            ? {
                // Re-activation: clear activeTo, refresh label if provided.
                activeTo: null,
                ...(payload.unit_label !== undefined ? { label: payload.unit_label } : {}),
              }
            : {
                // Removal: stamp activeTo (only if not already terminated earlier).
                activeTo: timestamp,
                ...(payload.unit_label !== undefined ? { label: payload.unit_label } : {}),
              },
        });

        return tx.eventLog.create({
          data: {
            organizationId: org.id,
            transactionId: payload.transaction_id!,
            serviceId: service.id,
            unitId: unit.id,
            unitExternalId: payload.unit_external_id!,
            unitLabel: payload.unit_label ?? null,
            operationType: op,
            kind: payload.kind ?? null,
            timestamp,
            properties: (payload.properties ?? {}) as object,
          },
        });
      });

      reply.send(serializeEvent(event));
    },
  });

  app.route({
    method: 'GET',
    url: '/api/v1/events',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as { per_page?: string; page?: string; service_code?: string; unit_external_id?: string };
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const where: import('@prisma/client').Prisma.EventLogWhereInput = { organizationId: org.id };
      if (q.service_code) {
        const svc = await prisma.service.findUnique({
          where: { organizationId_code: { organizationId: org.id, code: q.service_code } },
        });
        if (!svc) {
          reply.send({ events: [], meta: { current_page: page, next_page: null, prev_page: null, total_pages: 1, total_count: 0 } });
          return;
        }
        where.serviceId = svc.id;
      }
      if (q.unit_external_id) where.unitExternalId = q.unit_external_id;
      const [items, totalCount] = await Promise.all([
        prisma.eventLog.findMany({
          where,
          orderBy: { timestamp: 'desc' },
          take: perPage,
          skip: (page - 1) * perPage,
        }),
        prisma.eventLog.count({ where }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        events: items.map((e) => serializeEvent(e).event),
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
}
