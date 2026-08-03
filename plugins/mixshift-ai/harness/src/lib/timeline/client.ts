/**
 * HTTP client for the /api/timeline surface of mx-legacy-auth.
 *
 * Mirrors lib/context-sync/client.ts exactly — bearer from
 * getValidAccessToken, force-refresh-once on a mid-session 401, AbortSignal
 * timeouts, network failures classified as 'host_unreachable', injectable
 * fetchImpl for tests. See lib/timeline/types.ts for the frozen wire
 * contract.
 */

import { loadCredentials, getValidAccessToken } from '../auth/credentials.js';
import { intentHeader } from '../auth/intent.js';
import type {
  CorroborateEventInput,
  CorroborateEventResult,
  ListTimelineResult,
  PostTimelineEventInput,
  PostTimelineEventResult,
  TimelineFailure,
  TimelineFailureKind,
  TimelineListQuery,
  WireTimelineEvent,
} from './types.js';

/** Timeline requests are small JSON both ways; a comfortable budget. */
export const TIMELINE_TIMEOUT_MS = 30_000;

/** `--all` follows next_cursor until exhaustion, but never past this many
 *  events — the timeline is append-only and a busy org's history is
 *  unbounded. */
export const LIST_ALL_CAP = 2_000;

const UNREACHABLE_FRIENDLY =
  'The MixShift auth service is unreachable. Check your network ' +
  'or try again in a minute.';

class TimelineNetworkError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TimelineNetworkError';
  }
}

export interface TimelineClient {
  listEvents(query?: TimelineListQuery): Promise<ListTimelineResult>;
  postEvent(
    input: PostTimelineEventInput,
    opts?: { timeoutMs?: number },
  ): Promise<PostTimelineEventResult>;
  corroborateEvent(
    eventId: string,
    input: CorroborateEventInput,
    opts?: { timeoutMs?: number },
  ): Promise<CorroborateEventResult>;
}

export interface TimelineClientOptions {
  dataDirOverride?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Build a client bound to the stored credentials' api_base. The api_base is
 * resolved lazily per request (never hardcoded — creds may not exist yet at
 * construction, and the error message should surface at call time).
 */
export function createTimelineClient(
  options: TimelineClientOptions = {},
): TimelineClient {
  const { dataDirOverride } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  /**
   * Perform one authed GET/POST with force-refresh-once-on-401 semantics.
   * Throws TimelineNetworkError on transport failure and a plain Error when
   * no credentials exist or the session can't be refreshed.
   */
  async function authedRequest(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Response> {
    const apiBase = await resolveApiBase(dataDirOverride);

    const doFetch = async (bearer: string): Promise<Response> => {
      try {
        return await fetchImpl(`${apiBase}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${bearer}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...intentHeader(),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TimelineNetworkError(message);
      }
    };

    let token = await getValidAccessToken(dataDirOverride);
    let res = await doFetch(token);

    // Mid-session 401: token looked fresh client-side but the server
    // rejected it. Force-refresh and retry exactly once.
    if (res.status === 401) {
      token = await getValidAccessToken(dataDirOverride, true);
      res = await doFetch(token);
      if (res.status === 401) {
        throw new Error(
          'Your MixShift session expired and could not be refreshed. ' +
            'Run `mixshift auth login` to re-authenticate.',
        );
      }
    }
    return res;
  }

  return {
    async listEvents(query: TimelineListQuery = {}): Promise<ListTimelineResult> {
      try {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
          if (value === undefined) continue;
          params.set(key, String(value));
        }
        const qs = params.toString();
        const res = await authedRequest(
          'GET',
          `/api/timeline${qs ? `?${qs}` : ''}`,
          undefined,
          TIMELINE_TIMEOUT_MS,
        );
        const json = await parseEnvelope(res);
        if (json.ok === true && Array.isArray(json.events)) {
          return {
            ok: true,
            events: json.events as WireTimelineEvent[],
            ...(typeof json.next_cursor === 'string'
              ? { next_cursor: json.next_cursor }
              : {}),
          };
        }
        return failureFromEnvelope(json, res.status);
      } catch (err) {
        return failureFromException(err);
      }
    },

    async postEvent(
      input: PostTimelineEventInput,
      opts: { timeoutMs?: number } = {},
    ): Promise<PostTimelineEventResult> {
      try {
        const res = await authedRequest(
          'POST',
          '/api/timeline/event',
          input,
          opts.timeoutMs ?? TIMELINE_TIMEOUT_MS,
        );
        const json = await parseEnvelope(res);
        if (json.ok === true && typeof json.id === 'string') {
          return {
            ok: true,
            id: json.id,
            ...(json.duplicate === true ? { duplicate: true } : {}),
          };
        }
        return failureFromEnvelope(json, res.status);
      } catch (err) {
        return failureFromException(err);
      }
    },

    async corroborateEvent(
      eventId: string,
      input: CorroborateEventInput,
      opts: { timeoutMs?: number } = {},
    ): Promise<CorroborateEventResult> {
      try {
        const res = await authedRequest(
          'POST',
          `/api/timeline/event/${encodeURIComponent(eventId)}/corroborate`,
          input,
          opts.timeoutMs ?? TIMELINE_TIMEOUT_MS,
        );
        const json = await parseEnvelope(res);
        if (
          json.ok === true &&
          typeof json.event === 'object' &&
          json.event !== null &&
          typeof json.corroboration_id === 'string'
        ) {
          return {
            ok: true,
            event: json.event as WireTimelineEvent,
            corroboration_id: json.corroboration_id,
          };
        }
        return failureFromEnvelope(json, res.status);
      } catch (err) {
        return failureFromException(err);
      }
    },
  };
}

/**
 * Follow next_cursor until the server stops returning one, the cap is hit,
 * or a page fails (the failure is returned; already-fetched events are
 * discarded — pagination is cheap to redo, a silently truncated "all" is
 * not). Events accumulate in server order.
 */
export async function listAllEvents(
  client: TimelineClient,
  query: TimelineListQuery = {},
  cap: number = LIST_ALL_CAP,
): Promise<ListTimelineResult> {
  const events: WireTimelineEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listEvents({
      ...query,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    if (!page.ok) return page;
    events.push(...page.events);
    cursor = page.next_cursor;
    // Defensive: a page that advances nothing would loop forever.
    if (page.events.length === 0) break;
  } while (cursor !== undefined && events.length < cap);
  return { ok: true, events: events.slice(0, cap) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the service base URL from the stored credentials (datahub block
 * wins; service block covers unattended installs). Same precedence as the
 * context-sync client.
 */
async function resolveApiBase(dataDirOverride?: string): Promise<string> {
  const { credentials } = await loadCredentials(dataDirOverride);
  const apiBase = credentials?.datahub?.api_base ?? credentials?.service?.api_base;
  if (!apiBase) {
    throw new Error(
      'No credentials found. Run `mixshift auth login` to sign in, or ' +
        '`mixshift auth service-setup` to configure a service credential ' +
        'for unattended runs.',
    );
  }
  return apiBase;
}

interface WireEnvelope {
  ok?: boolean;
  kind?: string;
  friendly?: string;
  message?: string;
  events?: unknown;
  next_cursor?: unknown;
  id?: unknown;
  duplicate?: unknown;
  event?: unknown;
  corroboration_id?: unknown;
}

async function parseEnvelope(res: Response): Promise<WireEnvelope> {
  try {
    return (await res.json()) as WireEnvelope;
  } catch {
    return {};
  }
}

const KNOWN_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'bad_params',
  'too_large',
  'reserved_kind',
  'insufficient_scope',
  'not_found',
]);

function failureFromEnvelope(json: WireEnvelope, httpStatus: number): TimelineFailure {
  const kind: TimelineFailureKind =
    json.kind !== undefined && KNOWN_FAILURE_KINDS.has(json.kind)
      ? (json.kind as TimelineFailureKind)
      : 'unknown';
  const friendly =
    json.friendly ?? json.message ?? `Timeline service returned HTTP ${httpStatus}.`;
  return {
    ok: false,
    kind,
    message: json.message ?? friendly,
    friendly,
  };
}

function failureFromException(err: unknown): TimelineFailure {
  if (err instanceof TimelineNetworkError) {
    return {
      ok: false,
      kind: 'host_unreachable',
      message: err.message,
      friendly: UNREACHABLE_FRIENDLY,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, kind: 'unknown', message, friendly: message };
}
