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

/** One event as returned by GET /api/timeline. */
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
}

/** Body for POST /api/timeline/event. actor/client_id come from the token. */
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

export type PostTimelineEventResult = { ok: true; id: string } | TimelineFailure;
