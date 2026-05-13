// Golden runner normalization layer.
//
// Spec §8 "Regla canónica del comparador golden":
//   1. Strip-list (volatile fields).
//   2. Normalization-table (deterministic transforms from the appendix
//      "Divergencias mini-Lago vs captura Lago Cloud").
//   3. Deep-equal strict.

const STRIP_KEYS = new Set<string>([
  'lago_id',
  'lago_invoice_id',
  'lago_subscription_id',
  'lago_customer_id',
  'lago_item_id',
  'lago_billable_metric_id',
  'lago_tax_id',
  'lago_charge_id',
  'created_at',
  'updated_at',
  'received_at',
  'confirmed_at',
  'executed_at',
  'etag',
  'fee_lago_id',
  // Some fixtures embed scoped lago_<x>_id keys (eg. lago_invoice_id inside
  // applied_taxes); STRIP_KEYS picks them up by exact key name.
]);

const VOLATILE_NUMERIC_KEYS = new Set<string>([
  'sequential_id',
  // `slug` is humán-deterministic but depends on per-org counters.
  'slug',
  'customers_count',
  'add_ons_count',
  'plans_count',
  'charges_count',
  'commitments_count',
  'active_subscriptions_count',
  'draft_invoices_count',
  // The wire `timestamp` returned by /events depends on the request body's
  // epoch; we normalise it because the Lago Cloud capture was made with a
  // pinned host clock that doesn't match the test environment.
  'timestamp',
]);

export type NormalizationOptions = {
  // Optional bag of additional keys to strip for a specific fixture.
  extraStrip?: string[];
  // When true, also drop `subscription_at`, `started_at`, `ending_at`,
  // `terminated_at`, `canceled_at`, `current_billing_period_*` — these depend
  // on test wall-clock and aren't captured deterministically.
  stripSubscriptionDates?: boolean;
  // When true, drop `issuing_date` and `payment_due_date` (depend on now()).
  stripInvoiceDates?: boolean;
  // When true, treat `metadata: []` and `metadata: {}` as equivalent (D3).
  metadataObjectOrArray?: boolean;
};

export function normalize<T>(input: T, options: NormalizationOptions = {}): unknown {
  const extra = new Set(options.extraStrip ?? []);
  return walk(input, extra, options);
}

function walk(value: unknown, extra: Set<string>, options: NormalizationOptions): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => walk(v, extra, options));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (STRIP_KEYS.has(k)) continue;
      if (VOLATILE_NUMERIC_KEYS.has(k)) continue;
      if (extra.has(k)) continue;
      if (options.stripSubscriptionDates) {
        if (k === 'subscription_at' || k === 'started_at' || k === 'ending_at'
          || k === 'terminated_at' || k === 'canceled_at'
          || k === 'current_billing_period_started_at'
          || k === 'current_billing_period_ending_at') continue;
      }
      if (options.stripInvoiceDates) {
        if (k === 'issuing_date' || k === 'payment_due_date') continue;
      }
      if (options.metadataObjectOrArray && k === 'metadata') {
        // Treat `[]` and `{}` as equivalent. Any non-empty metadata is
        // compared structurally as an object.
        const m = v as unknown;
        if (Array.isArray(m) && m.length === 0) {
          out[k] = {};
          continue;
        }
      }
      out[k] = walk(v, extra, options);
    }
    return out;
  }
  return value;
}
