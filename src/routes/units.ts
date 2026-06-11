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
import {
  computeRemovalImmediateInvoice,
  computeSetupImmediateInvoice,
} from '../services/billing-engine.js';
import {
  dispatchInvoiceInBackground,
  emitImmediateInvoice,
} from '../services/immediate-invoice.js';
import type { NetSuiteDispatcher } from '../services/netsuite-dispatcher.js';
import { rejectUnknownFields } from '../services/payload.js';

// El API público acepta los campos comerciales de la unidad + dos flags de
// migración legacy ("ya pagado afuera"). Otras configuraciones de
// facturación (ciclo, ventana, prepaid_months, billing_starts_at) las
// administra Numaris desde el admin.
const CREATE_ALLOWED_FIELDS = [
  'service_code', 'external_id', 'label', 'metadata',
  'setup_already_billed', 'one_off_already_billed',
] as const;
// PATCH solo cambia el nombre legible. Para dar de baja una unidad usa
// `POST /api/v1/events` con operation_type='remove'.
const PATCH_ALLOWED_FIELDS = ['label'] as const;

type UnitPayload = {
  service_code?: string;
  external_id?: string;
  label?: string | null;
  // Flags de migración legacy: indican que el setup / one_off de esta unidad
  // ya fue cobrado afuera de Numaris Billing (típicamente en un sistema
  // previo durante un onboarding masivo). Marcan los gates de facturación
  // inicial para que la unidad nunca genere el fee correspondiente.
  //   - setup_already_billed (recurring): preestablece setup_billed_at.
  //   - one_off_already_billed (one_off): preestablece oneoff_billed_at.
  // Si se envía el flag "equivocado" para el pricing_model del plan, se
  // ignora silenciosamente.
  setup_already_billed?: boolean;
  one_off_already_billed?: boolean;
  metadata?: Record<string, unknown>;
};

export function registerUnitRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  opts?: { dispatcher?: NetSuiteDispatcher; callbackBaseUrl?: string },
): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/units',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = request.body as { unit?: Record<string, unknown> } | null;
      rejectUnknownFields(body?.unit, CREATE_ALLOWED_FIELDS);
      const payload = body?.unit as UnitPayload | undefined;
      if (!payload) throw validation({ unit: ['value_is_mandatory'] });
      if (!payload.service_code) throw validation({ service_code: ['value_is_mandatory'] });
      if (!payload.external_id) throw validation({ external_id: ['value_is_mandatory'] });

      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: payload.service_code } },
        include: { customer: true },
      });
      if (!service) throw notFound('service');

      const existing = await prisma.unit.findUnique({
        where: { serviceId_externalId: { serviceId: service.id, externalId: payload.external_id } },
      });
      if (existing) throw validation({ external_id: ['value_already_exist'] });

      const activeFrom = new Date();

      // Gates pre-pagados ("ya pagado afuera") — solo aplican al matching
      // pricing_model. El flag opuesto se ignora silenciosamente.
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
          setupBilledAt,
          oneoffBilledAt,
          metadata: (payload.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });

      // v18: si el service tiene setup_billing_mode='immediate', emitimos una
      // invoice independiente AHORA con el cargo de setup. La unit queda con
      // setupBilledAt seteado para que el cycle invoice no la vuelva a cobrar.
      // Solo aplica si:
      //   - recurring (one_off ignora este modo)
      //   - setup > 0
      //   - la unit aún no ha sido facturada por setup
      let triggeredInvoiceId: string | null = null;
      if (
        service.pricingModel === 'recurring'
        && service.setupBillingMode === 'immediate'
        && service.setupUnitAmountCents > 0
        && unit.setupBilledAt === null
      ) {
        const organization = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
        const computed = computeSetupImmediateInvoice({ service, unit });
        const result = await emitImmediateInvoice({
          prisma, organization, customer: service.customer,
          taxEntityId: service.taxEntityId,
          computed, trigger: 'setup_immediate',
          idempotencyKey: `setup-immediate:${unit.id}`,
          markBilled: async (tx) => {
            await tx.unit.update({ where: { id: unit.id }, data: { setupBilledAt: new Date() } });
          },
        });
        triggeredInvoiceId = result.invoiceId;
      }

      if (triggeredInvoiceId && opts?.dispatcher && opts?.callbackBaseUrl) {
        dispatchInvoiceInBackground(prisma, org.id, triggeredInvoiceId, opts.dispatcher, opts.callbackBaseUrl, request.log);
      }

      const refreshed = triggeredInvoiceId
        ? await prisma.unit.findUniqueOrThrow({ where: { id: unit.id } })
        : unit;
      const response = serializeUnit(refreshed);
      if (triggeredInvoiceId) (response as Record<string, unknown>).triggered_invoice_id = triggeredInvoiceId;
      reply.send(response);
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
      const body = (request.body ?? {}) as { unit?: Record<string, unknown> };
      rejectUnknownFields(body.unit, PATCH_ALLOWED_FIELDS);
      const payload = (body.unit ?? {}) as { label?: string };
      const unit = await prisma.unit.findFirst({ where: { id, service: { organizationId: org.id } } });
      if (!unit) throw notFound('unit');
      const data: Prisma.UnitUpdateInput = {};
      if (payload.label !== undefined) data.label = payload.label;
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

      // v18: si la migración cobra setup del plan nuevo Y el plan nuevo está en
      // modo immediate, emitimos la invoice del setup AHORA (no esperamos a
      // migration_at). Justificación: la migración es una decisión comercial
      // tomada hoy; cobrar el setup al instante alinea cash flow con la decisión.
      // En el cycle invoice posterior NO aparece porque setupBilledAt ya se
      // setea durante emitImmediateInvoice.
      let migrationSetupInvoiceId: string | null = null;
      if (
        chargeNewSetup
        && toService.setupBillingMode === 'immediate'
        && toService.setupUnitAmountCents > 0
      ) {
        const organization = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
        const toServiceWithCustomer = await prisma.service.findUniqueOrThrow({
          where: { id: toService.id }, include: { customer: true },
        });
        const computed = computeSetupImmediateInvoice({
          service: toServiceWithCustomer, unit: tx.newUnit,
        });
        const result = await emitImmediateInvoice({
          prisma, organization, customer: toServiceWithCustomer.customer,
          taxEntityId: toServiceWithCustomer.taxEntityId,
          computed, trigger: 'setup_immediate',
          idempotencyKey: `setup-immediate:${tx.newUnit.id}`,
          markBilled: async (innerTx) => {
            await innerTx.unit.update({ where: { id: tx.newUnit.id }, data: { setupBilledAt: new Date() } });
          },
          metadata: { source: 'plan_migration', from_unit_id: tx.closedOld.id },
        });
        migrationSetupInvoiceId = result.invoiceId;
      }

      if (migrationSetupInvoiceId && opts?.dispatcher && opts?.callbackBaseUrl) {
        dispatchInvoiceInBackground(prisma, org.id, migrationSetupInvoiceId, opts.dispatcher, opts.callbackBaseUrl, request.log);
      }

      const refreshedNew = migrationSetupInvoiceId
        ? await prisma.unit.findUniqueOrThrow({ where: { id: tx.newUnit.id } })
        : tx.newUnit;
      const response: Record<string, unknown> = {
        old_unit: serializeUnit(tx.closedOld).unit,
        new_unit: serializeUnit(refreshedNew).unit,
        event_id: tx.event.id,
      };
      if (migrationSetupInvoiceId) response.triggered_invoice_id = migrationSetupInvoiceId;
      reply.send(response);
    },
  });
}

function emptyMeta(page: number) {
  return { current_page: page, next_page: null, prev_page: null, total_pages: 1, total_count: 0 };
}
