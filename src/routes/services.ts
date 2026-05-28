// Service routes (v3 — owns units + per-unit pricing, NO billing cycle).

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { ApiError, notFound, validation } from '../errors.js';
import { serializeService, type ServiceWithLinks } from '../serializers/service.js';

type ServicePayload = {
  code?: string;
  customer_external_id?: string;
  name?: string;
  description?: string | null;
  currency?: string;
  pricing_model?: 'recurring' | 'one_off';
  monthly_unit_amount_cents?: number;
  setup_unit_amount_cents?: number;
  // v17: cargo de baja per-unit. Solo recurring. 0 (default) = sin cargo.
  removal_unit_amount_cents?: number;
  // v18: cuándo se emite el cargo. 'next_cycle' (default) consolida en el cycle
  // invoice; 'immediate' emite invoice independiente al crear/dar de baja la unit.
  setup_billing_mode?: 'next_cycle' | 'immediate';
  removal_billing_mode?: 'next_cycle' | 'immediate';
  prepaid_months_default?: number | null;
  // v9: códigos NetSuite por kind de fee que este service produce.
  // monthly mapea tanto a fees kind=monthly (recurring) como a
  // fees kind=one_off (mensualidades prepagadas).
  netsuite_monthly_item_code?: string | null;
  netsuite_setup_item_code?: string | null;
  netsuite_removal_item_code?: string | null;
  metadata?: Record<string, unknown>;
};

function validateBillingMode(value: unknown, field: string): 'next_cycle' | 'immediate' {
  if (value === undefined) return 'next_cycle';
  if (value !== 'next_cycle' && value !== 'immediate') {
    throw validation({ [field]: ['must_be_next_cycle_or_immediate'] });
  }
  return value;
}

function normalizeItemCode(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function registerServiceRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/services',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const body = request.body as { service?: ServicePayload } | null;
      const payload = body?.service;
      if (!payload) throw validation({ service: ['value_is_mandatory'] });
      if (!payload.code) throw validation({ code: ['value_is_mandatory'] });
      if (!payload.name) throw validation({ name: ['value_is_mandatory'] });
      if (!payload.customer_external_id) {
        throw validation({ customer_external_id: ['value_is_mandatory'] });
      }

      const customer = await prisma.customer.findUnique({
        where: { organizationId_externalId: { organizationId: org.id, externalId: payload.customer_external_id } },
      });
      if (!customer) throw notFound('customer');

      const existing = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code: payload.code } },
      });
      if (existing) throw validation({ code: ['value_already_exist'] });

      const pricingModel = payload.pricing_model ?? 'recurring';
      if (pricingModel !== 'recurring' && pricingModel !== 'one_off') {
        throw validation({ pricing_model: ['value_is_invalid'] });
      }
      const monthlyAmount = payload.monthly_unit_amount_cents ?? 0;
      const setupAmount = payload.setup_unit_amount_cents ?? 0;
      const removalAmount = payload.removal_unit_amount_cents ?? 0;
      if (monthlyAmount < 0 || setupAmount < 0 || removalAmount < 0) {
        throw validation({ amount: ['must_be_non_negative'] });
      }
      if (pricingModel === 'one_off' && monthlyAmount === 0) {
        throw validation({ monthly_unit_amount_cents: ['must_be_positive_for_one_off'] });
      }
      if (pricingModel === 'one_off' && removalAmount > 0) {
        throw validation({ removal_unit_amount_cents: ['only_applicable_to_recurring'] });
      }
      const setupBillingMode = validateBillingMode(payload.setup_billing_mode, 'setup_billing_mode');
      const removalBillingMode = validateBillingMode(payload.removal_billing_mode, 'removal_billing_mode');
      // setup_billing_mode='immediate' requiere setup > 0 — sin amount no hay nada
      // que cobrar. La validación nos protege de configurar el flujo "en vacío".
      if (setupBillingMode === 'immediate' && setupAmount === 0) {
        throw validation({ setup_billing_mode: ['requires_setup_unit_amount_cents_greater_than_zero'] });
      }
      if (removalBillingMode === 'immediate' && removalAmount === 0) {
        throw validation({ removal_billing_mode: ['requires_removal_unit_amount_cents_greater_than_zero'] });
      }
      if (pricingModel === 'one_off' && (setupBillingMode === 'immediate' || removalBillingMode === 'immediate')) {
        throw validation({ billing_mode: ['only_applicable_to_recurring'] });
      }
      // prepaid_months_default solo aplica a one_off; en recurring debe ser null.
      const prepaidMonthsDefault = payload.prepaid_months_default ?? null;
      if (pricingModel === 'recurring' && prepaidMonthsDefault !== null) {
        throw validation({ prepaid_months_default: ['only_applicable_to_one_off'] });
      }
      if (prepaidMonthsDefault !== null && (!Number.isInteger(prepaidMonthsDefault) || prepaidMonthsDefault <= 0)) {
        throw validation({ prepaid_months_default: ['must_be_positive_integer'] });
      }

      const currency = payload.currency ?? customer.currency;

      const created = await prisma.service.create({
        data: {
          organizationId: org.id,
          customerId: customer.id,
          code: payload.code!,
          name: payload.name!,
          description: payload.description ?? null,
          currency,
          pricingModel,
          monthlyUnitAmountCents: monthlyAmount,
          setupUnitAmountCents: setupAmount,
          removalUnitAmountCents: removalAmount,
          setupBillingMode,
          removalBillingMode,
          prepaidMonthsDefault: prepaidMonthsDefault,
          netsuiteMonthlyItemCode: normalizeItemCode(payload.netsuite_monthly_item_code),
          netsuiteSetupItemCode: normalizeItemCode(payload.netsuite_setup_item_code),
          netsuiteRemovalItemCode: normalizeItemCode(payload.netsuite_removal_item_code),
          metadata: (payload.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });

      const hydrated = await load(prisma, created.id);
      reply.send(serializeService(hydrated));
    },
  });

  app.route({
    method: 'GET',
    url: '/api/v1/services',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const q = request.query as { per_page?: string; page?: string; customer_external_id?: string; status?: string };
      const perPage = Math.min(500, Math.max(1, Number(q.per_page ?? 100)));
      const page = Math.max(1, Number(q.page ?? 1));
      const where: Prisma.ServiceWhereInput = { organizationId: org.id };
      if (q.customer_external_id) {
        const c = await prisma.customer.findUnique({
          where: { organizationId_externalId: { organizationId: org.id, externalId: q.customer_external_id } },
        });
        if (!c) { reply.send({ services: [], meta: emptyMeta(page) }); return; }
        where.customerId = c.id;
      }
      if (q.status) where.status = q.status;
      const [items, totalCount] = await Promise.all([
        prisma.service.findMany({
          where, orderBy: { createdAt: 'desc' },
          take: perPage, skip: (page - 1) * perPage,
        }),
        prisma.service.count({ where }),
      ]);
      const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
      reply.send({
        services: items.map((s) => serializeService(s).service),
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
    url: '/api/v1/services/:code',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code } = request.params as { code: string };
      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code } },
      });
      if (!service) throw notFound('service');
      const hydrated = await load(prisma, service.id);
      reply.send(serializeService(hydrated));
    },
  });

  // v9: PATCH para actualizar códigos NetSuite (y otros campos no-precio).
  // Los precios siguen yendo por PUT /price (v7) que tiene su propia lógica
  // de pending/promoción. Aquí solo: name, description, item codes, metadata.
  app.route({
    method: 'PATCH',
    url: '/api/v1/services/:code',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code } = request.params as { code: string };
      const body = (request.body ?? {}) as { service?: {
        name?: string;
        description?: string | null;
        // v17: edición del cargo de baja post-creación (sin tocar otros precios).
        removal_unit_amount_cents?: number;
        // v18: edición del modo de emisión post-creación.
        setup_billing_mode?: 'next_cycle' | 'immediate';
        removal_billing_mode?: 'next_cycle' | 'immediate';
        netsuite_monthly_item_code?: string | null;
        netsuite_setup_item_code?: string | null;
        netsuite_removal_item_code?: string | null;
        metadata?: Record<string, unknown>;
      } };
      const payload = body.service ?? {};
      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code } },
      });
      if (!service) throw notFound('service');
      const data: Prisma.ServiceUpdateInput = {};
      if (payload.name !== undefined) data.name = payload.name;
      if (payload.description !== undefined) data.description = payload.description;
      if (payload.removal_unit_amount_cents !== undefined) {
        if (!Number.isInteger(payload.removal_unit_amount_cents) || payload.removal_unit_amount_cents < 0) {
          throw validation({ removal_unit_amount_cents: ['must_be_non_negative_integer'] });
        }
        if (service.pricingModel === 'one_off' && payload.removal_unit_amount_cents > 0) {
          throw validation({ removal_unit_amount_cents: ['only_applicable_to_recurring'] });
        }
        data.removalUnitAmountCents = payload.removal_unit_amount_cents;
      }
      if (payload.netsuite_monthly_item_code !== undefined) {
        data.netsuiteMonthlyItemCode = normalizeItemCode(payload.netsuite_monthly_item_code);
      }
      if (payload.netsuite_setup_item_code !== undefined) {
        data.netsuiteSetupItemCode = normalizeItemCode(payload.netsuite_setup_item_code);
      }
      if (payload.netsuite_removal_item_code !== undefined) {
        data.netsuiteRemovalItemCode = normalizeItemCode(payload.netsuite_removal_item_code);
      }
      if (payload.setup_billing_mode !== undefined) {
        const mode = validateBillingMode(payload.setup_billing_mode, 'setup_billing_mode');
        if (mode === 'immediate' && service.pricingModel === 'one_off') {
          throw validation({ setup_billing_mode: ['only_applicable_to_recurring'] });
        }
        if (mode === 'immediate' && service.setupUnitAmountCents === 0
            && (payload.removal_unit_amount_cents === undefined || payload.removal_unit_amount_cents === 0)) {
          // El check usa setupUnitAmountCents actual; si el PATCH también cambia
          // setup_unit_amount_cents en el mismo body habría que combinarlo, pero
          // hoy PATCH no acepta setup amount (solo PUT /price), así que el chequeo
          // queda sobre el valor en DB.
          if (service.setupUnitAmountCents === 0) {
            throw validation({ setup_billing_mode: ['requires_setup_unit_amount_cents_greater_than_zero'] });
          }
        }
        data.setupBillingMode = mode;
      }
      if (payload.removal_billing_mode !== undefined) {
        const mode = validateBillingMode(payload.removal_billing_mode, 'removal_billing_mode');
        if (mode === 'immediate' && service.pricingModel === 'one_off') {
          throw validation({ removal_billing_mode: ['only_applicable_to_recurring'] });
        }
        // Si el PATCH también incluye removal_unit_amount_cents, usa el nuevo;
        // si no, el actual de la DB.
        const removalAfter = payload.removal_unit_amount_cents !== undefined
          ? payload.removal_unit_amount_cents
          : service.removalUnitAmountCents;
        if (mode === 'immediate' && removalAfter === 0) {
          throw validation({ removal_billing_mode: ['requires_removal_unit_amount_cents_greater_than_zero'] });
        }
        data.removalBillingMode = mode;
      }
      if (payload.metadata !== undefined) {
        data.metadata = (payload.metadata ?? {}) as Prisma.InputJsonValue;
      }
      const updated = await prisma.service.update({ where: { id: service.id }, data });
      reply.send(serializeService(updated));
    },
  });

  // v7: programar cambio de precio con vigencia a partir del próximo ciclo.
  // Si ya existe un cambio pendiente que aún no entró en vigor, lo sobreescribe.
  // Si el pendiente actual ya entró en vigor (effective_from <= ahora), se
  // promueve (copia pending -> base) antes de escribir el nuevo, para que el
  // precio "previo" no se pierda silenciosamente cuando lleguen clientes
  // mid-cycle con `periodStart < new_effective_from`.
  app.route({
    method: 'PUT',
    url: '/api/v1/services/:code/price',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code } = request.params as { code: string };
      const body = request.body as {
        price?: {
          monthly_unit_amount_cents?: number;
          setup_unit_amount_cents?: number;
          effective_from?: string;
        };
      } | null;
      const payload = body?.price;
      if (!payload) throw validation({ price: ['value_is_mandatory'] });
      const monthly = payload.monthly_unit_amount_cents;
      const setup = payload.setup_unit_amount_cents;
      const effectiveFromRaw = payload.effective_from;
      if (typeof monthly !== 'number' || !Number.isInteger(monthly) || monthly < 0) {
        throw validation({ monthly_unit_amount_cents: ['must_be_non_negative_integer'] });
      }
      if (typeof setup !== 'number' || !Number.isInteger(setup) || setup < 0) {
        throw validation({ setup_unit_amount_cents: ['must_be_non_negative_integer'] });
      }
      if (typeof effectiveFromRaw !== 'string') {
        throw validation({ effective_from: ['value_is_mandatory'] });
      }
      const effectiveFrom = new Date(effectiveFromRaw);
      if (Number.isNaN(effectiveFrom.getTime())) {
        throw validation({ effective_from: ['must_be_iso_datetime'] });
      }
      const now = new Date();
      if (effectiveFrom <= now) {
        throw validation({ effective_from: ['must_be_in_the_future'] });
      }

      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code } },
      });
      if (!service) throw notFound('service');
      if (service.status === 'terminated') {
        throw new ApiError(409, 'service_terminated', {
          errorDetails: { service: ['cannot_change_price_on_terminated_service'] },
        });
      }
      if (service.pricingModel === 'one_off' && monthly === 0) {
        throw validation({ monthly_unit_amount_cents: ['must_be_positive_for_one_off'] });
      }

      // Si el pending actual ya está en vigor, promuévelo a base antes de
      // sobreescribir con el nuevo. Esto preserva la semántica para clientes
      // mid-cycle: su `periodStart` puede ser < `newEffectiveFrom` pero >=
      // `promotedEffectiveFrom`, y deben ver el precio "ya promovido".
      let baseMonthly = service.monthlyUnitAmountCents;
      let baseSetup = service.setupUnitAmountCents;
      if (
        service.pendingEffectiveFrom !== null
        && service.pendingMonthlyUnitAmountCents !== null
        && service.pendingSetupUnitAmountCents !== null
        && service.pendingEffectiveFrom <= now
      ) {
        baseMonthly = service.pendingMonthlyUnitAmountCents;
        baseSetup = service.pendingSetupUnitAmountCents;
      }

      await prisma.service.update({
        where: { id: service.id },
        data: {
          monthlyUnitAmountCents: baseMonthly,
          setupUnitAmountCents: baseSetup,
          pendingMonthlyUnitAmountCents: monthly,
          pendingSetupUnitAmountCents: setup,
          pendingEffectiveFrom: effectiveFrom,
        },
      });

      const hydrated = await load(prisma, service.id);
      reply.send(serializeService(hydrated));
    },
  });

  // v7: cancela un cambio de precio programado SI todavía no entró en vigor.
  // Si effective_from ya pasó, devuelve 409 (en ese caso el cambio es la
  // realidad — para revertirlo se programa otro cambio en sentido opuesto).
  app.route({
    method: 'DELETE',
    url: '/api/v1/services/:code/pending-price',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code } = request.params as { code: string };
      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code } },
      });
      if (!service) throw notFound('service');
      if (service.pendingEffectiveFrom === null) {
        throw new ApiError(409, 'no_pending_price_change', {
          errorDetails: { pending_price: ['not_set'] },
        });
      }
      if (service.pendingEffectiveFrom <= new Date()) {
        throw new ApiError(409, 'pending_price_already_in_effect', {
          errorDetails: { pending_price: ['already_in_effect_schedule_a_new_change_to_revert'] },
        });
      }
      await prisma.service.update({
        where: { id: service.id },
        data: {
          pendingMonthlyUnitAmountCents: null,
          pendingSetupUnitAmountCents: null,
          pendingEffectiveFrom: null,
        },
      });
      const hydrated = await load(prisma, service.id);
      reply.send(serializeService(hydrated));
    },
  });

  app.route({
    method: 'POST',
    url: '/api/v1/services/:code/terminate',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code } = request.params as { code: string };
      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code } },
      });
      if (!service) throw notFound('service');
      if (service.status === 'terminated') {
        const hydrated = await load(prisma, service.id);
        reply.send(serializeService(hydrated));
        return;
      }
      await prisma.$transaction(async (tx) => {
        const now = new Date();
        await tx.service.update({
          where: { id: service.id },
          data: { status: 'terminated', terminatedAt: now },
        });
        await tx.unit.updateMany({
          where: { serviceId: service.id, activeTo: null },
          data: { activeTo: now },
        });
      });
      const hydrated = await load(prisma, service.id);
      reply.send(serializeService(hydrated));
    },
  });

  app.route({
    method: 'DELETE',
    url: '/api/v1/services/:code',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);
      const { code } = request.params as { code: string };
      const service = await prisma.service.findUnique({
        where: { organizationId_code: { organizationId: org.id, code } },
      });
      if (!service) throw notFound('service');
      const feesCount = await prisma.fee.count({ where: { serviceId: service.id } });
      if (feesCount > 0) {
        throw new ApiError(409, 'service_has_fees', {
          errorDetails: { service: ['use_terminate_instead'] },
        });
      }
      await prisma.service.delete({ where: { id: service.id } });
      reply.send({ deleted: true, code });
    },
  });
}

async function load(prisma: PrismaClient, id: string): Promise<ServiceWithLinks> {
  const service = await prisma.service.findUnique({ where: { id } });
  if (!service) throw notFound('service');
  return service;
}

function emptyMeta(page: number) {
  return { current_page: page, next_page: null, prev_page: null, total_pages: 1, total_count: 0 };
}
