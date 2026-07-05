/**
 * Local-side enumeration for org-context sync.
 *
 * Maps the files in ~/.mixshift/clients/<brand>/ into the doc space the
 * /api/context service speaks:
 *
 *   context.yaml      → doc_type 'context'
 *   narrative.md      → doc_type 'narrative'
 *   brand-brain.yaml  → doc_type 'brain'
 *   config.yaml       → doc_type 'config'
 *   corpora/<file>    → doc_type 'corpus' + corpus_name=<file>
 *                       (regular files directly in corpora/, any extension)
 *
 * Everything else in the brand dir is LOCAL-ONLY and never synced: dot-files
 * (.brain-status.json, .pending-discoveries.json, .context-sync-state.json),
 * the runs/ tree, and rendered HTML. Content is read VERBATIM — we never
 * re-serialize YAML, so the AM's formatting survives a round trip.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  brandDir,
  clientsDir,
  brandConfigPath,
  brainPath,
  contextPath,
  corporaDir,
  narrativePath,
} from '../paths/resolve.js';
import type { DocKey, LocalDoc, TextDocType } from './types.js';

/**
 * sha256 hex (lowercase) over the utf8 content bytes — the exact algorithm
 * the server uses for `content_hash`, so a local hash equal to a manifest
 * hash means byte-identical content.
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * List the brand slugs that have a local directory under clientsDir().
 * Directories only; a missing clients dir is just "no brands yet".
 */
export async function listLocalBrands(dataDirOverride?: string): Promise<string[]> {
  try {
    const entries = await readdir(clientsDir(dataDirOverride), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if (isFileNotFoundError(err)) return [];
    throw err;
  }
}

/** The four fixed-filename text docs, in stable display order. */
const TEXT_DOCS: Array<{
  docType: TextDocType;
  pathFor: (brandSlug: string, dataDirOverride?: string) => string;
}> = [
  { docType: 'context', pathFor: contextPath },
  { docType: 'narrative', pathFor: narrativePath },
  { docType: 'brain', pathFor: brainPath },
  { docType: 'config', pathFor: brandConfigPath },
];

/**
 * Enumerate the syncable local docs for one brand. Missing files are simply
 * absent from the result (a brand dir with only context.yaml yields one doc).
 * A missing brand dir yields an empty list — callers decide whether that's
 * an error (push) or fine (pull of a server-only brand).
 */
export async function readLocalDocs(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<LocalDoc[]> {
  const docs: LocalDoc[] = [];

  for (const { docType, pathFor } of TEXT_DOCS) {
    const path = pathFor(brandSlug, dataDirOverride);
    const content = await readFileIfPresent(path);
    if (content === null) continue;
    docs.push({ key: docType, docType, path, content, hash: hashContent(content) });
  }

  // corpora/: regular files directly in the directory, any extension.
  // Dot-files are excluded (consistent with the brand-dir rule — keeps
  // .DS_Store and editor droppings out of the org corpus).
  const dir = corporaDir(brandSlug, dataDirOverride);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isFileNotFoundError(err)) return docs;
    throw err;
  }
  const corpusNames = entries
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  for (const name of corpusNames) {
    const path = join(dir, name);
    const content = await readFile(path, 'utf8');
    docs.push({
      key: corpusKey(name),
      docType: 'corpus',
      corpusName: name,
      path,
      content,
      hash: hashContent(content),
    });
  }

  return docs;
}

/** Build the ledger key for a corpus file. */
export function corpusKey(corpusName: string): DocKey {
  return `corpus/${corpusName}`;
}

/**
 * Resolve the local file path a doc key maps to (used by pull when writing
 * a doc that doesn't exist locally yet). Verifies the brand-dir mapping in
 * one place so engine.ts can't drift from readLocalDocs.
 */
export function localPathForKey(
  brandSlug: string,
  key: DocKey,
  dataDirOverride?: string,
): string {
  switch (key) {
    case 'context':
      return contextPath(brandSlug, dataDirOverride);
    case 'narrative':
      return narrativePath(brandSlug, dataDirOverride);
    case 'brain':
      return brainPath(brandSlug, dataDirOverride);
    case 'config':
      return brandConfigPath(brandSlug, dataDirOverride);
    default: {
      const corpusName = key.slice('corpus/'.length);
      return join(corporaDir(brandSlug, dataDirOverride), corpusName);
    }
  }
}

/** True when the brand has a local directory (regardless of contents). */
export async function brandDirExists(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<boolean> {
  try {
    await readdir(brandDir(brandSlug, dataDirOverride));
    return true;
  } catch {
    return false;
  }
}

async function readFileIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (isFileNotFoundError(err)) return null;
    throw err;
  }
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    ((err as { code: unknown }).code === 'ENOENT' ||
      (err as { code: unknown }).code === 'ENOTDIR')
  );
}
