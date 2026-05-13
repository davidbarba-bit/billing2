// Endpoints #4, #5, #13a: POST /api/v1/events.
//
// Same endpoint for both add and remove (the difference is
// `properties.operation_type`). mini-Lago rejects ISO strings on
// `timestamp` (Lago Cloud accepts them and silently breaks — invariant #3).

import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { validation } from '../errors.js';
import { serializeEvent } from '../serializers/event.js';

type EventPayload = {
  transaction_id?: string;
  external_subscription_id?: string;
  code?: string;
  timestamp?: number | string;
  precise_total_amount_cents?: string | null;
  properties?: Record<string, unknown> & {
    unit_external_id?: string;
    unit_label?: string;
    kind?: string;
    operation_type?: 'add' | 'remove';
  };
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
      if (!payload.transaction_id) {
        throw validation({ transaction_id: ['value_is_mandatory'] });
      }
      if (!payload.code) throw validation({ code: ['value_is_mandatory'] });
      if (!payload.external_subscription_id) {
        throw validation({ external_subscription_id: ['value_is_mandatory'] });
      }
      if (payload.timestamp === undefined || payload.timestamp === null) {
        throw validation({ timestamp: ['value_is_mandatory'] });
      }
      if (typeof payload.timestamp !== 'number') {
        // Invariant #3: ISO strings are rejected, hard-failure.
        throw validation({ timestamp: ['must_be_unix_epoch_seconds'] });
      }
      if (!Number.isFinite(payload.timestamp) || payload.timestamp <= 0) {
        throw validation({ timestamp: ['must_be_unix_epoch_seconds'] });
      }

      const existing = await prisma.event.findUnique({
        where: {
          organizationId_transactionId: {
            organizationId: org.id,
            transactionId: payload.transaction_id,
          },
        },
      });
      if (existing) {
        throw validation({ transaction_id: ['value_already_exist'] });
      }

      const billableMetric = await prisma.billableMetric.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: payload.code } },
      });
      const subscription = await prisma.subscription.findUnique({
        where: {
          organizationId_externalId: {
            organizationId: org.id,
            externalId: payload.external_subscription_id,
          },
        },
      });

      const event = await prisma.event.create({
        data: {
          organizationId: org.id,
          transactionId: payload.transaction_id,
          externalSubscriptionId: payload.external_subscription_id,
          code: payload.code,
          timestamp: new Date(payload.timestamp * 1000),
          billableMetricId: billableMetric?.id ?? null,
          subscriptionId: subscription?.id ?? null,
          properties: (payload.properties ?? {}) as object,
        },
      });

      // D14: persist last seen unit_label per (sub, unit).
      const unitLabel = payload.properties?.unit_label;
      const unitExternalId = payload.properties?.unit_external_id;
      if (unitExternalId && subscription) {
        await prisma.unitLabel.upsert({
          where: {
            customerId_externalSubscriptionId_unitExternalId: {
              customerId: subscription.customerId,
              externalSubscriptionId: payload.external_subscription_id,
              unitExternalId,
            },
          },
          create: {
            customerId: subscription.customerId,
            externalSubscriptionId: payload.external_subscription_id,
            unitExternalId,
            label: unitLabel ?? null,
          },
          update: unitLabel !== undefined ? { label: unitLabel ?? null } : {},
        });
      }

      reply.send(serializeEvent(event));
    },
  });
}
