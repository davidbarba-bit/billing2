import { describe, expect, it } from 'vitest';
import { buildSignatureHeader, computeHmacSha256Hex, verifySignatureHeader } from '../../src/services/hmac.js';

describe('hmac', () => {
  it('computes hex sha256 deterministically', () => {
    const a = computeHmacSha256Hex('secret', 'body');
    const b = computeHmacSha256Hex('secret', 'body');
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
  it('verifies a matching signature', () => {
    const body = JSON.stringify({ external_invoice: { folio: 'X' } });
    const header = buildSignatureHeader('secret', body);
    expect(verifySignatureHeader(header, body, 'secret')).toBe(true);
  });
  it('rejects tampered bodies', () => {
    const header = buildSignatureHeader('secret', 'body-A');
    expect(verifySignatureHeader(header, 'body-B', 'secret')).toBe(false);
  });
  it('rejects malformed header values', () => {
    expect(verifySignatureHeader('garbage', 'body', 'secret')).toBe(false);
    expect(verifySignatureHeader(undefined, 'body', 'secret')).toBe(false);
    expect(verifySignatureHeader('sha256=NOT_HEX', 'body', 'secret')).toBe(false);
  });
});
