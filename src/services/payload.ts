// Helper para validar que un payload solo contenga campos esperados.
//
// El API público intencionalmente expone un contrato mínimo: solo los campos
// que el integrador (Numaris) controla. Campos internos del modelo de
// facturación (billing_starts_at, prepaid_months, billing_period_months, etc.)
// los administra el equipo Numaris desde el admin — la API los rechaza.

import { validation, type ErrorDetails } from '../errors.js';

export function rejectUnknownFields(
  payload: Record<string, unknown> | null | undefined,
  allowed: readonly string[],
): void {
  if (!payload || typeof payload !== 'object') return;
  const allowedSet = new Set(allowed);
  const details: ErrorDetails = {};
  for (const key of Object.keys(payload)) {
    if (!allowedSet.has(key)) {
      details[key] = ['unknown_field'];
    }
  }
  if (Object.keys(details).length > 0) {
    throw validation(details);
  }
}
