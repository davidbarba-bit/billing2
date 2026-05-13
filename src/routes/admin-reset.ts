// POST /api/v1/admin/reset — programmatic hard reset of the authenticated
// organization's data. Designed for staging / demo environments.
//
// Auth gate (defense in depth):
//   1. Standard `Authorization: Bearer <API_KEY>` (scopes the wipe to the
//      authenticated org — you cannot reset another tenant).
//   2. Additional header `X-Admin-Reset-Token: <ADMIN_RESET_TOKEN>`
//      compared timing-safe against an env-only secret. If the env var is
//      not set, the endpoint returns `403 admin_reset_disabled` — fail
//      closed so production accidents are impossible.
//   3. Request body must include `confirm: "<org_slug>"`. Forces an
//      explicit "yes, this is the org I mean to wipe" gesture.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { buildAuthHook, requireOrg } from '../auth.js';
import { forbidden, validation } from '../errors.js';
import { resetOrganizationData } from '../services/reset.js';

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function registerAdminResetRoute(app: FastifyInstance, prisma: PrismaClient): void {
  const authenticate = buildAuthHook(prisma);

  app.route({
    method: 'POST',
    url: '/api/v1/admin/reset',
    preHandler: authenticate,
    handler: async (request, reply) => {
      const org = requireOrg(request);

      // Layer 2: separate token.
      const expectedToken = process.env.ADMIN_RESET_TOKEN;
      if (!expectedToken) {
        throw forbidden('admin_reset_disabled');
      }
      const provided = request.headers['x-admin-reset-token'];
      const providedStr = Array.isArray(provided) ? provided[0] : provided;
      if (!providedStr || !timingSafeStringEqual(providedStr, expectedToken)) {
        throw forbidden('invalid_reset_token');
      }

      // Layer 3: body confirmation.
      const body = (request.body ?? {}) as { confirm?: string };
      if (body.confirm !== org.slug) {
        throw validation({ confirm: ['must_equal_organization_slug'] });
      }

      const summary = await resetOrganizationData(prisma, org.id);
      reply.send({ reset: true, ...summary });
    },
  });
}
