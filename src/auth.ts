// Bearer auth (per-organization API keys). Every `/api/v1/*` route requires
// `Authorization: Bearer <API_KEY>` matching exactly one organization.

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Organization, PrismaClient } from '@prisma/client';
import { unauthorized } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    organization?: Organization;
  }
}

export function buildAuthHook(prisma: PrismaClient) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      throw unauthorized('unauthorized');
    }
    const token = header.slice(7).trim();
    if (!token) {
      throw unauthorized('unauthorized');
    }
    const org = await prisma.organization.findUnique({ where: { apiKey: token } });
    if (!org) {
      throw unauthorized('unauthorized');
    }
    request.organization = org;
  };
}

// Convenience helper that asserts an organization is bound to the request.
export function requireOrg(request: FastifyRequest): Organization {
  if (!request.organization) {
    throw unauthorized('unauthorized');
  }
  return request.organization;
}
