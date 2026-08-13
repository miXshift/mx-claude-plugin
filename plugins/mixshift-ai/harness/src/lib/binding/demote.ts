/**
 * Sub-brand DEMOTION — the reversal of promotion (mx-ops#6 P2;
 * docs/subbrand-architecture.md §5 "every promotion is DEMOTABLE" in
 * mx-legacy-auth).
 *
 * Two-phase contract, same shape as promote.ts:
 *
 *   previewDemotion(slug)  — pure read. Never writes. Reports whether the
 *                            brand is currently a bound sub-brand and what
 *                            demoting it would do.
 *
 *   applyDemotion(slug)    — write. Unsets the binding (publishing that as
 *                            the FINAL revision before parking, so org-store
 *                            history shows the transition), then parks the
 *                            local directory (lib/binding/promote.ts's
 *                            parkBrandDirectory — never a hard delete).
 *
 * REVERSIBILITY, stated plainly (design brief: "document what is and is not
 * reversible"):
 *   - REVERSIBLE: the org store's revision history for this brand
 *     (`mcp_brand_context_revisions`) is never touched by a demote — nothing
 *     here calls a delete endpoint. Restoring is a revision PULL against
 *     that history, not an un-park of the local directory.
 *   - NOT automatically reversible: the local directory rename
 *     (`<slug>` -> `<slug>.parked`) has no "un-park" command in this build.
 *     A human can rename it back by hand; this module does not promise to.
 *   - PERMANENT / manual-only: hard deletion of org-store history stays a
 *     manual, ops-gated operation — this module never performs one.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveBinding } from './resolve.js';
import { parkBrandDirectory, type ParkResult } from './promote.js';
import { contextSchema, type BindingBlock } from '../context/schema.js';
import { contextPath } from '../paths/resolve.js';
import { pushAfterWrite } from '../context-sync/push-after-write.js';

export interface DemotionPreview {
  slug: string;
  is_sub_brand: boolean;
  binding_summary: string | null;
  would_park_to: string;
  note: string;
}

const PREVIEW_NOTE =
  'Nothing has been written. Re-run with --apply to unset the binding and park the local ' +
  'directory. Org-store revision history is never deleted by this command; restoring after a ' +
  'demote is a revision pull, not an un-park, and a hard delete stays a manual, ops-gated operation.';

/** Read-only: reports what a demote WOULD do. Never writes. */
export async function previewDemotion(slug: string, dataDirOverride?: string): Promise<DemotionPreview> {
  const binding = await resolveBinding(slug, dataDirOverride);
  return {
    slug,
    is_sub_brand: binding !== null,
    binding_summary: binding ? summarizeBinding(binding) : null,
    would_park_to: `${slug}.parked`,
    note: PREVIEW_NOTE,
  };
}

function summarizeBinding(binding: BindingBlock): string {
  const parts: string[] = [];
  if (binding.retail_label) parts.push(`retail label "${binding.retail_label.value}"`);
  if (binding.ads_label) parts.push(`ads label "${binding.ads_label.value}"`);
  if (binding.amazon_seller_id) parts.push(`account ${binding.amazon_seller_id}`);
  return parts.length > 0 ? parts.join(', ') : '(binding present but empty)';
}

export interface DemotionResult {
  status: 'ok' | 'not_a_sub_brand' | 'error';
  detail: string;
  did_write: boolean;
  parked_dir?: string;
}

/**
 * Execute a demotion. Idempotent: calling this on an already-demoted brand
 * (no binding, directory already parked) reports `not_a_sub_brand` — never
 * an error, never a second park attempt on nothing.
 */
export async function applyDemotion(slug: string, dataDirOverride?: string): Promise<DemotionResult> {
  const binding = await resolveBinding(slug, dataDirOverride);
  if (binding === null) {
    return {
      status: 'not_a_sub_brand',
      detail: `"${slug}" has no binding; it is not a promoted sub-brand, so there is nothing to demote.`,
      did_write: false,
    };
  }

  const unsetResult = await unsetBindingBlock(slug, dataDirOverride);
  if (!unsetResult.ok) {
    return { status: 'error', detail: unsetResult.detail, did_write: false };
  }

  const parked: ParkResult = await parkBrandDirectory(slug, dataDirOverride);
  return {
    status: 'ok',
    detail: parked.parked
      ? `Demoted "${slug}": binding unset, local directory parked at ${parked.parked_dir}. Org-store revision history is intact.`
      : `Demoted "${slug}": binding unset. Parking skipped (${parked.reason}).`,
    did_write: true,
    ...(parked.parked_dir ? { parked_dir: parked.parked_dir } : {}),
  };
}

async function unsetBindingBlock(
  slug: string,
  dataDirOverride?: string,
): Promise<{ ok: boolean; detail: string }> {
  const path = contextPath(slug, dataDirOverride);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      detail: `Could not read context.yaml for "${slug}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed: unknown = parseYaml(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, detail: `context.yaml for "${slug}" did not parse to an object.` };
  }
  const merged: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  delete merged.binding;

  const check = contextSchema.safeParse(merged);
  if (!check.success) {
    return { ok: false, detail: `Removing the binding would make "${slug}"'s context.yaml invalid; refusing to write.` };
  }

  // Write `merged` (raw document minus `binding`), NOT check.data: contextSchema
  // strips unknown keys, and this file is published to the org store below, so
  // serializing the parsed output would silently delete newer-version or
  // hand-added fields from a real customer context fleet-wide. Validation is a
  // GATE, not the serialization source (same rule as promote.ts).
  await writeYamlAtomic(path, merged);
  await pushAfterWrite(slug, { dataDirOverride });
  return { ok: true, detail: 'binding unset' };
}

async function writeYamlAtomic(path: string, obj: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const yamlText = stringifyYaml(obj, { indent: 2, lineWidth: 0 });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, yamlText, 'utf-8');
  await rename(tmpPath, path);
}
