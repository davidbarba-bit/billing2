// Minimal templating helpers for the admin UI. We render plain template
// literals so the admin keeps the same `npm run dev` story as the rest of
// the app (no separate build step). Styling is Tailwind via CDN; light
// interactivity uses HTMX.

const NAV_ITEMS: Array<{ href: string; label: string }> = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/customers', label: 'Customers' },
  { href: '/admin/subscriptions', label: 'Subscriptions' },
  { href: '/admin/invoices', label: 'Invoices' },
  { href: '/admin/credit-notes', label: 'Credit notes' },
  { href: '/admin/events', label: 'Events' },
  { href: '/admin/plans', label: 'Plans' },
  { href: '/admin/billable-metrics', label: 'Billable metrics' },
  { href: '/admin/add-ons', label: 'Add-ons' },
  { href: '/admin/taxes', label: 'Taxes' },
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

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export function fmtDateOnly(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toISOString().slice(0, 10);
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

export function layout(options: {
  title: string;
  active?: string;
  body: string;
  orgSlug: string;
  flash?: { kind: 'success' | 'error'; message: string } | null;
}): string {
  const nav = NAV_ITEMS.map((item) => {
    const active = options.active === item.href || (item.href !== '/admin' && options.active?.startsWith(item.href));
    const classes = active
      ? 'bg-gray-900 text-white'
      : 'text-gray-300 hover:bg-gray-700 hover:text-white';
    return `<a href="${item.href}" class="block px-4 py-2 rounded text-sm font-medium ${classes}">${escapeHtml(item.label)}</a>`;
  }).join('');

  const flashBanner = options.flash
    ? `<div class="${options.flash.kind === 'success' ? 'bg-green-50 border-green-300 text-green-900' : 'bg-red-50 border-red-300 text-red-900'} border rounded px-4 py-3 mb-4">${escapeHtml(options.flash.message)}</div>`
    : '';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)} · mini-Lago admin</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://unpkg.com/htmx.org@1.9.12" defer></script>
<style>
  pre.json { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; }
</style>
</head>
<body class="min-h-screen bg-gray-50 text-gray-900">
<div class="flex">
  <aside class="w-60 min-h-screen bg-gray-800 text-white p-4 sticky top-0">
    <div class="mb-6">
      <div class="text-xl font-bold">mini-Lago</div>
      <div class="text-xs text-gray-400 mt-1">${escapeHtml(options.orgSlug)}</div>
    </div>
    <nav class="space-y-1">${nav}</nav>
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
