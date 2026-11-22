/**
 * Client for the dayparting read surface on the MixShift service (`/api/dayparting/*`):
 * when in the day an Ads profile's campaigns earn clearly less or more than their own average.
 *
 *   daypartingHours    -> GET  /api/dayparting/hours?profile_id=&from=&to=
 *   daypartingDiagnose -> POST /api/dayparting/diagnose
 *                         { profile_id, lookback_days?, objective?, excluded_dates?, campaign_ids? }
 *
 * Both are reads (scope ads:read) and compute only: nothing is written, scheduled or applied, so
 * a lost answer is a failed read and safe to retry. The service answers snake_case JSON; this
 * client returns the parsed answer untouched (`json`) so `--json` can print exactly what the
 * service said.
 *
 * Refusals arrive as `{ ok:false, kind, friendly }`. The kinds are the service's own and some come
 * from the data plane behind it (for example `source_not_enabled`), so the kind set is open here:
 * an unknown kind keeps its friendly sentence and its name instead of collapsing to "unknown".
 *
 * Same transport shape as lib/labels/client.ts (Bearer from the signed-in session, one
 * forced-refresh retry on 401).
 */

import { loadCredentials, getValidAccessToken } from '../auth/credentials.js';
import { intentHeader } from '../auth/intent.js';
import { cleanServerText } from '../amazon/reports.js';

export interface DaypartingClientOptions {
  dataDirOverride?: string;
  apiBaseOverride?: string;
  tokenProvider?: (forceRefresh?: boolean) => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DaypartingFailure {
  ok: false;
  /** The service's kind, or a local one (not_authenticated, session_expired, host_unreachable, unknown). */
  kind: string;
  /** User-facing, safe to print verbatim. */
  friendly: string;
  message?: string;
  httpStatus?: number;
  retryable?: boolean;
  /** The service's whole refusal body, printed as is by `--json`. */
  body?: Record<string, unknown>;
}

export interface DaypartingSuccess {
  ok: true;
  /** The service's answer, unchanged. */
  json: Record<string, unknown>;
}

export const isDaypartingFailure = (x: { ok: boolean }): x is DaypartingFailure => x.ok === false;

export interface DiagnoseInput {
  profileId: string;
  lookbackDays?: number;
  /** Percent, the unit of window_acos (28 = 28%). */
  objective?: { metric: 'acos' | 'tacos'; target: number };
  excludedDates?: string[];
  campaignIds?: string[];
}

export interface HoursInput {
  profileId: string;
  from: string;
  to: string;
}

// diagnose reads up to ~62 days of hourly rows in 14-day chunks, so it gets longer than a single indexed read.
const TIMEOUT_MS = 90_000;

export function daypartingHours(input: HoursInput, opts: DaypartingClientOptions = {}): Promise<DaypartingSuccess | DaypartingFailure> {
  const qs = new URLSearchParams({ profile_id: input.profileId, from: input.from, to: input.to });
  return request({ method: 'GET', path: `/api/dayparting/hours?${qs.toString()}` }, opts);
}

export function daypartingDiagnose(input: DiagnoseInput, opts: DaypartingClientOptions = {}): Promise<DaypartingSuccess | DaypartingFailure> {
  const body: Record<string, unknown> = { profile_id: input.profileId };
  if (input.lookbackDays !== undefined) body.lookback_days = input.lookbackDays;
  if (input.objective) body.objective = input.objective;
  if (input.excludedDates && input.excludedDates.length > 0) body.excluded_dates = input.excludedDates;
  if (input.campaignIds && input.campaignIds.length > 0) body.campaign_ids = input.campaignIds;
  return request({ method: 'POST', path: '/api/dayparting/diagnose', body }, opts);
}

/** Exit codes, aligned with the labels and shelf surfaces for the same situations. */
export function exitCodeForDaypartingKind(kind: string): number {
  switch (kind) {
    case 'not_authenticated':
    case 'session_expired':
      return 2; // sign in again
    case 'source_not_enabled':
    case 'account_not_in_scope':
    case 'source_not_current':
      return 6; // the hourly feed is not on, or not current, for this profile
    case 'insufficient_scope':
    case 'account_limited':
    case 'not_a_member':
      return 11; // this credential may not read this
    case 'bad_params':
      return 15; // refused as sent: change the request
    default:
      return 1;
  }
}

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}

async function request(spec: RequestSpec, opts: DaypartingClientOptions): Promise<DaypartingSuccess | DaypartingFailure> {
  let apiBase = opts.apiBaseOverride;
  if (!apiBase) {
    const { credentials } = await loadCredentials(opts.dataDirOverride);
    apiBase = credentials?.datahub?.api_base ?? credentials?.service?.api_base;
    if (!apiBase) return { ok: false, kind: 'not_authenticated', friendly: defaultFriendly('not_authenticated') };
  }
  const tokenProvider = opts.tokenProvider ?? ((force?: boolean) => getValidAccessToken(opts.dataDirOverride, force));
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
  const unreachable = (a: { networkError: string }): DaypartingFailure => ({
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
    return sessionFailure(err);
  }
  let attempt = await doFetch(token);
  if ('networkError' in attempt) return unreachable(attempt);
  let res = attempt.res;
  if (res.status === 401) {
    try {
      token = await tokenProvider(true);
    } catch (err) {
      return sessionFailure(err);
    }
    attempt = await doFetch(token);
    if ('networkError' in attempt) return unreachable(attempt);
    res = attempt.res;
    if (res.status === 401) return { ok: false, kind: 'session_expired', friendly: defaultFriendly('session_expired'), httpStatus: 401 };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return statusOnly(res.status);
  }
  const obj = typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  if (obj && obj.ok === false) return toFailure(obj, res.status);
  if (!res.ok || !obj) return statusOnly(res.status);
  return { ok: true, json: obj };
}

function toFailure(json: Record<string, unknown>, httpStatus: number): DaypartingFailure {
  const kind = typeof json.kind === 'string' && json.kind ? json.kind : httpStatus === 400 ? 'bad_params' : httpStatus === 500 ? 'internal' : 'unknown';
  const sentence = typeof json.friendly === 'string' && json.friendly.includes(' ') ? cleanServerText(json.friendly) : undefined;
  return {
    ok: false,
    kind,
    friendly: sentence ?? defaultFriendly(kind),
    httpStatus,
    ...(typeof json.message === 'string' ? { message: cleanServerText(json.message) } : {}),
    ...(json.retryable === true || httpStatus === 429 || httpStatus === 503 ? { retryable: true } : {}),
    body: json,
  };
}

function statusOnly(httpStatus: number): DaypartingFailure {
  const kind = httpStatus === 404 ? 'route_missing' : httpStatus === 400 ? 'bad_params' : httpStatus === 500 ? 'internal' : 'unknown';
  return {
    ok: false,
    kind,
    friendly: defaultFriendly(kind),
    message: `Service returned HTTP ${httpStatus} without a recognized error envelope.`,
    httpStatus,
  };
}

function sessionFailure(err: unknown): DaypartingFailure {
  const message = err instanceof Error ? err.message : String(err);
  const expired = /expired|refresh/i.test(message);
  const kind = expired ? 'session_expired' : 'not_authenticated';
  return { ok: false, kind, friendly: defaultFriendly(kind), message };
}

/** A sentence for each kind, used only when the service sent none. */
export function defaultFriendly(kind: string): string {
  switch (kind) {
    case 'not_authenticated':
      return "You're not signed in to MixShift. Run `mixshift auth login` first.";
    case 'session_expired':
      return 'Your MixShift session expired and could not be refreshed. Run `mixshift auth login` to re-authenticate.';
    case 'host_unreachable':
      return 'The MixShift service did not answer in time. Check your network or try again in a minute.';
    case 'route_missing':
      return 'The MixShift service does not have dayparting yet. Update the plugin, or try again later.';
    case 'bad_params':
      return 'The dayparting request was refused as sent. Check the inputs and run `mixshift dayparting --help`.';
    case 'insufficient_scope':
      return 'This credential cannot read Ads data. Sign in again, or ask your org admin for a credential that can.';
    case 'account_limited':
      return 'This credential is limited to other accounts, so it cannot read this Ads profile. Sign in as yourself, or ask your org admin.';
    case 'source_not_enabled':
      return 'Hourly Ads data (Amazon Marketing Stream) is not turned on for this account yet.';
    case 'account_not_in_scope':
      return 'Hourly Ads data is on for your organization but not for this Ads profile yet.';
    case 'source_not_current':
      return 'The hourly Ads data for this profile is not current, so there is nothing reliable to diagnose.';
    default:
      return 'The dayparting request failed unexpectedly. Try again shortly.';
  }
}
