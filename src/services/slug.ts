// Slug + sequential-id helpers (humán-determinístico, §3).
//
// Slug shape: `{ORG_SLUG}-{sequential_id_padded_to_3}`. Lago Cloud caps at 3
// digits in the captures (`NUM-FC2D-009`); we pad with leading zeros and let
// it grow once it exceeds 3 digits, matching Lago Cloud's overflow behaviour
// (no truncation, just longer).

export function buildCustomerSlug(orgSlug: string, sequentialId: number): string {
  const padded = sequentialId.toString().padStart(3, '0');
  return `${orgSlug}-${padded}`;
}

// Deriva un slug ASCII a partir del nombre comercial. Se usa para generar el
// external_id interno del cliente cuando el operador no captura uno (el admin
// ya no lo pide: el identificador que importa hacia afuera es el de la razón
// social). Sin garantía de unicidad — el caller la resuelve.
export function slugifyName(name: string): string {
  const slug = name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'cliente';
}
