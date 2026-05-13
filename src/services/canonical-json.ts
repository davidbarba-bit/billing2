// Canonical JSON: stable key ordering + minimal formatting. Used for
// idempotency hashing (D10) and as input to HMAC computations when a
// stable form is required.

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const k of keys) {
      result[k] = canonicalize(obj[k]);
    }
    return result;
  }
  return value;
}
