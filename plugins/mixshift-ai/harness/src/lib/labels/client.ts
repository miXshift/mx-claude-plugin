/**
 * Client for the labels read surface on the MixShift service (mcp.mixshift.io,
 * `/api/labels/*`): the labels you put on your items (ASINs) and Amazon
 * campaigns to organize them (Item Group, Brand, Nickname, Parent ASIN, Item
 * Label 1 and 2, Tags 1 to 4, and for campaigns also Manager and Objective).
 * The REST sibling of the service's labels_* MCP tools.
 *
 *   labelsState    -> GET  /api/labels/state
 *   labelsFields   -> GET  /api/labels/fields?account=&entity=
 *   labelsList     -> GET  /api/labels/items | /api/labels/campaigns
 *                          ?account=&field=&value=&cursor=&limit=
 *   labelsLookup   -> POST /api/labels/items/lookup | /api/labels/campaigns/lookup
 *                          { account, ids } (at most 500 ids a call)
 *   labelsDrift    -> GET  /api/labels/drift?account=&entity=&cursor=&limit=
 *   labelsChanges  -> GET  /api/labels/changes?account=&since=&cursor=&limit=
 *
 * What the service promises (and this client relies on):
 *   - Reads only, and free. Nothing here can change a label, so a lost answer
 *     is simply a failed read and safe to retry.
 *   - While a tenant's labels are `observing`, the store is a copy kept current
 *     from the Data Manager about every 15 minutes, so an answer can be up to
 *     15 minutes behind a label someone just edited there. Every answer says
 *     its `state` (observing or on), and every label carries a `sync` state.
 *   - A never-seen id (the service has not read it yet), a seen item with no
 *     label set (blank) and a label that was cleared are three different things.
 *   - Errors are `{ ok:false, kind, friendly }`. `not_enabled` means the labels
 *     service is not turned on for this organization yet: a plain "not yet",
 *     not a fault.
 *
 * Same transport SHAPE as lib/shelf/client.ts (Bearer from the signed-in
 * session, one forced-refresh retry on 401, typed envelope discrimination), as
 * its own implementation: the shelf and Walmart clients' kind sets are closed
 * over their own surfaces and would collapse `not_enabled` to `unknown`.
 */

import { loadCredentials, getValidAccessToken } from '../auth/credentials.js';
import { intentHeader } from '../auth/intent.js';
import { cleanServerText, parseRouteIssues } from '../amazon/reports.js';

// ---------------------------------------------------------------------------
// Types (mirror the service's labels envelopes)
// ---------------------------------------------------------------------------

export const LABEL_ENTITIES = ['item', 'campaign'] as const;
export type LabelEntity = (typeof LABEL_ENTITIES)[number];

/** off: nothing stored yet; observing: a copy kept current from the Data Manager; on: the store is the source of truth. */
export type LabelsServiceState = 'off' | 'observing' | 'on';

export type LabelSync = 'synced' | 'pending' | 'failed';

/** The most ids one lookup call takes (the service's own limit). */
export const LOOKUP_MAX = 500;
/** The most rows a page holds (the service's own limit); the default is 50. */
export const PAGE_MAX = 200;

export interface LabelValue {
  value: string;
  sync: LabelSync;
  updated_at: string;
}

/**
 * One item or campaign as the service returns it. `unseen`: the service has
 * never read this id. `seen` with an empty `labels`: it is known and has no
 * label set (blank). A label whose value is '' is a clear that has not reached
 * the Data Manager yet (sync pending or failed); once it has, the field simply
 * drops out of `labels`.
 */
export interface LabelRow {
  id: string;
  status: 'seen' | 'unseen';
  labels: Record<string, LabelValue>;
}

export interface LabelsStateAnswer {
  ok: true;
  state: LabelsServiceState;
  backfilled_at: string | null;
  last_run: {
    mode?: string;
    status?: string;
    started_at?: string | null;
    finished_at?: string | null;
    complete?: boolean;
    duration_ms?: number | null;
    counts?: Record<string, number>;
  } | null;
  last_completed_at: string | null;
  running: boolean;
  freshness: { note?: string; typical_lag_minutes?: number };
}

export interface LabelFieldInfo {
  key: string;
  label: string;
  /** The account's own name for the field, when it set one. */
  display_name: string | null;
  legacy_column?: string;
  max_length: number;
  length_unit: 'chars' | 'bytes' | string;
  items_labeled: number;
  distinct_values: number;
  values: Array<{ value: string; count: number }>;
  /** True when the values list was cut (the service keeps the most used). */
  values_truncated: boolean;
}

export interface LabelsFieldsAnswer {
  ok: true;
  state: LabelsServiceState;
  account: number;
  merchant_type: string;
  entity: LabelEntity;
  fields: LabelFieldInfo[];
  values_limit?: { max_values?: number; max_characters?: number; order?: string };
  /** When the values in use were read (they are kept up to a minute). */
  values_as_of?: string;
  values_age_seconds?: number;
}

export interface LabelsPage {
  ok: true;
  state: LabelsServiceState;
  account: number;
  merchant_type: string;
  entity: LabelEntity;
  /** The field keys this kind of entity carries. */
  fields: string[];
  rows: LabelRow[];
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}

export interface LabelsLookupAnswer {
  ok: true;
  state: LabelsServiceState;
  account: number;
  merchant_type: string;
  entity: LabelEntity;
  fields: string[];
  results: LabelRow[];
  unseen: string[];
  /** How many calls the ids took (500 ids a call). */
  batches: number;
}

export interface DriftRow {
  entity: LabelEntity;
  id: string;
  field: string;
  /** The distinct values legacy rows hold ('' = blank). */
  legacy_values: string[];
  /** The value the Data Manager's own rule picks. */
  picked_value: string;
  /** What MixShift holds, or null when it holds no row. */
  store_value: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface LabelsDriftPage {
  ok: true;
  state: LabelsServiceState;
  account: number;
  merchant_type: string;
  rows: DriftRow[];
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}

export interface LabelChange {
  id: string;
  entity: LabelEntity;
  entity_id: string;
  field: string;
  /** null: the field had never been set. */
  before: string | null;
  /** '' (or null): the label was cleared. */
  after: string | null;
  result: string;
  source: 'service' | 'dash' | 'backfill' | 'inherit' | string;
  actor: string | null;
  time: string;
  change_set_id?: string | null;
  undoes?: string | null;
}

export interface LabelsChangesPage {
  ok: true;
  state: LabelsServiceState;
  account: number;
  merchant_type: string;
  rows: LabelChange[];
  /** Pass back as the cursor to poll for newer changes without missing or repeating any. */
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
  as_of?: string;
  settle_seconds?: number;
}

/** Kinds the service emits (labels route + read api), and local-only kinds for client-side states. */
export type LabelsFailureKind =
  // --- service-emitted ---
  | 'not_enabled' // 403: the labels service is not turned on for this organization yet
  | 'not_available' // 403 / 503: this login does not map to one database, or the lookup failed (503 is retryable)
  | 'not_found' // 404: no such account for this login
  | 'bad_params' // 400: the request was refused as sent
  | 'insufficient_scope' // 403: the credential lacks the read scopes
  | 'account_limited' // 403: this credential is limited to other accounts
  | 'internal' // 500: labels service error
  // --- local-only ---
  | 'not_authenticated'
  | 'session_expired'
  | 'host_unreachable'
  | 'unknown';

export interface LabelsFailure {
  ok: false;
  kind: LabelsFailureKind;
  /** User-facing, safe to print verbatim. */
  friendly: string;
  /** Diagnostic detail, when the service sent one. */
  message?: string;
  httpStatus?: number;
  /** Whether the SAME call can succeed later; `false` = change something first. */
  retryable?: boolean;
  /** Parameter names a bad_params answer is about. */
  invalidParams?: string[];
  /** The service sent a kind this build does not know (contract drift). */
  unrecognizedKind?: string;
}

export interface LabelsClientOptions {
  /** Forwarded to credential resolution (the --data-dir override). */
  dataDirOverride?: string;
  /** Skip credential lookup for the base URL (tests / local service). */
  apiBaseOverride?: string;
  /** Injectable for tests. Defaults to getValidAccessToken bound to dataDir. */
  tokenProvider?: (forceRefresh?: boolean) => Promise<string>;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-call network timeout. Default 30 s: every call is one indexed read. */
  timeoutMs?: number;
}

export function isLabelsFailure(x: { ok: boolean }): x is LabelsFailure {
  return x.ok === false;
}

/** Exit codes, aligned with the numbers the shelf surface uses for the same situation. */
export function exitCodeForLabelsKind(kind: LabelsFailureKind): number {
  switch (kind) {
    case 'not_authenticated':
    case 'session_expired':
      return 2; // sign in again
    case 'not_enabled':
      return 6; // labels are not turned on for this organization yet
    case 'not_found':
      return 7; // no such account for this login
    case 'insufficient_scope':
    case 'account_limited':
      return 11; // this credential may not read labels
    case 'bad_params':
      return 15; // refused as sent: change the request
    case 'not_available':
    case 'internal':
    case 'host_unreachable':
    case 'unknown':
    default:
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 30_000;

/** Whether labels are on for this organization and how fresh the copy is. No account needed. */
export async function labelsState(opts: LabelsClientOptions = {}): Promise<LabelsStateAnswer | LabelsFailure> {
  const r = await labelsRequest({ method: 'GET', path: '/api/labels/state' }, opts);
  if (!r.ok) return r;
  const j = r.json as Partial<LabelsStateAnswer>;
  if (!isState(j.state)) return unrecognizedShape(r.httpStatus, 'state');
  return {
    ok: true,
    state: j.state,
    backfilled_at: strOrNull(j.backfilled_at),
    last_run: j.last_run && typeof j.last_run === 'object' ? j.last_run : null,
    last_completed_at: strOrNull(j.last_completed_at),
    running: j.running === true,
    freshness: j.freshness && typeof j.freshness === 'object' ? j.freshness : {},
  };
}

/** The label fields of one account for items or campaigns, with the values in use and how many carry each. */
export async function labelsFields(
  input: { account: string; entity: LabelEntity },
  opts: LabelsClientOptions = {},
): Promise<LabelsFieldsAnswer | LabelsFailure> {
  const r = await labelsRequest({ method: 'GET', path: `/api/labels/fields${query({ account: input.account, entity: input.entity })}` }, opts);
  if (!r.ok) return r;
  const j = r.json as Partial<LabelsFieldsAnswer>;
  if (!isState(j.state) || !Array.isArray(j.fields)) return unrecognizedShape(r.httpStatus, 'fields');
  return { ...(j as LabelsFieldsAnswer), ok: true, entity: input.entity };
}

/** One page of the items or campaigns of an account with their labels, optionally one field = value. */
export async function labelsList(
  input: { account: string; entity: LabelEntity; field?: string; value?: string; cursor?: string; limit?: number },
  opts: LabelsClientOptions = {},
): Promise<LabelsPage | LabelsFailure> {
  const path = input.entity === 'item' ? '/api/labels/items' : '/api/labels/campaigns';
  const r = await labelsRequest(
    { method: 'GET', path: path + query({ account: input.account, field: input.field, value: input.value, cursor: input.cursor, limit: input.limit }) },
    opts,
  );
  if (!r.ok) return r;
  const j = r.json as Record<string, unknown>;
  const rows = input.entity === 'item' ? j.items : j.campaigns;
  if (!isState(j.state) || !Array.isArray(rows)) return unrecognizedShape(r.httpStatus, 'list');
  const nextCursor = strOrNull(j.next_cursor);
  return {
    ok: true,
    state: j.state,
    account: Number(j.account),
    merchant_type: String(j.merchant_type ?? ''),
    entity: input.entity,
    fields: Array.isArray(j.fields) ? j.fields.map(String) : [],
    rows: rows as LabelRow[],
    next_cursor: nextCursor,
    has_more: j.has_more === true && nextCursor !== null,
    limit: Number(j.limit ?? input.limit ?? 0),
  };
}

/**
 * The labels of the given ids, in batches of 500 (the service's limit). Ids
 * are kept in the order given, repeats dropped; a batch that fails fails the
 * whole call (a half answer would read as complete).
 */
export async function labelsLookup(
  input: { account: string; entity: LabelEntity; ids: readonly string[] },
  opts: LabelsClientOptions = {},
): Promise<LabelsLookupAnswer | LabelsFailure> {
  const ids = [...new Set(input.ids)];
  const path = input.entity === 'item' ? '/api/labels/items/lookup' : '/api/labels/campaigns/lookup';
  let first: Record<string, unknown> | undefined;
  const results: LabelRow[] = [];
  const unseen: string[] = [];
  let batches = 0;
  for (let i = 0; i < ids.length || batches === 0; i += LOOKUP_MAX) {
    const batch = ids.slice(i, i + LOOKUP_MAX);
    const r = await labelsRequest({ method: 'POST', path, body: { account: Number(input.account), ids: batch } }, opts);
    if (!r.ok) return r;
    const j = r.json as Record<string, unknown>;
    if (!isState(j.state) || !Array.isArray(j.results)) return unrecognizedShape(r.httpStatus, 'lookup');
    first ??= j;
    batches += 1;
    results.push(...(j.results as LabelRow[]));
    if (Array.isArray(j.unseen)) unseen.push(...j.unseen.map(String));
  }
  const head = first as Record<string, unknown>;
  return {
    ok: true,
    state: head.state as LabelsServiceState,
    account: Number(head.account),
    merchant_type: String(head.merchant_type ?? ''),
    entity: input.entity,
    fields: Array.isArray(head.fields) ? head.fields.map(String) : [],
    results,
    unseen,
    batches,
  };
}

/** One page of identities whose legacy rows disagree with each other on a label. */
export async function labelsDrift(
  input: { account: string; entity?: LabelEntity; cursor?: string; limit?: number },
  opts: LabelsClientOptions = {},
): Promise<LabelsDriftPage | LabelsFailure> {
  const r = await labelsRequest(
    { method: 'GET', path: `/api/labels/drift${query({ account: input.account, entity: input.entity, cursor: input.cursor, limit: input.limit })}` },
    opts,
  );
  if (!r.ok) return r;
  const j = r.json as Record<string, unknown>;
  if (!isState(j.state) || !Array.isArray(j.drift)) return unrecognizedShape(r.httpStatus, 'drift');
  const nextCursor = strOrNull(j.next_cursor);
  return {
    ok: true,
    state: j.state,
    account: Number(j.account),
    merchant_type: String(j.merchant_type ?? ''),
    rows: j.drift as DriftRow[],
    next_cursor: nextCursor,
    has_more: j.has_more === true && nextCursor !== null,
    limit: Number(j.limit ?? input.limit ?? 0),
  };
}

/**
 * One page of the change feed, oldest first. `since` (a UTC time, inclusive)
 * starts a feed; `cursor` continues one. The service refuses both together.
 * `next_cursor` is always the position to poll from next, even on the last page.
 */
export async function labelsChanges(
  input: { account: string; since?: string; cursor?: string; limit?: number },
  opts: LabelsClientOptions = {},
): Promise<LabelsChangesPage | LabelsFailure> {
  const r = await labelsRequest(
    { method: 'GET', path: `/api/labels/changes${query({ account: input.account, since: input.since, cursor: input.cursor, limit: input.limit })}` },
    opts,
  );
  if (!r.ok) return r;
  const j = r.json as Record<string, unknown>;
  if (!isState(j.state) || !Array.isArray(j.changes)) return unrecognizedShape(r.httpStatus, 'changes');
  return {
    ok: true,
    state: j.state,
    account: Number(j.account),
    merchant_type: String(j.merchant_type ?? ''),
    rows: j.changes as LabelChange[],
    next_cursor: strOrNull(j.next_cursor),
    has_more: j.has_more === true,
    limit: Number(j.limit ?? input.limit ?? 0),
    ...(typeof j.as_of === 'string' ? { as_of: j.as_of } : {}),
    ...(typeof j.settle_seconds === 'number' ? { settle_seconds: j.settle_seconds } : {}),
  };
}

/**
 * Follow `next_cursor` until the service says there is no more, the cap is
 * reached, or a page fails (the failure is returned and the pages already read
 * are discarded: paging is cheap to redo, a silently truncated "all" is not).
 * Whole pages are kept, so the cap is checked between pages and a run can pass
 * it by less than one page. `truncated` says the cap stopped it while the
 * service still had more, and `next_cursor` is then exactly where to resume.
 */
export async function collectPages<R, P extends { ok: true; rows: R[]; next_cursor: string | null; has_more: boolean }>(
  fetchPage: (cursor: string | undefined) => Promise<P | LabelsFailure>,
  opts: { cap: number; cursor?: string },
): Promise<{ ok: true; first: P; rows: R[]; pages: number; truncated: boolean; next_cursor: string | null } | LabelsFailure> {
  const rows: R[] = [];
  let first: P | undefined;
  let last: P | undefined;
  let cursor = opts.cursor;
  let pages = 0;
  const used = new Set<string>();
  for (;;) {
    if (cursor !== undefined) used.add(cursor);
    const page = await fetchPage(cursor);
    if (!page.ok) return page;
    first ??= page;
    last = page;
    pages += 1;
    rows.push(...page.rows);
    cursor = page.next_cursor ?? undefined;
    // A page that advances nothing, or a cursor already used, would loop forever.
    if (!page.has_more || cursor === undefined || page.rows.length === 0 || used.has(cursor)) break;
    if (rows.length >= opts.cap) break;
  }
  const l = last as P;
  const more = l.has_more && l.next_cursor !== null && l.rows.length > 0;
  return { ok: true, first: first as P, rows, pages, truncated: more, next_cursor: l.next_cursor };
}

// ---------------------------------------------------------------------------
// Internal request plumbing
// ---------------------------------------------------------------------------

const isState = (v: unknown): v is LabelsServiceState => v === 'off' || v === 'observing' || v === 'on';
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** A query string from the defined values only (an empty value is a value the service would refuse, so it is sent). */
function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : '';
}

function unrecognizedShape(httpStatus: number, what: string): LabelsFailure {
  return {
    ok: false,
    kind: 'unknown',
    friendly: 'MixShift answered the labels request but returned an unrecognized shape. Try again, or contact MixShift if it persists.',
    message: `labels ${what} response missing its envelope fields`,
    httpStatus,
  };
}

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}

type RequestSuccess = { ok: true; json: unknown; httpStatus: number };

async function labelsRequest(spec: RequestSpec, opts: LabelsClientOptions): Promise<RequestSuccess | LabelsFailure> {
  const resolved = await resolveBaseAndToken(opts);
  if ('ok' in resolved) return resolved;
  const { apiBase, tokenProvider } = resolved;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;

  const doFetch = async (bearer: string): Promise<{ res: Response } | { networkError: string }> => {
    try {
      const res = await fetchImpl(`${apiBase}${spec.path}`, {
        method: spec.method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(spec.body ? { 'Content-Type': 'application/json' } : {}),
          ...intentHeader(),
        },
        body: spec.body ? JSON.stringify(spec.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { res };
    } catch (err) {
      return { networkError: err instanceof Error ? err.message : String(err) };
    }
  };
  const networkFailure = (a: { networkError: string }): LabelsFailure => ({
    ok: false,
    kind: 'host_unreachable',
    friendly: defaultFriendly('host_unreachable'),
    message: a.networkError,
    retryable: true,
  });

  let token: string;
  try {
    token = await tokenProvider(false);
  } catch (err) {
    return sessionFailureFromError(err);
  }

  let attempt = await doFetch(token);
  if ('networkError' in attempt) return networkFailure(attempt);
  let res = attempt.res;

  // Mid-session 401: force a refresh and retry exactly once.
  if (res.status === 401) {
    try {
      token = await tokenProvider(true);
    } catch (err) {
      return sessionFailureFromError(err);
    }
    attempt = await doFetch(token);
    if ('networkError' in attempt) return networkFailure(attempt);
    res = attempt.res;
    if (res.status === 401) {
      return { ok: false, kind: 'session_expired', friendly: defaultFriendly('session_expired'), httpStatus: 401 };
    }
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return statusOnlyFailure(res.status);
  }
  if (isServerFailureEnvelope(json)) return toLabelsFailure(json, res.status);
  if (!res.ok) return statusOnlyFailure(res.status, safeJsonPreview(json));
  return { ok: true, json, httpStatus: res.status };
}

interface ResolvedConn {
  apiBase: string;
  tokenProvider: (forceRefresh?: boolean) => Promise<string>;
}

async function resolveBaseAndToken(opts: LabelsClientOptions): Promise<ResolvedConn | LabelsFailure> {
  let apiBase = opts.apiBaseOverride;
  if (!apiBase) {
    const { credentials } = await loadCredentials(opts.dataDirOverride);
    // datahub (user session) wins; service (machine credential) is the
    // unattended fallback, same precedence getValidAccessToken applies.
    const base = credentials?.datahub?.api_base ?? credentials?.service?.api_base;
    if (!base) {
      return { ok: false, kind: 'not_authenticated', friendly: defaultFriendly('not_authenticated') };
    }
    apiBase = base;
  }
  const tokenProvider = opts.tokenProvider ?? ((forceRefresh?: boolean) => getValidAccessToken(opts.dataDirOverride, forceRefresh));
  return { apiBase, tokenProvider };
}

// ---------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------

const KNOWN_KINDS: ReadonlySet<string> = new Set<LabelsFailureKind>([
  // Keep in step with the kinds the service's labels read API and route emit.
  'not_enabled',
  'not_available',
  'not_found',
  'bad_params',
  'insufficient_scope',
  'account_limited',
  'internal',
  'unknown',
]);

function isServerFailureEnvelope(json: unknown): json is Record<string, unknown> & { ok: false } {
  return typeof json === 'object' && json !== null && (json as { ok?: unknown }).ok === false;
}

function toLabelsFailure(json: Record<string, unknown>, httpStatus: number): LabelsFailure {
  const rawKind = typeof json.kind === 'string' ? json.kind : '';
  const recognized = KNOWN_KINDS.has(rawKind);
  const kind: LabelsFailureKind = recognized ? (rawKind as LabelsFailureKind) : kindForStatus(httpStatus);
  // A route the service does not have answers `{ kind: 'unknown', friendly: 'not_found' }`: a bare word, not a sentence.
  const sentence = typeof json.friendly === 'string' && json.friendly.includes(' ') ? cleanServerText(json.friendly) : undefined;
  const friendly = sentence ?? (httpStatus === 404 && kind === 'unknown' ? defaultFriendly('route_missing') : defaultFriendly(kind));
  const issues = parseRouteIssues(json.issues);
  const message = typeof json.message === 'string' ? cleanServerText(json.message) : issues?.detail;
  return {
    ok: false,
    kind,
    friendly,
    httpStatus,
    ...(message !== undefined ? { message } : {}),
    ...(json.retryable === true ? { retryable: true } : {}),
    ...(recognized ? {} : { unrecognizedKind: rawKind || '(absent)' }),
    ...(issues && issues.paths.length > 0 ? { invalidParams: issues.paths } : {}),
  };
}

/** Reverse-map a status only where it is unambiguous for this surface. */
function kindForStatus(httpStatus: number): LabelsFailureKind {
  if (httpStatus === 400) return 'bad_params';
  if (httpStatus === 500) return 'internal';
  return 'unknown';
}

function statusOnlyFailure(httpStatus: number, detail?: string): LabelsFailure {
  const kind = kindForStatus(httpStatus);
  return {
    ok: false,
    kind,
    friendly: defaultFriendly(kind),
    message: `Service returned HTTP ${httpStatus} without a recognized error envelope${detail ? `: ${detail}` : '.'}`,
    httpStatus,
  };
}

export function defaultFriendly(kind: LabelsFailureKind | 'route_missing'): string {
  switch (kind) {
    case 'not_enabled':
      return 'Labels are not turned on for your account yet. Your MixShift contact can turn them on.';
    case 'not_available':
      return 'Labels are not available for this login right now. Try again in a minute, or ask your MixShift contact to check how it is connected.';
    case 'not_found':
      return 'No such account for this login. Run `mixshift amazon merchants` for the account ids you can use (the legacySellerId).';
    case 'bad_params':
      return 'The labels request was refused as sent. Check the inputs and run `mixshift labels --help`.';
    case 'insufficient_scope':
      return 'This credential cannot read labels. Sign in again, or ask your org admin for a credential that can read your data.';
    case 'account_limited':
      return 'This credential is limited to other accounts, so it cannot read labels. Sign in as yourself, or ask your org admin.';
    case 'internal':
      return 'The labels service hit an error. Try again shortly.';
    case 'route_missing':
      return 'The MixShift service does not have labels yet. Update the plugin, or try again later.';
    case 'host_unreachable':
      return 'The MixShift service did not answer in time. Check your network or try again in a minute.';
    case 'not_authenticated':
      return "You're not signed in to MixShift. Run `mixshift auth login` first.";
    case 'session_expired':
      return 'Your MixShift session expired and could not be refreshed. Run `mixshift auth login` to re-authenticate.';
    default:
      return 'The labels request failed unexpectedly. Try again shortly.';
  }
}

function sessionFailureFromError(err: unknown): LabelsFailure {
  const message = err instanceof Error ? err.message : String(err);
  const expired = /expired|refresh/i.test(message);
  return {
    ok: false,
    kind: expired ? 'session_expired' : 'not_authenticated',
    friendly: defaultFriendly(expired ? 'session_expired' : 'not_authenticated'),
    message,
  };
}

function safeJsonPreview(json: unknown): string {
  try {
    const s = JSON.stringify(json);
    return s.length > 300 ? s.slice(0, 300) + '...' : s;
  } catch {
    return String(json);
  }
}
