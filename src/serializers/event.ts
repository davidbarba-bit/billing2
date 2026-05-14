// Event log serializer.

import type { EventLog } from '@prisma/client';
import { isoUtc } from '../services/tz.js';

export function serializeEvent(event: EventLog) {
  return {
    event: {
      id: event.id,
      transaction_id: event.transactionId,
      service_id: event.serviceId,
      unit_id: event.unitId ?? null,
      unit_external_id: event.unitExternalId,
      unit_label: event.unitLabel ?? null,
      operation_type: event.operationType,
      kind: event.kind ?? null,
      timestamp: isoUtc(event.timestamp),
      properties: event.properties ?? {},
      created_at: isoUtc(event.createdAt),
    },
  };
}
