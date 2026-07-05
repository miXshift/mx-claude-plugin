/**
 * Shared types for org-context sync (`mixshift context ...`).
 *
 * The server (mx-legacy-auth, /api/context/*) is the source of truth for
 * org-shared brand context docs; the local files under
 * ~/.mixshift/clients/<brand>/ are the cache the skills read. These types
 * cover both sides:
 *
 *   - LocalDoc          — one enumerated local file (see local.ts)
 *   - Wire*             — the frozen /api/context wire contract
 *   - DocVerdict        — per-doc comparison result (see engine.ts)
 *   - DocActionResult   — per-doc outcome of a pull/push/sync/migrate
 */

// ---------------------------------------------------------------------------
// Doc identity
// ---------------------------------------------------------------------------

/** Text doc types with a fixed filename in the brand dir. */
export type TextDocType = 'context' | 'narrative' | 'brain' | 'config';

/** Wire doc_type enum (frozen contract). */
export type DocType = TextDocType | 'corpus';

/**
 * Stable per-brand doc key. Text docs use their doc_type verbatim; corpus
 * docs are namespaced by filename so `corpora/tone.md` and `corpora/faq.md`
 * track independently in the state ledger.
 */
export type DocKey = TextDocType | `corpus/${string}`;

/** One local file mapped into the doc space. Content is the VERBATIM file
 *  text — never re-serialized — so the AM's YAML formatting survives sync. */
export interface LocalDoc {
  key: DocKey;
  docType: DocType;
  corpusName?: string;
  /** Absolute path of the local file. */
  path: string;
  content: string;
  /** sha256 hex (lowercase) over the utf8 content bytes. */
  hash: string;
}

// ---------------------------------------------------------------------------
// Wire contract (FROZEN — mirror of the /api/context service)
// ---------------------------------------------------------------------------

export interface WireManifestDoc {
  doc_type: DocType;
  corpus_name?: string;
  revision: number;
  content_hash: string;
  sensitivity: string;
  updated_at: string;
  updated_by_actor: string;
}

export interface WireManifestBrand {
  brand_slug: string;
  docs: WireManifestDoc[];
}

export interface WireDoc {
  brand_slug: string;
  doc_type: DocType;
  corpus_name?: string;
  revision: number;
  content_hash: string;
  content: string;
  sensitivity: string;
  source_ref?: string;
  updated_at: string;
  updated_by_actor: string;
}

export interface PutDocInput {
  brand_slug: string;
  doc_type: DocType;
  corpus_name?: string;
  content: string;
  base_revision?: number;
  sensitivity?: string;
  source_ref?: string;
}

/** The 409 envelope's `server` block — current server-side head. */
export interface ConflictServerDoc {
  revision: number;
  content: string;
  content_hash: string;
  updated_at: string;
  updated_by_actor: string;
}

// ---------------------------------------------------------------------------
// Client result envelopes (see client.ts)
// ---------------------------------------------------------------------------

export type ContextSyncFailureKind =
  | 'not_found'
  | 'revision_conflict'
  | 'insufficient_scope'
  | 'bad_params'
  | 'too_large'
  | 'host_unreachable'
  | 'unknown';

export interface ContextSyncFailure {
  ok: false;
  kind: ContextSyncFailureKind;
  /** Raw message (server `friendly` when present, else transport detail). */
  message: string;
  /** User-facing message. */
  friendly: string;
  /** kind 'revision_conflict' only: the server's current head. */
  server?: ConflictServerDoc;
}

export type FetchManifestResult =
  | { ok: true; brands: WireManifestBrand[] }
  | ContextSyncFailure;

export type FetchDocResult = { ok: true; doc: WireDoc } | ContextSyncFailure;

export type PutDocResult =
  | { ok: true; status: 'created' | 'updated' | 'noop'; revision: number }
  | ContextSyncFailure;

// ---------------------------------------------------------------------------
// Engine verdicts + action results (see engine.ts)
// ---------------------------------------------------------------------------

/**
 * Per-doc comparison verdict:
 *
 *   in-sync        — local content matches the server head (or neither moved)
 *   local-ahead    — local edited since last sync; server unchanged
 *   server-ahead   — server moved since last sync; local unchanged
 *   diverged       — both moved (or untracked and contents differ) — needs
 *                    an explicit --force pull/push to resolve
 *   local-only     — file exists locally, never seen on the server
 *   server-only    — server has the doc, no local file
 *   server-deleted — file exists locally AND the ledger proves it was on
 *                    the server, but the manifest no longer lists it:
 *                    someone deleted it org-side. push/sync SKIP it so a
 *                    deliberate deletion is never silently resurrected —
 *                    delete the local file to accept the deletion, or
 *                    `push --brand <slug> --force` to recreate it.
 */
export type DocVerdict =
  | 'in-sync'
  | 'local-ahead'
  | 'server-ahead'
  | 'diverged'
  | 'local-only'
  | 'server-only'
  | 'server-deleted';

/**
 * Per-doc outcome of one pull/push/sync/migrate action:
 *
 *   pushed      — local content updated an existing server doc
 *   pulled      — server content written to the local file
 *   created     — push created the doc server-side (first upload)
 *   noop        — server already held identical content (state adopted)
 *   up-to-date  — nothing to do (verdict was in-sync)
 *   conflict    — revision conflict / diverged; not touched (see detail)
 *   skipped     — intentionally not acted on (e.g. local edits during pull,
 *                 or invalid local doc during migrate)
 *   error       — the action failed (see detail); local file untouched
 */
export type DocActionResult =
  | 'pushed'
  | 'pulled'
  | 'created'
  | 'noop'
  | 'up-to-date'
  | 'conflict'
  | 'skipped'
  | 'error';

/** One row of a pull/push/sync/migrate report. */
export interface DocActionReport {
  key: DocKey;
  docType: DocType;
  corpusName?: string;
  action: DocActionResult;
  /** Human-readable amplification (conflict instructions, error cause, ...). */
  detail?: string;
}

/** One row of a `context status` report. */
export interface DocStatusReport {
  key: DocKey;
  docType: DocType;
  corpusName?: string;
  verdict: DocVerdict;
  /** Local file differs from the last-synced hash (false when no local file). */
  locallyModified: boolean;
  /** Server revision from the manifest; null when the doc isn't on the server. */
  serverRevision: number | null;
  /** Revision recorded at last sync; null when untracked. */
  syncedRevision: number | null;
  /** Server-side attribution (manifest), when the doc exists server-side. */
  serverUpdatedAt?: string;
  serverUpdatedBy?: string;
}
