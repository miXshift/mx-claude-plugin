/**
 * HTTP client for the gateway's skill run ledger (`/api/run-ledger`).
 *
 * The MixShift service is the single source of truth for a skill's per-brand run
 * ledger; the files under ~/.mixshift/clients/<brand>/runs/<folder>/ are a cache.
 * Run state is NOT brand context: this client never calls the brand context routes, and the
 * context sync never touches the ledger.
 *
 * Wire contract:
 *
 *   GET /api/run-ledger?brand=<slug>&skill=<skill_id>[&content=0]
 *     200 { ok, ledger: null | { brand_slug, skill_id, revision, file_count, total_bytes,
 *           created_at, updated_at, updated_by_actor, files: [{ path, content_hash,
 *           byte_size, revision, updated_at, updated_by_actor, content? }] } }
 *   PUT /api/run-ledger { brand_slug, skill_id, base_revision, files: [{ path, content | null }] }
 *     200 { ok, status: 'created' | 'updated' | 'noop', revision, changed? }
 *     409 { ok:false, kind:'revision_conflict', server: { revision, updated_at, updated_by_actor } }
 *     400 bad_params | too_large    403 insufficient_scope
 *   503 { ok:false, kind:'ledger_unavailable' }   the service has no ledger store yet
 *
 * A brand with no ledger is 200 `ledger: null`, so ANY 404 or 405 means the service
 * predates the ledger route: that reads as `unsupported`, never as "no ledger".
 */

import { loadCredentials, getValidAccessToken } from '../auth/credentials.js';
import { intentHeader } from '../auth/intent.js';
import { networkErrorMessage } from '../net/classify.js';
import { resolveApiBaseHost } from '../net/api-base.js';

/** A whole ledger is capped at 16 MB on the service; give the transfer room. */
export const LEDGER_TIMEOUT_MS = 120_000;

export interface WireLedgerFile {
  path: string;
  content_hash: string;
  byte_size: number;
  revision: number;
  updated_at: string;
  updated_by_actor: string;
  content?: string;
}

export interface WireLedger {
  brand_slug: string;
  skill_id: string;
  revision: number;
  file_count: number;
  total_bytes: number;
  created_at: string;
  updated_at: string;
  updated_by_actor: string;
  files: WireLedgerFile[];
}

export type LedgerFailureKind =
  /** The service predates the ledger route (404/405). */
  | 'unsupported'
  /** The service has the route but its store is not provisioned (503). */
  | 'unavailable'
  | 'revision_conflict'
  | 'insufficient_scope'
  | 'too_large'
  | 'bad_params'
  | 'host_unreachable'
  | 'not_signed_in'
  | 'unknown';

export interface LedgerFailure {
  ok: false;
  kind: LedgerFailureKind;
  friendly: string;
  http_status?: number;
  server?: { revision: number; updated_at: string | null; updated_by_actor: string | null };
}

export type GetLedgerResult = { ok: true; ledger: WireLedger | null; tenant: string | null } | LedgerFailure;

export interface PutLedgerBody {
  brand_slug: string;
  skill_id: string;
  base_revision: number;
  files: Array<{ path: string; content: string | null }>;
}

export type PutLedgerResult =
  | { ok: true; status: 'created' | 'updated' | 'noop'; revision: number; tenant: string | null }
  | LedgerFailure;

export interface RunLedgerClient {
  get(brandSlug: string, skillId: string): Promise<GetLedgerResult>;
  put(body: PutLedgerBody): Promise<PutLedgerResult>;
  /** The tenant of the current sign-in (token `sub`), or null when unknown. No network call. */
  tenant(): Promise<string | null>;
}

export interface RunLedgerClientOptions {
  dataDirOverride?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

class LedgerNetworkError extends Error {
  readonly friendly: string;
  constructor(message: string, friendly: string) {
    super(message);
    this.name = 'LedgerNetworkError';
    this.friendly = friendly;
  }
}

class NotSignedInError extends Error {}

/**
 * The tenant a bearer token belongs to (its `sub` claim), decoded without
 * verification. Used only to notice that a local ledger cache was synced under a
 * DIFFERENT sign-in, never for authorization (the service decides that).
 */
export function tenantFromBearer(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

export function createRunLedgerClient(options: RunLedgerClientOptions = {}): RunLedgerClient {
  const { dataDirOverride } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function authedRequest(
    method: 'GET' | 'PUT',
    path: string,
    body: unknown,
  ): Promise<{ res: Response; tenant: string | null }> {
    const { credentials } = await loadCredentials(dataDirOverride);
    const apiBase = credentials?.datahub?.api_base ?? credentials?.service?.api_base;
    if (!apiBase) {
      throw new NotSignedInError(
        'Not signed in to MixShift, so the run ledger cannot be read from the service. ' +
          'Run `mixshift auth login` (or `mixshift auth service-setup` for unattended runs).',
      );
    }
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
          signal: AbortSignal.timeout(LEDGER_TIMEOUT_MS),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new LedgerNetworkError(message, networkErrorMessage(err, resolveApiBaseHost(apiBase)));
      }
    };

    let token = await getValidAccessToken(dataDirOverride);
    let res = await doFetch(token);
    if (res.status === 401) {
      token = await getValidAccessToken(dataDirOverride, true);
      res = await doFetch(token);
      if (res.status === 401) {
        throw new NotSignedInError(
          'Your MixShift session expired and could not be refreshed. Run `mixshift auth login` to sign in again.',
        );
      }
    }
    return { res, tenant: tenantFromBearer(token) };
  }

  return {
    async tenant(): Promise<string | null> {
      try {
        return tenantFromBearer(await getValidAccessToken(dataDirOverride));
      } catch {
        return null;
      }
    },

    async get(brandSlug: string, skillId: string): Promise<GetLedgerResult> {
      try {
        const params = new URLSearchParams({ brand: brandSlug, skill: skillId });
        const { res, tenant } = await authedRequest('GET', `/api/run-ledger?${params.toString()}`, undefined);
        const json = await parseJson(res);
        if (res.ok && json.ok === true && 'ledger' in json) {
          const ledger = json.ledger;
          if (ledger === null) return { ok: true, ledger: null, tenant };
          if (isWireLedger(ledger, brandSlug, skillId)) return { ok: true, ledger, tenant };
          return failure('unknown', 'The MixShift service answered the run ledger read in a shape this plugin does not recognize.', res.status);
        }
        return failureFrom(json, res.status);
      } catch (err) {
        return failureFromException(err);
      }
    },

    async put(body: PutLedgerBody): Promise<PutLedgerResult> {
      try {
        const { res, tenant } = await authedRequest('PUT', '/api/run-ledger', body);
        const json = await parseJson(res);
        if (
          res.ok &&
          json.ok === true &&
          (json.status === 'created' || json.status === 'updated' || json.status === 'noop') &&
          typeof json.revision === 'number'
        ) {
          return { ok: true, status: json.status, revision: json.revision, tenant };
        }
        return failureFrom(json, res.status);
      } catch (err) {
        return failureFromException(err);
      }
    },
  };
}

type Json = Record<string, unknown>;

async function parseJson(res: Response): Promise<Json> {
  try {
    const parsed = (await res.json()) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

function isWireLedger(value: unknown, brandSlug: string, skillId: string): value is WireLedger {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Json;
  return (
    v.brand_slug === brandSlug &&
    v.skill_id === skillId &&
    typeof v.revision === 'number' &&
    Array.isArray(v.files) &&
    v.files.every(
      (f) =>
        f !== null &&
        typeof f === 'object' &&
        typeof (f as Json).path === 'string' &&
        typeof (f as Json).content_hash === 'string',
    )
  );
}

function failure(kind: LedgerFailureKind, friendly: string, httpStatus?: number): LedgerFailure {
  return { ok: false, kind, friendly, ...(httpStatus !== undefined ? { http_status: httpStatus } : {}) };
}

/** Map an error response. 404/405 (no route) is an older service, told apart by status alone. */
export function failureFrom(json: Json, httpStatus: number): LedgerFailure {
  const friendly = typeof json.friendly === 'string' ? json.friendly : `The run ledger service returned HTTP ${httpStatus}.`;
  if (httpStatus === 404 || httpStatus === 405) {
    return failure(
      'unsupported',
      'This MixShift service does not have the run ledger yet, so the local ledger is used.',
      httpStatus,
    );
  }
  if (httpStatus === 503 || json.kind === 'ledger_unavailable') {
    return failure('unavailable', 'The run ledger store is not available on this MixShift service yet, so the local ledger is used.', httpStatus);
  }
  if (httpStatus === 409 || json.kind === 'revision_conflict') {
    const server = (json.server ?? {}) as Json;
    return {
      ...failure('revision_conflict', friendly, httpStatus),
      server: {
        revision: typeof server.revision === 'number' ? server.revision : 0,
        updated_at: typeof server.updated_at === 'string' ? server.updated_at : null,
        updated_by_actor: typeof server.updated_by_actor === 'string' ? server.updated_by_actor : null,
      },
    };
  }
  if (json.kind === 'insufficient_scope' || httpStatus === 403) return failure('insufficient_scope', friendly, httpStatus);
  if (json.kind === 'too_large') return failure('too_large', friendly, httpStatus);
  if (json.kind === 'bad_params') return failure('bad_params', friendly, httpStatus);
  return failure('unknown', friendly, httpStatus);
}

function failureFromException(err: unknown): LedgerFailure {
  if (err instanceof LedgerNetworkError) return failure('host_unreachable', err.friendly);
  if (err instanceof NotSignedInError) return failure('not_signed_in', err.message);
  const message = err instanceof Error ? err.message : String(err);
  // getValidAccessToken throws when no usable sign-in exists.
  if (/auth login|sign in|signed in|credential/i.test(message)) return failure('not_signed_in', message);
  return failure('unknown', message);
}
