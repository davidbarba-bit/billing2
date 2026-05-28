// Unit routes — direct CRUD over the materialized unit table.
//
// Cliente teams that prefer to track units explicitly (without sending
// events) can POST/PATCH/DELETE units directly. POSTing an event with
// `operation_type: add` is equivalent to POSTing a unit + an audit event.

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { ApiError, notFound, validation } from '../errors.js';
import { serializeUnit } from '../serializers/unit.js';

type UnitPayload = {
  service_code?: string;
  external_id?: string;
  label?: string | null;
  active_from?: string;
  // v8: override de fecha de facturación. Si null/omitido, el motor usa
  // active_from. Útil para migración desde otras plataformas (cobrar mes
  // completo aunque entre mid-mes, o saltarse el primer mes ya pagado).
  billing_starts_at?: string | null;
  prepaid_months?: number | null;
  // v14: flags de "ya pagado afuera" para migración desde sistemas legacy.
  // Marcan los gates de facturación inicial sin pasar por el motor.
  //   - setup_already_billed: para services recurring con setup > 0. Marca
  //     setupBilledAt = active_from para que la unit NO genere fee de setup.
  //     La unit sigue facturando mensualidad normal.
  //   - one_off_already_billed: para services one_off. Marca oneoffBilledAt
  //     = active_from para que la unit nunca entre al cycle invoice ni al
  //     ping immediate.
  // Si se envía el flag "equivocado" para el pricing_model, se ignora
  // silenciosamente (el gate del otro tipo no afecta este pricing_model).
  setup_already_billed?: boolean;
  one_off_already_billed?: boolean;
  metadata?: Record<string, unknown>;
};

export function registerUnitRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/units',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = request.body as { unit?: UnitPayload } | null;
      const payload = body?.unit;
      if (!payload) throw validation({ unit: ['value_is_mandatory'] });
      if (!payload.service_code) throw validation({ service_code: ['value_is_mandatory'] });
      if (!payload.external_id) throw validation({ external_id: ['value_is_mandatory'] });

      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: payload.service_code } },
      });
      if (!service) throw notFound('service');

      const existing = await prisma.unit.findUnique({
        where: { serviceId_externalId: { serviceId: service.id, externalId: payload.external_id } },
      });
      if (existing) throw validation({ external_id: ['value_already_exist'] });

      const activeFrom = payload.active_from ? new Date(payload.active_from) : new Date();
      if (Number.isNaN(activeFrom.getTime())) throw validation({ active_from: ['invalid_iso_datetime'] });
      let billingStartsAt: Date | null = null;
      if (payload.billing_starts_at !== undefined && payload.billing_starts_at !== null) {
        billingStartsAt = new Date(payload.billing_starts_at);
        if (Number.isNaN(billingStartsAt.getTime())) throw validation({ billing_starts_at: ['invalid_iso_datetime'] });
      }
      const prepaidMonths = payload.prepaid_months ?? null;
      if (prepaidMonths !== null && (!Number.isInteger(prepaidMonths) || prepaidMonths <= 0)) {
        throw validation({ prepaid_months: ['must_be_positive_integer'] });
      }

      // v14: gates pre-pagados ("ya pagado afuera").
      const isOneOff = service.pricingModel === 'one_off';
      const setupBilledAt = (!isOneOff && payload.setup_already_billed === true)
        ? activeFrom
        : null;
      const oneoffBilledAt = (isOneOff && payload.one_off_already_billed === true)
        ? activeFrom
        : null;

      const unit = await prisma.unit.create({
        data: {
          serviceId: service.id,
          externalId: payload.external_id,
          label: payload.label ?? null,
          activeFrom,
          billingStartsAt,
          prepaidMonths,
          setupBilledAt,
          oneoffBilledAt,
          metadata: (payload.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
      reply.send(serializeUnit(unit));
    },
  });

  app.route({
    method: 'GET',
    url: '/api/v1/units',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as { per_page?: string; page?: string; service_code?: string; status?: 'active' | 'terminated' };
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const where: Prisma.UnitWhereInput = { service: { organizationId: org.id } };
      if (q.service_code) {
        const svc = await prisma.service.findUnique({
          where: { organizationId_code: { organizationId: org.id, code: q.service_code } },
        });
        if (!svc) {
          reply.send({ units: [], meta: emptyMeta(page) });
          return;
        }
        where.serviceId = svc.id;
      }
      if (q.status === 'active') where.activeTo = null;
      if (q.status === 'terminated') where.activeTo = { not: null };
      const [items, totalCount] = await Promise.all([
        prisma.unit.findMany({
          where,
          orderBy: [{ activeFrom: 'desc' }, { externalId: 'asc' }],
          take: perPage,
          skip: (page - 1) * perPage,
        }),
        prisma.unit.count({ where }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        units: items.map((u) => serializeUnit(u).unit),
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
    url: '/api/v1/units/:id',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const unit = await prisma.unit.findFirst({
        where: { id, service: { organizationId: org.id } },
      });
      if (!unit) throw notFound('unit');
      reply.send(serializeUnit(unit));
    },
  });

  // PATCH: update label or terminate (set active_to).
  app.route({
    method: 'PATCH',
    url: '/api/v1/units/:id',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { unit?: { label?: string; active_to?: string | null; billing_starts_at?: string | null; prepaid_months?: number | null; metadata?: Record<string, unknown> } };
      const payload = body.unit ?? {};
      const unit = await prisma.unit.findFirst({ where: { id, service: { organizationId: org.id } } });
      if (!unit) throw notFound('unit');
      const data: Prisma.UnitUpdateInput = {};
      if (payload.label !== undefined) data.label = payload.label;
      if (payload.active_to !== undefined) {
        data.activeTo = payload.active_to === null ? null : new Date(payload.active_to);
      }
      if (payload.billing_starts_at !== undefined) {
        if (payload.billing_starts_at === null) {
          data.billingStartsAt = null;
        } else {
          const bs = new Date(payload.billing_starts_at);
          if (Number.isNaN(bs.getTime())) throw validation({ billing_starts_at: ['invalid_iso_datetime'] });
          data.billingStartsAt = bs;
        }
      }
      if (payload.prepaid_months !== undefined) {
        if (payload.prepaid_months !== null && (!Number.isInteger(payload.prepaid_months) || payload.prepaid_months <= 0)) {
          throw validation({ prepaid_months: ['must_be_positive_integer'] });
        }
        // Solo permitir cambio antes de que se haya facturado (oneoffBilledAt = null).
        if (unit.oneoffBilledAt !== null) {
          throw validation({ prepaid_months: ['unit_already_billed'] });
        }
        data.prepaidMonths = payload.prepaid_months;
      }
      if (payload.metadata !== undefined) {
        data.metadata = (payload.metadata ?? {}) as Prisma.InputJsonValue;
      }
      const updated = await prisma.unit.update({ where: { id: unit.id }, data });
      reply.send(serializeUnit(updated));
    },
  });

  // v8: migración de plan — atómica, terminate-and-recreate.
  // Política (confirmada con el usuario):
  //   - Solo futuro (migration_at > now).
  //   - Mismo customer, mismo pricing_model (recurring↔recurring o
  //     one_off↔one_off; cross-model bloqueado en v1).
  //   - external_id preservado en la unit nueva.
  //   - charge_new_setup=false por default → marcamos setupBilledAt en la
  //     nueva unit para que no se cobre setup del nuevo plan.
  //   - Add-ons per-unit del service viejo NO se migran (se cierran cuando
  //     se termina la unit vieja, que es como están ligados).
  //   - Audit: metadata.migrated_to en la unit vieja, metadata.migrated_from
  //     en la nueva, + EventLog con operation_type='migrate'.
  app.route({
    method: 'POST',
    url: '/api/v1/units/:id/migrate',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { migration?: {
        to_service_code?: string;
        migration_at?: string;
        charge_new_setup?: boolean;
        new_label?: string | null;
        metadata?: Record<string, unknown>;
      } };
      const payload = body.migration;
      if (!payload) throw validation({ migration: ['value_is_mandatory'] });
      if (!payload.to_service_code) throw validation({ to_service_code: ['value_is_mandatory'] });
      if (!payload.migration_at) throw validation({ migration_at: ['value_is_mandatory'] });
      const migrationAt = new Date(payload.migration_at);
      if (Number.isNaN(migrationAt.getTime())) throw validation({ migration_at: ['invalid_iso_datetime'] });
      if (migrationAt <= new Date()) {
        throw validation({ migration_at: ['must_be_in_the_future'] });
      }
      const chargeNewSetup = payload.charge_new_setup ?? false;

      const oldUnit = await prisma.unit.findFirst({
        where: { id, service: { organizationId: org.id } },
        include: { service: true },
      });
      if (!oldUnit) throw notFound('unit');
      if (oldUnit.activeTo !== null) {
        throw new ApiError(409, 'unit_terminated', { errorDetails: { unit: ['already_terminated'] } });
      }
      // Si ya fue migrada antes, bloquea (no doble-migración via mismo registro viejo).
      const oldMeta = (oldUnit.metadata as Record<string, unknown> | null) ?? {};
      if (oldMeta.migrated_to) {
        throw new ApiError(409, 'unit_already_migrated', {
          errorDetails: { unit: ['already_migrated'] },
        });
      }

      const toService = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: payload.to_service_code } },
      });
      if (!toService) throw notFound('to_service');
      if (toService.id === oldUnit.serviceId) {
        throw validation({ to_service_code: ['same_as_current_service'] });
      }
      if (toService.customerId !== oldUnit.service.customerId) {
        throw validation({ to_service_code: ['must_be_same_customer'] });
      }
      if (toService.pricingModel !== oldUnit.service.pricingModel) {
        throw validation({ to_service_code: ['must_be_same_pricing_model'] });
      }
      if (toService.status !== 'active') {
        throw validation({ to_service_code: ['service_terminated'] });
      }
      // external_id no debe chocar en el service destino.
      const collision = await prisma.unit.findUnique({
        where: { serviceId_externalId: { serviceId: toService.id, externalId: oldUnit.externalId } },
      });
      if (collision) {
        throw new ApiError(409, 'external_id_collision_on_target', {
          errorDetails: { external_id: ['already_exists_on_target_service'] },
        });
      }

      const tx = await prisma.$transaction(async (tx) => {
        // 1) Marca la unit vieja como terminada en migrationAt y deja huella.
        //    v17: neutralizamos el cargo de baja porque migración != desinstalación
        //    real. Setear removalBilledAt = migrationAt hace que buildRemovalFee
        //    salte esta unit (símil al patrón de setupBilledAt en la nueva unit).
        const closedOld = await tx.unit.update({
          where: { id: oldUnit.id },
          data: {
            activeTo: migrationAt,
            removalBilledAt: migrationAt,
            metadata: {
              ...(oldMeta as object),
              migrated_to: {
                service_code: toService.code,
                service_id: toService.id,
                at: migrationAt.toISOString(),
              },
            } as Prisma.InputJsonValue,
          },
        });

        // 2) Crea la unit nueva en el service destino.
        const newMetaFromPayload = payload.metadata ?? {};
        const newUnit = await tx.unit.create({
          data: {
            serviceId: toService.id,
            externalId: oldUnit.externalId,
            label: payload.new_label !== undefined ? payload.new_label : oldUnit.label,
            activeFrom: migrationAt,
            // Si NO se va a cobrar setup, marcar setupBilledAt para que el
            // gate del motor no lo emita en el próximo cycle.
            setupBilledAt: chargeNewSetup ? null : migrationAt,
            prepaidMonths: null, // se setea aparte si el nuevo plan lo requiere
            metadata: {
              ...(newMetaFromPayload as object),
              migrated_from: {
                unit_id: oldUnit.id,
                service_code: oldUnit.service.code,
                service_id: oldUnit.serviceId,
                at: migrationAt.toISOString(),
              },
            } as Prisma.InputJsonValue,
          },
        });

        // 3) EventLog con operation_type='migrate', amarrado a la unit vieja
        //    (referencia conceptual "desde dónde sale la migración").
        const event = await tx.eventLog.create({
          data: {
            organizationId: org.id,
            transactionId: `migrate-${oldUnit.id}-${migrationAt.getTime()}`,
            serviceId: oldUnit.serviceId,
            unitId: oldUnit.id,
            unitExternalId: oldUnit.externalId,
            unitLabel: oldUnit.label,
            operationType: 'migrate',
            kind: 'plan_migration',
            timestamp: migrationAt,
            properties: {
              from_service_code: oldUnit.service.code,
              to_service_code: toService.code,
              new_unit_id: newUnit.id,
              charge_new_setup: chargeNewSetup,
            } as object,
          },
        });

        return { closedOld, newUnit, event };
      });

      reply.send({
        old_unit: serializeUnit(tx.closedOld).unit,
        new_unit: serializeUnit(tx.newUnit).unit,
        event_id: tx.event.id,
      });
    },
  });
}

function emptyMeta(page: number) {
  return { current_page: page, next_page: null, prev_page: null, total_pages: 1, total_count: 0 };
}
