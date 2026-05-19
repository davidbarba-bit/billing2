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
  // v16: admin auth.
  //   - mode='basic' (default): basic auth con ADMIN_USER/ADMIN_PASSWORD.
  //   - mode='google': Google OAuth2 + sesión por cookie firmada.
  readonly adminAuthMode: 'basic' | 'google';
  readonly googleOauthClientId: string | undefined;
  readonly googleOauthClientSecret: string | undefined;
  // Domain dueño aceptado para login (sin "@"). Default 'numaris.com'.
  readonly adminAllowedEmailDomain: string;
  // HMAC secret para firmar cookies de sesión admin (debe ser ≥ 32 chars).
  readonly sessionSecret: string | undefined;
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
  const adminAuthMode = (env.ADMIN_AUTH_MODE === 'google' ? 'google' : 'basic') as 'basic' | 'google';
  if (adminAuthMode === 'google' && nodeEnv === 'production') {
    if (!env.GOOGLE_OAUTH_CLIENT_ID) throw new Error('GOOGLE_OAUTH_CLIENT_ID is required when ADMIN_AUTH_MODE=google');
    if (!env.GOOGLE_OAUTH_CLIENT_SECRET) throw new Error('GOOGLE_OAUTH_CLIENT_SECRET is required when ADMIN_AUTH_MODE=google');
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
      throw new Error('SESSION_SECRET is required and must be at least 32 characters when ADMIN_AUTH_MODE=google');
    }
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
    adminAuthMode,
    googleOauthClientId: env.GOOGLE_OAUTH_CLIENT_ID,
    googleOauthClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    adminAllowedEmailDomain: env.ADMIN_ALLOWED_EMAIL_DOMAIN ?? 'numaris.com',
    sessionSecret: env.SESSION_SECRET,
  };
}
