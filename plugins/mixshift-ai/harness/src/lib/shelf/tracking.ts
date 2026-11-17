/**
 * Client for the organization's shelf rank tracking sets on the MixShift
 * service (`/api/shelf/tracking*`), on the transport of lib/shelf/client.ts.
 *
 *   shelfTrackingList   -> GET    /api/shelf/tracking
 *   shelfTrackingGet    -> GET    /api/shelf/tracking/:id
 *   shelfTrackingPut    -> PUT    /api/shelf/tracking/:id   create or replace
 *   shelfTrackingPatch  -> PATCH  /api/shelf/tracking/:id   add/remove keywords and ASINs, enabled, pages, cadence, note
 *   shelfTrackingDelete -> DELETE /api/shelf/tracking/:id
 *
 * A tracking set is a list of keywords, shopper locations (zips), views
 * (desktop, mobile), a page depth and the ASINs to read back. Once a day the
 * service takes the results page for every keyword x zip x view x page of
 * every enabled set; each of those counts one against the organization's
 * monthly shelf allowance. Reading and changing the sets is free.
 *
 * Who may write: an owner, admin or manager of the organization; anyone else
 * is refused (forbidden, the service's friendly line). A change
 * that would push the projected monthly use past the allowance is refused
 * (tracking_over_allowance) with `projected_calls_per_month` and `allowance`.
 *
 * Every write is idempotent (PUT replaces, adding a keyword twice or removing
 * an absent one changes nothing, DELETE of a deleted set is not_found), so a
 * lost answer is safe to retry.
 */

import {
  defaultFriendly,
  shelfRequest,
  unrecognizedShape,
  type ShelfClientOptions,
  type ShelfCountry,
  type ShelfFailure,
  type ShelfSurface,
} from './client.js';

/** Mirrors the service's check on a set id: lower-case letters, digits and hyphens, 2-63 characters, not starting with a hyphen. */
export const TRACKING_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
/** The service's limits per set (the list call answers the live values in `limits`). */
export const TRACKING_MAX_KEYWORDS = 50;
export const TRACKING_MAX_ZIPS = 10;
export const TRACKING_MAX_PAGES = 5;

export type TrackingCadence = 'daily' | 'off';

/** What the last daily run recorded: counts only. */
export interface ShelfTrackingRunSummary {
  calls: number;
  ok: number;
  failed: number;
  /** Answers served from an earlier observation, not taken that day. */
  stale: number;
  /** Calls refused because the allowance was used up. */
  exhausted: number;
  stopped_reason: string | null;
}

export interface ShelfTrackingSet {
  id: string;
  retailer: string;
  country: string;
  keywords: string[];
  zips: string[];
  surfaces: ShelfSurface[];
  asins: string[];
  pages: number;
  cadence: TrackingCadence;
  enabled: boolean;
  note: string | null;
  /** keywords x zips x views x pages: the shelf answers one daily run takes. */
  calls_per_day: number;
  last_run_date: string | null;
  last_run_at: string | null;
  last_run_summary: ShelfTrackingRunSummary | null;
  updated_at: string | null;
  updated_by: string | null;
}

export interface ShelfTrackingLimits {
  max_keywords: number;
  max_zips: number;
  max_pages: number;
  max_asins: number | null;
  max_calls_per_day_per_set: number | null;
}

export interface ShelfTrackingList {
  ok: true;
  sets: ShelfTrackingSet[];
  /** What the enabled daily sets will use in a month. */
  projected_calls_per_month: number | null;
  /** The organization's monthly shelf allowance. */
  allowance: number | null;
  /** Whether the signed-in person may change the sets (owner, admin or manager). */
  can_edit: boolean;
  limits: ShelfTrackingLimits;
}

export interface ShelfTrackingOne {
  ok: true;
  set: ShelfTrackingSet;
}

export interface ShelfTrackingWritten {
  ok: true;
  set: ShelfTrackingSet;
  projected_calls_per_month: number | null;
  allowance: number | null;
}

export interface ShelfTrackingPutInput {
  keywords: string[];
  zips: string[];
  /** The marketplace country; the service keeps the set's own (us for a new set) when absent. */
  country?: ShelfCountry;
  surfaces?: ShelfSurface[];
  asins?: string[];
  pages?: number;
  cadence?: TrackingCadence;
  enabled?: boolean;
  note?: string;
}

export interface ShelfTrackingPatchInput {
  add_keywords?: string[];
  remove_keywords?: string[];
  add_asins?: string[];
  remove_asins?: string[];
  enabled?: boolean;
  pages?: number;
  cadence?: TrackingCadence;
  note?: string;
}

const TIMEOUT_MS = 30_000;

/** The keyword as the service stores it (trimmed, lower-cased, single-spaced), so a diff compares like with like. */
export function normalizeKeyword(k: string): string {
  return k.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function shelfTrackingList(opts: ShelfClientOptions = {}): Promise<ShelfTrackingList | ShelfFailure> {
  const r = await shelfRequest({ method: 'GET', path: '/api/shelf/tracking' }, { ...opts, timeoutMs: opts.timeoutMs ?? TIMEOUT_MS });
  if (!r.ok) return trackingFailure(r, { write: false });
  const j = r.json as Record<string, unknown>;
  if (j.ok !== true || !Array.isArray(j.sets)) return unrecognizedShape(r.httpStatus, 'tracking list');
  const sets: ShelfTrackingSet[] = [];
  for (const raw of j.sets) {
    const s = parseSet(raw);
    if (s) sets.push(s);
  }
  const limits = (typeof j.limits === 'object' && j.limits !== null ? j.limits : {}) as Record<string, unknown>;
  return {
    ok: true,
    sets,
    projected_calls_per_month: numOrNull(j.projected_calls_per_month),
    allowance: numOrNull(j.allowance),
    can_edit: j.can_edit === true,
    limits: {
      max_keywords: numOrNull(limits.max_keywords) ?? TRACKING_MAX_KEYWORDS,
      max_zips: numOrNull(limits.max_zips) ?? TRACKING_MAX_ZIPS,
      max_pages: numOrNull(limits.max_pages) ?? TRACKING_MAX_PAGES,
      max_asins: numOrNull(limits.max_asins),
      max_calls_per_day_per_set: numOrNull(limits.max_calls_per_day_per_set),
    },
  };
}

export async function shelfTrackingGet(id: string, opts: ShelfClientOptions = {}): Promise<ShelfTrackingOne | ShelfFailure> {
  const r = await shelfRequest({ method: 'GET', path: setPath(id) }, { ...opts, timeoutMs: opts.timeoutMs ?? TIMEOUT_MS });
  if (!r.ok) return trackingFailure(r, { setId: id, write: false });
  const j = r.json as Record<string, unknown>;
  const set = j.ok === true ? parseSet(j.set) : null;
  if (!set) return unrecognizedShape(r.httpStatus, 'tracking set');
  return { ok: true, set };
}

/** Create the set, or replace it whole when the id is taken. */
export async function shelfTrackingPut(id: string, input: ShelfTrackingPutInput, opts: ShelfClientOptions = {}): Promise<ShelfTrackingWritten | ShelfFailure> {
  // No set id for the failure reading: a PUT creates, so a 404 there is never "no such set".
  return write({ method: 'PUT', path: setPath(id), body: clean({ ...input }) }, undefined, opts);
}

export async function shelfTrackingPatch(id: string, input: ShelfTrackingPatchInput, opts: ShelfClientOptions = {}): Promise<ShelfTrackingWritten | ShelfFailure> {
  return write({ method: 'PATCH', path: setPath(id), body: clean({ ...input }) }, id, opts);
}

export async function shelfTrackingDelete(id: string, opts: ShelfClientOptions = {}): Promise<{ ok: true } | ShelfFailure> {
  const r = await shelfRequest({ method: 'DELETE', path: setPath(id) }, { ...opts, timeoutMs: opts.timeoutMs ?? TIMEOUT_MS });
  if (!r.ok) return trackingFailure(r, { setId: id, write: true });
  if ((r.json as { ok?: unknown }).ok !== true) return unrecognizedShape(r.httpStatus, 'tracking delete');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function write(
  spec: { method: 'PUT' | 'PATCH'; path: string; body: Record<string, unknown> },
  setId: string | undefined,
  opts: ShelfClientOptions,
): Promise<ShelfTrackingWritten | ShelfFailure> {
  const r = await shelfRequest(spec, { ...opts, timeoutMs: opts.timeoutMs ?? TIMEOUT_MS });
  if (!r.ok) return trackingFailure(r, { setId, write: true });
  const j = r.json as Record<string, unknown>;
  const set = j.ok === true ? parseSet(j.set) : null;
  if (!set) return unrecognizedShape(r.httpStatus, 'tracking write');
  return { ok: true, set, projected_calls_per_month: numOrNull(j.projected_calls_per_month), allowance: numOrNull(j.allowance) };
}

function setPath(id: string): string {
  return `/api/shelf/tracking/${encodeURIComponent(id)}`;
}

/** Drop undefined fields and empty lists, so an absent flag is never sent as "set it to nothing". */
function clean(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/** What a failure came from: the set the route names (a 404 there can mean "no such set"; a PUT names none, it creates), and whether it was a write. */
export interface TrackingCall {
  setId?: string;
  write: boolean;
}

/** The service's line for a route it does not have: the tracking routes are not deployed there yet. */
const ENDPOINT_MISSING = /no such shelf endpoint/i;

/**
 * Tracking-specific reading of a failure:
 *   - a not_found on a set route with no line of its own is "no such set";
 *   - a not_found saying "no such shelf endpoint" (or a bare 404) is the tracking routes missing on the service:
 *     tracking_unavailable, never "no such set";
 *   - an envelope carrying `projected_calls_per_month` is the allowance refusal, also when it comes as an
 *     unrecognized kind or as shelf_allowance_exhausted (which otherwise means this month's requests are used up);
 *   - on a write only, a 403 with a kind this build does not know is the role refusal (forbidden).
 * The service's kind stays in `unrecognizedKind`, and its friendly line is kept unless it was a default.
 */
export function trackingFailure(f: ShelfFailure, call: TrackingCall): ShelfFailure {
  const defaulted = f.friendly === defaultFriendly(f.kind);
  if (f.kind === 'not_found' && call.setId !== undefined && defaulted) {
    return { ...f, friendly: `There is no tracking set "${call.setId}" in your organization. Run \`mixshift shelf tracking list\` for the sets there are.` };
  }
  if ((f.kind === 'not_found' && ENDPOINT_MISSING.test(f.friendly)) || (f.kind === 'unknown' && f.httpStatus === 404)) {
    return { ...f, kind: 'tracking_unavailable', friendly: defaultFriendly('tracking_unavailable') };
  }
  let kind = f.kind;
  if (f.projectedCallsPerMonth !== undefined && (f.unrecognizedKind !== undefined || f.kind === 'shelf_allowance_exhausted')) kind = 'tracking_over_allowance';
  else if (call.write && f.unrecognizedKind !== undefined && f.httpStatus === 403) kind = 'forbidden';
  if (kind === f.kind) return f;
  return { ...f, kind, friendly: defaulted ? defaultFriendly(kind) : f.friendly };
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : [];
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function parseSummary(v: unknown): ShelfTrackingRunSummary | null {
  if (typeof v !== 'object' || v === null) return null;
  const s = v as Record<string, unknown>;
  const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return { calls: n(s.calls), ok: n(s.ok), failed: n(s.failed), stale: n(s.stale), exhausted: n(s.exhausted), stopped_reason: strOrNull(s.stopped_reason) };
}

export function parseSet(raw: unknown): ShelfTrackingSet | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string' || !s.id) return null;
  const keywords = strings(s.keywords);
  const zips = strings(s.zips);
  const surfaces = strings(s.surfaces).filter((x): x is ShelfSurface => x === 'desktop' || x === 'mobile');
  const pages = typeof s.pages === 'number' && Number.isFinite(s.pages) ? s.pages : 1;
  return {
    id: s.id,
    retailer: String(s.retailer ?? 'amazon'),
    country: String(s.country ?? 'us'),
    keywords,
    zips,
    surfaces,
    asins: strings(s.asins),
    pages,
    cadence: s.cadence === 'off' ? 'off' : 'daily',
    enabled: s.enabled !== false,
    note: strOrNull(s.note),
    calls_per_day: numOrNull(s.calls_per_day) ?? keywords.length * zips.length * surfaces.length * pages,
    last_run_date: strOrNull(s.last_run_date),
    last_run_at: strOrNull(s.last_run_at),
    last_run_summary: parseSummary(s.last_run_summary),
    updated_at: strOrNull(s.updated_at),
    updated_by: strOrNull(s.updated_by),
  };
}
