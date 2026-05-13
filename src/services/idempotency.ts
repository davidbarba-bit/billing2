// Idempotency store (D10). Backed by Prisma.

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { canonicalJson } from './canonical-json.js';

export type IdempotencyOutcome =
  | { kind: 'cached'; status: number; body: Record<string, unknown> }
  | { kind: 'fresh'; key: string; bodyHash: string };

export function hashRequestBody(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// Look up a prior response keyed on (org, path, key). If the same key has
// been recorded with the same request body hash, the prior response is
// returned ("cached"). If the body hash differs, an `IdempotencyConflictError`
// is thrown so the route can emit `422 idempotency_key_reused_with_different_body`.
export async function lookupIdempotent(
  prisma: PrismaClient,
  organizationId: string,
  path: string,
  key: string,
  bodyHash: string,
): Promise<IdempotencyOutcome> {
  const record = await prisma.idempotencyRecord.findUnique({
    where: { organizationId_path_key: { organizationId, path, key } },
  });
  if (!record) {
    return { kind: 'fresh', key, bodyHash };
  }
  if (record.requestHash !== bodyHash) {
    throw new IdempotencyConflictError('idempotency_key_reused_with_different_body');
  }
  return {
    kind: 'cached',
    status: record.responseStatus,
    body: record.responseBody as Record<string, unknown>,
  };
}

export async function recordIdempotent(
  prisma: PrismaClient,
  organizationId: string,
  path: string,
  key: string,
  bodyHash: string,
  status: number,
  responseBody: Record<string, unknown>,
): Promise<void> {
  await prisma.idempotencyRecord.upsert({
    where: { organizationId_path_key: { organizationId, path, key } },
    update: { requestHash: bodyHash, responseStatus: status, responseBody: responseBody as object },
    create: {
      organizationId,
      path,
      key,
      requestHash: bodyHash,
      responseStatus: status,
      responseBody: responseBody as object,
    },
  });
}
