// Regression test for the proration engine: ensures events are filtered by
// BM code before the per-unit math runs. Without the filter (pre-fix), a
// unit with both a setup event and a monthly-ping event at the same
// timestamp gets two open intervals on the recurring fee, inflating its
// fraction by ~2x.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestHarness, closeHarness, type Harness } from '../helpers/server.js';
import { seedNumaris } from '../../src/admin/seed.js';

describe('proration: events are scoped to a single BM (no leak from setup)', () => {
  let h: Harness;
  beforeAll(async () => { h = await buildTestHarness({ orgTimezone: 'America/Mexico_City' }); });
  afterAll(async () => { await closeHarness(h); });

  it('a monthly fee only counts events whose BM code matches the recurring metric', async () => {
    // Run the same Numaris seed the admin uses in prod.
    await seedNumaris(h.prisma, h.organization);

    const result = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invoices',
      headers: { ...h.authHeader(), 'idempotency-key': 'regression-bm-filter' },
      payload: {
        invoice: {
          external_customer_id: 'carga-express-mx',
          currency: 'MXN',
          fees: [
            {
              add_on_code: 'cobro-carga-express-mx-combustible',
              unit_amount_cents: 45000,
              units: '3',
            },
          ],
          metadata: { idempotency_key: 'regression-bm-filter' },
        },
      },
    });
    expect(result.statusCode).toBe(200);
    const body = result.json() as { invoice: { fees: Array<{ units: string; billed_units_detail: Array<{ external_id: string; billed_fraction: string }> }> } };
    const fee = body.invoice.fees[0]!;

    // Three trucks, each appears once.
    expect(fee.billed_units_detail).toHaveLength(3);
    const byUnit = new Map(fee.billed_units_detail.map((d) => [d.external_id, d.billed_fraction]));

    // Camión 001 is active the entire period.
    expect(byUnit.get('unit-camion-001')).toBe('1.0000');

    // Camión 002 was added mid-period and never removed. Its monthly fraction
    // must be < 1 — pre-fix this would have been double-counted to ~1.2x due
    // to its setup event also landing as an "add" interval.
    const cam002 = Number(byUnit.get('unit-camion-002'));
    expect(cam002).toBeGreaterThan(0);
    expect(cam002).toBeLessThan(1);

    // Total units must be < 3 (some prorating happened).
    expect(Number(fee.units)).toBeLessThan(3);
    // And > 2 (the three trucks combined have most of the period covered).
    expect(Number(fee.units)).toBeGreaterThan(2);
  });
});
