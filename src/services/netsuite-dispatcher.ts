// NetSuite outbound dispatcher (D11 / endpoint #14).
//
// When `FEATURE_NETSUITE_DISPATCH_ENABLED=true`, the real OAuth 1.0a/TBA
// pipeline is used: per-organization credentials are read from the
// `organization` row, the request is signed with HMAC-SHA256 and POSTed to
// `{netsuiteRestBase}/services/rest/record/v1/customrecord_minilago_invoice`.
//
// When the flag is off, the dispatcher short-circuits: it records the
// payload in memory and returns a synthetic `accepted` response. Tests can
// rely on this mode without any NetSuite credentials.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Organization } from '@prisma/client';

export type DispatchPayload = Record<string, unknown>;

export type DispatchResult = {
  status: 'accepted' | 'failed';
  netsuiteInternalId?: string;
  externalId: string;
  receivedAt: string;
  estimatedEmissionAt?: string;
  error?: string;
};

export interface NetSuiteDispatcher {
  dispatch(org: Organization, payload: DispatchPayload, kind: 'invoice' | 'credit_note'): Promise<DispatchResult>;
}

// Mock dispatcher used when the feature flag is off or for tests.
export class FakeNetSuiteDispatcher implements NetSuiteDispatcher {
  public readonly calls: Array<{ orgId: string; kind: string; payload: DispatchPayload }> = [];

  async dispatch(
    org: Organization,
    payload: DispatchPayload,
    kind: 'invoice' | 'credit_note',
  ): Promise<DispatchResult> {
    this.calls.push({ orgId: org.id, kind, payload });
    const externalId = String(payload.external_id ?? '');
    return {
      status: 'accepted',
      netsuiteInternalId: `rec-${randomBytes(4).toString('hex')}`,
      externalId,
      receivedAt: new Date().toISOString(),
      estimatedEmissionAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }
}

// Real dispatcher signing OAuth 1.0a with HMAC-SHA256 (TBA).
export class RealNetSuiteDispatcher implements NetSuiteDispatcher {
  async dispatch(
    org: Organization,
    payload: DispatchPayload,
    kind: 'invoice' | 'credit_note',
  ): Promise<DispatchResult> {
    const requiredFields: Array<keyof Organization> = [
      'netsuiteAccountId',
      'netsuiteConsumerKey',
      'netsuiteConsumerSecret',
      'netsuiteTokenKey',
      'netsuiteTokenSecret',
      'netsuiteRestBase',
    ];
    for (const key of requiredFields) {
      if (!org[key]) {
        return {
          status: 'failed',
          externalId: String(payload.external_id ?? ''),
          receivedAt: new Date().toISOString(),
          error: `missing_credential:${key}`,
        };
      }
    }

    const recordName = kind === 'invoice'
      ? 'customrecord_minilago_invoice'
      : 'customrecord_minilago_credit_note';
    const url = `${org.netsuiteRestBase}/services/rest/record/v1/${recordName}`;
    const body = JSON.stringify(payload);
    const auth = buildOauthHeader({
      method: 'POST',
      url,
      consumerKey: org.netsuiteConsumerKey!,
      consumerSecret: org.netsuiteConsumerSecret!,
      tokenKey: org.netsuiteTokenKey!,
      tokenSecret: org.netsuiteTokenSecret!,
      realm: org.netsuiteAccountId!,
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: auth,
        },
        body,
      });
      const text = await response.text();
      if (!response.ok) {
        return {
          status: 'failed',
          externalId: String(payload.external_id ?? ''),
          receivedAt: new Date().toISOString(),
          error: `http_${response.status}:${text.slice(0, 240)}`,
        };
      }
      const parsed = safeJson(text);
      return {
        status: 'accepted',
        netsuiteInternalId: typeof parsed?.netsuite_internal_id === 'string' ? parsed.netsuite_internal_id : undefined,
        externalId: String(payload.external_id ?? ''),
        receivedAt: new Date().toISOString(),
        estimatedEmissionAt: typeof parsed?.estimated_emission_at === 'string' ? parsed.estimated_emission_at : undefined,
      };
    } catch (err) {
      return {
        status: 'failed',
        externalId: String(payload.external_id ?? ''),
        receivedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// OAuth 1.0a HMAC-SHA256 signature (TBA). Implementation per RFC 5849 + the
// NetSuite Token-Based Authentication guide.
function buildOauthHeader(args: {
  method: string;
  url: string;
  consumerKey: string;
  consumerSecret: string;
  tokenKey: string;
  tokenSecret: string;
  realm: string;
}): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: args.consumerKey,
    oauth_token: args.tokenKey,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  };

  const baseUrl = args.url.split('?')[0]!;
  const queryString = args.url.split('?')[1] ?? '';
  const queryParams = parseQuery(queryString);
  const all: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(oauthParams)) all.push([k, v]);
  for (const [k, vs] of Object.entries(queryParams)) for (const v of vs) all.push([k, v]);
  all.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const paramString = all.map(([k, v]) => `${percent(k)}=${percent(v)}`).join('&');
  const baseString = `${args.method.toUpperCase()}&${percent(baseUrl)}&${percent(paramString)}`;
  const signingKey = `${percent(args.consumerSecret)}&${percent(args.tokenSecret)}`;
  const signature = createHmac('sha256', signingKey).update(baseString).digest('base64');
  oauthParams.oauth_signature = signature;

  const header = `OAuth realm="${args.realm}", ` + Object.entries(oauthParams)
    .map(([k, v]) => `${percent(k)}="${percent(v)}"`)
    .join(', ');
  return header;
}

function percent(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function parseQuery(qs: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!qs) return out;
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const [rawKey, rawValue = ''] = pair.split('=');
    const key = decodeURIComponent(rawKey ?? '');
    const value = decodeURIComponent(rawValue);
    (out[key] ??= []).push(value);
  }
  return out;
}

// Used only by tests to build a deterministic hash for snapshot comparisons.
export function hashPayload(payload: DispatchPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
