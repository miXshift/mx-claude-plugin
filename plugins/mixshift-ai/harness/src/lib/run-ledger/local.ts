/**
 * The local cache of a skill's run ledger, and its sync state.
 *
 * Cache: ~/.mixshift/clients/<brand>/runs/<folder>/ (every regular file under it, up
 * to four path segments deep). For Report Max the folder keeps the skill's OLD id,
 * `mx-monthly-report-max`, on purpose: that is where every existing ledger already is.
 *
 * Sync state: ~/.mixshift/clients/<brand>/.run-ledger-state.json, one entry per skill:
 * the revision last synced with the service, the content hash of every file at that
 * revision, and the tenant the sync ran as. It lives OUTSIDE the ledger folder so it
 * is never uploaded, and it is a dot-file in the brand dir, which context sync never
 * carries (lib/context-sync/local.ts).
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { brandDir } from '../paths/resolve.js';

/** The skills that keep a run ledger, and the local folder each one's cache lives in. */
export const SKILL_LEDGERS: Readonly<Record<string, { folder: string }>> = {
  // The folder keeps the pre-rename id: it holds every brand's existing ledger.
  'mx-max-report': { folder: 'mx-monthly-report-max' },
};

/** The MixShift service's caps, mirrored to refuse early. */
export const MAX_FILE_BYTES = 1_048_576;
export const MAX_LEDGER_BYTES = 16_777_216;
export const MAX_LEDGER_FILES = 500;

const SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** The temp name writeLedgerFile renames from; a crash can leave one behind. Never synced. */
const TEMP_FILE_RE = /\.tmp-\d+$/;
const RESERVED_SEGMENT_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * SECURITY: a ledger path crosses a trust boundary both ways (a local file name going
 * up, a server-controlled name coming down and becoming a local path on pull). Same
 * rule as the service: relative, POSIX separators, one to four segments of portable
 * characters, no '..', no segment ending in '.' (Windows drops the dot, so two names
 * would be one file), no Windows device name, no ':' (NTFS streams).
 */
export function isSafeLedgerPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 256) return false;
  if (path.includes('..')) return false;
  const segments = path.split('/');
  if (segments.length > 4) return false;
  // A sync temp name is never a ledger file, in either direction (local ignore, pull,
  // push --prune all agree because none of them ever sees one as a ledger path).
  if (TEMP_FILE_RE.test(segments[segments.length - 1]!)) return false;
  return segments.every((s) => SEGMENT_RE.test(s) && !s.endsWith('.') && !RESERVED_SEGMENT_RE.test(s));
}

/** sha256 hex (lowercase) over the utf8 bytes: the service's content_hash. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function ledgerDir(brandSlug: string, skillId: string, dataDirOverride?: string): string {
  const entry = SKILL_LEDGERS[skillId];
  if (!entry) throw new Error(`internal error: no run ledger is defined for skill ${JSON.stringify(skillId)}`);
  return join(brandDir(brandSlug, dataDirOverride), 'runs', entry.folder);
}

export function statePath(brandSlug: string, dataDirOverride?: string): string {
  return join(brandDir(brandSlug, dataDirOverride), '.run-ledger-state.json');
}

/** Where `pull --force` keeps the local copy of a file the service version replaced. */
export function conflictsDir(brandSlug: string, skillId: string, stamp: string, dataDirOverride?: string): string {
  return join(brandDir(brandSlug, dataDirOverride), 'runs', '.run-ledger-conflicts', skillId, stamp);
}

export interface LocalLedgerFile {
  content: string;
  hash: string;
  bytes: number;
}

export interface SkippedFile {
  path: string;
  reason: 'unsafe_path' | 'not_text' | 'too_large' | 'too_deep';
}

export interface LocalLedger {
  /** Did the ledger folder exist at all? */
  exists: boolean;
  files: Map<string, LocalLedgerFile>;
  /** Files the cache holds that cannot be synced, with the reason. Never silent. */
  skipped: SkippedFile[];
}

/**
 * Read every syncable file of the local ledger. Files the service would refuse (an
 * unsafe name, binary content, over the per-file cap, nested too deep) are listed in
 * `skipped`, never dropped silently.
 */
export async function readLocalLedger(dir: string): Promise<LocalLedger> {
  const files = new Map<string, LocalLedgerFile>();
  const skipped: SkippedFile[] = [];
  let exists = true;

  async function walk(abs: string, rel: string[], depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err) && depth === 0) {
        exists = false;
        return;
      }
      throw err;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relPath = [...rel, e.name].join('/');
      if (e.isDirectory()) {
        if (depth >= 3) {
          skipped.push({ path: `${relPath}/`, reason: 'too_deep' });
          continue;
        }
        await walk(join(abs, e.name), [...rel, e.name], depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (TEMP_FILE_RE.test(e.name)) continue;
      if (!isSafeLedgerPath(relPath)) {
        skipped.push({ path: relPath, reason: 'unsafe_path' });
        continue;
      }
      const buf = await readFile(join(abs, e.name));
      if (buf.length > MAX_FILE_BYTES) {
        skipped.push({ path: relPath, reason: 'too_large' });
        continue;
      }
      const content = decodeText(buf);
      if (content === null) {
        skipped.push({ path: relPath, reason: 'not_text' });
        continue;
      }
      files.set(relPath, { content, hash: hashContent(content), bytes: buf.length });
    }
  }

  await walk(dir, [], 0);
  return { exists, files, skipped };
}

/** Strict UTF-8 text with no NUL bytes, or null. Kept verbatim (a BOM survives). */
function decodeText(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * JSON files that do not parse. A corrupt ledger file is never uploaded: once on the
 * service it would be the source of truth for every later run.
 */
export function corruptJsonFiles(files: Map<string, LocalLedgerFile>): string[] {
  const out: string[] = [];
  for (const [path, f] of files) {
    if (!path.toLowerCase().endsWith('.json')) continue;
    try {
      JSON.parse(f.content.replace(/^﻿/, ''));
    } catch {
      out.push(path);
    }
  }
  return out;
}

/** Resolve a ledger path to a local path inside `dir`, refusing anything unsafe. */
export function localPathFor(dir: string, path: string): string {
  if (!isSafeLedgerPath(path)) {
    throw new Error(`unsafe run ledger path ${JSON.stringify(path)}: refusing to resolve a local path`);
  }
  const abs = join(dir, ...path.split('/'));
  if (!abs.startsWith(dir + sep)) {
    throw new Error(`run ledger path ${JSON.stringify(path)} resolves outside the ledger folder`);
  }
  return abs;
}

/** Write one file atomically (temp file + rename), creating parent folders. */
export async function writeLedgerFile(dir: string, path: string, content: string): Promise<void> {
  const abs = localPathFor(dir, path);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, abs);
}

export async function deleteLedgerFile(dir: string, path: string): Promise<void> {
  await rm(localPathFor(dir, path), { force: true });
}

export interface SkillSyncState {
  /** The service revision the cache last matched. */
  revision: number;
  /** path -> content hash at that revision. */
  files: Record<string, string>;
  /** The tenant (token `sub`) the sync ran as, when known. */
  tenant: string | null;
  synced_at: string;
}

type StateFile = Record<string, SkillSyncState>;

export async function readSyncState(
  brandSlug: string,
  skillId: string,
  dataDirOverride?: string,
): Promise<SkillSyncState | null> {
  const all = await readStateFile(brandSlug, dataDirOverride);
  const s = all[skillId];
  if (!s || typeof s.revision !== 'number' || typeof s.files !== 'object' || s.files === null) return null;
  return {
    revision: s.revision,
    files: s.files,
    tenant: typeof s.tenant === 'string' ? s.tenant : null,
    synced_at: typeof s.synced_at === 'string' ? s.synced_at : '',
  };
}

export async function writeSyncState(
  brandSlug: string,
  skillId: string,
  state: SkillSyncState,
  dataDirOverride?: string,
): Promise<void> {
  const path = statePath(brandSlug, dataDirOverride);
  const all = await readStateFile(brandSlug, dataDirOverride);
  all[skillId] = state;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(all, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

async function readStateFile(brandSlug: string, dataDirOverride?: string): Promise<StateFile> {
  try {
    const parsed = JSON.parse(await readFile(statePath(brandSlug, dataDirOverride), 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as StateFile) : {};
  } catch (err) {
    if (isNotFound(err)) return {};
    // A corrupt state file is treated as no state: the next pull compares by content
    // and refuses to overwrite anything that differs, so nothing is lost.
    return {};
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    ((err as { code: unknown }).code === 'ENOENT' || (err as { code: unknown }).code === 'ENOTDIR')
  );
}
