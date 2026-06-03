// v21: admin del catálogo de eventos únicos. Lista, crea, edita, activa/
// desactiva. Los detalles del modelo y flujo viven en routes/catalog-events.ts
// y services/billing-engine.ts.

import {
  INPUT_CLASS,
  INPUT_CLASS_MONO,
  escapeHtml,
  fmtDateOnly,
  fmtMoney,
  formField,
  modal,
  modalTrigger,
  pageTitle,
  panel,
  postButton,
  primaryButton,
  secondaryLink,
  statusBadge,
  table,
} from './views.js';

type CatalogEventRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  defaultAmountCents: number | null;
  netsuiteItemCode: string | null;
  active: boolean;
  occurrenceCount: number;
};

export function renderCatalogEventList(rows: CatalogEventRow[]): string {
  const newButton = modalTrigger({ modalId: 'modal-new-catalog-event', label: '+ Nuevo evento' });

  const t = rows.length === 0
    ? `<div class="text-sm ink-faint italic py-6 text-center">Aún no hay eventos en el catálogo. Crea el primero con el botón de arriba.</div>`
    : table({
        rows,
        empty: 'Sin eventos',
        rowHref: (r) => `/admin/catalogo-eventos/${encodeURIComponent(r.code)}`,
        columns: [
          { label: 'Código', render: (r) => `<code class="font-mono-pro text-xs">${escapeHtml(r.code)}</code>` },
          { label: 'Nombre', render: (r) => `<div class="ink">${escapeHtml(r.name)}</div>${r.description ? `<div class="text-xs ink-faint mt-0.5">${escapeHtml(r.description)}</div>` : ''}` },
          { label: 'Monto default', render: (r) => r.defaultAmountCents !== null
            ? `<span class="font-mono-pro">${fmtMoney(r.defaultAmountCents, 'MXN')}</span>`
            : '<span class="ink-faint text-xs">— sin default —</span>' },
          { label: 'NetSuite', render: (r) => r.netsuiteItemCode
            ? `<code class="font-mono-pro text-xs">${escapeHtml(r.netsuiteItemCode)}</code>`
            : '<span class="ink-faint text-xs">— sin código —</span>' },
          { label: 'Status', render: (r) => statusBadge(r.active ? 'active' : 'terminated') },
          { label: 'Ocurrencias', render: (r) => `<span class="font-mono-pro text-xs">${r.occurrenceCount}</span>` },
        ],
      });

  const newForm = renderCatalogEventForm({ mode: 'create' });
  const newModal = modal({
    id: 'modal-new-catalog-event',
    title: 'Nuevo evento del catálogo',
    description: 'Define un evento único facturable (ej. revisión de dispositivo, capacitación). El código se genera automáticamente a partir del nombre.',
    body: newForm,
  });

  return panel({
    title: `Catálogo de eventos · ${rows.length}`,
    description: 'Eventos únicos facturables que se pueden registrar vía API para cualquier cliente. Cada ocurrencia detona una factura inmediata o se incluye en el próximo cierre de ciclo.',
    actions: newButton,
    body: t,
  }) + newModal;
}

type OccurrenceRow = {
  id: string;
  customerName: string;
  customerExternalId: string;
  unitExternalId: string | null;
  amountCents: number;
  currency: string;
  billingMode: string;
  reference: string | null;
  occurredAt: Date;
  feeId: string | null;
  invoiceId: string | null;
};

export function renderCatalogEventDetail(args: {
  event: CatalogEventRow;
  occurrences: OccurrenceRow[];
}): string {
  const header = pageTitle({
    eyebrow: 'Catálogo de eventos',
    title: args.event.name,
    description: args.event.description ?? undefined,
    actions: secondaryLink('/admin/catalogo-eventos', '← Catálogo'),
  });

  const propsList = `
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3">
      <div>
        <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Código</div>
        <div class="font-mono-pro ink">${escapeHtml(args.event.code)}</div>
      </div>
      <div>
        <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Monto default</div>
        <div class="font-mono-pro ink">${args.event.defaultAmountCents !== null
          ? fmtMoney(args.event.defaultAmountCents, 'MXN')
          : '<span class="ink-faint">— sin default —</span>'}</div>
      </div>
      <div>
        <div class="text-[10px] uppercase tracking-wider ink-faint mb-1">Item code NetSuite</div>
        <div class="font-mono-pro ink">${args.event.netsuiteItemCode ?? '<span class="ink-faint">— sin código —</span>'}</div>
      </div>
      <div class="sm:col-span-3 mt-2">
        ${statusBadge(args.event.active ? 'active' : 'terminated')}
      </div>
    </div>
    <div class="mt-5 pt-5 flex items-center gap-3" style="border-top: 1px solid var(--rule-soft);">
      ${modalTrigger({ modalId: 'modal-edit-catalog-event', label: 'Editar' })}
      ${postButton(`/admin/catalogo-eventos/${escapeHtml(args.event.code)}/toggle`, args.event.active ? 'Desactivar' : 'Activar', 'secondary', args.event.active ? '¿Desactivar este evento? No se podrán registrar nuevas ocurrencias.' : '¿Reactivar este evento?')}
      ${args.event.occurrenceCount === 0
        ? postButton(`/admin/catalogo-eventos/${escapeHtml(args.event.code)}/delete`, 'Eliminar', 'danger', '¿Eliminar este evento del catálogo? La acción no se puede deshacer.')
        : `<span class="text-xs ink-faint">No se puede eliminar — tiene ${args.event.occurrenceCount} ocurrencias registradas.</span>`}
    </div>
  `;

  const editForm = renderCatalogEventForm({ mode: 'edit', event: args.event });
  const editModal = modal({
    id: 'modal-edit-catalog-event',
    title: 'Editar evento del catálogo',
    description: 'El código no se puede cambiar después de creado.',
    body: editForm,
  });

  const occurrencesTable = args.occurrences.length === 0
    ? `<div class="text-sm ink-faint italic py-6 text-center">Aún no se han registrado ocurrencias de este evento.</div>`
    : table({
        rows: args.occurrences,
        empty: 'Sin ocurrencias',
        columns: [
          { label: 'Cliente', render: (o) => `<a class="hover:underline" style="color: var(--accent-deep);" href="/admin/customers/${escapeHtml(o.customerExternalId)}">${escapeHtml(o.customerName)}</a>` },
          { label: 'Unidad', render: (o) => o.unitExternalId
            ? `<code class="font-mono-pro text-xs">${escapeHtml(o.unitExternalId)}</code>`
            : '<span class="ink-faint text-xs">—</span>' },
          { label: 'Monto', render: (o) => `<span class="font-mono-pro">${fmtMoney(o.amountCents, o.currency)}</span>` },
          { label: 'Modo', render: (o) => o.billingMode === 'immediate'
            ? `<span class="pill pill-info">Inmediato</span>`
            : `<span class="pill pill-warn">Próximo ciclo</span>` },
          { label: 'Status', render: (o) => o.feeId
            ? (o.invoiceId
              ? `<a class="text-xs hover:underline" style="color: var(--accent-deep);" href="/admin/invoices/${escapeHtml(o.invoiceId)}">facturado</a>`
              : `<span class="pill pill-success">facturado</span>`)
            : `<span class="pill pill-warn">pendiente</span>` },
          { label: 'Ocurrido', render: (o) => fmtDateOnly(o.occurredAt) },
          { label: 'Referencia', render: (o) => o.reference
            ? `<span class="text-xs">${escapeHtml(o.reference)}</span>`
            : '<span class="ink-faint text-xs">—</span>' },
        ],
      });

  return header
    + panel({ title: 'Configuración', body: propsList })
    + panel({ title: `Ocurrencias · ${args.occurrences.length}`, body: occurrencesTable })
    + editModal;
}

function renderCatalogEventForm(args: {
  mode: 'create' | 'edit';
  event?: CatalogEventRow;
}): string {
  const e = args.event;
  const action = e ? `/admin/catalogo-eventos/${escapeHtml(e.code)}` : '/admin/catalogo-eventos';
  return `
    <form method="post" action="${action}" class="space-y-0">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5 mb-6">
        ${formField({
          label: 'Nombre',
          required: true,
          span: 2,
          hint: args.mode === 'create' ? 'El código se genera automáticamente a partir del nombre.' : 'Cambiar el nombre no afecta ocurrencias ya facturadas.',
          input: `<input required name="name" value="${escapeHtml(e?.name ?? '')}" placeholder="Revisión de dispositivo" class="${INPUT_CLASS}">`,
        })}
        ${formField({
          label: 'Descripción',
          span: 2,
          hint: 'Texto interno (opcional). No se muestra al cliente.',
          input: `<input name="description" value="${escapeHtml(e?.description ?? '')}" class="${INPUT_CLASS}">`,
        })}
        ${formField({
          label: 'Monto default',
          hint: 'En pesos MXN. Opcional — la API puede sobrescribirlo por ocurrencia. Si no hay default ni override, la ocurrencia será rechazada.',
          input: `<input type="number" step="0.01" min="0" name="default_amount" value="${e?.defaultAmountCents !== null && e?.defaultAmountCents !== undefined ? (e.defaultAmountCents / 100).toFixed(2) : ''}" placeholder="0.00" class="${INPUT_CLASS_MONO}">`,
        })}
        ${formField({
          label: 'Item code NetSuite',
          hint: 'Mapea cada ocurrencia a una línea del catálogo NetSuite. Opcional.',
          input: `<input name="netsuite_item_code" value="${escapeHtml(e?.netsuiteItemCode ?? '')}" placeholder="EVENT-REVIEW" class="${INPUT_CLASS_MONO}">`,
        })}
      </div>
      <div class="flex items-center gap-3 pt-4" style="border-top: 1px solid var(--rule);">
        ${primaryButton(args.mode === 'create' ? 'Crear evento' : 'Guardar cambios')}
      </div>
    </form>
  `;
}
