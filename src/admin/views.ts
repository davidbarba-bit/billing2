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

// Render una sidebar editorial — links sutiles, indicador de activo con
// una barra vertical en lugar de un bloque resaltado pesado.
function renderNav(active?: string): string {
  return NAV_SECTIONS.map((section) => {
    const links = section.items.map((item) => {
      const isActive = active === item.href || (item.href !== '/admin' && active?.startsWith(item.href));
      const linkClass = isActive ? 'nav-link-active' : 'nav-link';
      const indicator = isActive
        ? '<span class="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[2px]" style="background: var(--accent);"></span>'
        : '';
      const targetAttr = item.target ? ` target="${item.target}" rel="noopener"` : '';
      return `<a href="${item.href}"${targetAttr} class="${linkClass} relative block pl-4 pr-3 py-1.5 rounded-sm text-[13px] font-normal">${indicator}${escapeHtml(item.label)}</a>`;
    }).join('');
    const heading = section.heading
      ? `<div class="px-4 pt-5 pb-1.5 text-[10px] uppercase tracking-[0.12em] font-medium" style="color: #6E6759;">${escapeHtml(section.heading)}</div>`
      : '';
    return `<div class="space-y-px">${heading}${links}</div>`;
  }).join('<div class="my-1.5"></div>');
}

function renderTechToggle(currentUrl: string): string {
  const on = isTechMode();
  const next = on ? 'off' : 'on';
  return `
    <form method="post" action="/admin/settings/tech-mode" class="mt-4">
      <input type="hidden" name="next" value="${escapeHtml(next)}">
      <input type="hidden" name="return_to" value="${escapeHtml(currentUrl)}">
      <button type="submit" class="tech-toggle w-full flex items-center justify-between px-3 py-2 rounded-sm text-[11px]">
        <span class="uppercase tracking-wider">Modo técnico</span>
        <span class="inline-flex items-center gap-1.5">
          <span class="relative inline-block w-7 h-3.5 rounded-full transition-colors" style="background: ${on ? 'var(--accent)' : '#3F4A40'};">
            <span class="absolute top-0.5 w-2.5 h-2.5 rounded-full transition-all" style="background: #FBFAF7; ${on ? 'right: 2px;' : 'left: 2px;'}"></span>
          </span>
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
<title>${escapeHtml(options.title)} · Numaris Billing</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/htmx.org@1.9.12" defer></script>
<link rel="preconnect" href="https://fonts.bunny.net" crossorigin>
<link rel="stylesheet" href="https://fonts.bunny.net/css?family=fraunces:400,500,600,700|ibm-plex-sans:400,500,600|ibm-plex-mono:400,500&display=swap">
<style>
  /* ----- design tokens: 'quiet precision' ----- */
  :root {
    --paper:        #FBFAF7;
    --paper-soft:   #F4F1EA;
    --ink:          #1A1714;
    --ink-soft:     #4A463F;
    --ink-faint:    #8A857B;
    --rule:         #E5E1D8;
    --rule-soft:    #EFEBE2;
    --accent:       #0F3D2E;
    --accent-hover: #1A5B47;
    --accent-soft:  #E4ECE7;
    --warn:         #B8731A;
    --warn-soft:    #FAF1E0;
    --danger:       #A8351F;
    --danger-soft:  #F6E5E2;
    --info:         #2C5282;
    --info-soft:    #E3EAF2;
    --sidebar:      #1A1F1B;
    --sidebar-soft: #283129;
  }
  html, body { background: var(--paper); }
  body {
    font-family: 'IBM Plex Sans', system-ui, -apple-system, sans-serif;
    color: var(--ink);
    font-feature-settings: 'ss01';
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  /* subtle grain — gives the paper feel without being distracting */
  body::before {
    content: '';
    position: fixed; inset: 0;
    pointer-events: none;
    z-index: 0;
    opacity: 0.4;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.1 0 0 0 0 0.09 0 0 0 0 0.08 0 0 0 0.04 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  }
  body > * { position: relative; z-index: 1; }
  .font-display { font-family: 'Fraunces', Georgia, serif; font-feature-settings: 'ss01'; letter-spacing: -0.01em; }
  .font-mono-pro { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
  .num { font-variant-numeric: tabular-nums; }

  /* surfaces */
  .surface-paper { background: var(--paper); }
  .surface-card { background: #FFFFFF; border: 1px solid var(--rule); }
  .surface-tone { background: var(--paper-soft); }
  .rule { border-color: var(--rule); }
  .rule-soft { border-color: var(--rule-soft); }

  /* ink colors as utilities */
  .ink { color: var(--ink); }
  .ink-soft { color: var(--ink-soft); }
  .ink-faint { color: var(--ink-faint); }

  /* accent system */
  .accent { color: var(--accent); }
  .bg-accent { background: var(--accent); }
  .bg-accent-soft { background: var(--accent-soft); }
  .border-accent { border-color: var(--accent); }

  /* primary button — refined, no gratuitous shadows */
  .btn-primary {
    background: var(--accent); color: #FBFAF7;
    padding: 0.625rem 1.25rem;
    border-radius: 4px;
    font-weight: 500;
    font-size: 0.875rem;
    letter-spacing: 0.01em;
    transition: background 160ms ease;
    border: 1px solid var(--accent);
    box-shadow: 0 1px 0 rgba(15,61,46,.08);
  }
  .btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn-primary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* ghost / secondary */
  .btn-ghost {
    background: transparent; color: var(--ink-soft);
    padding: 0.625rem 1.25rem;
    border-radius: 4px;
    font-weight: 500;
    font-size: 0.875rem;
    border: 1px solid var(--rule);
    transition: border-color 160ms ease, color 160ms ease;
  }
  .btn-ghost:hover { border-color: var(--ink-faint); color: var(--ink); }

  /* inputs — refined: only bottom border on focus, restrained palette */
  .field {
    width: 100%;
    background: #FFFFFF;
    border: 1px solid var(--rule);
    border-radius: 4px;
    padding: 0.625rem 0.875rem;
    font-size: 0.875rem;
    color: var(--ink);
    font-family: 'IBM Plex Sans', sans-serif;
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }
  .field::placeholder { color: var(--ink-faint); }
  .field:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(15,61,46,0.08);
  }
  .field-mono { font-family: 'IBM Plex Mono', monospace; font-size: 0.8125rem; }

  /* select chevron */
  select.field {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='%238A857B' stroke-width='1.5'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.875rem center;
    padding-right: 2.25rem;
  }

  /* badges editorial — pills sin bordes pesados */
  .pill {
    display: inline-flex; align-items: center;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    font-size: 0.6875rem;
    font-weight: 500;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .pill-success { background: var(--accent-soft); color: var(--accent); }
  .pill-warn    { background: var(--warn-soft);   color: var(--warn); }
  .pill-danger  { background: var(--danger-soft); color: var(--danger); }
  .pill-info    { background: var(--info-soft);   color: var(--info); }
  .pill-mute    { background: var(--paper-soft);  color: var(--ink-soft); }

  /* page entrance — discreto, sin bouncy springs */
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  main > * { animation: fadeUp 320ms cubic-bezier(0.2, 0.7, 0.2, 1) both; }
  main > *:nth-child(1) { animation-delay: 0ms; }
  main > *:nth-child(2) { animation-delay: 40ms; }
  main > *:nth-child(3) { animation-delay: 80ms; }
  main > *:nth-child(4) { animation-delay: 120ms; }

  /* form section dividers — only between siblings, not before the first */
  .form-section + .form-section {
    border-top: 1px solid var(--rule);
    padding-top: 2.25rem;
    margin-top: 2.25rem;
  }

  /* sidebar interactives */
  .nav-link {
    color: #B6AB97;
    transition: color 160ms ease, background 160ms ease;
  }
  .nav-link:hover { color: #FBFAF7; }
  .nav-link-active {
    color: #FBFAF7;
    background: #283129;
  }
  .nav-link-active:hover { color: #FBFAF7; }

  .tech-toggle {
    color: #8A8678;
    border: 1px solid #2F3A30;
    transition: color 160ms ease, border-color 160ms ease;
  }
  .tech-toggle:hover { color: #E9E5DC; border-color: #3F4A40; }

  .user-link {
    color: #8A8678;
    transition: color 160ms ease, background 160ms ease;
  }
  .user-link:hover { color: #E9E5DC; background: #283129; }

  pre.json { font-family: 'IBM Plex Mono', monospace; font-size: 12px; }

  /* override de utilidades tailwind clave que aparecen en el código viejo
     para que las páginas no migradas hereden la nueva paleta automáticamente */
  .bg-indigo-600, .hover\\:bg-indigo-700:hover { background-color: var(--accent) !important; }
  .bg-indigo-700 { background-color: var(--accent-hover) !important; }
  .text-indigo-600, .text-indigo-700 { color: var(--accent) !important; }
  .border-indigo-600, .border-indigo-500 { border-color: var(--accent) !important; }
  .ring-indigo-500 { --tw-ring-color: var(--accent) !important; }
  .focus\\:ring-indigo-500:focus { --tw-ring-color: var(--accent) !important; }
  .focus\\:border-indigo-500:focus { border-color: var(--accent) !important; }
</style>
</head>
<body class="min-h-screen">
<div class="flex">
  <aside class="w-64 min-h-screen p-5 sticky top-0 flex flex-col" style="background: var(--sidebar); color: #E9E5DC;">
    <div class="mb-8">
      <div class="font-display text-[1.35rem] leading-tight font-medium" style="color: #FBFAF7;">Numaris</div>
      <div class="font-display text-[1.35rem] leading-tight italic font-normal" style="color: #B6AB97; margin-top: -2px;">Billing</div>
      <div class="mt-3 flex items-center gap-2">
        <span class="text-[10px] uppercase tracking-wider font-medium" style="color: #6E6759;">${escapeHtml(options.orgSlug)}</span>
      </div>
      <a href="/admin/settings" class="text-xs mt-2 inline-flex items-center gap-1 transition-colors" style="color: #6E6759;" onmouseover="this.style.color='#E9E5DC'" onmouseout="this.style.color='#6E6759'">
        <span class="font-mono-pro text-[10px]">${escapeHtml(currentTz())}</span> ✎
      </a>
    </div>
    <nav class="flex-1">${nav}</nav>
    ${techToggle}
    ${(() => {
      const u = options.user ?? getCurrentAdminUser();
      return u ? `
    <div class="mt-4 pt-4" style="border-top: 1px solid #2F3A30;">
      <div class="flex items-center gap-2.5 mb-2.5">
        ${u.picture
          ? `<img src="${escapeHtml(u.picture)}" referrerpolicy="no-referrer" class="w-8 h-8 rounded-full" alt="">`
          : `<div class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium" style="background: var(--accent); color: #FBFAF7;">${escapeHtml(u.email.charAt(0).toUpperCase())}</div>`}
        <div class="min-w-0 flex-1">
          <div class="text-xs font-medium truncate" style="color: #E9E5DC;">${escapeHtml(u.name)}</div>
          <div class="text-[11px] truncate" style="color: #8A8678;">${escapeHtml(u.email)}</div>
        </div>
      </div>
      <form method="post" action="/admin/auth/logout">
        <button type="submit" class="user-link block w-full text-left text-xs py-1.5 px-2 rounded">Cerrar sesión</button>
      </form>
    </div>
    ` : '';
    })()}
  </aside>
  <main class="flex-1 px-10 py-10 max-w-[1280px]">
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

// --- Form helpers (v21 — 'quiet precision') -----------------------------

// Las clases viven en el <style> del layout (ver clase `.field`). Estas
// constantes solo añaden lo que es específico de cada uso.
export const INPUT_CLASS = 'field';
export const INPUT_CLASS_MONO = 'field field-mono';

// Bloque visual para una sección del form. El hairline divider se aplica
// vía CSS `.form-section + .form-section` solo entre hermanos — el primero
// no recibe borde ni padding-top adicional.
export function formSection(opts: {
  title: string;
  description?: string;
  body: string;
}): string {
  return `<section class="form-section pb-1">
    <div class="mb-6">
      <h3 class="font-display text-lg font-medium ink tracking-tight">${escapeHtml(opts.title)}</h3>
      ${opts.description ? `<p class="text-sm ink-soft mt-1 max-w-2xl leading-relaxed">${opts.description}</p>` : ''}
    </div>
    <div>${opts.body}</div>
  </section>`;
}

// Campo de form con label uppercase pequeño (estilo editorial), input
// arbitrario y hint. `input` debe ser HTML crudo — usar INPUT_CLASS para
// consistencia.
export function formField(opts: {
  label: string;
  required?: boolean;
  hint?: string;
  input: string;
  span?: 1 | 2;
}): string {
  const reqMark = opts.required ? ' <span style="color: var(--danger);" aria-hidden="true">*</span>' : '';
  const hint = opts.hint ? `<p class="mt-2 text-xs ink-faint leading-relaxed">${opts.hint}</p>` : '';
  const colSpan = opts.span === 2 ? 'sm:col-span-2' : '';
  return `<label class="block ${colSpan}">
    <span class="block text-[11px] uppercase tracking-[0.08em] font-medium ink-soft mb-2">${escapeHtml(opts.label)}${reqMark}</span>
    ${opts.input}
    ${hint}
  </label>`;
}

// Input de monto: prefix de currency en mono, valor en pesos con dos
// decimales. El handler convierte a cents al persistir.
export function moneyInput(opts: {
  name: string;
  currency: string;
  valueCents?: number | null;
  required?: boolean;
  min?: number;
  placeholder?: string;
}): string {
  const valuePesos = opts.valueCents != null ? (opts.valueCents / 100).toFixed(2) : '';
  const required = opts.required ? 'required' : '';
  const min = opts.min !== undefined ? `min="${opts.min}"` : 'min="0"';
  const placeholder = opts.placeholder ?? '0.00';
  return `<div class="relative">
    <span class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-[11px] font-mono-pro uppercase tracking-wider ink-faint">${escapeHtml(opts.currency)}</span>
    <input ${required} type="number" step="0.01" ${min} name="${escapeHtml(opts.name)}" value="${escapeHtml(valuePesos)}" placeholder="${escapeHtml(placeholder)}" class="field field-mono pl-14 text-right">
  </div>`;
}

// Botones. El primario tiene la sombra editorial muy sutil; el secundario
// es ghost con hairline.
export function primaryButton(label: string, opts?: { type?: 'submit' | 'button' }): string {
  return `<button type="${opts?.type ?? 'submit'}" class="btn-primary inline-flex items-center justify-center">${escapeHtml(label)}</button>`;
}

export function secondaryLink(href: string, label: string): string {
  return `<a href="${href}" class="btn-ghost inline-flex items-center justify-center">${escapeHtml(label)}</a>`;
}

// Panel — sustituye `card()` para páginas migradas. Surface cream sobre
// fondo papel, hairline en lugar de sombra pesada.
export function panel(opts: {
  title?: string;
  description?: string;
  body: string;
  actions?: string;
  toned?: boolean;
}): string {
  const surface = opts.toned ? 'surface-tone' : 'surface-card';
  const header = opts.title
    ? `<div class="flex items-start justify-between gap-4 px-7 py-5" style="border-bottom: 1px solid var(--rule);">
        <div>
          <h2 class="text-[11px] uppercase tracking-[0.1em] font-semibold ink-soft">${escapeHtml(opts.title)}</h2>
          ${opts.description ? `<p class="text-xs ink-faint mt-1">${opts.description}</p>` : ''}
        </div>
        ${opts.actions ? `<div class="flex items-center gap-2 shrink-0">${opts.actions}</div>` : ''}
      </div>`
    : '';
  return `<div class="${surface} mb-8" style="border-radius: 6px;">
    ${header}
    <div class="px-7 py-6">${opts.body}</div>
  </div>`;
}

// Cabecera de página — eyebrow uppercase + título serif XL + descripción.
// Asimétrica: el título a la izquierda con buen aire, acciones empujadas a
// la derecha. La descripción se permite respirar (max-w-2xl, leading-relax).
export function pageTitle(opts: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: string;
}): string {
  return `<header class="mb-10 flex items-end justify-between gap-8 flex-wrap">
    <div class="max-w-3xl">
      ${opts.eyebrow ? `<div class="text-[10px] uppercase tracking-[0.18em] font-medium mb-3" style="color: var(--accent);">${escapeHtml(opts.eyebrow)}</div>` : ''}
      <h1 class="font-display text-[2.25rem] leading-[1.1] font-medium ink tracking-tight">${escapeHtml(opts.title)}</h1>
      ${opts.description ? `<p class="text-[15px] ink-soft mt-3 leading-relaxed max-w-2xl">${opts.description}</p>` : ''}
    </div>
    ${opts.actions ? `<div class="flex items-center gap-2 shrink-0 pb-1">${opts.actions}</div>` : ''}
  </header>`;
}
