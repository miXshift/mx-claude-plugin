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
 *   category        event.type when the server knows it, else `other` with the
 *                   original slug carried on kind + evidence.local_type (so a
 *                   NEWER plugin's taxonomy still syncs losslessly through an
 *                   older server enum — see resolveCategory)
 *   source          declared              (curated by a human, by definition)
 *   interpretation  event.interpretation  (required on both sides)
 *   ts              event.start; date-only pinned to T00:00:00Z, zone-less
 *                   stamped UTC. Undated + no end => OMITTED (the server
 *                   stamps now). Undated WITH an end => anchored to the end
 *                   day, because omitting it would put the close before the
 *                   start and 400. evidence.event_date_known:false always
 *                   marks that the event's own date is unknown.
 *   end_ts          event.end ?? event.active_through, date-only pinned to
 *                   T23:59:59Z (an end DATE means through that day)
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
 * Failures are classified PERMANENT (a rejected field, a reserved kind, a
 * duplicate id — hopeless without a context.yaml edit) or transient. Only
 * transient ones hold back the ledger stamp, so a single bad event cannot make
 * the auto-publish seam re-post the whole set on every future write forever.
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
import { STAKE_CATEGORIES, type StakeCategory, type TimelineFailureKind } from './types.js';
import type { PostTimelineEventInput } from './types.js';

/** Wall-clock budget for ONE post when a caller does not override it. The
 *  auto-publish seam passes a much tighter shared budget. */
export const STAKE_POST_TIMEOUT_MS = 10_000;

/** Server-side caps mirrored so an oversized field fails LOCALLY with a
 *  precise message instead of a generic 400 after a wasted round trip
 *  (mx-legacy-auth routes/timeline.ts MAX_* constants). */
export const MAX_INTERPRETATION_CHARS = 4_000;
export const MAX_AFFECTS = 64;
export const MAX_AFFECT_CHARS = 256;

/**
 * Failure kinds that will NEVER succeed on a retry without a context edit:
 * the request itself is unacceptable. Distinguishing these from transient
 * ones (host_unreachable, timeout, insufficient_scope) is what stops ONE bad
 * event from wedging a brand's auto-sync forever — see syncStakes' stamping
 * rule and push-after-write's hash-skip.
 */
const PERMANENT_FAILURE_KINDS: readonly TimelineFailureKind[] = [
  'bad_params',
  'reserved_kind',
  'too_large',
];

export type StakeOutcome = 'created' | 'duplicate' | 'failed' | 'planned';

export interface StakeSyncEventReport {
  /** The local context.yaml event id. */
  id: string;
  outcome: StakeOutcome;
  /** Server event id (created / duplicate). */
  event_id?: string;
  /** Failure detail (outcome 'failed'). */
  detail?: string;
  /**
   * True when this failure can never succeed on a retry without editing
   * context.yaml (a rejected field, a reserved kind, a duplicate id). Drives
   * the stamping rule so one bad event cannot re-post the whole set forever.
   */
  permanent?: boolean;
  category: string;
  /** False when the event has no start date (ts is a recording/anchor time). */
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
  /** Of `failed`, how many can never succeed without a context.yaml edit. */
  permanent_failures: number;
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
/** A full ISO local time with NO zone designator. The server requires an
 *  offset (strictTsSchema uses .datetime({offset:true})), so a zone-less form
 *  written by hand would 400; treat it as UTC, matching the date-only rule. */
const ZONELESS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/** Pin a date-only START to the beginning of that day (UTC), and stamp a
 *  zone-less timestamp as UTC. Offset-carrying ISO forms pass through
 *  untouched; anything else is left for the server to judge. */
export function normalizeStartTs(value: string): string {
  if (DATE_ONLY_RE.test(value)) return `${value}T00:00:00Z`;
  if (ZONELESS_RE.test(value)) return `${value}Z`;
  return value;
}

/** Pin a date-only END to the end of that day (UTC) — an end DATE means
 *  "through that day", and T00:00:00Z would exclude the whole final day from
 *  interval-overlap reads. Zone-less timestamps are stamped UTC as above. */
export function normalizeEndTs(value: string): string {
  if (DATE_ONLY_RE.test(value)) return `${value}T23:59:59Z`;
  if (ZONELESS_RE.test(value)) return `${value}Z`;
  return value;
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

/**
 * Resolve a local `type` onto the server's fixed category enum. A KNOWN type
 * maps 1:1; an unrecognized slug (a newer plugin's taxonomy, or a hand-edited
 * file) maps to `other` and carries the original slug forward as the kind, so
 * a type this build has never heard of still syncs losslessly instead of
 * bouncing off the server enum. Returns the category plus the kind leaf.
 */
export function resolveCategory(event: StructuralEvent): {
  category: StakeCategory;
  kindLeaf: string;
} {
  const known = (STAKE_CATEGORIES as readonly string[]).includes(event.type);
  if (known) {
    return {
      category: event.type as StakeCategory,
      kindLeaf: event.kind ?? event.type,
    };
  }
  return { category: 'other', kindLeaf: event.kind ?? event.type };
}

/** Build the wire POST body for one local structural event. */
export function mapEventToStake(
  brandSlug: string,
  event: StructuralEvent,
): PostTimelineEventInput {
  const end = event.end ?? event.active_through;
  const dateKnown = event.start !== undefined;
  // An UNDATED event that nonetheless records an end/active_through cannot
  // omit ts: the server would pin ts to now, putting the close BEFORE the
  // start and 400ing ('end_ts must be at or after ts') forever. Anchor ts to
  // the start of the end day so the range stays valid and honest; the
  // evidence marker still says the event's own date is unknown.
  const ts = dateKnown
    ? normalizeStartTs(event.start as string)
    : end !== undefined
      ? normalizeStartTs(dateOnlyPart(end))
      : undefined;
  const affects = (event.affects ?? [])
    .map(mapAffectsRef)
    .filter((r): r is string => r !== null);
  const { category, kindLeaf } = resolveCategory(event);
  return {
    brand_slug: brandSlug,
    family: 'structural',
    kind: `structural.${kindLeaf}`,
    category,
    source: 'declared',
    interpretation: event.interpretation,
    ...(ts !== undefined ? { ts } : {}),
    ...(end !== undefined ? { end_ts: normalizeEndTs(end) } : {}),
    ...(affects.length > 0 ? { affects } : {}),
    ...(event.tags && event.tags.length > 0 ? { tags: event.tags } : {}),
    // Provenance: where the record came from, whether the event's own date is
    // known (when false, ts is a recording/anchor time, not an occurrence),
    // and the original local type whenever it had to be folded into `other`.
    evidence: {
      recorded_from: 'context.yaml',
      event_date_known: dateKnown,
      ...(category === 'other' && event.type !== 'other'
        ? { local_type: event.type }
        : {}),
    },
    idempotency_key: stakeIdempotencyKey(brandSlug, event.id),
  };
}

/** The YYYY-MM-DD head of a date or timestamp string (used to anchor an
 *  undated event's ts to its end day). Falls back to the whole value. */
function dateOnlyPart(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1] : value;
}

/**
 * Local pre-flight of the server's field caps + the one structural invariant
 * the wire cannot express. Returns a reason string when the event must NOT be
 * posted, else null. Catching these here turns a wasted round trip and an
 * opaque 400 into a precise, actionable per-event report.
 */
export function preflightEvent(
  event: StructuralEvent,
  seenIds: ReadonlySet<string>,
): string | null {
  if (seenIds.has(event.id)) {
    return `duplicate id '${event.id}' in structural_events; ids must be unique (both events would resolve to the same timeline record)`;
  }
  if (event.interpretation.length > MAX_INTERPRETATION_CHARS) {
    return `interpretation is ${event.interpretation.length} characters; the limit is ${MAX_INTERPRETATION_CHARS}`;
  }
  const refs = (event.affects ?? []).map(mapAffectsRef).filter((r): r is string => r !== null);
  if (refs.length > MAX_AFFECTS) {
    return `affects has ${refs.length} entries; the limit is ${MAX_AFFECTS}`;
  }
  const tooLong = refs.find((r) => r.length > MAX_AFFECT_CHARS);
  if (tooLong !== undefined) {
    return `an affects entry is ${tooLong.length} characters; the limit is ${MAX_AFFECT_CHARS}`;
  }
  return null;
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
    permanent_failures: 0,
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
  const seenIds = new Set<string>();
  for (const event of events) {
    const body = mapEventToStake(brandSlug, event);
    const reportBase = {
      id: event.id,
      category: body.category as string,
      date_known: event.start !== undefined,
    };
    // Local pre-flight: a cap violation or duplicate id can never succeed, so
    // report it precisely and skip the round trip entirely.
    const rejected = preflightEvent(event, seenIds);
    seenIds.add(event.id);
    if (rejected !== null) {
      if (!options.dryRun) {
        result.failed += 1;
        result.permanent_failures += 1;
        result.ok = false;
      }
      result.reports.push({
        ...reportBase,
        outcome: options.dryRun ? 'planned' : 'failed',
        detail: rejected,
        ...(options.dryRun ? {} : { permanent: true }),
      });
      continue;
    }
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
      const permanent = PERMANENT_FAILURE_KINDS.includes(posted.kind);
      result.failed += 1;
      if (permanent) result.permanent_failures += 1;
      result.ok = false;
      result.reports.push({
        ...reportBase,
        outcome: 'failed',
        detail: posted.friendly,
        ...(permanent ? { permanent: true } : {}),
      });
    }
  }
  // Stamp the sync ledger so the auto-publish seam's hash-skip fires on the
  // next write. Advisory (saveState swallows failures): a missing stamp only
  // means one extra idempotent sync.
  //
  // Stamp when every REMAINING failure is PERMANENT: those cannot be fixed by
  // retrying, so leaving the hash unstamped would re-post the whole event set
  // on every single context write forever, burning the seam's network budget
  // and never making progress. A TRANSIENT failure (offline, timeout, missing
  // scope) does NOT stamp, so the next write retries it. Editing the offending
  // event changes the hash and re-arms the leg either way.
  const stampable = result.failed === result.permanent_failures;
  if (!options.dryRun && stampable) {
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
