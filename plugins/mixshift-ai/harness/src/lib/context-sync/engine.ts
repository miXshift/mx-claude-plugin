/**
 * Org-context sync engine — the logic behind `mixshift context
 * status|pull|push|sync|migrate`.
 *
 * Model: the server (/api/context) is the source of truth for org-shared
 * brand context docs; the local files under ~/.mixshift/clients/<brand>/
 * are the cache the skills read. Per doc we track the last-synced server
 * revision + content hash in a per-brand ledger (state.ts) and derive a
 * verdict:
 *
 *                       server unchanged      server moved
 *   local unchanged     in-sync               server-ahead
 *   local edited        local-ahead           diverged
 *
 * plus 'local-only' / 'server-only' for one-sided docs. Untracked docs that
 * exist on both sides are 'in-sync' when content hashes match, otherwise
 * 'diverged' (we can't attribute the difference). The engine NEVER merges
 * content — diverged docs need an explicit --force pull or push.
 *
 * Every function returns structured result objects; the command layer
 * (commands/context.ts) does all formatting.
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { contextSchema, normalizeLegacyTacosFields } from '../context/schema.js';
import { createContextSyncClient, type ContextSyncClient } from './client.js';
import {
  corpusKey,
  hashContent,
  listLocalBrands,
  localPathForKey,
  readLocalDocs,
} from './local.js';
import {
  loadState,
  saveState,
  type ContextSyncDocState,
  type ContextSyncState,
} from './state.js';
import type {
  DocActionReport,
  DocKey,
  DocStatusReport,
  DocType,
  DocVerdict,
  LocalDoc,
  PutDocResult,
  WireManifestBrand,
  WireManifestDoc,
} from './types.js';

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

export type BrandStatusResult =
  | { ok: true; brand: string; docs: DocStatusReport[] }
  | { ok: false; brand: string; message: string };

export type BrandActionResult =
  | { ok: true; brand: string; reports: DocActionReport[] }
  | { ok: false; brand: string; message: string };

export interface MigrateBrandSummary {
  brand: string;
  reports: DocActionReport[];
}

export type MigrateResult =
  | { ok: true; brands: MigrateBrandSummary[] }
  | { ok: false; message: string };

export interface EngineOptions {
  dataDirOverride?: string;
  /** Injectable for tests; defaults to the real HTTP client. */
  client?: ContextSyncClient;
  /**
   * Pre-fetched manifest brands. One GET covers every brand, so the command
   * layer fetches once and reuses it across a multi-brand loop; when absent
   * the engine fetches the manifest itself.
   */
  manifest?: WireManifestBrand[];
}

// ---------------------------------------------------------------------------
// Doc pairing + verdicts
// ---------------------------------------------------------------------------

interface DocPair {
  key: DocKey;
  docType: DocType;
  corpusName?: string;
  local?: LocalDoc;
  manifestDoc?: WireManifestDoc;
  state?: ContextSyncDocState;
  verdict: DocVerdict;
}

function keyForManifestDoc(d: WireManifestDoc): DocKey | null {
  if (d.doc_type === 'corpus') {
    // A corpus manifest entry without a name is malformed — skip defensively.
    return d.corpus_name ? corpusKey(d.corpus_name) : null;
  }
  return d.doc_type;
}

function verdictFor(
  local: LocalDoc | undefined,
  manifestDoc: WireManifestDoc | undefined,
  state: ContextSyncDocState | undefined,
): DocVerdict | null {
  if (!local && !manifestDoc) return null; // absent everywhere → not reported
  if (local && !manifestDoc) return 'local-only';
  if (!local && manifestDoc) return 'server-only';
  // Both exist from here on.
  if (local!.hash === manifestDoc!.content_hash) return 'in-sync';
  if (!state) return 'diverged'; // untracked + contents differ: unattributable
  const locallyModified = local!.hash !== state.last_synced_hash;
  const serverMoved = manifestDoc!.revision !== state.server_revision;
  if (locallyModified && serverMoved) return 'diverged';
  if (locallyModified) return 'local-ahead';
  if (serverMoved) return 'server-ahead';
  // Ledger says neither side moved, yet hashes differ — inconsistent state
  // (e.g. hand-edited ledger). Fail safe: require an explicit resolution.
  return 'diverged';
}

/** Stable display order: fixed text docs first, then corpora alphabetically. */
const KEY_ORDER: Record<string, number> = { context: 0, narrative: 1, brain: 2, config: 3 };

function compareKeys(a: DocKey, b: DocKey): number {
  const ra = KEY_ORDER[a] ?? 4;
  const rb = KEY_ORDER[b] ?? 4;
  if (ra !== rb) return ra - rb;
  return a < b ? -1 : a > b ? 1 : 0;
}

type PairsResult =
  | { ok: true; pairs: DocPair[]; state: ContextSyncState }
  | { ok: false; message: string };

async function buildDocPairs(
  brandSlug: string,
  options: EngineOptions,
): Promise<PairsResult> {
  const client = options.client ?? createContextSyncClient({ dataDirOverride: options.dataDirOverride });

  let manifestBrands = options.manifest;
  if (!manifestBrands) {
    const manifest = await client.fetchManifest();
    if (!manifest.ok) return { ok: false, message: manifest.friendly };
    manifestBrands = manifest.brands;
  }
  const manifestBrand = manifestBrands.find((b) => b.brand_slug === brandSlug);

  const localDocs = await readLocalDocs(brandSlug, options.dataDirOverride);
  const state = await loadState(brandSlug, options.dataDirOverride);

  const localByKey = new Map<DocKey, LocalDoc>(localDocs.map((d) => [d.key, d]));
  const manifestByKey = new Map<DocKey, WireManifestDoc>();
  for (const d of manifestBrand?.docs ?? []) {
    const key = keyForManifestDoc(d);
    if (key !== null) manifestByKey.set(key, d);
  }

  const keys = [...new Set<DocKey>([...localByKey.keys(), ...manifestByKey.keys()])].sort(
    compareKeys,
  );

  const pairs: DocPair[] = [];
  for (const key of keys) {
    const local = localByKey.get(key);
    const manifestDoc = manifestByKey.get(key);
    const docState = state.docs[key];
    const verdict = verdictFor(local, manifestDoc, docState);
    if (verdict === null) continue;
    const docType: DocType = local?.docType ?? manifestDoc!.doc_type;
    const corpusName = local?.corpusName ?? manifestDoc?.corpus_name;
    pairs.push({
      key,
      docType,
      ...(corpusName !== undefined ? { corpusName } : {}),
      ...(local ? { local } : {}),
      ...(manifestDoc ? { manifestDoc } : {}),
      ...(docState ? { state: docState } : {}),
      verdict,
    });
  }
  return { ok: true, pairs, state };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function computeStatus(
  brandSlug: string,
  options: EngineOptions = {},
): Promise<BrandStatusResult> {
  const built = await buildDocPairs(brandSlug, options);
  if (!built.ok) return { ok: false, brand: brandSlug, message: built.message };

  const docs: DocStatusReport[] = built.pairs.map((p) => ({
    key: p.key,
    docType: p.docType,
    ...(p.corpusName !== undefined ? { corpusName: p.corpusName } : {}),
    verdict: p.verdict,
    locallyModified: Boolean(
      p.local && (!p.state || p.local.hash !== p.state.last_synced_hash),
    ),
    serverRevision: p.manifestDoc?.revision ?? null,
    syncedRevision: p.state?.server_revision ?? null,
    ...(p.manifestDoc
      ? {
          serverUpdatedAt: p.manifestDoc.updated_at,
          serverUpdatedBy: p.manifestDoc.updated_by_actor,
        }
      : {}),
  }));
  return { ok: true, brand: brandSlug, docs };
}

// ---------------------------------------------------------------------------
// Content validation (pull + migrate)
// ---------------------------------------------------------------------------

/**
 * Validate doc content before it touches the local cache (pull) or the org
 * store (migrate). context docs must be YAML AND pass the brand-context Zod
 * schema (with the legacy-tacos pre-normalization the loader applies);
 * brain/config must parse as YAML; narrative/corpus travel as-is.
 */
export function validateDocContent(
  docType: DocType,
  content: string,
): { ok: true } | { ok: false; detail: string } {
  if (docType === 'narrative' || docType === 'corpus') return { ok: true };

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `malformed YAML: ${message}` };
  }
  if (docType !== 'context') return { ok: true };

  const result = contextSchema.safeParse(normalizeLegacyTacosFields(parsed));
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('; ');
    const more = result.error.issues.length > 3 ? '; ...' : '';
    return { ok: false, detail: `schema violation: ${issues}${more}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Shared per-doc actions
// ---------------------------------------------------------------------------

/**
 * Self-heal the ledger for an in-sync doc. 'in-sync' means the local hash
 * equals the server content hash, so adopting the manifest revision + local
 * hash is exactly correct — this lets a lost/corrupt state file (which the
 * verdict matrix degrades to 'diverged' on the next edit) recover during any
 * pull/push/sync instead of forcing a --force resolution later.
 * Returns true when the ledger changed.
 */
function adoptInSyncState(pair: DocPair, state: ContextSyncState): boolean {
  if (!pair.local || !pair.manifestDoc) return false;
  const cur = state.docs[pair.key];
  if (
    cur &&
    cur.server_revision === pair.manifestDoc.revision &&
    cur.last_synced_hash === pair.local.hash
  ) {
    return false;
  }
  state.docs[pair.key] = {
    server_revision: pair.manifestDoc.revision,
    last_synced_hash: pair.local.hash,
    last_synced_at: new Date().toISOString(),
  };
  return true;
}

function conflictInstructions(brandSlug: string): string {
  return (
    `resolve with \`mixshift context pull --brand ${brandSlug} --force\` (take the ` +
    `server version) or \`mixshift context push --brand ${brandSlug} --force\` (overwrite it)`
  );
}

function reportFor(pair: DocPair, action: DocActionReport['action'], detail?: string): DocActionReport {
  return {
    key: pair.key,
    docType: pair.docType,
    ...(pair.corpusName !== undefined ? { corpusName: pair.corpusName } : {}),
    action,
    ...(detail !== undefined ? { detail } : {}),
  };
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, content, 'utf8');
  await rename(tmpPath, path);
}

/**
 * Pull one doc: fetch → validate → atomic local write → ledger entry.
 * Returns the report plus the new ledger entry (undefined when nothing
 * changed). The local file is untouched on any failure.
 */
async function pullOneDoc(
  brandSlug: string,
  pair: DocPair,
  client: ContextSyncClient,
  dataDirOverride: string | undefined,
): Promise<{ report: DocActionReport; stateEntry?: ContextSyncDocState }> {
  const fetched = await client.fetchDoc(brandSlug, pair.docType, pair.corpusName);
  if (!fetched.ok) {
    return { report: reportFor(pair, 'error', `fetch failed: ${fetched.friendly}`) };
  }
  const { doc } = fetched;

  const valid = validateDocContent(pair.docType, doc.content);
  if (!valid.ok) {
    return {
      report: reportFor(
        pair,
        'error',
        `server copy is invalid (${valid.detail}) — local file untouched`,
      ),
    };
  }

  const path = localPathForKey(brandSlug, pair.key, dataDirOverride);
  await writeFileAtomic(path, doc.content);
  return {
    report: reportFor(pair, 'pulled', `rev ${doc.revision}`),
    stateEntry: {
      server_revision: doc.revision,
      last_synced_hash: hashContent(doc.content),
      last_synced_at: new Date().toISOString(),
    },
  };
}

/**
 * Push one doc via PUT, mapping the wire result onto an action report + a
 * ledger entry. `baseRevision` undefined = unconditional create-or-conflict
 * (the local-only / migrate path). When `force` is set, a revision conflict
 * is retried exactly once against the conflict envelope's server revision.
 */
async function pushOneDoc(
  brandSlug: string,
  pair: DocPair,
  client: ContextSyncClient,
  baseRevision: number | undefined,
  force: boolean,
): Promise<{ report: DocActionReport; stateEntry?: ContextSyncDocState }> {
  const local = pair.local!;
  const put = (base: number | undefined): Promise<PutDocResult> =>
    client.putDoc({
      brand_slug: brandSlug,
      doc_type: pair.docType,
      ...(pair.corpusName !== undefined ? { corpus_name: pair.corpusName } : {}),
      content: local.content,
      ...(base !== undefined ? { base_revision: base } : {}),
    });

  let result = await put(baseRevision);
  if (!result.ok && result.kind === 'revision_conflict' && force && result.server) {
    // Forced overwrite: re-put against the server's CURRENT revision.
    result = await put(result.server.revision);
  }

  if (result.ok) {
    const stateEntry: ContextSyncDocState = {
      server_revision: result.revision,
      last_synced_hash: local.hash,
      last_synced_at: new Date().toISOString(),
    };
    if (result.status === 'created') {
      return { report: reportFor(pair, 'created', `rev ${result.revision}`), stateEntry };
    }
    if (result.status === 'updated') {
      return { report: reportFor(pair, 'pushed', `rev ${result.revision}`), stateEntry };
    }
    // noop: the server already held identical content — adopt its revision.
    return {
      report: reportFor(pair, 'noop', `server already current (rev ${result.revision})`),
      stateEntry,
    };
  }

  if (result.kind === 'revision_conflict') {
    const who = result.server
      ? `server changed by ${result.server.updated_by_actor} at ${result.server.updated_at}; `
      : '';
    return {
      report: reportFor(pair, 'conflict', `${who}${conflictInstructions(brandSlug)}`),
    };
  }
  return { report: reportFor(pair, 'error', `push failed: ${result.friendly}`) };
}

// ---------------------------------------------------------------------------
// pull / push / sync
// ---------------------------------------------------------------------------

export async function pull(
  brandSlug: string,
  options: EngineOptions & { force?: boolean } = {},
): Promise<BrandActionResult> {
  const built = await buildDocPairs(brandSlug, options);
  if (!built.ok) return { ok: false, brand: brandSlug, message: built.message };
  const client =
    options.client ?? createContextSyncClient({ dataDirOverride: options.dataDirOverride });

  const reports: DocActionReport[] = [];
  let stateChanged = false;

  for (const pair of built.pairs) {
    switch (pair.verdict) {
      case 'server-ahead':
      case 'server-only': {
        const { report, stateEntry } = await pullOneDoc(
          brandSlug,
          pair,
          client,
          options.dataDirOverride,
        );
        reports.push(report);
        if (stateEntry) {
          built.state.docs[pair.key] = stateEntry;
          stateChanged = true;
        }
        break;
      }
      case 'diverged': {
        if (options.force) {
          const { report, stateEntry } = await pullOneDoc(
            brandSlug,
            pair,
            client,
            options.dataDirOverride,
          );
          reports.push(report);
          if (stateEntry) {
            built.state.docs[pair.key] = stateEntry;
            stateChanged = true;
          }
        } else {
          reports.push(
            reportFor(pair, 'conflict', `diverged — ${conflictInstructions(brandSlug)}`),
          );
        }
        break;
      }
      case 'in-sync':
        if (adoptInSyncState(pair, built.state)) stateChanged = true;
        reports.push(reportFor(pair, 'up-to-date'));
        break;
      case 'local-ahead':
      case 'local-only':
        reports.push(
          reportFor(
            pair,
            'skipped',
            `local changes — push them with \`mixshift context push --brand ${brandSlug}\``,
          ),
        );
        break;
    }
  }

  if (stateChanged) await saveState(brandSlug, built.state, options.dataDirOverride);
  return { ok: true, brand: brandSlug, reports };
}

export async function push(
  brandSlug: string,
  options: EngineOptions & { force?: boolean } = {},
): Promise<BrandActionResult> {
  const built = await buildDocPairs(brandSlug, options);
  if (!built.ok) return { ok: false, brand: brandSlug, message: built.message };
  const client =
    options.client ?? createContextSyncClient({ dataDirOverride: options.dataDirOverride });

  const reports: DocActionReport[] = [];
  let stateChanged = false;

  for (const pair of built.pairs) {
    switch (pair.verdict) {
      case 'local-ahead':
      case 'local-only': {
        // local-ahead pushes against the last-synced revision so the server
        // can detect a concurrent move; local-only omits base_revision (the
        // server creates, or reports a conflict when someone else created
        // different content first).
        const baseRevision =
          pair.verdict === 'local-ahead' ? pair.state?.server_revision : undefined;
        const { report, stateEntry } = await pushOneDoc(
          brandSlug,
          pair,
          client,
          baseRevision,
          options.force ?? false,
        );
        reports.push(report);
        if (stateEntry) {
          built.state.docs[pair.key] = stateEntry;
          stateChanged = true;
        }
        break;
      }
      case 'diverged': {
        if (options.force) {
          const { report, stateEntry } = await pushOneDoc(
            brandSlug,
            pair,
            client,
            pair.manifestDoc?.revision,
            true,
          );
          reports.push(report);
          if (stateEntry) {
            built.state.docs[pair.key] = stateEntry;
            stateChanged = true;
          }
        } else {
          const who = pair.manifestDoc
            ? `server changed by ${pair.manifestDoc.updated_by_actor} at ${pair.manifestDoc.updated_at}; `
            : '';
          reports.push(
            reportFor(pair, 'conflict', `diverged — ${who}${conflictInstructions(brandSlug)}`),
          );
        }
        break;
      }
      case 'in-sync':
        if (adoptInSyncState(pair, built.state)) stateChanged = true;
        reports.push(reportFor(pair, 'up-to-date'));
        break;
      case 'server-ahead':
      case 'server-only':
        reports.push(
          reportFor(
            pair,
            'skipped',
            `server is ahead — fetch with \`mixshift context pull --brand ${brandSlug}\``,
          ),
        );
        break;
    }
  }

  if (stateChanged) await saveState(brandSlug, built.state, options.dataDirOverride);
  return { ok: true, brand: brandSlug, reports };
}

/**
 * Two-way, non-destructive sync: pull every non-conflicting server-side
 * change, push every non-conflicting local change, and LIST diverged docs
 * as conflicts. Never merges content.
 */
export async function sync(
  brandSlug: string,
  options: EngineOptions = {},
): Promise<BrandActionResult> {
  const built = await buildDocPairs(brandSlug, options);
  if (!built.ok) return { ok: false, brand: brandSlug, message: built.message };
  const client =
    options.client ?? createContextSyncClient({ dataDirOverride: options.dataDirOverride });

  const reports: DocActionReport[] = [];
  let stateChanged = false;

  for (const pair of built.pairs) {
    let outcome: { report: DocActionReport; stateEntry?: ContextSyncDocState } | null = null;
    switch (pair.verdict) {
      case 'server-ahead':
      case 'server-only':
        outcome = await pullOneDoc(brandSlug, pair, client, options.dataDirOverride);
        break;
      case 'local-ahead':
      case 'local-only':
        outcome = await pushOneDoc(
          brandSlug,
          pair,
          client,
          pair.verdict === 'local-ahead' ? pair.state?.server_revision : undefined,
          false,
        );
        break;
      case 'diverged':
        reports.push(
          reportFor(pair, 'conflict', `diverged — ${conflictInstructions(brandSlug)}`),
        );
        break;
      case 'in-sync':
        if (adoptInSyncState(pair, built.state)) stateChanged = true;
        reports.push(reportFor(pair, 'up-to-date'));
        break;
    }
    if (outcome) {
      reports.push(outcome.report);
      if (outcome.stateEntry) {
        built.state.docs[pair.key] = outcome.stateEntry;
        stateChanged = true;
      }
    }
  }

  if (stateChanged) await saveState(brandSlug, built.state, options.dataDirOverride);
  return { ok: true, brand: brandSlug, reports };
}

// ---------------------------------------------------------------------------
// migrate — the "first push" flow
// ---------------------------------------------------------------------------

/**
 * Seed the org store from this machine's local brand dirs. For every local
 * brand (or the given subset): validate context.yaml (an invalid context doc
 * is skipped with a message; the brand's OTHER docs still migrate), then PUT
 * every doc — untracked docs go up with no base_revision, so the server
 * creates them, dedupes identical content as 'noop', and reports differing
 * existing content as a conflict (surfaced for reconciliation, never forced).
 *
 * After a migrate, state ledgers exist and normal status/pull/push/sync
 * take over.
 */
export async function migrate(
  options: EngineOptions & { brands?: string[] } = {},
): Promise<MigrateResult> {
  const client =
    options.client ?? createContextSyncClient({ dataDirOverride: options.dataDirOverride });
  const brands = options.brands ?? (await listLocalBrands(options.dataDirOverride));

  const summaries: MigrateBrandSummary[] = [];
  for (const brandSlug of brands) {
    const localDocs = await readLocalDocs(brandSlug, options.dataDirOverride);
    const state = await loadState(brandSlug, options.dataDirOverride);
    const reports: DocActionReport[] = [];
    let stateChanged = false;

    for (const local of localDocs) {
      const pair: DocPair = {
        key: local.key,
        docType: local.docType,
        ...(local.corpusName !== undefined ? { corpusName: local.corpusName } : {}),
        local,
        verdict: 'local-only',
      };

      const valid = validateDocContent(local.docType, local.content);
      if (!valid.ok) {
        reports.push(
          reportFor(
            pair,
            'skipped',
            `local file is invalid (${valid.detail}) — fix it and re-run migrate`,
          ),
        );
        continue;
      }

      const { report, stateEntry } = await pushOneDoc(
        brandSlug,
        pair,
        client,
        state.docs[local.key]?.server_revision,
        false,
      );
      reports.push(report);
      if (stateEntry) {
        state.docs[local.key] = stateEntry;
        stateChanged = true;
      }
    }

    if (stateChanged) await saveState(brandSlug, state, options.dataDirOverride);
    summaries.push({ brand: brandSlug, reports });
  }
  return { ok: true, brands: summaries };
}
