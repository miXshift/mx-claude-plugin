/**
 * HTTP client for the /api/context surface of mx-legacy-auth.
 *
 * Mirrors the datahub request pattern from lib/data/query-runner.ts —
 * bearer from getValidAccessToken, force-refresh-once on a mid-session 401,
 * AbortSignal timeouts, network failures classified as 'host_unreachable' —
 * but supports GET and PUT (the query-runner helper is POST-only and stays
 * untouched).
 *
 * Wire contract (FROZEN; the service is built against it in parallel):
 *
 *   GET /api/context/manifest
 *     → 200 { ok:true, brands:[{ brand_slug, docs:[...] }] }
 *   GET /api/context/doc?brand=<slug>&type=<doc_type>[&name=<corpus_name>]
 *     → 200 { ok:true, doc:{...} } | 404 { ok:false, kind:'not_found', friendly }
 *   PUT /api/context/doc  { brand_slug, doc_type, corpus_name?, content,
 *                           base_revision?, sensitivity?, source_ref? }
 *     → 200 { ok:true, status:'created'|'updated'|'noop', revision }
 *     | 409 { ok:false, kind:'revision_conflict', friendly, server:{...} }
 *     | 403 { ok:false, kind:'insufficient_scope', friendly }
 *     | 400 { ok:false, kind:'bad_params'|'too_large', friendly }
 *   PUT /api/context/assignments  { op:'add'|'remove', brand_slug, role }
 *     → 200 { ok:true }   (actor defaults server-side to the caller)
 *     | 403 { ok:false, kind:'insufficient_scope', friendly }
 *     | 400 { ok:false, kind:'bad_params', friendly }
 */

import { loadCredentials, getValidAccessToken } from '../auth/credentials.js';
import { intentHeader } from '../auth/intent.js';
import type {
  ContextSyncFailure,
  ContextSyncFailureKind,
  ConflictServerDoc,
  DocType,
  FetchDocResult,
  FetchManifestResult,
  PutDocInput,
  PutDocResult,
  WireDoc,
  WireManifestBrand,
} from './types.js';

/** Text docs are ≤1MB; a comfortable request budget. */
export const TEXT_DOC_TIMEOUT_MS = 30_000;
/** Corpus docs can be up to 10MB; give the transfer real room. */
export const CORPUS_TIMEOUT_MS = 120_000;
/** Assignment mirroring is best-effort inside interactive commands — a
 *  hung host must not stall `brand key add`. Matched to the other
 *  best-effort side-channels (autosync + ads-emit both 2s): in `--json`
 *  mode the mirror is awaited before the JSON is written, so this bounds the
 *  worst-case stdout stall on a reachable-but-hanging host to ~2s, not 10s. */
export const ASSIGNMENT_TIMEOUT_MS = 2_000;

const UNREACHABLE_FRIENDLY =
  'The MixShift auth service is unreachable. Check your network ' +
  'or try again in a minute.';

class ContextSyncNetworkError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ContextSyncNetworkError';
  }
}

/** Body for PUT /api/context/assignments (the P1 person→brand assignment
 *  table; recorded, not enforced). `role: 'key'` mirrors the local
 *  key-brand list; the acting person defaults server-side to the caller. */
export interface AssignmentInput {
  op: 'add' | 'remove';
  brand_slug: string;
  role: 'key';
}

export type PutAssignmentResult = { ok: true } | ContextSyncFailure;

export interface ContextSyncClient {
  fetchManifest(): Promise<FetchManifestResult>;
  fetchDoc(
    brandSlug: string,
    docType: DocType,
    corpusName?: string,
  ): Promise<FetchDocResult>;
  putDoc(input: PutDocInput): Promise<PutDocResult>;
  putAssignment(input: AssignmentInput): Promise<PutAssignmentResult>;
}

export interface ContextSyncClientOptions {
  dataDirOverride?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Build a client bound to the stored credentials' api_base. The api_base is
 * resolved lazily per request (never hardcoded — creds may not exist yet at
 * construction, and the error message should surface at call time).
 */
export function createContextSyncClient(
  options: ContextSyncClientOptions = {},
): ContextSyncClient {
  const { dataDirOverride } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  /**
   * Perform one authed GET/PUT with force-refresh-once-on-401 semantics.
   * Throws ContextSyncNetworkError on transport failure and a plain Error
   * when no credentials exist or the session can't be refreshed.
   */
  async function authedRequest(
    method: 'GET' | 'PUT',
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
        throw new ContextSyncNetworkError(message);
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
    async fetchManifest(): Promise<FetchManifestResult> {
      try {
        const res = await authedRequest(
          'GET',
          '/api/context/manifest',
          undefined,
          TEXT_DOC_TIMEOUT_MS,
        );
        const json = await parseEnvelope(res);
        if (json.ok === true && Array.isArray(json.brands)) {
          return { ok: true, brands: json.brands as WireManifestBrand[] };
        }
        return failureFromEnvelope(json, res.status);
      } catch (err) {
        return failureFromException(err);
      }
    },

    async fetchDoc(
      brandSlug: string,
      docType: DocType,
      corpusName?: string,
    ): Promise<FetchDocResult> {
      try {
        const params = new URLSearchParams({ brand: brandSlug, type: docType });
        if (corpusName !== undefined) params.set('name', corpusName);
        const timeoutMs = docType === 'corpus' ? CORPUS_TIMEOUT_MS : TEXT_DOC_TIMEOUT_MS;
        const res = await authedRequest(
          'GET',
          `/api/context/doc?${params.toString()}`,
          undefined,
          timeoutMs,
        );
        const json = await parseEnvelope(res);
        if (json.ok === true && typeof json.doc === 'object' && json.doc !== null) {
          return { ok: true, doc: json.doc as WireDoc };
        }
        return failureFromEnvelope(json, res.status);
      } catch (err) {
        return failureFromException(err);
      }
    },

    async putDoc(input: PutDocInput): Promise<PutDocResult> {
      try {
        const timeoutMs =
          input.doc_type === 'corpus' ? CORPUS_TIMEOUT_MS : TEXT_DOC_TIMEOUT_MS;
        const res = await authedRequest('PUT', '/api/context/doc', input, timeoutMs);
        const json = await parseEnvelope(res);
        if (
          json.ok === true &&
          (json.status === 'created' || json.status === 'updated' || json.status === 'noop') &&
          typeof json.revision === 'number'
        ) {
          return { ok: true, status: json.status, revision: json.revision };
        }
        return failureFromEnvelope(json, res.status);
      } catch (err) {
        return failureFromException(err);
      }
    },

    async putAssignment(input: AssignmentInput): Promise<PutAssignmentResult> {
      try {
        const res = await authedRequest(
          'PUT',
          '/api/context/assignments',
          input,
          ASSIGNMENT_TIMEOUT_MS,
        );
        const json = await parseEnvelope(res);
        if (json.ok === true) return { ok: true };
        return failureFromEnvelope(json, res.status);
      } catch (err) {
        return failureFromException(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the service base URL from the stored credentials (datahub block
 * wins; service block covers unattended installs). Never hardcodes the URL —
 * DEFAULT_API_BASE is only baked in at sign-in time (lib/net/api-base.ts).
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
  server?: ConflictServerDoc;
  brands?: unknown;
  doc?: unknown;
  status?: string;
  revision?: unknown;
}

async function parseEnvelope(res: Response): Promise<WireEnvelope> {
  try {
    return (await res.json()) as WireEnvelope;
  } catch {
    return {};
  }
}

const KNOWN_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'not_found',
  'revision_conflict',
  'insufficient_scope',
  'bad_params',
  'too_large',
]);

function failureFromEnvelope(json: WireEnvelope, httpStatus: number): ContextSyncFailure {
  const kind: ContextSyncFailureKind =
    json.kind !== undefined && KNOWN_FAILURE_KINDS.has(json.kind)
      ? (json.kind as ContextSyncFailureKind)
      : 'unknown';
  const friendly =
    json.friendly ?? json.message ?? `Context service returned HTTP ${httpStatus}.`;
  return {
    ok: false,
    kind,
    message: json.message ?? friendly,
    friendly,
    ...(kind === 'revision_conflict' && json.server ? { server: json.server } : {}),
  };
}

function failureFromException(err: unknown): ContextSyncFailure {
  if (err instanceof ContextSyncNetworkError) {
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
