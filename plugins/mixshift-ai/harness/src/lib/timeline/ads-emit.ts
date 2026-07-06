/**
 * Best-effort timeline emission for committed Ads changes.
 *
 * After `mixshift ads call --commit` succeeds, the command layer calls
 * emitAdsCommitEvent to append one `action.ads_change_committed` event per
 * committed change set to the brand timeline (POST /api/timeline/event).
 *
 * HARD CONSTRAINTS (mirrored in tests):
 *   - Never fails or delays the ads commit: the POST is bounded by a short
 *     timeout and every failure is swallowed (debug log via MIXSHIFT_DEBUG
 *     at most). The function never throws.
 *   - Never guesses the brand: the committed profile's legacySellerId must
 *     map to exactly ONE brand in the local registry (index.yaml). Zero or
 *     multiple matches → skip emission silently.
 *
 * DEDUPE NOTE: the server already projects mcp_ads_changes rows into the
 * timeline read path, so this native event is ADDITIVE detail (richer
 * payload, proposal linkage, skill/model attribution). The payload carries
 * change_set_id (= the mcp_ads_changes audit row id) precisely so the P3
 * consolidation pass can dedupe the projection against this event.
 *
 * Attribution convention: callers that know which skill/model drove the
 * change set the env vars MIXSHIFT_SKILL_ID / MIXSHIFT_MODEL_ID before
 * invoking the harness; they land on the event verbatim.
 */

import { readIndex } from '../clients/index.js';
import { createTimelineClient, type TimelineClient } from './client.js';
import { DEADLINE, raceDeadline } from '../utils/deadline.js';
import type { PostTimelineEventInput } from './types.js';

/** The POST must never make a committed change feel slow. */
export const ADS_EMIT_TIMEOUT_MS = 2_000;

/** entity_ids payload cap — enough to audit, never payload-bloating. */
export const ENTITY_IDS_CAP = 50;

/** before-state summaries are truncated to keep the payload well under the
 *  server's 32KB cap even with 50 entity ids alongside. */
const BEFORE_SUMMARY_MAX_CHARS = 2_000;

export interface AdsCommitEmitInput {
  /** Catalog operation id, e.g. 'sp.update_keywords'. */
  operation: string;
  /** Per-marketplace seller record id the commit ran against. */
  legacySellerId: number;
  /** mcp_ads_changes audit row id of THIS commit (the change-set id). */
  auditId?: string;
  /** Size of the applied change set, when the service reported it. */
  itemsCount?: number;
  /** The request body sent to Amazon (the change set) — entity-id source. */
  requestBody?: unknown;
  /** Pre-write snapshot (updates only, best-effort). */
  beforeState?: unknown;
  /** Amazon's multi-status response payload. */
  responsePayload?: unknown;
  /** The dry-run/preview audit id threaded via `--proposal-id`; falls back
   *  to this commit's own auditId when the flow didn't thread one. */
  proposalId?: string;
}

export interface AdsEmitOptions {
  dataDirOverride?: string;
  /** Injectable for tests; defaults to the real HTTP client. */
  client?: TimelineClient;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export type AdsEmitResult =
  | { posted: true; id: string; brand_slug: string }
  | { posted: false; reason: 'no_brand' | 'post_failed' | 'error'; detail?: string };

/**
 * Emit one action.ads_change_committed event for a successful commit.
 * Best-effort and non-throwing by contract — callers fire it after the
 * commit output and ignore the result beyond optional debug logging.
 */
export async function emitAdsCommitEvent(
  input: AdsCommitEmitInput,
  options: AdsEmitOptions = {},
): Promise<AdsEmitResult> {
  const env = options.env ?? process.env;
  try {
    const brandSlug = await resolveBrandSlugForSeller(
      input.legacySellerId,
      options.dataDirOverride,
    );
    if (brandSlug === null) {
      debugLog(env, `ads-emit: no unique brand for seller ${input.legacySellerId}; skipped`);
      return { posted: false, reason: 'no_brand' };
    }

    const client =
      options.client ?? createTimelineClient({ dataDirOverride: options.dataDirOverride });

    const event: PostTimelineEventInput = {
      brand_slug: brandSlug,
      family: 'action',
      kind: 'action.ads_change_committed',
      payload: buildPayload(input),
      // The preview/commit linkage: the dry-run's audit id when the flow
      // threaded it (--proposal-id), else this commit's own audit id.
      ...(input.proposalId ?? input.auditId
        ? { proposal_id: input.proposalId ?? input.auditId }
        : {}),
      // A commit only happens after the user confirmed the preview.
      decision: 'approved',
      ...(env.MIXSHIFT_SKILL_ID ? { skill_id: env.MIXSHIFT_SKILL_ID } : {}),
      ...(env.MIXSHIFT_MODEL_ID ? { model_id: env.MIXSHIFT_MODEL_ID } : {}),
    };

    // The per-request timeoutMs passed to postEvent only bounds the FETCH;
    // authedRequest first awaits getValidAccessToken, and a token
    // refresh/mint rides the GLOBAL fetch with its own 30s timeout — so a
    // stale token against a blackholed host could otherwise hold the
    // (already applied!) commit's exit for ~30s+. Racing the whole POST
    // against the same wall-clock budget keeps the ads command snappy no
    // matter where the hang is. On deadline the detached POST is left to
    // finish on its own: postEvent never rejects by contract, and a late
    // success simply means the timeline converged after all.
    const timeoutMs = options.timeoutMs ?? ADS_EMIT_TIMEOUT_MS;
    const raced = await raceDeadline(client.postEvent(event, { timeoutMs }), timeoutMs);
    if (raced === DEADLINE) {
      debugLog(env, `ads-emit: post exceeded the ${timeoutMs}ms budget; detached`);
      return {
        posted: false,
        reason: 'post_failed',
        detail: `timed out after ${timeoutMs}ms`,
      };
    }
    if (!raced.ok) {
      debugLog(env, `ads-emit: post failed (${raced.kind}): ${raced.message}`);
      return { posted: false, reason: 'post_failed', detail: raced.friendly };
    }
    return { posted: true, id: raced.id, brand_slug: brandSlug };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog(env, `ads-emit: swallowed error: ${message}`);
    return { posted: false, reason: 'error', detail: message };
  }
}

/**
 * Map a legacy seller id to the ONE brand whose registry accounts contain
 * it. Null when the registry is missing/unreadable, no brand matches, or —
 * defensively — more than one does (never guess).
 */
export async function resolveBrandSlugForSeller(
  legacySellerId: number,
  dataDirOverride?: string,
): Promise<string | null> {
  let brands;
  try {
    ({
      index: { brands },
    } = await readIndex(dataDirOverride));
  } catch {
    return null; // malformed registry — the discover flow owns that error
  }
  const matches = brands.filter((b) =>
    b.accounts.some((a) => a.seller_id === legacySellerId),
  );
  return matches.length === 1 ? matches[0]!.slug : null;
}

// ---------------------------------------------------------------------------
// Payload construction
// ---------------------------------------------------------------------------

function buildPayload(input: AdsCommitEmitInput): Record<string, unknown> {
  const entityType = deriveEntityType(input.operation);
  const entityIds = extractEntityIds(input.requestBody);
  return {
    operation: input.operation,
    ...(entityType !== null ? { entity_type: entityType } : {}),
    ...(entityIds.length > 0 ? { entity_ids: entityIds } : {}),
    ...(typeof input.itemsCount === 'number' ? { items_count: input.itemsCount } : {}),
    ...(input.beforeState !== undefined
      ? { before_summary: truncatedJson(input.beforeState, BEFORE_SUMMARY_MAX_CHARS) }
      : {}),
    ...buildResultSummary(input.responsePayload),
    // The mcp_ads_changes audit row id — the P3 dedupe key against the
    // server-side projection of the same commit.
    ...(input.auditId ? { change_set_id: input.auditId } : {}),
  };
}

/** 'sp.update_keywords' → 'keywords'; null when the id doesn't follow the
 *  <family>.<verb>_<entity> catalog convention. */
function deriveEntityType(operation: string): string | null {
  const m = /^[a-z0-9]+\.(?:create|update|delete|add|remove)_(.+)$/i.exec(operation);
  return m ? m[1]! : null;
}

const ENTITY_ID_KEY_RE =
  /^(campaign|adGroup|keyword|target|targeting|ad|productAd|negativeKeyword|negativeTarget|portfolio)Id$/i;

/**
 * Best-effort entity-id extraction from the change-set body. Amazon Ads
 * write bodies vary (bare arrays, { keywords: [...] } wrappers), so this
 * walks the structure depth-limited and collects values under conventional
 * *Id keys. Deduped, capped at ENTITY_IDS_CAP, stringified (Ads ids exceed
 * JS safe-integer range on the wire elsewhere; strings are lossless).
 */
export function extractEntityIds(body: unknown, cap: number = ENTITY_IDS_CAP): string[] {
  const found = new Set<string>();
  const walk = (node: unknown, depth: number): void => {
    if (found.size >= cap || depth > 4 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (found.size >= cap) return;
        walk(item, depth + 1);
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (found.size >= cap) return;
      if (
        ENTITY_ID_KEY_RE.test(key) &&
        (typeof value === 'string' || typeof value === 'number')
      ) {
        found.add(String(value));
      } else {
        walk(value, depth + 1);
      }
    }
  };
  walk(body, 0);
  return [...found];
}

/** success/error counts from Amazon's multi-status response, when its shape
 *  exposes them ({ success: [...], error: [...] } per the v3 convention). */
function buildResultSummary(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const p = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (Array.isArray(p.success)) out.success_count = p.success.length;
  if (Array.isArray(p.error)) out.error_count = p.error.length;
  return out;
}

function truncatedJson(value: unknown, maxChars: number): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserializable]';
  }
  return json.length > maxChars ? `${json.slice(0, maxChars)}…` : json;
}

function debugLog(env: NodeJS.ProcessEnv, message: string): void {
  if (env.MIXSHIFT_DEBUG) process.stderr.write(`[debug] ${message}\n`);
}
