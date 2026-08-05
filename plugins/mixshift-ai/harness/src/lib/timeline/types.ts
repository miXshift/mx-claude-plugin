/**
 * Shared types for the brand timeline (`mixshift timeline ...`).
 *
 * The timeline (ORG-BRAIN.md section 2b) is the first-class, surface-agnostic
 * event log per brand: context revisions (`knowledge.*`, server-emitted),
 * audited Ads writes (`action.*`), stakes in the ground (`structural.*`), and
 * human annotations (`comment`). It is the CUSTOMER-FACING business record —
 * distinct from plugin telemetry, which stays in its own operational store.
 *
 * Wire contract (FROZEN; the service is built against it in parallel):
 *
 *   GET /api/timeline?brand=&family=&kind=&actor=&client_id=&proposal_id=
 *                    &since=&until=&limit=&cursor=
 *     → 200 { ok:true, events:[WireTimelineEvent...], next_cursor? }
 *   POST /api/timeline/event  { brand_slug, family, kind, ts?, payload?,
 *                               target_ref?, source_ref?, sensitivity?,
 *                               proposal_id?, skill_id?, model_id?, decision? }
 *     → 200 { ok:true, id }
 *     | 400 { ok:false, kind:'bad_params'|'too_large'|'reserved_kind' }
 *     | 403 { ok:false, kind:'insufficient_scope' }
 *
 * actor and client_id are derived from the bearer token server-side — the
 * client NEVER sends them. `knowledge.*` kinds are server-emitted only and
 * rejected on POST (reserved_kind).
 */

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** Event families a CLIENT may post. The server additionally emits
 *  `knowledge` events from the context service; those are read-only here. */
export type PostableTimelineFamily = 'action' | 'structural' | 'comment';

/**
 * The 15-value stake category enum (org brain P2.5; widened by server
 * migration 018 / feedback #37499). A `structural.*` event that carries a
 * `category` is a "stake"; a structural event with no category behaves
 * exactly as it did in P2. FROZEN — mirrors the server enum. The recurring
 * categories are labels; recurrence is not occurrence-expanded. The #37499
 * additions: `off_amazon_media` (a standing off-Amazon media condition:
 * outside demand gen, MMM attribution, non-Amazon ad lines),
 * `assortment_change` (products rotating in/out of the catalog as expected
 * behavior), and `other` (the explicit escape — pair it with a specific
 * freeform `kind` instead of forcing a wrong fixed category).
 */
export const STAKE_CATEGORIES = [
  'brand_migration',
  'media_spike',
  'media_spike_recurring',
  'portfolio_decision',
  'promotional_window',
  'promotional_window_recurring',
  'stockout',
  'price_test',
  'launch',
  'content_change',
  'strategy_change',
  'platform_external',
  'off_amazon_media',
  'assortment_change',
  'other',
] as const;
export type StakeCategory = (typeof STAKE_CATEGORIES)[number];

/** Trust axis: who asserted the stake. Defaults to `declared` server-side;
 *  any value is accepted from any writer. Independent of `status`. */
export const STAKE_SOURCES = ['declared', 'system', 'suggested'] as const;
export type StakeSource = (typeof STAKE_SOURCES)[number];

/** Verification axis (a server-set projection column): a stake is born
 *  `unverified` and moves only via corroborate. Never accepted on create. */
export const STAKE_STATUSES = [
  'unverified',
  'corroborated',
  'disputed',
  'no_effect',
] as const;
export type StakeStatus = (typeof STAKE_STATUSES)[number];

/** One event as returned by GET /api/timeline.
 *
 *  Stake fields (`end_ts`, `category`, `source`, `status`, `interpretation`,
 *  `intensity`, `evidence`) are present only when meaningful, and `affects`
 *  appears only when non-empty — a legacy (pre-P2.5) row grows no new keys. */
export interface WireTimelineEvent {
  id: string;
  brand_slug: string;
  family: string;
  kind: string;
  ts: string;
  actor: string;
  client_id: string;
  payload: Record<string, unknown>;
  target_ref?: string;
  source_ref?: string;
  sensitivity: string;
  proposal_id?: string;
  skill_id?: string;
  model_id?: string;
  decision?: string;
  // Stake fields (org brain P2.5).
  end_ts?: string;
  category?: StakeCategory;
  source?: StakeSource;
  status?: StakeStatus;
  interpretation?: string;
  intensity?: number;
  evidence?: Record<string, unknown>;
  affects?: string[];
  /** Freeform lowercase slug tags (#37499); present only when non-empty. */
  tags?: string[];
}

/** Filter set for GET /api/timeline (all optional; wire param names). */
export interface TimelineListQuery {
  brand?: string;
  family?: string;
  kind?: string;
  actor?: string;
  client_id?: string;
  proposal_id?: string;
  /** ISO-8601 timestamp (resolve relative forms before calling). */
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
  // Stake filters (org brain P2.5).
  /** Restrict to stakes (category is not null). */
  stakes?: boolean;
  category?: StakeCategory;
  source?: StakeSource;
  status?: StakeStatus;
  /** A single type-prefixed ref; matches stakes whose `affects` contains it. */
  affects?: string;
  /** A single lowercase slug; matches stakes whose `tags` contains it. */
  tag?: string;
  /** Reinterpret since/until as an interval overlap against [ts, end_ts]. */
  overlap?: boolean;
  /** Lift the default now+24h upper bound (show scheduled stakes). */
  include_future?: boolean;
}

/** Body for POST /api/timeline/event. actor/client_id come from the token.
 *
 *  Stake fields (org brain P2.5): presence of `category` makes the event a
 *  stake (requires family `structural` + `interpretation`). `status` is never
 *  sent — the server sets it. */
export interface PostTimelineEventInput {
  brand_slug: string;
  family: PostableTimelineFamily;
  kind: string;
  ts?: string;
  payload?: Record<string, unknown>;
  target_ref?: string;
  source_ref?: string;
  sensitivity?: string;
  proposal_id?: string;
  skill_id?: string;
  model_id?: string;
  decision?: string;
  // Stake fields (org brain P2.5).
  category?: StakeCategory;
  end_ts?: string;
  affects?: string[];
  source?: StakeSource;
  intensity?: number;
  interpretation?: string;
  evidence?: Record<string, unknown>;
  /** Freeform lowercase slug tags, ≤16 × 64 chars (#37499). Stake-only. */
  tags?: string[];
  /**
   * Server-side idempotency key (org brain P3.1, contract R10): a duplicate
   * (same tenant + key) returns 200 with the EXISTING id + duplicate:true
   * instead of a second row. The stake-sync path derives it deterministically
   * (`ctxev:<brand>:<event.id>`) so re-syncs are convergent with no local
   * ledger.
   */
  idempotency_key?: string;
}

/** Body for POST /api/timeline/event/:id/corroborate. At least one of
 *  status / end_ts / evidence must be present (a `note` alone is not a
 *  corroboration). */
export interface CorroborateEventInput {
  status?: StakeStatus;
  end_ts?: string;
  note?: string;
  evidence?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Client result envelopes (see client.ts)
// ---------------------------------------------------------------------------

export type TimelineFailureKind =
  | 'bad_params'
  | 'too_large'
  | 'reserved_kind'
  | 'insufficient_scope'
  | 'not_found'
  | 'host_unreachable'
  | 'unknown';

export interface TimelineFailure {
  ok: false;
  kind: TimelineFailureKind;
  /** Raw message (server `friendly` when present, else transport detail). */
  message: string;
  /** User-facing message. */
  friendly: string;
}

export type ListTimelineResult =
  | { ok: true; events: WireTimelineEvent[]; next_cursor?: string }
  | TimelineFailure;

export type PostTimelineEventResult =
  | {
      ok: true;
      id: string;
      /** Present (true) exactly when an idempotency_key re-POST resolved to
       *  an existing event instead of creating a new row. */
      duplicate?: boolean;
    }
  | TimelineFailure;

/** Corroborate returns the updated stake (mapped like a list row) plus the
 *  id of the appended `structural.corroboration` child event. */
export type CorroborateEventResult =
  | { ok: true; event: WireTimelineEvent; corroboration_id: string }
  | TimelineFailure;
