import { nextSequence } from '@/models/Counter';

/**
 * Human-readable, collision-free identifiers.
 *
 * The previous generators built IDs from `Math.random().toString(36)`, which
 * gave a real collision probability against the `unique` indexes on
 * `applicationNo` / `certNo` and had no retry path — a collision surfaced as a
 * 500. These use an atomic counter instead, and produce the sequential,
 * auditable format the spec asks for.
 */

function pad(n: number, width = 6): string {
  return String(n).padStart(width, '0');
}

/** e.g. `VT-APP-2026-000928` */
export async function generateApplicationNo(date = new Date()): Promise<string> {
  const year = date.getFullYear();
  const seq = await nextSequence(`application:${year}`);
  return `VT-APP-${year}-${pad(seq)}`;
}

/** e.g. `VT-CERT-2026-000451` */
export async function generateCertNo(date = new Date()): Promise<string> {
  const year = date.getFullYear();
  const seq = await nextSequence(`certificate:${year}`);
  return `VT-CERT-${year}-${pad(seq)}`;
}

/** e.g. `VT-INSP-2026-001204` */
export async function generateInspectionNo(date = new Date()): Promise<string> {
  const year = date.getFullYear();
  const seq = await nextSequence(`inspection:${year}`);
  return `VT-INSP-${year}-${pad(seq)}`;
}

/** e.g. `VT-ENF-2026-000037` */
export async function generateEnforcementCaseNo(date = new Date()): Promise<string> {
  const year = date.getFullYear();
  const seq = await nextSequence(`enforcement:${year}`);
  return `VT-ENF-${year}-${pad(seq)}`;
}

/**
 * e.g. `VT-CMP-2026-000112` — the reference a citizen is handed when they file a
 * complaint.
 *
 * Deliberately the same shape as every other identifier in the system: a
 * complainant with no account has nothing else to hold on to, so the reference
 * has to be short enough to write on a scrap of paper and read back over a
 * phone.
 */
export async function generateComplaintNo(date = new Date()): Promise<string> {
  const year = date.getFullYear();
  const seq = await nextSequence(`complaint:${year}`);
  return `VT-CMP-${year}-${pad(seq)}`;
}

/** e.g. `VT-SEAL-2026-000037` — the physical seal reference stamped on a passing instrument. */
export async function generateSealNo(date = new Date()): Promise<string> {
  const year = date.getFullYear();
  const seq = await nextSequence(`seal:${year}`);
  return `VT-SEAL-${year}-${pad(seq)}`;
}

/**
 * Certificate-number parsing lives in `constants.ts`, which is client-safe, so
 * the public QR scanner reads a scanned code exactly the way the server does.
 * Re-exported here because server-side callers naturally look for it alongside
 * the generators.
 */
export { normalizeCertNo, looksLikeCertNo, extractCertNo } from '@/lib/constants';
