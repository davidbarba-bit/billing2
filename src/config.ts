// Environment configuration. Read once at startup so the rest of the code
// can treat values as constants.

export type AppConfig = {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly host: string;
  readonly logLevel: string;
  readonly databaseUrl: string;
  readonly featureNetsuiteDispatchEnabled: boolean;
  readonly featureNetsuiteCallbackMtls: boolean;
  readonly netsuiteCallbackIpAllowlist: readonly string[];
  readonly periodRolloverEnabled: boolean;
  readonly periodRolloverCron: string;
  readonly seedDefaultOrgSlug: string;
  readonly seedDefaultOrgTimezone: string;
  readonly seedDefaultApiKey: string;
  readonly callbackBaseUrl: string | undefined;
};

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development') as AppConfig['nodeEnv'];
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  return {
    nodeEnv,
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    logLevel: env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    databaseUrl,
    featureNetsuiteDispatchEnabled: bool(env.FEATURE_NETSUITE_DISPATCH_ENABLED, false),
    featureNetsuiteCallbackMtls: bool(env.FEATURE_NETSUITE_CALLBACK_MTLS, false),
    netsuiteCallbackIpAllowlist: (env.NETSUITE_CALLBACK_IP_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    periodRolloverEnabled: bool(env.PERIOD_ROLLOVER_ENABLED, true),
    periodRolloverCron: env.PERIOD_ROLLOVER_CRON ?? '*/15 * * * *',
    seedDefaultOrgSlug: env.SEED_DEFAULT_ORG_SLUG ?? 'NUM-FC2D',
    seedDefaultOrgTimezone: env.SEED_DEFAULT_ORG_TIMEZONE ?? 'America/Mexico_City',
    seedDefaultApiKey: env.SEED_DEFAULT_API_KEY ?? 'dev-api-key-replace-me',
    callbackBaseUrl: env.CALLBACK_BASE_URL,
  };
}
