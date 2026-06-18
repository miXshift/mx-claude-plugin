/**
 * Discoveries: typed observations a skill surfaces that may warrant a
 * brand-context (Tier-3) update. PROPOSALS, never auto-applied edits — the
 * Phase-9 promotion step (lib/brain/observe.ts) turns them into Tier-2 Brain
 * observations, and AM confirmation promotes those to Tier-3.
 *
 * Schema source of truth (documentation): shared/clients/_schema/
 * discoveries.schema.yaml. This module is the runtime contract + the
 * capture-on-save emitter used by the confirm-flow.
 *
 * Two scopes share the shape (see the YAML): per-run files written by skills
 * directly, and the brand-level `.pending-discoveries.json` accumulated by the
 * confirm card. This module owns the brand-level capture path; per-run files
 * are authored by skills as JSON and validated against the same schema.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { pendingDiscoveriesPath } from '../paths/resolve.js';

/**
 * A captured value that maps to a SHARED brand-context field (2+/1 litmus),
 * proposed for promotion. Value is in the brand-state convention
 * (whole-number percents), so the applier can write it straight to context.
 */
export const contextFieldProposalSchema = z.object({
  field: z.string().min(1),
  proposed_value: z.unknown(),
  source_skill: z.string().min(1),
  confidence: z.number().min(0).max(1),
  note: z.string().optional(),
  observed_by: z.string().min(1),
  observed_at: z.string().min(1),
});
export type ContextFieldProposal = z.infer<typeof contextFieldProposalSchema>;

/** Non-capture categories (cold-start anomaly proposals) are validated loosely
 *  here — those files are authored by skills; this module only writes the
 *  capture category. */
const looseItemSchema = z.object({}).passthrough();

export const discoveriesDocSchema = z.object({
  schema_version: z.literal(1).default(1),
  generated_by: z.string().min(1),
  generated_at: z.string().min(1),
  discoveries: z
    .object({
      context_field_proposals: z.array(contextFieldProposalSchema).optional(),
    })
    .catchall(z.array(looseItemSchema))
    .default({}),
});
export type DiscoveriesDoc = z.infer<typeof discoveriesDocSchema>;

export interface CaptureInput {
  /** Dotted context path, e.g. "management.acos_target_pct". */
  field: string;
  /** Captured value, brand-state convention (whole-number percents). */
  proposed_value: unknown;
  /** Skill the capture happened under. */
  source_skill: string;
  /** "<skill_id>@<version>" or "confirm-flow". */
  observed_by: string;
  /** ISO-8601. Passed in (not stamped here) so callers stay testable. */
  observed_at: string;
  /** 0..1; defaults to 0.95 (AM-set captures are high-confidence). */
  confidence?: number;
  note?: string;
}

export type AppendDiscoveriesResult =
  | { ok: true; path: string; count: number }
  | { ok: false; reason: string };

/**
 * Append capture proposals to the brand's `.pending-discoveries.json`,
 * upserting by `field` (a newer capture of the same field supersedes the
 * older proposal — the AM's latest intent wins). Atomic write (temp +
 * rename). Best-effort by contract: callers swallow failures so a discovery
 * write never fails a save.
 */
export async function appendCaptureDiscoveries(
  brandSlug: string,
  captures: CaptureInput[],
  dataDirOverride?: string,
): Promise<AppendDiscoveriesResult> {
  if (captures.length === 0) return { ok: false, reason: 'no captures supplied' };

  const path = pendingDiscoveriesPath(brandSlug, dataDirOverride);

  let doc: DiscoveriesDoc;
  try {
    const raw = await readFile(path, 'utf-8');
    doc = discoveriesDocSchema.parse(JSON.parse(raw));
  } catch {
    // Missing or malformed — start fresh.
    doc = {
      schema_version: 1,
      generated_by: captures[0]!.observed_by,
      generated_at: captures[0]!.observed_at,
      discoveries: {},
    };
  }

  const byField = new Map<string, ContextFieldProposal>(
    (doc.discoveries.context_field_proposals ?? []).map((p) => [p.field, p]),
  );
  for (const c of captures) {
    byField.set(c.field, {
      field: c.field,
      proposed_value: c.proposed_value,
      source_skill: c.source_skill,
      confidence: c.confidence ?? 0.95,
      ...(c.note ? { note: c.note } : {}),
      observed_by: c.observed_by,
      observed_at: c.observed_at,
    });
  }
  doc.discoveries.context_field_proposals = [...byField.values()];
  doc.generated_at = captures[captures.length - 1]!.observed_at;

  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(doc, null, 2), 'utf-8');
    await rename(tmp, path);
    return {
      ok: true,
      path,
      count: doc.discoveries.context_field_proposals.length,
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
