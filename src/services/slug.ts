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
