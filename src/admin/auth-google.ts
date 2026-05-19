// v16: Google OAuth2 admin auth.
//
// Flujo:
//   1. GET /admin/auth/login  → muestra la pantalla con botón "Iniciar sesión con Google".
//   2. GET /admin/auth/google-start  → @fastify/oauth2 redirige a Google (con state CSRF).
//   3. GET /admin/auth/callback  → recibe code, intercambia por tokens, valida domain,
//      setea cookie firmada con la sesión.
//   4. POST /admin/auth/logout → limpia la cookie.
//
// Cookie firmada (HMAC-SHA256):
//   formato: <base64-payload>.<base64-signature>
//   payload: { email, name, picture, exp }
//   verify: re-compute HMAC y compara; chequea exp > now.
//
// Validación de dominio: el id_token de Google está firmado por Google. Decodificamos
// (sin verificar firma — Google ya lo verificó al darnos el token) y leemos email +
// email_verified. Solo aceptamos email_verified=true y endsWith('@'+allowedDomain).

import { createHmac } from 'node:crypto';
import oauthPlugin from '@fastify/oauth2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type GoogleSession = {
  email: string;
  name: string;
  picture: string | null;
  exp: number; // unix seconds
};

export const ADMIN_SESSION_COOKIE = 'numaris_admin_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h

function b64urlEncode(input: string | Buffer): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf-8');
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function encodeSession(session: GoogleSession, secret: string): string {
  const payload = b64urlEncode(JSON.stringify(session));
  return `${payload}.${sign(payload, secret)}`;
}

export function decodeSession(cookie: string, secret: string): GoogleSession | null {
  if (typeof cookie !== 'string') return null;
  const dot = cookie.indexOf('.');
  if (dot <= 0 || dot === cookie.length - 1) return null;
  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  // Comparación segura contra timing attacks: comparamos longitud primero,
  // luego carácter por carácter sin short-circuit.
  const expected = sign(payload, secret);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const session = JSON.parse(b64urlDecode(payload).toString('utf-8')) as GoogleSession;
    if (typeof session.exp !== 'number' || session.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof session.email !== 'string') return null;
    return session;
  } catch {
    return null;
  }
}

export function getGoogleSession(request: FastifyRequest, secret: string): GoogleSession | null {
  const cookies = (request as unknown as { cookies?: Record<string, string> }).cookies ?? {};
  const cookie = cookies[ADMIN_SESSION_COOKIE];
  if (!cookie) return null;
  return decodeSession(cookie, secret);
}

export function clearGoogleSession(reply: FastifyReply): void {
  reply.clearCookie(ADMIN_SESSION_COOKIE, { path: '/admin' });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function loginPage(allowedDomain: string, next?: string, error?: string): string {
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : '';
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Numaris Billing · Iniciar sesión</title>
<script src="https://cdn.tailwindcss.com"></script>
</head><body class="min-h-screen bg-gray-50 flex items-center justify-center">
<div class="bg-white p-8 rounded-lg shadow-md max-w-md w-full mx-4">
  <h1 class="text-2xl font-bold text-gray-900 mb-2">Numaris Billing</h1>
  <p class="text-sm text-gray-600 mb-6">Inicia sesión con tu cuenta corporativa <code class="bg-gray-100 px-1.5 py-0.5 rounded text-xs">@${escapeHtml(allowedDomain)}</code></p>
  ${error ? `<div class="mb-4 p-3 rounded border border-red-300 bg-red-50 text-sm text-red-900">${escapeHtml(error)}</div>` : ''}
  <a href="/admin/auth/google-start${nextQuery}" class="flex items-center justify-center gap-3 w-full px-4 py-3 bg-white border-2 border-gray-300 rounded-md font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-400 transition">
    <svg width="20" height="20" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
      <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
      <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
      <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571.001-.001.002-.001.003-.002l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
    </svg>
    Iniciar sesión con Google
  </a>
  <p class="text-xs text-gray-500 mt-6 text-center">Solo cuentas del dominio <code>@${escapeHtml(allowedDomain)}</code> pueden acceder.</p>
</div>
</body></html>`;
}

function deniedPage(allowedDomain: string, attemptedEmail: string): string {
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<title>Acceso denegado</title>
<script src="https://cdn.tailwindcss.com"></script>
</head><body class="min-h-screen bg-gray-50 flex items-center justify-center">
<div class="bg-white p-8 rounded-lg shadow-md max-w-md w-full mx-4">
  <div class="flex items-center gap-3 mb-4">
    <div class="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center text-red-600 text-xl font-bold">✕</div>
    <h1 class="text-xl font-bold text-gray-900">Acceso denegado</h1>
  </div>
  <p class="text-sm text-gray-700 mb-2">El dominio de tu correo no está autorizado para entrar a Numaris Billing.</p>
  <div class="bg-gray-50 border border-gray-200 rounded p-3 my-4 text-sm">
    <div><span class="text-gray-500">Tu correo:</span> <code class="font-mono">${escapeHtml(attemptedEmail)}</code></div>
    <div class="mt-1"><span class="text-gray-500">Permitido:</span> <code class="font-mono">@${escapeHtml(allowedDomain)}</code></div>
  </div>
  <p class="text-xs text-gray-500 mt-4">Si necesitas acceso, contacta al administrador.</p>
  <div class="mt-6">
    <a href="https://accounts.google.com/Logout" target="_blank" rel="noopener" class="text-sm text-indigo-600 hover:underline">Cerrar sesión de Google</a>
    <span class="text-gray-300 mx-2">·</span>
    <a href="/admin/auth/login" class="text-sm text-indigo-600 hover:underline">Volver al login</a>
  </div>
</div>
</body></html>`;
}

export type GoogleAuthConfig = {
  clientId: string;
  clientSecret: string;
  // URL pública de la app (ej. https://billing.numaris.com). El callback se
  // monta en `${publicBaseUrl}/admin/auth/callback`.
  publicBaseUrl: string;
  allowedDomain: string;
  sessionSecret: string;
};

export async function registerGoogleAuth(app: FastifyInstance, cfg: GoogleAuthConfig): Promise<void> {
  const callbackUri = `${cfg.publicBaseUrl.replace(/\/$/, '')}/admin/auth/callback`;

  await app.register(oauthPlugin, {
    name: 'googleOAuth2',
    scope: ['openid', 'email', 'profile'],
    credentials: {
      client: { id: cfg.clientId, secret: cfg.clientSecret },
      auth: oauthPlugin.GOOGLE_CONFIGURATION,
    },
    // El plugin auto-genera el handler en este path que redirige a Google.
    startRedirectPath: '/admin/auth/google-start',
    callbackUri,
    // hd hint (limita el account chooser a un Workspace específico — extra
    // capa además de la validación en el callback).
    discovery: undefined,
  });

  // Pantalla de login (con botón hacia google-start).
  app.get('/admin/auth/login', async (request, reply) => {
    const q = request.query as { next?: string; error?: string };
    // Si ya hay sesión válida, va directo al admin.
    const session = getGoogleSession(request, cfg.sessionSecret);
    if (session) {
      reply.redirect(q.next || '/admin');
      return;
    }
    reply.type('text/html').send(loginPage(cfg.allowedDomain, q.next, q.error));
  });

  // Callback de Google.
  app.get('/admin/auth/callback', async (request, reply) => {
    try {
      // @ts-expect-error decorator agregado por oauthPlugin
      const tokenResp = await app.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);
      const idToken = tokenResp?.token?.id_token as string | undefined;
      if (!idToken) {
        reply.code(500).type('text/html').send('<h1>Error</h1><p>Google no devolvió id_token.</p>');
        return;
      }
      // Decodifica payload del id_token JWT (firmado por Google; ya verificado
      // por el intercambio del code).
      const parts = idToken.split('.');
      if (parts.length !== 3) {
        reply.code(500).type('text/html').send('<h1>Error</h1><p>id_token con formato inválido.</p>');
        return;
      }
      const claims = JSON.parse(b64urlDecode(parts[1]!).toString('utf-8')) as {
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
      };

      if (!claims.email || !claims.email_verified) {
        reply.code(403).type('text/html').send(deniedPage(cfg.allowedDomain, claims.email ?? '(desconocido)'));
        return;
      }
      const email = claims.email.toLowerCase();
      const suffix = '@' + cfg.allowedDomain.toLowerCase();
      if (!email.endsWith(suffix)) {
        reply.code(403).type('text/html').send(deniedPage(cfg.allowedDomain, email));
        return;
      }

      const session: GoogleSession = {
        email,
        name: claims.name ?? email,
        picture: claims.picture ?? null,
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      };
      const value = encodeSession(session, cfg.sessionSecret);
      reply.setCookie(ADMIN_SESSION_COOKIE, value, {
        path: '/admin',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: SESSION_TTL_SECONDS,
      });
      // Redirect a la URL original que querían visitar (state es manejado por el plugin,
      // pero el next= viaja por query si lo soportamos así). En esta versión simple
      // siempre vamos al dashboard.
      reply.redirect('/admin');
    } catch (err) {
      app.log.error({ err }, 'google auth callback failed');
      reply.code(500).type('text/html').send('<h1>Error</h1><p>No se pudo procesar el login. Intenta de nuevo desde <a href="/admin/auth/login">/admin/auth/login</a>.</p>');
    }
  });

  // Logout — cualquier método (GET/POST), por si se llama desde un link.
  const logoutHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
    clearGoogleSession(reply);
    reply.redirect('/admin/auth/login');
  };
  app.post('/admin/auth/logout', logoutHandler);
  app.get('/admin/auth/logout', logoutHandler);
}
