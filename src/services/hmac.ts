// HMAC-SHA256 with timing-safe comparison for NetSuite callbacks (D12).

import { createHmac, timingSafeEqual } from 'node:crypto';

export function computeHmacSha256Hex(secret: string, rawBody: Buffer | string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody);
  return hmac.digest('hex');
}

// Verify an `X-NetSuite-Signature` header value (`sha256=<hex>`). Returns
// true only when the hex hashes are equal under a constant-time comparison.
// Returns false on any malformed input.
export function verifySignatureHeader(
  headerValue: string | undefined,
  rawBody: Buffer | string,
  secret: string,
): boolean {
  if (!headerValue || typeof headerValue !== 'string') return false;
  const match = /^sha256=([0-9a-f]+)$/i.exec(headerValue.trim());
  if (!match) return false;
  const provided = match[1]!.toLowerCase();
  const expected = computeHmacSha256Hex(secret, rawBody);
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// Helper used by tests that need to forge a valid signature.
export function buildSignatureHeader(secret: string, rawBody: Buffer | string): string {
  return `sha256=${computeHmacSha256Hex(secret, rawBody)}`;
}
