// Cuestionario público de migración. Renderiza un form auto-explicativo
// que el equipo comercial llena para que el admin configure la cuenta.
// No pide datos fiscales del cliente ni listado de unidades — solo lo
// necesario para configurar planes, ciclo y add-ons.

import { escapeHtml } from './views.js';

const PUBLIC_HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<link rel="preconnect" href="https://fonts.bunny.net" crossorigin>
<link rel="stylesheet" href="https://fonts.bunny.net/css?family=raleway:400,500,600,700|montserrat:400,500,600,700|ibm-plex-mono:400,500&display=swap">
<style>
  :root {
    --paper: #FAFAFA; --paper-soft: #F2F2F2;
    --ink: #0F1419; --ink-soft: #3A4452; --ink-faint: #7A8390;
    --rule: #DCDFE3; --rule-soft: #E8EAED;
    --accent: #3274BA; --accent-hover: #013668; --accent-deep: #013668;
    --accent-soft: #E2EBF4; --accent-tint: #F1F6FB;
    --warn: #8B5A1C; --warn-soft: #F3EDE3;
    --danger: #8B2D1E;
  }
  html, body { background: var(--paper); }
  body { font-family: 'Montserrat', system-ui, sans-serif; color: var(--ink); -webkit-font-smoothing: antialiased; }
  .font-display { font-family: 'Raleway', system-ui, sans-serif; letter-spacing: -0.01em; }
  .font-mono-pro { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; }
  .ink { color: var(--ink); } .ink-soft { color: var(--ink-soft); } .ink-faint { color: var(--ink-faint); }
  .surface-card { background: #FFFFFF; border: 1px solid var(--rule); }
  .surface-tone { background: var(--paper-soft); }
  .btn-primary {
    background: var(--accent); color: #FAFAFA;
    padding: 0.75rem 1.5rem; border-radius: 4px;
    font-weight: 500; font-size: 0.9rem;
    border: 1px solid var(--accent);
    transition: background 160ms ease;
  }
  .btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn-ghost {
    background: transparent; color: var(--ink-soft);
    padding: 0.625rem 1.25rem; border-radius: 4px;
    font-weight: 500; font-size: 0.85rem;
    border: 1px dashed var(--rule);
    transition: border-color 160ms ease, color 160ms ease;
    cursor: pointer;
  }
  .btn-ghost:hover { border-color: var(--accent); color: var(--accent); border-style: solid; }
  .field {
    width: 100%; background: #FFFFFF;
    border: 1px solid var(--rule); border-radius: 4px;
    padding: 0.625rem 0.875rem; font-size: 0.9rem;
    color: var(--ink); font-family: 'Montserrat', sans-serif;
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }
  .field::placeholder { color: var(--ink-faint); }
  .field:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(50,116,186,0.12); }
  .field-mono { font-family: 'IBM Plex Mono', monospace; font-size: 0.85rem; }
  select.field {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='%237A8390' stroke-width='1.5'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 0.875rem center;
    padding-right: 2.25rem;
  }
  .field-label {
    display: block; font-size: 0.7rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--ink-soft); margin-bottom: 0.4rem;
  }
  .field-hint { font-size: 0.78rem; color: var(--ink-faint); margin-top: 0.35rem; line-height: 1.5; }
  .req { color: var(--danger); font-weight: 400; }
  .section-head { padding: 1.5rem 1.75rem; border-bottom: 1px solid var(--rule); }
  .section-body { padding: 1.75rem; }
  .section-title { font-family: 'Raleway', sans-serif; font-size: 1.1rem; font-weight: 600; color: var(--ink); letter-spacing: -0.01em; }
  .section-desc { font-size: 0.875rem; color: var(--ink-soft); margin-top: 0.4rem; line-height: 1.55; max-width: 56ch; }
  .radio-card {
    position: relative; cursor: pointer; padding: 1rem 1.25rem;
    background: #FFFFFF; border: 1px solid var(--rule); border-radius: 4px;
    transition: all 160ms ease;
  }
  .radio-card:hover { border-color: var(--ink-faint); }
  .radio-card:has(input[type="radio"]:checked) {
    background: var(--accent-soft); border-color: var(--accent);
  }
  .radio-card-title { font-family: 'Raleway', sans-serif; font-size: 0.95rem; font-weight: 500; }
  .radio-card:has(input[type="radio"]:checked) .radio-card-title { color: var(--accent-deep); }
  .radio-card-desc { font-size: 0.8rem; color: var(--ink-soft); margin-top: 0.35rem; line-height: 1.5; }
  /* mostrar campos condicionales según radio seleccionado (CSS :has) */
  .plan-block .recurring-only, .plan-block .prepago-only { display: none; }
  .plan-block:has(input[name$="[pricing_model]"][value="recurring"]:checked) .recurring-only { display: block; }
  .plan-block:has(input[name$="[pricing_model]"][value="one_off"]:checked) .prepago-only { display: block; }
  .cal-block .multi-period-only { display: none; }
  .cal-block:has(input[name="calendar[frequency_months]"][value="3"]:checked) .multi-period-only,
  .cal-block:has(input[name="calendar[frequency_months]"][value="6"]:checked) .multi-period-only,
  .cal-block:has(input[name="calendar[frequency_months]"][value="12"]:checked) .multi-period-only { display: block; }
  .remove-btn {
    background: transparent; border: none; cursor: pointer;
    color: var(--ink-faint); font-size: 0.78rem;
    padding: 0.3rem 0.6rem; border-radius: 4px;
    transition: color 160ms ease, background 160ms ease;
  }
  .remove-btn:hover { color: var(--danger); background: var(--paper-soft); }
</style>`;

function publicLayout(opts: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="es">
<head>
${PUBLIC_HEAD}
<title>${escapeHtml(opts.title)} · Numaris Billing</title>
</head>
<body>
<header style="background: var(--accent-deep); padding: 1.5rem 0;">
  <div class="max-w-4xl mx-auto px-6">
    <div class="font-display text-[1.4rem] font-medium" style="color: #FAFAFA;">Numaris <span style="font-style: italic; color: #8FA8C4;">Billing</span></div>
  </div>
</header>
<main class="max-w-4xl mx-auto px-6 py-12">
  ${opts.body}
</main>
</body>
</html>`;
}

// -------------------------------------------------------------------------
// Form principal
// -------------------------------------------------------------------------

// Renderiza un bloque de plan. `idx` puede ser un número (render inicial) o
// el placeholder string "__IDX__" (template para clonar via JS).
// `showRemove=false` solo para el primer plan (el inicial sí se puede dejar).
function planBlock(idx: number | string, showRemove: boolean): string {
  return `<div class="plan-block surface-card" style="border-radius: 6px;" data-plan-block>
  <div class="section-head flex items-center justify-between">
    <div>
      <div class="section-title">Plan #<span class="plan-index">${idx}</span></div>
      <div class="section-desc">Un cliente puede tener varios planes. Llena uno por cada servicio distinto que esté contratando.</div>
    </div>
    ${showRemove ? `<button type="button" class="remove-btn" data-remove="plan">Eliminar</button>` : ''}
  </div>
  <div class="section-body space-y-6">

    <div>
      <label class="field-label">Nombre comercial <span class="req">*</span></label>
      <input required name="plans[${idx}][name]" placeholder="Videotelemetría Avanzada" class="field">
      <div class="field-hint">Aparece en la factura. Por ejemplo: "Renta GPS", "Videotelemetría", "Monitoreo Premium".</div>
    </div>

    <div>
      <label class="field-label">Descripción interna</label>
      <input name="plans[${idx}][description]" class="field">
      <div class="field-hint">Opcional. No se muestra al cliente. Útil para distinguir planes parecidos.</div>
    </div>

    <div>
      <label class="field-label">Modelo de cobro <span class="req">*</span></label>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="radio-card">
          <input type="radio" name="plans[${idx}][pricing_model]" value="recurring" checked class="sr-only">
          <div class="radio-card-title">Recurrente</div>
          <div class="radio-card-desc">Renta mensual por unidad activa. Cada periodo se cobra. Es lo normal en GPS y video.</div>
        </label>
        <label class="radio-card">
          <input type="radio" name="plans[${idx}][pricing_model]" value="one_off" class="sr-only">
          <div class="radio-card-title">Prepago</div>
          <div class="radio-card-desc">Cliente paga N meses por adelantado al instalar cada unidad. No hay renta recurrente.</div>
        </label>
      </div>
      <textarea name="plans[${idx}][pricing_model_comments]" rows="2" class="field" placeholder="Comentarios sobre el modelo de cobro (opcional)" style="margin-top: 0.75rem;"></textarea>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div>
        <label class="field-label">Renta mensual /unidad <span class="req">*</span></label>
        <input required type="number" step="0.01" min="0" name="plans[${idx}][monthly_amount]" placeholder="0.00" class="field field-mono">
        <div class="field-hint">Neto, sin IVA. En prepago se multiplica por los meses prepagados.</div>
      </div>
      <div>
        <label class="field-label">Setup /unidad</label>
        <input type="number" step="0.01" min="0" name="plans[${idx}][setup_amount]" value="0" class="field field-mono">
        <div class="field-hint">Cargo único al instalar la unidad. 0 si no aplica.</div>
      </div>
      <div class="recurring-only">
        <label class="field-label">Baja /unidad</label>
        <input type="number" step="0.01" min="0" name="plans[${idx}][removal_amount]" value="0" class="field field-mono">
        <div class="field-hint">Cargo único al desinstalar. Solo recurrentes.</div>
      </div>
      <div class="prepago-only">
        <label class="field-label">Meses prepagados <span class="req">*</span></label>
        <input type="number" min="1" name="plans[${idx}][prepaid_months]" placeholder="48" class="field field-mono">
        <div class="field-hint">Cuántos meses paga el cliente por adelantado al instalar cada unidad.</div>
      </div>
    </div>

    <div>
      <label class="field-label">Cuándo se emite la factura por estos cargos</label>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-1">
        <div>
          <div class="text-xs ink-soft mb-2 font-medium">Setup</div>
          <select name="plans[${idx}][setup_billing_mode]" class="field">
            <option value="next_cycle">Al cierre del periodo (consolidado con la renta)</option>
            <option value="immediate">Inmediato (factura individual al instalar)</option>
          </select>
        </div>
        <div class="recurring-only">
          <div class="text-xs ink-soft mb-2 font-medium">Baja</div>
          <select name="plans[${idx}][removal_billing_mode]" class="field">
            <option value="next_cycle">Al cierre del periodo (consolidado)</option>
            <option value="immediate">Inmediato (factura individual al dar de baja)</option>
          </select>
        </div>
      </div>
      <div class="field-hint" style="margin-top: 0.6rem;">Solo importa si el monto del cargo es mayor a 0.</div>
      <textarea name="plans[${idx}][billing_mode_comments]" rows="2" class="field" placeholder="Comentarios sobre la emisión de estos cargos (opcional)" style="margin-top: 0.75rem;"></textarea>
    </div>

  </div>
</div>`;
}

function addonFlatBlock(idx: number | string): string {
  return `<div class="surface-card" style="border-radius: 6px;" data-addon-flat-block>
  <div class="section-head flex items-center justify-between">
    <div>
      <div class="section-title">Add-on flat #<span class="addon-flat-index">${idx}</span></div>
    </div>
    <button type="button" class="remove-btn" data-remove="addon_flat">Eliminar</button>
  </div>
  <div class="section-body space-y-5">
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label class="field-label">Nombre <span class="req">*</span></label>
        <input required name="addons_flat[${idx}][name]" placeholder="10 reglas de evento" class="field">
      </div>
      <div>
        <label class="field-label">Monto flat /mes <span class="req">*</span></label>
        <input required type="number" step="0.01" min="0" name="addons_flat[${idx}][amount]" placeholder="0.00" class="field field-mono">
      </div>
    </div>
  </div>
</div>`;
}

function addonUnitBlock(idx: number | string): string {
  return `<div class="surface-card" style="border-radius: 6px;" data-addon-unit-block>
  <div class="section-head flex items-center justify-between">
    <div>
      <div class="section-title">Add-on por unidad #<span class="addon-unit-index">${idx}</span></div>
    </div>
    <button type="button" class="remove-btn" data-remove="addon_unit">Eliminar</button>
  </div>
  <div class="section-body space-y-5">
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label class="field-label">Plan al que se asocia <span class="req">*</span></label>
        <select required name="addons_unit[${idx}][plan_name]" class="field" data-plan-select>
          <option value="">— elegir plan —</option>
        </select>
        <div class="field-hint">Se llena automáticamente con los planes que pusiste arriba. Si no aparece el plan, primero captúralo en la sección de planes.</div>
      </div>
      <div>
        <label class="field-label">Nombre del add-on <span class="req">*</span></label>
        <input required name="addons_unit[${idx}][name]" placeholder="Historial 6 → 12 meses" class="field">
      </div>
      <div>
        <label class="field-label">Monto /unidad /mes <span class="req">*</span></label>
        <input required type="number" step="0.01" min="0" name="addons_unit[${idx}][amount]" placeholder="0.00" class="field field-mono">
      </div>
    </div>
  </div>
</div>`;
}

export function renderQuestionnaireForm(opts: { error?: string } = {}): string {
  const body = `
${opts.error ? `<div class="surface-card" style="border-radius: 6px; border-color: var(--danger); background: #F7E8E5; padding: 1rem 1.25rem; margin-bottom: 1.5rem; color: var(--danger);">${escapeHtml(opts.error)}</div>` : ''}

<div class="mb-10">
  <div class="text-[10px] uppercase tracking-[0.18em] font-medium mb-3" style="color: var(--accent);">Migración de cliente</div>
  <h1 class="font-display text-[2.25rem] leading-[1.1] font-medium ink tracking-tight">Cuestionario de configuración</h1>
  <p class="text-[15px] ink-soft mt-3 leading-relaxed max-w-2xl">
    Llena los siguientes datos para configurar la facturación del cliente en Numaris Billing.
  </p>
</div>

<form method="post" action="/cuestionario" class="space-y-8">

  <!-- SECCIÓN A — Quién contesta -->
  <div class="surface-card" style="border-radius: 6px;">
    <div class="section-head">
      <div class="section-title">Quién contesta</div>
      <div class="section-desc">Para poder regresar a preguntarte si surge alguna duda.</div>
    </div>
    <div class="section-body grid grid-cols-1 sm:grid-cols-2 gap-5">
      <div>
        <label class="field-label">Tu nombre <span class="req">*</span></label>
        <input required name="filled_by_name" class="field" placeholder="Ana López">
      </div>
      <div>
        <label class="field-label">Tu correo</label>
        <input type="email" name="filled_by_email" class="field" placeholder="ana@numaris.com">
      </div>
      <div class="sm:col-span-2">
        <label class="field-label">Cliente al que se refiere este cuestionario <span class="req">*</span></label>
        <input required name="customer_label" class="field" placeholder="Transportes Pilot SA de CV">
        <div class="field-hint">Solo para que sepamos a quién pertenece esta respuesta. No tiene que ser la razón social exacta.</div>
      </div>
    </div>
  </div>

  <!-- SECCIÓN B — Calendario de facturación -->
  <div class="cal-block surface-card" style="border-radius: 6px;">
    <div class="section-head">
      <div class="section-title">Calendario de facturación</div>
      <div class="section-desc">Define cuándo y cómo se le emiten facturas al cliente.</div>
    </div>
    <div class="section-body space-y-7">

      <div>
        <label class="field-label">Frecuencia de facturación <span class="req">*</span></label>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <label class="radio-card">
            <input type="radio" name="calendar[frequency_months]" value="1" checked class="sr-only">
            <div class="radio-card-title">Mensual</div>
            <div class="radio-card-desc">Una factura cada mes.</div>
          </label>
          <label class="radio-card">
            <input type="radio" name="calendar[frequency_months]" value="3" class="sr-only">
            <div class="radio-card-title">Trimestral</div>
            <div class="radio-card-desc">Una factura cada 3 meses.</div>
          </label>
          <label class="radio-card">
            <input type="radio" name="calendar[frequency_months]" value="6" class="sr-only">
            <div class="radio-card-title">Semestral</div>
            <div class="radio-card-desc">Una factura cada 6 meses.</div>
          </label>
          <label class="radio-card">
            <input type="radio" name="calendar[frequency_months]" value="12" class="sr-only">
            <div class="radio-card-title">Anual</div>
            <div class="radio-card-desc">Una factura al año.</div>
          </label>
        </div>
        <div class="field-hint" style="margin-top: 0.6rem;">Lo más común es <strong>mensual</strong>. Frecuencias mayores agrupan más periodos en una misma factura.</div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div>
          <label class="field-label">Día de corte <span class="req">*</span></label>
          <input type="number" min="1" max="28" name="calendar[anchor_day]" value="1" class="field field-mono" style="max-width: 8rem;">
          <div class="field-hint">Día del mes en que cierra cada periodo y se emite la factura. Entre 1 y 28 (para evitar problemas en febrero). Si pones <code class="font-mono-pro">1</code>, el periodo va del día 1 al fin de mes.</div>
        </div>

        <div class="multi-period-only">
          <label class="field-label">Mes ancla</label>
          <select name="calendar[anchor_month]" class="field" style="max-width: 14rem;">
            <option value="">— sin ancla (arranca el mes que firmó) —</option>
            <option value="1">Enero</option>
            <option value="2">Febrero</option>
            <option value="3">Marzo</option>
            <option value="4">Abril</option>
            <option value="5">Mayo</option>
            <option value="6">Junio</option>
            <option value="7">Julio</option>
            <option value="8">Agosto</option>
            <option value="9">Septiembre</option>
            <option value="10">Octubre</option>
            <option value="11">Noviembre</option>
            <option value="12">Diciembre</option>
          </select>
          <div class="field-hint">Solo aplica si la frecuencia es mayor a mensual. Define en qué mes empiezan los ciclos. Ej. trimestral con ancla en enero → ciclos en ene/abr/jul/oct. Si no se especifica, arranca en el mes en que el cliente firmó el contrato.</div>
        </div>
      </div>

      <div>
        <label class="field-label">Cómo se factura un servicio prepago al instalar una unidad <span class="req">*</span></label>
        <div class="text-[13px] ink-soft" style="margin-bottom: 0.75rem; line-height: 1.55;">Un servicio <strong>prepago</strong> es aquél en el que el cliente paga varias mensualidades por adelantado (típicamente 12, 24, 36, 48, 60 o 72 meses) en una sola exhibición al instalar cada unidad. Una vez cobrado el paquete, esa unidad no genera más cargos hasta que se renueve.</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="radio-card">
            <input type="radio" name="calendar[prepago_trigger]" value="next_cycle" checked class="sr-only">
            <div class="radio-card-title">Al cierre del periodo</div>
            <div class="radio-card-desc">El paquete prepago (setup + N mensualidades) se agrega a la factura del periodo en que se instala la unidad. Más común.</div>
          </label>
          <label class="radio-card">
            <input type="radio" name="calendar[prepago_trigger]" value="immediate" class="sr-only">
            <div class="radio-card-title">Inmediato al instalar</div>
            <div class="radio-card-desc">Se emite una factura individual con el paquete prepago el mismo día que entra la unidad. Útil cuando el cliente exige factura al instalar.</div>
          </label>
        </div>
        <div class="field-hint" style="margin-top: 0.6rem;">Solo aplica si el cliente tiene planes <strong>prepago</strong>. Si todos sus planes son recurrentes, ignora esta pregunta.</div>
        <textarea name="calendar[prepago_trigger_comments]" rows="2" class="field" placeholder="Comentarios sobre el cobro de prepago (opcional)" style="margin-top: 0.75rem;"></textarea>
      </div>

      <div>
        <label class="field-label">Modo de la factura al cierre del periodo <span class="req">*</span></label>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="radio-card">
            <input type="radio" name="calendar[invoice_mode]" value="unified" checked class="sr-only">
            <div class="radio-card-title">Unificada</div>
            <div class="radio-card-desc">Una sola factura por periodo con todos los conceptos: renta, setup, baja, add-ons y prepagos. Es el default.</div>
          </label>
          <label class="radio-card">
            <input type="radio" name="calendar[invoice_mode]" value="split_by_kind" class="sr-only">
            <div class="radio-card-title">Separada por tipo</div>
            <div class="radio-card-desc">Hasta dos facturas: una con conceptos recurrentes (renta + add-ons + prepagados) y otra con cargos únicos (setup, baja). Útil para clientes con contabilidad estricta que separan operación de instalaciones.</div>
          </label>
        </div>
        <textarea name="calendar[invoice_mode_comments]" rows="2" class="field" placeholder="Comentarios sobre el modo de factura (opcional)" style="margin-top: 0.75rem;"></textarea>
      </div>

    </div>
  </div>

  <!-- SECCIÓN C — Planes -->
  <div>
    <div class="mb-4">
      <div class="font-display text-lg font-medium ink">Planes contratados</div>
      <div class="text-sm ink-soft mt-1.5 max-w-2xl leading-relaxed">
        Un plan agrupa cómo se cobra un servicio: precio por unidad, setup, baja y los códigos de NetSuite. <strong>Si el cliente tiene varios servicios con precios distintos, agrega un plan por cada uno.</strong>
      </div>
    </div>
    <div id="plans-container" class="space-y-6">
      ${planBlock(1, false)}
    </div>
    <button type="button" class="btn-ghost mt-5" data-add="plan">+ Agregar otro plan</button>
  </div>

  <!-- SECCIÓN D — Add-ons -->
  <div>
    <div class="mb-4">
      <div class="font-display text-lg font-medium ink">Cargos especiales (opcional)</div>
      <div class="text-sm ink-soft mt-1.5 max-w-2xl leading-relaxed">
        Cargos adicionales recurrentes que no encajan dentro de un plan. <strong>La mayoría de clientes no tienen ninguno</strong> — si no aplica, ignora esta sección.
      </div>
    </div>

    <div class="surface-tone" style="border-radius: 6px; padding: 1.25rem 1.5rem; margin-bottom: 1.25rem;">
      <div class="text-sm ink-soft leading-relaxed">
        <strong class="ink">Flat (a nivel cliente):</strong> cargo fijo mensual que no depende de unidades. Ej. "10 reglas de evento +$1,000/mes" — son $1,000 totales, sin importar cuántas unidades tenga.<br>
        <strong class="ink">Por unidad (a nivel plan):</strong> cargo extra mensual que sí se multiplica por unidades activas. Ej. "Historial 6 → 12 meses +$50/unidad/mes". Si el plan tiene 200 unidades, son $50 × 200 = $10,000/mes.
      </div>
    </div>

    <div class="mb-6">
      <div class="text-sm font-semibold ink mb-3">Add-ons flat</div>
      <div id="addons-flat-container" class="space-y-4"></div>
      <button type="button" class="btn-ghost mt-3" data-add="addon_flat">+ Agregar add-on flat</button>
    </div>

    <div>
      <div class="text-sm font-semibold ink mb-3">Add-ons por unidad</div>
      <div id="addons-unit-container" class="space-y-4"></div>
      <button type="button" class="btn-ghost mt-3" data-add="addon_unit">+ Agregar add-on por unidad</button>
    </div>
  </div>

  <!-- SECCIÓN E — Comentarios -->
  <div class="surface-card" style="border-radius: 6px;">
    <div class="section-head">
      <div class="section-title">Comentarios, acuerdos y excepciones</div>
      <div class="section-desc">Cualquier cosa que no entre en las secciones anteriores. Descuentos permanentes, cambios de precio futuros, migración a mitad de periodo, etc.</div>
    </div>
    <div class="section-body">
      <textarea name="comments" rows="6" class="field" placeholder="Ej. 'descuento del 10% sobre la renta mensual durante los primeros 6 meses', 'a partir de enero 2027 sube a $900', 'el cliente migra a mitad de septiembre así que ese periodo no se factura desde Numaris Billing'..."></textarea>
    </div>
  </div>

  <!-- Submit -->
  <div class="flex items-center gap-4 pt-2">
    <button type="submit" class="btn-primary">Enviar cuestionario</button>
    <span class="text-xs ink-faint">Se guarda y nos llega para revisión. Si después necesitas corregir algo, mándanos un correo.</span>
  </div>
</form>

<!-- Templates HTML para clonar (escondidos) -->
<template id="plan-template">${planBlock('__IDX__', true)}</template>
<template id="addon-flat-template">${addonFlatBlock('__IDX__')}</template>
<template id="addon-unit-template">${addonUnitBlock('__IDX__')}</template>

<script>
(function() {
  // Manejador de "+ Agregar" — clona el template, reemplaza __IDX__ con el
  // siguiente índice secuencial, y lo agrega al container correspondiente.
  function nextIndex(container) { return container.querySelectorAll(':scope > div').length + 1; }
  function reindexLabels(container, className) {
    const items = container.querySelectorAll(':scope > div');
    items.forEach((item, i) => {
      const label = item.querySelector('.' + className);
      if (label) label.textContent = String(i + 1);
    });
  }
  // Re-popula los <select> de "Plan al que se asocia" en los add-ons por unidad
  // con los nombres de planes capturados arriba. Preserva la selección actual
  // si el plan sigue existiendo.
  function refreshPlanSelects() {
    const planInputs = document.querySelectorAll('input[name^="plans["][name$="[name]"]');
    const names = [];
    planInputs.forEach(function(inp) {
      const v = (inp.value || '').trim();
      if (v) names.push(v);
    });
    const selects = document.querySelectorAll('select[data-plan-select]');
    selects.forEach(function(sel) {
      const current = sel.value;
      sel.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = names.length === 0 ? '— captura un plan arriba primero —' : '— elegir plan —';
      sel.appendChild(placeholder);
      names.forEach(function(n) {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = n;
        if (n === current) opt.selected = true;
        sel.appendChild(opt);
      });
    });
  }
  document.addEventListener('click', function(e) {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const addType = t.getAttribute('data-add');
    if (addType) {
      e.preventDefault();
      const tpl = document.getElementById(addType.replace('_', '-') + '-template');
      const containerId = addType === 'plan' ? 'plans-container'
        : addType === 'addon_flat' ? 'addons-flat-container'
        : 'addons-unit-container';
      const container = document.getElementById(containerId);
      if (!tpl || !container) return;
      const idx = nextIndex(container);
      const html = tpl.innerHTML.replace(/__IDX__/g, String(idx));
      const wrapper = document.createElement('div');
      wrapper.innerHTML = html;
      const node = wrapper.firstElementChild;
      if (node) container.appendChild(node);
      refreshPlanSelects();
    }
    const removeType = t.getAttribute('data-remove');
    if (removeType) {
      e.preventDefault();
      const block = t.closest('[data-' + removeType.replace('_', '-') + '-block]');
      if (!block) return;
      const container = block.parentElement;
      block.remove();
      if (!container) return;
      // Re-index visible numbers (los names del form quedan con índice gappy, pero el server-side reagrupa).
      if (removeType === 'plan') reindexLabels(container, 'plan-index');
      if (removeType === 'addon_flat') reindexLabels(container, 'addon-flat-index');
      if (removeType === 'addon_unit') reindexLabels(container, 'addon-unit-index');
      if (removeType === 'plan') refreshPlanSelects();
    }
  });
  // Cualquier cambio en el nombre de un plan refresca los selects.
  document.addEventListener('input', function(e) {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    const name = t.getAttribute('name') || '';
    if (/^plans\\[\\d+\\]\\[name\\]$/.test(name)) refreshPlanSelects();
  });
  // Render inicial.
  refreshPlanSelects();
})();
</script>
`;
  return publicLayout({ title: 'Cuestionario de migración', body });
}

// -------------------------------------------------------------------------
// Página de agradecimiento
// -------------------------------------------------------------------------

export function renderQuestionnaireThanks(opts: { customerLabel: string }): string {
  const body = `
<div class="surface-card" style="border-radius: 6px; padding: 3rem 2.5rem; text-align: center;">
  <div style="display: inline-flex; width: 56px; height: 56px; border-radius: 50%; background: var(--accent-soft); align-items: center; justify-content: center; margin-bottom: 1.5rem;">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 12l4 4L19 8" stroke="#3274BA" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>
  <h1 class="font-display text-[1.75rem] font-medium ink tracking-tight">¡Gracias!</h1>
  <p class="text-[15px] ink-soft mt-3 leading-relaxed max-w-md mx-auto">
    Recibimos tu respuesta sobre <strong>${escapeHtml(opts.customerLabel)}</strong>. El equipo de billing la va a revisar y te buscará si surge alguna duda antes de configurar la cuenta.
  </p>
  <div class="mt-8 flex items-center justify-center gap-3">
    <a href="/cuestionario" class="btn-primary" style="text-decoration: none;">Capturar otro cliente</a>
  </div>
</div>
`;
  return publicLayout({ title: 'Gracias', body });
}

// -------------------------------------------------------------------------
// Parser del payload del form (form bodies vienen como flat keys)
// -------------------------------------------------------------------------

// Convierte el body del form (que viene como flat keys con sintaxis
// `plans[0][name]`) a una estructura anidada, y re-compacta los índices
// gappy que dejan los "Eliminar" del JS.
export function parseQuestionnaireBody(body: Record<string, string>): {
  calendar: Record<string, string>;
  plans: Array<Record<string, string>>;
  addons_flat: Array<Record<string, string>>;
  addons_unit: Array<Record<string, string>>;
  comments: string;
} {
  const calendar: Record<string, string> = {};
  const planMap: Record<number, Record<string, string>> = {};
  const flatMap: Record<number, Record<string, string>> = {};
  const unitMap: Record<number, Record<string, string>> = {};

  for (const [rawKey, value] of Object.entries(body)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    // calendar[xxx]
    const cm = /^calendar\[(\w+)\]$/.exec(rawKey);
    if (cm && cm[1]) { calendar[cm[1]] = trimmed; continue; }
    // plans[i][xxx]
    const pm = /^plans\[(\d+)\]\[(\w+)\]$/.exec(rawKey);
    if (pm && pm[1] && pm[2]) {
      const i = parseInt(pm[1], 10);
      (planMap[i] ??= {})[pm[2]] = trimmed;
      continue;
    }
    // addons_flat[i][xxx]
    const fm = /^addons_flat\[(\d+)\]\[(\w+)\]$/.exec(rawKey);
    if (fm && fm[1] && fm[2]) {
      const i = parseInt(fm[1], 10);
      (flatMap[i] ??= {})[fm[2]] = trimmed;
      continue;
    }
    // addons_unit[i][xxx]
    const um = /^addons_unit\[(\d+)\]\[(\w+)\]$/.exec(rawKey);
    if (um && um[1] && um[2]) {
      const i = parseInt(um[1], 10);
      (unitMap[i] ??= {})[um[2]] = trimmed;
      continue;
    }
  }

  const compact = (m: Record<number, Record<string, string>>): Array<Record<string, string>> => {
    const out: Array<Record<string, string>> = [];
    for (const k of Object.keys(m).map(Number).sort((a, b) => a - b)) {
      const v = m[k];
      if (v) out.push(v);
    }
    return out;
  };

  return {
    calendar,
    plans: compact(planMap),
    addons_flat: compact(flatMap),
    addons_unit: compact(unitMap),
    comments: (body.comments ?? '').trim(),
  };
}

// -------------------------------------------------------------------------
// Vista admin — lista de cuestionarios recibidos
// -------------------------------------------------------------------------

type QuestionnaireRow = {
  id: string;
  filledByName: string;
  filledByEmail: string | null;
  customerLabel: string;
  createdAt: Date;
  payload: unknown;
};

export function renderQuestionnaireList(rows: QuestionnaireRow[]): string {
  if (rows.length === 0) {
    return `<div class="surface-card" style="border-radius: 6px; padding: 3rem; text-align: center;">
      <div class="text-sm ink-faint">Aún no se ha enviado ningún cuestionario.</div>
      <div class="text-xs ink-faint mt-2">El link público es <code class="font-mono-pro" style="color: var(--accent-deep);">/cuestionario</code>.</div>
    </div>`;
  }
  const FREQ_LABEL: Record<string, string> = { '1': 'mensual', '3': 'trimestral', '6': 'semestral', '12': 'anual' };
  const list = rows.map((r) => {
    const payload = r.payload as { plans?: unknown[]; calendar?: { frequency_months?: string } } | null;
    const planCount = Array.isArray(payload?.plans) ? payload.plans.length : 0;
    const freq = payload?.calendar?.frequency_months ?? '';
    const freqLabel = FREQ_LABEL[freq] ?? '—';
    return `<a href="/admin/cuestionarios/${escapeHtml(r.id)}" class="surface-card block transition-colors" style="border-radius: 6px; padding: 1.25rem 1.5rem; text-decoration: none;">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1 min-w-0">
          <div class="font-display text-base font-medium ink">${escapeHtml(r.customerLabel)}</div>
          <div class="text-xs ink-faint mt-1">
            ${escapeHtml(r.filledByName)}${r.filledByEmail ? ` · <span class="font-mono-pro">${escapeHtml(r.filledByEmail)}</span>` : ''}
          </div>
        </div>
        <div class="text-right shrink-0">
          <div class="text-xs ink-soft">${planCount} ${planCount === 1 ? 'plan' : 'planes'} · ${escapeHtml(freqLabel)}</div>
          <div class="text-[11px] ink-faint mt-0.5">${r.createdAt.toISOString().slice(0, 10)}</div>
        </div>
      </div>
    </a>`;
  }).join('');
  return `<div class="space-y-3">${list}</div>`;
}

// -------------------------------------------------------------------------
// Vista admin — detalle de un cuestionario
// -------------------------------------------------------------------------

export function renderQuestionnaireDetail(row: QuestionnaireRow): string {
  const payload = (row.payload ?? {}) as {
    calendar?: Record<string, string>;
    plans?: Array<Record<string, string>>;
    addons_flat?: Array<Record<string, string>>;
    addons_unit?: Array<Record<string, string>>;
    comments?: string;
  };
  const FREQ_LABEL: Record<string, string> = { '1': 'Mensual', '3': 'Trimestral', '6': 'Semestral', '12': 'Anual' };
  const MONTH_LABEL: Record<string, string> = { '1': 'Enero', '2': 'Febrero', '3': 'Marzo', '4': 'Abril', '5': 'Mayo', '6': 'Junio', '7': 'Julio', '8': 'Agosto', '9': 'Septiembre', '10': 'Octubre', '11': 'Noviembre', '12': 'Diciembre' };
  const TRIGGER_LABEL: Record<string, string> = { 'next_cycle': 'Al cierre del periodo', 'immediate': 'Inmediato al instalar' };
  const MODE_LABEL: Record<string, string> = { 'unified': 'Unificada', 'split_by_kind': 'Separada por tipo' };

  const headerBlock = `
    <div class="mb-8">
      <div class="text-[10px] uppercase tracking-[0.18em] font-medium mb-3" style="color: var(--accent);">Cuestionario de migración</div>
      <h1 class="font-display text-[2rem] leading-tight font-medium ink tracking-tight">${escapeHtml(row.customerLabel)}</h1>
      <div class="flex items-center gap-3 text-xs ink-soft mt-3">
        <span>Llenado por <strong class="ink">${escapeHtml(row.filledByName)}</strong></span>
        ${row.filledByEmail ? `<span>·</span><span class="font-mono-pro">${escapeHtml(row.filledByEmail)}</span>` : ''}
        <span>·</span><span>${row.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</span>
      </div>
    </div>
  `;

  const kvRow = (label: string, value: string | undefined | null): string =>
    `<div class="flex items-baseline gap-3 py-2" style="border-bottom: 1px solid var(--rule-soft);">
      <div class="text-[10px] uppercase tracking-wider ink-faint" style="min-width: 200px;">${escapeHtml(label)}</div>
      <div class="text-sm ink">${value ? escapeHtml(value) : '<span class="ink-faint">—</span>'}</div>
    </div>`;

  const cal = payload.calendar ?? {};
  const cycleBlock = `
    <div class="surface-card" style="border-radius: 6px; margin-bottom: 1.5rem;">
      <div class="px-7 py-5" style="border-bottom: 1px solid var(--rule);">
        <h2 class="text-[11px] uppercase tracking-[0.1em] font-semibold ink-soft">Calendario de facturación</h2>
      </div>
      <div class="px-7 py-5">
        ${kvRow('Frecuencia', cal.frequency_months ? FREQ_LABEL[cal.frequency_months] : undefined)}
        ${kvRow('Día de corte', cal.anchor_day)}
        ${cal.anchor_month ? kvRow('Mes ancla', MONTH_LABEL[cal.anchor_month]) : ''}
        ${kvRow('Cobro de servicio prepago', cal.prepago_trigger ? TRIGGER_LABEL[cal.prepago_trigger] : undefined)}
        ${cal.prepago_trigger_comments ? kvRow('↳ Comentarios', cal.prepago_trigger_comments) : ''}
        ${kvRow('Modo de factura al cierre', cal.invoice_mode ? MODE_LABEL[cal.invoice_mode] : undefined)}
        ${cal.invoice_mode_comments ? kvRow('↳ Comentarios', cal.invoice_mode_comments) : ''}
      </div>
    </div>
  `;

  const renderPlan = (p: Record<string, string>, i: number): string => {
    const isPrepago = p.pricing_model === 'one_off';
    return `<div class="surface-card" style="border-radius: 6px; margin-bottom: 1rem;">
      <div class="px-7 py-4 flex items-center justify-between" style="border-bottom: 1px solid var(--rule);">
        <div>
          <h3 class="font-display text-base font-medium ink">${escapeHtml(p.name ?? `Plan #${i + 1}`)}</h3>
          ${p.description ? `<div class="text-xs ink-faint mt-1">${escapeHtml(p.description)}</div>` : ''}
        </div>
        <span class="text-[11px] px-2.5 py-1 rounded font-medium" style="background: ${isPrepago ? 'var(--warn-soft)' : 'var(--accent-soft)'}; color: ${isPrepago ? 'var(--warn)' : 'var(--accent-deep)'};">${isPrepago ? 'Prepago' : 'Recurrente'}</span>
      </div>
      <div class="px-7 py-5">
        ${p.pricing_model_comments ? kvRow('Comentarios sobre el modelo', p.pricing_model_comments) : ''}
        ${kvRow('Renta mensual /unidad', p.monthly_amount)}
        ${kvRow('Setup /unidad', p.setup_amount)}
        ${!isPrepago ? kvRow('Baja /unidad', p.removal_amount) : ''}
        ${isPrepago ? kvRow('Meses prepagados', p.prepaid_months) : ''}
        ${kvRow('Emisión setup', p.setup_billing_mode)}
        ${!isPrepago ? kvRow('Emisión baja', p.removal_billing_mode) : ''}
        ${p.billing_mode_comments ? kvRow('↳ Comentarios', p.billing_mode_comments) : ''}
      </div>
    </div>`;
  };

  const plansBlock = (payload.plans ?? []).length > 0 ? `
    <div style="margin-bottom: 1.5rem;">
      <div class="text-[11px] uppercase tracking-[0.1em] font-semibold ink-soft px-1 mb-3">Planes</div>
      ${(payload.plans ?? []).map(renderPlan).join('')}
    </div>
  ` : '';

  const renderAddon = (a: Record<string, string>, kind: 'flat' | 'unit'): string => `
    <div class="surface-card" style="border-radius: 6px; margin-bottom: 0.75rem; padding: 1rem 1.25rem;">
      <div class="text-sm ink">${escapeHtml(a.name ?? '—')}${kind === 'unit' && a.plan_name ? ` <span class="ink-faint">— en plan "${escapeHtml(a.plan_name)}"</span>` : ''}</div>
      <div class="text-xs ink-soft mt-1">
        <span class="font-mono-pro">${escapeHtml(a.amount ?? '0')}</span>${kind === 'flat' ? ' flat/mes' : ' /unidad/mes'}
      </div>
    </div>
  `;

  const flatAddons = (payload.addons_flat ?? []).filter((a) => a.name);
  const unitAddons = (payload.addons_unit ?? []).filter((a) => a.name);
  const addonsBlock = (flatAddons.length + unitAddons.length) > 0 ? `
    <div style="margin-bottom: 1.5rem;">
      <div class="text-[11px] uppercase tracking-[0.1em] font-semibold ink-soft px-1 mb-3">Add-ons</div>
      ${flatAddons.length > 0 ? `<div class="text-xs ink-faint mb-2">Flat (a nivel cliente)</div>${flatAddons.map((a) => renderAddon(a, 'flat')).join('')}` : ''}
      ${unitAddons.length > 0 ? `<div class="text-xs ink-faint mb-2 mt-4">Por unidad (a nivel plan)</div>${unitAddons.map((a) => renderAddon(a, 'unit')).join('')}` : ''}
    </div>
  ` : '';

  const commentsBlock = payload.comments ? `
    <div class="surface-card" style="border-radius: 6px;">
      <div class="px-7 py-5" style="border-bottom: 1px solid var(--rule);">
        <h2 class="text-[11px] uppercase tracking-[0.1em] font-semibold ink-soft">Comentarios</h2>
      </div>
      <div class="px-7 py-5 text-sm ink whitespace-pre-wrap">${escapeHtml(payload.comments)}</div>
    </div>
  ` : '';

  return headerBlock + cycleBlock + plansBlock + addonsBlock + commentsBlock;
}
