/**
 * Stake sync — publish a brand's curated Tier-3 `structural_events[]` (local
 * context.yaml) to the server brand timeline as DECLARED STAKES (#37499; the
 * "structural_events migrate into the timeline" leg of org brain P2.5 that
 * shipped server-side in migration 011/012 but never had a client).
 *
 * One local event maps to one `POST /api/timeline/event`:
 *
 *   family          structural
 *   kind            structural.<event.kind ?? event.type>
 *   category        event.type            (local enum ⊂ server enum, 1:1)
 *   source          declared              (curated by a human, by definition)
 *   interpretation  event.interpretation  (required on both sides)
 *   ts              event.start, date-only forms pinned to T00:00:00Z;
 *                   OMITTED when the event is undated — the server stamps
 *                   "now" and evidence.event_date_known:false marks that the
 *                   timestamp is when we RECORDED it, not when it happened
 *   end_ts          event.end ?? event.active_through, date-only forms pinned
 *                   to T23:59:59Z (an end DATE means through that day)
 *   affects         local {key: value} entries -> "key:value" wire refs
 *   tags            event.tags
 *   idempotency_key ctxev:<brand>:<event.id>
 *
 * The idempotency key makes every re-sync CONVERGENT with no local ledger: a
 * re-POST of an already-synced event returns 200 + duplicate:true and no
 * second row (server contract R10, migration 012). context.yaml is never
 * mutated — it stays the local source of truth and the timeline holds the
 * org-visible record.
 *
 * Callers: the pushAfterWrite auto-publish seam (best-effort, budgeted,
 * hash-skip — see lib/context-sync/push-after-write.ts), `mixshift context
 * push` / `context migrate` (visible reporting after a successful doc push),
 * and `mixshift timeline sync` (explicit backfill / dry-run).
 */

import { createHash } from 'node:crypto';
import { validateBrandContext } from '../context/load.js';
import type { StructuralEvent } from '../context/schema.js';
import { loadState, resolveLedgerIdentity, saveState } from '../context-sync/state.js';
import { createTimelineClient, type TimelineClient } from './client.js';
import type { PostTimelineEventInput } from './types.js';

/** Wall-clock budget for ONE post when a caller does not override it. The
 *  auto-publish seam passes a much tighter shared budget. */
export const STAKE_POST_TIMEOUT_MS = 10_000;

export type StakeOutcome = 'created' | 'duplicate' | 'failed' | 'planned';

export interface StakeSyncEventReport {
  /** The local context.yaml event id. */
  id: string;
  outcome: StakeOutcome;
  /** Server event id (created / duplicate). */
  event_id?: string;
  /** Failure detail (outcome 'failed'). */
  detail?: string;
  category: string;
  /** False when the event has no start date (ts omitted; server stamps now). */
  date_known: boolean;
}

export interface StakeSyncResult {
  /** True when nothing FAILED (created/duplicate/planned all count as ok). */
  ok: boolean;
  brand: string;
  total: number;
  created: number;
  duplicates: number;
  failed: number;
  reports: StakeSyncEventReport[];
  /** Whole-run failure (no/invalid context) — reports is empty. */
  error?: string;
}

export interface StakeSyncOptions {
  dataDirOverride?: string;
  /** Injectable for tests / for the budgeted auto-publish path. */
  client?: TimelineClient;
  /** Map + report without posting anything. */
  dryRun?: boolean;
  /** Per-post timeout override (the auto-publish seam tightens this). */
  postTimeoutMs?: number;
}

/** Deterministic server-side idempotency key for one local event. Stays
 *  debuggable in the common case; hashes only when the local id would push
 *  the key past the server's 255-char cap. */
export function stakeIdempotencyKey(brandSlug: string, eventId: string): string {
  const plain = `ctxev:${brandSlug}:${eventId}`;
  if (plain.length <= 255) return plain;
  const digest = createHash('sha256').update(eventId, 'utf8').digest('hex');
  return `ctxev:${brandSlug}:${digest}`;
}

/** Content hash of a brand's structural_events block — the auto-publish
 *  seam's "anything to sync?" skip (stored in the per-brand sync ledger). */
export function hashStructuralEvents(events: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(events), 'utf8').digest('hex');
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Pin a date-only START to the beginning of that day (UTC). Full ISO forms
 *  pass through untouched; anything else is left for the server to judge. */
export function normalizeStartTs(value: string): string {
  return DATE_ONLY_RE.test(value) ? `${value}T00:00:00Z` : value;
}

/** Pin a date-only END to the end of that day (UTC) — an end DATE means
 *  "through that day", and T00:00:00Z would exclude the whole final day from
 *  interval-overlap reads. */
export function normalizeEndTs(value: string): string {
  return DATE_ONLY_RE.test(value) ? `${value}T23:59:59Z` : value;
}

/**
 * Map one local affects entry to a type-prefixed wire ref. The local schema
 * keeps entries as `unknown` (curated YAML): a `{key: value}` single-pair
 * object becomes `"key:value"`, a plain string passes through, anything else
 * maps to null (dropped — a malformed scope ref must not sink the event).
 */
export function mapAffectsRef(entry: unknown): string | null {
  if (typeof entry === 'string') return entry.length > 0 ? entry : null;
  if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
    const pairs = Object.entries(entry as Record<string, unknown>);
    if (pairs.length === 1) {
      const [key, value] = pairs[0];
      if (typeof value === 'string' || typeof value === 'number') {
        return `${key}:${value}`;
      }
    }
  }
  return null;
}

/** Build the wire POST body for one local structural event. */
export function mapEventToStake(
  brandSlug: string,
  event: StructuralEvent,
): PostTimelineEventInput {
  const start = event.start;
  const end = event.end ?? event.active_through;
  const dateKnown = start !== undefined;
  const affects = (event.affects ?? [])
    .map(mapAffectsRef)
    .filter((r): r is string => r !== null);
  return {
    brand_slug: brandSlug,
    family: 'structural',
    kind: `structural.${event.kind ?? event.type}`,
    category: event.type,
    source: 'declared',
    interpretation: event.interpretation,
    ...(dateKnown ? { ts: normalizeStartTs(start) } : {}),
    ...(end !== undefined ? { end_ts: normalizeEndTs(end) } : {}),
    ...(affects.length > 0 ? { affects } : {}),
    ...(event.tags && event.tags.length > 0 ? { tags: event.tags } : {}),
    // Provenance: where the record came from, and — for an undated event —
    // that ts is the moment of RECORDING, not occurrence.
    evidence: {
      recorded_from: 'context.yaml',
      event_date_known: dateKnown,
    },
    idempotency_key: stakeIdempotencyKey(brandSlug, event.id),
  };
}

/**
 * Sync every structural_event of one brand. Sequential posts (curated sets
 * are small and order keeps reports readable); a per-event failure is
 * REPORTED, never thrown, and never stops the remaining events. context.yaml
 * is read-only to this function.
 */
export async function syncStakes(
  brandSlug: string,
  options: StakeSyncOptions = {},
): Promise<StakeSyncResult> {
  const base: Omit<StakeSyncResult, 'ok'> = {
    brand: brandSlug,
    total: 0,
    created: 0,
    duplicates: 0,
    failed: 0,
    reports: [],
  };
  // Never throws — the auto-publish seam calls this fire-and-forget-style
  // and a disk hiccup must degrade to a reported error, not an exception.
  let validated: Awaited<ReturnType<typeof validateBrandContext>>;
  try {
    validated = await validateBrandContext(brandSlug, options.dataDirOverride);
  } catch (err) {
    return {
      ...base,
      ok: false,
      error: `Could not read the brand context: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!validated.ok) {
    return {
      ...base,
      ok: false,
      error:
        validated.kind === 'file_missing'
          ? `No brand context found for "${brandSlug}".`
          : `Brand context for "${brandSlug}" failed validation; fix it before syncing events (mixshift brand validate ${brandSlug}).`,
    };
  }
  const events = validated.context.structural_events ?? [];
  if (events.length === 0) return { ...base, ok: true };

  const client = options.client ?? createTimelineClient({ dataDirOverride: options.dataDirOverride });
  const result: StakeSyncResult = { ...base, ok: true, total: events.length };
  for (const event of events) {
    const body = mapEventToStake(brandSlug, event);
    const reportBase = {
      id: event.id,
      category: event.type,
      date_known: body.ts !== undefined,
    };
    if (options.dryRun) {
      result.reports.push({ ...reportBase, outcome: 'planned' });
      continue;
    }
    const posted = await client.postEvent(body, {
      timeoutMs: options.postTimeoutMs ?? STAKE_POST_TIMEOUT_MS,
    });
    if (posted.ok) {
      if (posted.duplicate) {
        result.duplicates += 1;
        result.reports.push({ ...reportBase, outcome: 'duplicate', event_id: posted.id });
      } else {
        result.created += 1;
        result.reports.push({ ...reportBase, outcome: 'created', event_id: posted.id });
      }
    } else {
      result.failed += 1;
      result.ok = false;
      result.reports.push({ ...reportBase, outcome: 'failed', detail: posted.friendly });
    }
  }
  // Stamp the sync ledger on a FULLY-clean real run so the auto-publish
  // seam's hash-skip fires on the next write. Advisory (saveState swallows
  // failures): a missing stamp only means one extra idempotent sync. A
  // partial failure deliberately does NOT stamp — the leg keeps re-running
  // until every event lands.
  if (!options.dryRun && result.ok) {
    try {
      const identity = await resolveLedgerIdentity(options.dataDirOverride);
      const state = await loadState(brandSlug, options.dataDirOverride, identity);
      state.stakes = {
        last_synced_hash: hashStructuralEvents(events),
        last_synced_at: new Date().toISOString(),
      };
      await saveState(brandSlug, state, options.dataDirOverride);
    } catch {
      // Advisory stamp — never worth failing a successful sync over.
    }
  }
  return result;
}
