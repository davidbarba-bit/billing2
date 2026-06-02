# Cuestionario de migración a Numaris Billing

**Para:** equipos de postventa
**Objetivo:** capturar toda la información que necesitamos para dar de alta a un cliente que ya está siendo facturado en el sistema anterior, dentro de Numaris Billing.
**Tiempo estimado:** 20–40 minutos por cliente (depende de cuántas unidades tenga).

> **Cómo usar este documento**
> Llena una copia completa por cada cliente. Si una pregunta no aplica al cliente, escribe "No aplica" — no la dejes en blanco. Si tienes dudas sobre alguna pregunta, **pregunta antes de adivinar**; un dato mal capturado puede generar facturas equivocadas. Cuando termines, envíalo al equipo de billing junto con (si es posible) la última factura emitida al cliente desde el sistema legacy, como referencia.

---

## Sección 1 · Datos del cliente

Esta es la información que aparecerá en el CFDI. Tiene que coincidir exactamente con la Constancia de Situación Fiscal.

| Campo | Tu respuesta |
|---|---|
| Razón social (nombre fiscal completo) | |
| RFC | |
| Régimen fiscal (código SAT, ej. 601) | |
| Uso de CFDI por default (ej. G03) | |
| Código postal del domicilio fiscal | |
| Correo para envío de facturas | |
| Nombre del contacto principal | |
| Teléfono del contacto principal | |
| Moneda en la que se factura (MXN / USD) | |

**Notas:**
- Si el cliente factura en USD pero opera en México, confirma con el cliente que su CFDI debe emitirse en USD.
- Si el cliente tiene varias sucursales con razones sociales diferentes, **cada razón social es un cliente distinto en Numaris Billing**.

---

## Sección 2 · Ciclo de facturación

Esto define **cuándo** se emite cada factura. Es la decisión más importante después del precio. Solo hay dos modelos:

- **Calendario** — la factura cubre del **día 1 al último día de cada mes**. Se emite al cierre del mes. Es el modelo más común.
  *Ejemplo: factura de septiembre cubre del 1 al 30 de septiembre.*

- **Aniversario** — la factura cubre del **día N de un mes al día N–1 del siguiente**, donde N es el día en que arrancó el contrato.
  *Ejemplo: si el contrato inició el día 15, la factura de septiembre cubre del 15 de sep al 14 de oct.*

| Pregunta | Tu respuesta |
|---|---|
| ¿Qué modelo de ciclo usa este cliente? (calendario / aniversario) | |
| Si es aniversario: ¿cuál es el día de corte? (1–28) | |
| Términos de pago (días de crédito, ej. PUE / 30 días / 60 días) | |
| Día estimado del primer ciclo a facturar **ya en Numaris Billing** | |

**Nota crítica sobre la fecha de cutover:**
El "primer ciclo en Numaris Billing" debe ser el siguiente periodo completo. Lo que ya se facturó en el sistema legacy **no se re-factura**. Si vas a migrar a mitad de un periodo, indícalo en la sección 6.

---

## Sección 3 · Planes contratados

Un **plan** (lo que internamente llamamos también "service") agrupa el cómo se cobra un servicio: precio por unidad, setup, baja y los códigos de NetSuite. Las unidades concretas (GPS, cámaras, etc.) se asignan después a uno de estos planes.

**Llena un bloque por cada plan distinto que tenga contratado el cliente.** Si tiene 3 servicios diferentes con precios diferentes → 3 bloques.

### Plan #___

| Campo | Tu respuesta |
|---|---|
| Nombre comercial del plan (aparece en factura) | |
| Descripción interna (no se muestra al cliente, opcional) | |

**Modelo de cobro** — elige uno:

- [ ] **Recurrente** — Renta mensual por unidad activa. Opcionalmente cargo de setup al instalar y cargo de baja al desinstalar. Es lo normal en GPS/video.
- [ ] **Prepago** — Setup opcional + **N mensualidades pagadas por adelantado** al instalar cada unidad. No hay renta mensual recurrente: una vez cobrado el paquete, la unidad no genera más cargos hasta que vuelva a renovarse. Útil para proyectos con presupuesto cerrado.

**Precios** (todos en moneda del cliente, **netos sin IVA** — NetSuite agrega el impuesto al emitir el CFDI):

| Cargo | Monto $ | Aplica |
|---|---|---|
| Renta mensual **por unidad** | | Siempre (en prepago se multiplica por los meses prepagados) |
| Setup **por unidad** | | Cargo único al instalar la unidad. Pon 0 si no aplica |
| Baja **por unidad** | | Cargo único al desinstalar. Pon 0 si no aplica. **Solo recurrente** |
| Meses prepagados (si plan es prepago) | | Cuántos meses paga el cliente por adelantado al instalar cada unidad |

**Emisión de cargos no recurrentes** — solo aplica si el setup o la baja son mayores a 0:

| Cargo | Cuándo se emite la factura |
|---|---|
| Setup | [ ] Al cierre del periodo (consolidado con la renta) &nbsp; [ ] Inmediato (factura individual al instalar) |
| Baja | [ ] Al cierre del periodo &nbsp; [ ] Inmediato (factura individual al dar de baja) |

**Códigos NetSuite** — son los `item_code` del catálogo de NetSuite que se mapean a las líneas de la factura. Si quedan vacíos, NetSuite rechazará el dispatch en producción.

| Línea | Item code en NetSuite |
|---|---|
| Mensual / renta | |
| Setup | |
| Baja | |

> Repite la sección 3 con un bloque nuevo por cada plan adicional.

---

## Sección 4 · Unidades activas

Son las cosas concretas que se cobran: un GPS, una cámara, una sim, un "asiento", etc. Cada unidad pertenece a **un único plan** (sección 3).

**Cómo entregar esto:** si el cliente tiene más de ~10 unidades, **adjunta un Excel** con una fila por unidad y estas columnas. Si son pocas, llena la tabla aquí mismo.

| Columna | Qué poner | Ejemplo |
|---|---|---|
| `plan` | Nombre del plan al que pertenece (debe coincidir con un plan de la sección 3) | "Videotelemetría Avanzada" |
| `identificador_externo` | El ID que viene del sistema externo (GPS, cámara, etc.). Tiene que ser único y estable | `gps-001` |
| `etiqueta` | Texto humano descriptivo (opcional) | "Camión 001" |
| `activa_desde` | Fecha y hora reales en que la unidad empezó a operar / reportar | 2025-03-12 14:00 |
| `empieza_a_facturarse` | Solo si es **diferente** a `activa_desde`. Si lo dejas vacío se factura desde que está activa | 2025-04-01 00:00 |
| `meses_prepagados` | Solo si plan es prepago y este cliente pagó **más o menos** meses que el default del plan | 36 |
| `ya_facturada_afuera` | **Crítico** — ver explicación abajo | sí / no |

### Sobre "ya facturada afuera"

Como estamos migrando desde otro sistema, algunas unidades **ya pagaron** sus cargos iniciales antes de entrar a Numaris Billing. Si no marcamos esto, vamos a doble-cobrar.

- **Plan recurrente:** ¿el cargo de setup de esta unidad ya se facturó en el sistema anterior? Si sí → la unidad sigue facturando renta normal en Numaris Billing pero **no incluye renglón de setup**.
- **Plan prepago:** ¿el paquete prepago (setup + N mensualidades) ya se facturó en el sistema anterior? Si sí → la unidad no se cobra al instalar ni al cierre. Solo se vuelve a cobrar si en el futuro se renueva el paquete.

Lo más común al migrar: **todas las unidades activas heredadas vienen con "ya facturada afuera = sí"** porque ya se cobraron en el sistema viejo. Las unidades nuevas, instaladas después del cutover, vienen con "no".

| Plan | Identificador externo | Etiqueta | Activa desde | Empieza a facturarse | Meses prepagados | ¿Ya facturada afuera? |
|---|---|---|---|---|---|---|
| | | | | | | |
| | | | | | | |
| | | | | | | |

---

## Sección 5 · Cargos especiales (add-ons)

Cargos adicionales recurrentes que no encajan dentro de un plan. Hay dos tipos. La mayoría de clientes **no tienen ninguno**: si no aplica, escribe "Ninguno" y pasa a la sección 6.

### 5.1 · Add-ons flat (a nivel cliente)

Cargo **mensual fijo** que **no depende de cuántas unidades** tiene el cliente.
*Ejemplo: "10 reglas de evento adicionales +$1,000/mes" — son $1,000 al mes en total, independientemente de si tiene 5 o 500 unidades.*

| Nombre | Monto mensual $ | Vigente desde | Item code NetSuite |
|---|---|---|---|
| | | | |
| | | | |

### 5.2 · Add-ons per-unit (a nivel plan)

Cargo **mensual por unidad** dentro de un plan específico. Se cobra sobre cada unidad activa del plan.
*Ejemplo: "Historial 6 → 12 meses +$50/unidad/mes". Si el plan tiene 200 unidades, son $50 × 200 = $10,000/mes.*

| Plan al que se asocia | Nombre | Monto $ /unidad /mes | Vigente desde | Item code NetSuite |
|---|---|---|---|---|
| | | | | |
| | | | | |

---

## Sección 6 · Comentarios, acuerdos y excepciones

Espacio libre para cualquier cosa que no entre en las secciones anteriores. Incluye:

- **Descuentos o promociones permanentes:** ej. "10% off sobre la renta mensual"
- **Cambios de precio acordados pero aún no vigentes:** ej. "a partir de enero 2027 la renta sube a $X"
- **Migración a mitad de periodo:** si el corte en Numaris Billing no empieza el día normal del ciclo, explica cómo se acordó con el cliente
- **Cualquier diferencia respecto al contrato estándar**
- **Notas internas relevantes para el equipo de billing**

```
[Escribe aquí]
```

---

## Sección 7 · Checklist final (antes de enviar)

- [ ] Razón social y RFC verificados contra la Constancia de Situación Fiscal
- [ ] Confirmé con el cliente la moneda y el día de corte
- [ ] Cada unidad tiene marcada correctamente si ya pagó sus cargos iniciales afuera
- [ ] Los códigos de NetSuite los validé con el equipo financiero (no los inventé)
- [ ] Si hay add-ons, sé exactamente cuál es flat y cuál es por unidad
- [ ] Adjunté la última factura emitida al cliente desde el sistema legacy como referencia
- [ ] Adjunté el Excel de unidades si son más de 10

---

**Llenado por:** _________________________
**Fecha:** _________________________
**Cliente:** _________________________
