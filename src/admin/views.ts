// Minimal templating helpers for the admin UI. We render plain template
// literals so the admin keeps the same `npm run dev` story as the rest of
// the app (no separate build step). Styling is Tailwind via CDN; light
// interactivity uses HTMX.

import { DateTime } from 'luxon';
import { adminContextStorage, getCurrentAdminUser, getCurrentUrl, isTechMode } from './context.js';

type NavItem = { href: string; label: string; target?: string };
type NavSection = { heading?: string; items: NavItem[]; techOnly?: boolean };

// Sidebar agrupada por función. La sección "Operaciones" reúne las vistas
// raw que casi nunca se navegan por sí solas (Units, Events, Invoices, CNs)
// — siguen accesibles desde el detalle del customer o desde issues.
const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { href: '/admin', label: 'Dashboard' },
      { href: '/admin/customers', label: 'Clientes' },
      { href: '/admin/services', label: 'Planes' },
    ],
  },
  {
    heading: 'Operaciones',
    items: [
      { href: '/admin/invoices', label: 'Facturas' },
      { href: '/admin/credit-notes', label: 'Notas de crédito' },
      { href: '/admin/units', label: 'Unidades' },
      { href: '/admin/events', label: 'Eventos' },
    ],
  },
  {
    heading: 'Sistema',
    items: [
      { href: '/presentacion.html', label: 'Presentación', target: '_blank' },
      { href: '/admin/settings', label: 'Ajustes' },
    ],
  },
];

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtMoney(amountCents: number, currency: string): string {
  const value = amountCents / 100;
  return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

// Returns the display timezone for the current admin request. Falls back
// to `UTC` so unit tests don't blow up if invoked outside a request.
function currentTz(): string {
  return adminContextStorage.getStore()?.displayTz ?? 'UTC';
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  const tz = currentTz();
  const dt = DateTime.fromJSDate(date, { zone: 'utc' }).setZone(tz);
  // Format: "2026-05-13 14:15:26 CST" (short tz abbreviation).
  return dt.toFormat("yyyy-LL-dd HH:mm:ss") + ' ' + (dt.offsetNameShort ?? dt.zoneName ?? tz);
}

export function fmtDateOnly(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  return DateTime.fromJSDate(date, { zone: 'utc' }).setZone(currentTz()).toFormat('yyyy-LL-dd');
}

// "Hace 3 días", "en 12 días", "hoy". Útil en dashboard / resumen.
export function fmtRelative(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  const dt = DateTime.fromJSDate(date, { zone: 'utc' }).setZone(currentTz());
  const now = DateTime.now().setZone(currentTz());
  const diff = dt.diff(now, ['days', 'hours']).toObject();
  const days = Math.round(diff.days ?? 0);
  if (Math.abs(days) === 0) return 'hoy';
  if (days > 0) return `en ${days} día${days === 1 ? '' : 's'}`;
  return `hace ${-days} día${days === -1 ? '' : 's'}`;
}

export function badge(text: string, tone: 'green' | 'yellow' | 'red' | 'gray' | 'blue' = 'gray'): string {
  const tones: Record<string, string> = {
    green: 'bg-green-100 text-green-800 border-green-300',
    yellow: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    red: 'bg-red-100 text-red-800 border-red-300',
    gray: 'bg-gray-100 text-gray-800 border-gray-300',
    blue: 'bg-blue-100 text-blue-800 border-blue-300',
  };
  return `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${tones[tone]}">${escapeHtml(text)}</span>`;
}

export function statusBadge(status: string): string {
  const map: Record<string, 'green' | 'yellow' | 'red' | 'gray' | 'blue'> = {
    active: 'green',
    pending: 'yellow',
    terminated: 'gray',
    canceled: 'gray',
    calculated: 'yellow',
    finalized: 'green',
    voided: 'red',
    dispatched: 'blue',
    confirmed: 'green',
    failed: 'red',
    paid: 'green',
    overdue: 'red',
    disputed: 'red',
    available: 'green',
    consumed: 'gray',
  };
  return badge(status, map[status] ?? 'gray');
}

// Render una sidebar. Cada `active` se compara contra `href` (exacto para
// /admin, prefix para los otros).
function renderNav(active?: string): string {
  return NAV_SECTIONS.map((section) => {
    const links = section.items.map((item) => {
      const isActive = active === item.href || (item.href !== '/admin' && active?.startsWith(item.href));
      const classes = isActive
        ? 'bg-gray-900 text-white'
        : 'text-gray-300 hover:bg-gray-700 hover:text-white';
      const targetAttr = item.target ? ` target="${item.target}" rel="noopener"` : '';
      return `<a href="${item.href}"${targetAttr} class="block px-3 py-1.5 rounded text-sm ${classes}">${escapeHtml(item.label)}</a>`;
    }).join('');
    const heading = section.heading
      ? `<div class="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">${escapeHtml(section.heading)}</div>`
      : '';
    return `<div class="space-y-0.5">${heading}${links}</div>`;
  }).join('<div class="my-2"></div>');
}

function renderTechToggle(currentUrl: string): string {
  const on = isTechMode();
  const next = on ? 'off' : 'on';
  return `
    <form method="post" action="/admin/settings/tech-mode" class="mt-3">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <input type="hidden" name="return_to" value="${escapeHtml(currentUrl)}">
      <button type="submit" class="w-full flex items-center justify-between px-3 py-2 rounded text-xs text-gray-300 hover:bg-gray-700 hover:text-white border border-gray-700">
        <span>Modo técnico</span>
        <span class="inline-flex items-center gap-1.5">
          <span class="w-7 h-3.5 rounded-full ${on ? 'bg-indigo-500' : 'bg-gray-600'} relative">
            <span class="absolute top-0.5 ${on ? 'right-0.5' : 'left-0.5'} w-2.5 h-2.5 rounded-full bg-white transition-all"></span>
          </span>
          <span class="text-[10px] uppercase font-semibold ${on ? 'text-indigo-300' : 'text-gray-400'}">${on ? 'on' : 'off'}</span>
        </span>
      </button>
    </form>
  `;
}

export function layout(options: {
  title: string;
  active?: string;
  body: string;
  orgSlug: string;
  flash?: { kind: 'success' | 'error'; message: string } | null;
  // v16: si hay sesión Google, mostramos el email + botón logout en el sidebar.
  user?: { email: string; name: string; picture: string | null } | null;
  // v20: URL actual — necesaria para que el toggle de modo técnico vuelva
  // a la misma página. Si no se provee, vuelve al dashboard.
  currentUrl?: string;
}): string {
  const nav = renderNav(options.active);
  // El toggle vuelve a la URL actual cuando el layout no la recibe
  // explícitamente — el hook `onRequest` del admin la guarda en el
  // AsyncLocalStorage para que esté disponible sin tocar cada handler.
  const techToggle = renderTechToggle(options.currentUrl ?? getCurrentUrl());

  const flashBanner = options.flash
    ? `<div class="${options.flash.kind === 'success' ? 'bg-green-50 border-green-300 text-green-900' : 'bg-red-50 border-red-300 text-red-900'} border rounded px-4 py-3 mb-4">${escapeHtml(options.flash.message)}</div>`
    : '';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)} · Numaris Billing admin</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/htmx.org@1.9.12" defer></script>
<style>
  pre.json { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; }
</style>
</head>
<body class="min-h-screen bg-gray-50 text-gray-900">
<div class="flex">
  <aside class="w-60 min-h-screen bg-gray-800 text-white p-4 sticky top-0 flex flex-col">
    <div class="mb-6">
      <div class="text-xl font-bold">Numaris Billing</div>
      <div class="text-xs text-gray-400 mt-1">${escapeHtml(options.orgSlug)}</div>
      <a href="/admin/settings" class="text-xs text-gray-400 hover:text-white mt-1 inline-block">
        tz: <code>${escapeHtml(currentTz())}</code> ✎
      </a>
    </div>
    <nav class="flex-1">${nav}</nav>
    ${techToggle}
    ${(() => {
      // v16: usuario activo (Google session) — viene del options.user explícito O del
      // AsyncLocalStorage (el hook lo pone para que cualquier handler que llame
      // `layout()` herede el usuario sin tener que recibirlo como argumento).
      const u = options.user ?? getCurrentAdminUser();
      return u ? `
    <div class="mt-3 pt-3 border-t border-gray-700">
      <div class="flex items-center gap-2 mb-2">
        ${u.picture
          ? `<img src="${escapeHtml(u.picture)}" referrerpolicy="no-referrer" class="w-8 h-8 rounded-full" alt="">`
          : `<div class="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center text-xs font-bold">${escapeHtml(u.email.charAt(0).toUpperCase())}</div>`}
        <div class="min-w-0 flex-1">
          <div class="text-xs font-medium truncate">${escapeHtml(u.name)}</div>
          <div class="text-xs text-gray-400 truncate">${escapeHtml(u.email)}</div>
        </div>
      </div>
      <form method="post" action="/admin/auth/logout">
        <button type="submit" class="block w-full text-left text-xs text-gray-300 hover:text-white py-1 px-2 hover:bg-gray-700 rounded">Cerrar sesión</button>
      </form>
    </div>
    ` : '';
    })()}
  </aside>
  <main class="flex-1 p-8 max-w-7xl">
    ${flashBanner}
    ${options.body}
  </main>
</div>
</body>
</html>`;
}

export function table<T>(args: {
  columns: Array<{ label: string; render: (row: T) => string; className?: string }>;
  rows: T[];
  empty?: string;
  rowHref?: (row: T) => string;
}): string {
  if (args.rows.length === 0) {
    return `<div class="text-gray-500 italic py-8">${escapeHtml(args.empty ?? 'No hay elementos')}</div>`;
  }
  const head = args.columns
    .map((c) => `<th class="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider ${c.className ?? ''}">${escapeHtml(c.label)}</th>`)
    .join('');
  const body = args.rows
    .map((row) => {
      const cells = args.columns
        .map((c) => `<td class="px-4 py-3 text-sm border-t ${c.className ?? ''}">${c.render(row)}</td>`)
        .join('');
      if (args.rowHref) {
        const href = args.rowHref(row);
        return `<tr class="hover:bg-gray-50 cursor-pointer" onclick="window.location='${href}'">${cells}</tr>`;
      }
      return `<tr class="hover:bg-gray-50">${cells}</tr>`;
    })
    .join('');
  return `<div class="bg-white rounded shadow-sm border overflow-hidden">
<table class="min-w-full divide-y">
  <thead class="bg-gray-50">${head}</thead>
  <tbody class="divide-y">${body}</tbody>
</table>
</div>`;
}

export function pageHeader(title: string, actions?: string): string {
  return `<div class="flex justify-between items-center mb-6">
    <h1 class="text-2xl font-bold">${escapeHtml(title)}</h1>
    <div>${actions ?? ''}</div>
  </div>`;
}

export function card(title: string, body: string, actions?: string): string {
  return `<div class="bg-white rounded shadow-sm border mb-6">
    <div class="px-4 py-3 border-b flex items-center justify-between">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-gray-600">${escapeHtml(title)}</h2>
      ${actions ? `<div>${actions}</div>` : ''}
    </div>
    <div class="p-4">${body}</div>
  </div>`;
}

export function kv(rows: Array<[string, string]>): string {
  return `<dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
  ${rows.map(([k, v]) => `<dt class="text-gray-500">${escapeHtml(k)}</dt><dd class="font-mono">${v}</dd>`).join('')}
  </dl>`;
}

export function code(value: unknown): string {
  return `<pre class="json bg-gray-900 text-gray-100 rounded p-4 overflow-auto">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

export function btn(href: string, label: string, kind: 'primary' | 'secondary' | 'danger' = 'secondary'): string {
  const classes = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700',
    secondary: 'bg-white text-gray-700 border hover:bg-gray-50',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  };
  return `<a href="${href}" class="inline-flex items-center px-3 py-1.5 rounded text-sm font-medium ${classes[kind]}">${escapeHtml(label)}</a>`;
}

export function postButton(action: string, label: string, kind: 'primary' | 'secondary' | 'danger' = 'secondary', confirm?: string): string {
  const classes = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700',
    secondary: 'bg-white text-gray-700 border hover:bg-gray-50',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  };
  const confirmAttr = confirm ? `onsubmit="return confirm('${escapeHtml(confirm)}')"` : '';
  return `<form method="post" action="${action}" class="inline" ${confirmAttr}>
    <button type="submit" class="inline-flex items-center px-3 py-1.5 rounded text-sm font-medium ${classes[kind]}">${escapeHtml(label)}</button>
  </form>`;
}

// Métricas grandes del dashboard. Tres tamaños:
//   - prominent → la cifra grande (MRR, MTD)
//   - medium    → secundarias (#customers activos)
//   - compact   → mini-stat
export function metricCard(args: {
  label: string;
  value: string;
  hint?: string;
  trend?: { direction: 'up' | 'down' | 'flat'; text: string };
  href?: string;
  size?: 'prominent' | 'medium' | 'compact';
  tone?: 'default' | 'warning' | 'success';
}): string {
  const sizeClasses = {
    prominent: { value: 'text-3xl', label: 'text-xs', padding: 'p-5' },
    medium: { value: 'text-2xl', label: 'text-xs', padding: 'p-4' },
    compact: { value: 'text-lg', label: 'text-[10px]', padding: 'p-3' },
  }[args.size ?? 'medium'];
  const toneBorder = {
    default: 'border-gray-200',
    warning: 'border-amber-300 bg-amber-50',
    success: 'border-green-300 bg-green-50',
  }[args.tone ?? 'default'];
  const trendHtml = args.trend
    ? (() => {
        const arrow = args.trend.direction === 'up' ? '↑' : args.trend.direction === 'down' ? '↓' : '→';
        const color = args.trend.direction === 'up' ? 'text-green-600'
          : args.trend.direction === 'down' ? 'text-red-600'
          : 'text-gray-500';
        return `<div class="text-xs ${color} mt-1">${arrow} ${escapeHtml(args.trend.text)}</div>`;
      })()
    : '';
  const hintHtml = args.hint
    ? `<div class="text-xs text-gray-500 mt-1">${args.hint}</div>`
    : '';
  const inner = `
    <div class="${sizeClasses.label} uppercase text-gray-500 tracking-wider font-semibold">${escapeHtml(args.label)}</div>
    <div class="${sizeClasses.value} font-semibold mt-1 text-gray-900">${args.value}</div>
    ${trendHtml}
    ${hintHtml}
  `;
  if (args.href) {
    return `<a href="${args.href}" class="block bg-white border rounded ${sizeClasses.padding} hover:shadow transition-shadow ${toneBorder}">${inner}</a>`;
  }
  return `<div class="bg-white border rounded ${sizeClasses.padding} ${toneBorder}">${inner}</div>`;
}

// Item de la lista "Atención requerida" del dashboard.
export function attentionItem(args: {
  icon: '⚠' | '●' | '⏳' | '✗';
  text: string;
  href?: string;
  tone: 'warning' | 'danger' | 'info';
}): string {
  const toneClasses = {
    warning: 'text-amber-700',
    danger: 'text-red-700',
    info: 'text-blue-700',
  }[args.tone];
  const link = args.href
    ? `<a href="${args.href}" class="text-indigo-600 hover:underline ml-1">→ ver</a>`
    : '';
  return `<li class="flex items-start gap-2 py-1.5 border-b border-gray-100 last:border-0">
    <span class="${toneClasses} font-semibold mt-0.5">${args.icon}</span>
    <span class="flex-1 text-sm text-gray-800">${args.text}${link}</span>
  </li>`;
}

// Tabs nav. `active` debe ser uno de los `key`. Genera links que mantienen
// el resto de query params del request actual pasando `currentSearch`.
export function tabs(args: {
  baseHref: string;
  active: string;
  items: Array<{ key: string; label: string; count?: number; badge?: string }>;
}): string {
  const links = args.items.map((item) => {
    const isActive = item.key === args.active;
    const classes = isActive
      ? 'border-indigo-600 text-indigo-700 font-semibold'
      : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300';
    const countHtml = typeof item.count === 'number'
      ? ` <span class="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] ${isActive ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600'}">${item.count}</span>`
      : '';
    const badgeHtml = item.badge ? ` ${item.badge}` : '';
    return `<a href="${args.baseHref}?tab=${encodeURIComponent(item.key)}" class="inline-flex items-center px-4 py-2 border-b-2 text-sm transition-colors ${classes}">${escapeHtml(item.label)}${countHtml}${badgeHtml}</a>`;
  }).join('');
  return `<div class="border-b border-gray-200 mb-6 -mt-2 flex items-center gap-1 overflow-x-auto">${links}</div>`;
}

// Bloque que solo se renderiza si el modo técnico está activado.
// Permite que cada vista decida qué esconder sin tener que ramificar a
// nivel de handler.
export function techOnly(content: string): string {
  if (!isTechMode()) return '';
  return content;
}

// Inverso: si el modo técnico está ON, esconde el bloque (para mostrar
// versiones "user-friendly" cuando el técnico está OFF).
export function unlessTech(content: string): string {
  if (isTechMode()) return '';
  return content;
}
