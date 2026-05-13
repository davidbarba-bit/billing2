// Event serializer matching fixtures 04 / 05 / 13a.
//
// Note the timestamp transform: requests deliver `timestamp` as a Unix epoch
// in **seconds** (invariant #3) but the wire response uses an ISO string with
// millisecond precision in UTC, eg. "2025-05-12T20:00:00.000Z".

import type { Event } from '@prisma/client';
import { DateTime } from 'luxon';
import { isoUtc } from '../services/tz.js';

export function serializeEvent(event: Event) {
  return {
    event: {
      lago_id: event.id,
      transaction_id: event.transactionId,
      lago_customer_id: null,
      code: event.code,
      timestamp: DateTime.fromJSDate(event.timestamp, { zone: 'utc' }).toFormat(
        "yyyy-LL-dd'T'HH:mm:ss.SSS'Z'",
      ),
      precise_total_amount_cents: null,
      properties: (event.properties ?? {}) as Record<string, unknown>,
      lago_subscription_id: null,
      external_subscription_id: event.externalSubscriptionId,
      created_at: isoUtc(event.createdAt),
    },
  };
}
