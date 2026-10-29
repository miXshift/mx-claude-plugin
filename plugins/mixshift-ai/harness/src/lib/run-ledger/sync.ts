/**
 * Sync a skill's run ledger between the MixShift service (the source of truth) and
 * the local cache. Three operations, all per (brand, skill):
 *
 *   pull    service -> cache. When the service has no ledger yet but the cache does
 *           (a ledger from before the service held it), uploads the cache ONCE as
 *           the service's first revision (the migration path), then proceeds.
 *   push    cache -> service, carrying only the files that changed since the last
 *           sync and the revision they were read at. A stale revision is refused.
 *   status  compare without writing anything.
 *
 * Every outcome is a named `state` the skill acts on (see SKILL.md, "The run ledger").
 * Nothing here ever clobbers: a file changed on both sides is `diverged` and left
 * alone unless the caller passes force (service wins, the local copy is kept aside).
 */

import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LedgerFailure, RunLedgerClient, WireLedger } from './client.js';
import {
  conflictsDir,
  corruptJsonFiles,
  deleteLedgerFile,
  isSafeLedgerPath,
  ledgerDir,
  localPathFor,
  MAX_LEDGER_BYTES,
  MAX_LEDGER_FILES,
  readLocalLedger,
  readSyncState,
  writeLedgerFile,
  writeSyncState,
  type LocalLedger,
  type SkippedFile,
  type SkillSyncState,
} from './local.js';

export type PullState =
  /** The service ledger is now in the cache (files written or deleted). */
  | 'pulled'
  /** The cache already matched the service. */
  | 'up_to_date'
  /**
   * The service has none but this computer does. Nothing was uploaded: the skill shows
   * the user what the local ledger holds (its hub URLs) and, on their yes, `push`
   * saves it as the first service copy. A local ledger never becomes canonical silently.
   */
  | 'local_only'
  /** Neither the service nor the cache has a ledger for this brand. */
  | 'absent'
  /** The service has no ledger route or store, or cannot be reached: the cache is all there is. */
  | 'gateway_unavailable'
  /** A file changed both locally and on the service; nothing was overwritten. */
  | 'diverged'
  /** This cache was synced before, but the service now has no ledger: refuse to guess. */
  | 'server_missing'
  /** The local ledger has a JSON file that does not parse; it was not uploaded. */
  | 'local_corrupt'
  /** The cache was synced under a different MixShift sign-in: nothing read into it or uploaded. */
  | 'other_account'
  /** Any other failure (sign-in, scope, a refused upload). */
  | 'error';

export type PushState =
  | 'pushed'
  | 'up_to_date'
  /** The service moved since the last pull. Pull, reconcile, push again. */
  | 'conflict'
  /** No sync state and the service already has a ledger: pull first. */
  | 'pull_first'
  | 'gateway_unavailable'
  | 'local_corrupt'
  | 'other_account'
  | 'error';

export interface FileChange {
  path: string;
  change: 'added' | 'updated' | 'deleted';
}

export interface SyncResult<S extends string> {
  state: S;
  brand: string;
  skill: string;
  local_dir: string;
  /** The service revision the cache now matches (null when unknown). */
  revision: number | null;
  /** What moved, in either direction. */
  changes: FileChange[];
  /** Local files kept as-is because they are newer than the service (push them). */
  local_edits: string[];
  diverged: string[];
  corrupt: string[];
  /** push only: files the last sync had that are gone locally; deleted on the service only with prune. */
  missing_locally?: string[];
  skipped: SkippedFile[];
  /** Where `--force` kept the local copies the service version replaced. */
  kept_aside?: string;
  /** Local file count after the operation. */
  local_files: number;
  failure?: { kind: LedgerFailure['kind']; message: string; http_status?: number };
  server?: { revision: number; updated_at: string | null; updated_by_actor: string | null; file_count: number };
  message: string;
}

export interface SyncOptions {
  brand: string;
  skill: string;
  client: RunLedgerClient;
  dataDirOverride?: string;
  /** pull only: a diverged file takes the service version (the local copy is kept aside). */
  force?: boolean;
  /** push only: a file deleted locally is deleted on the service too. Off by default. */
  prune?: boolean;
  /** Injectable clock for tests. */
  now?: () => Date;
}

const UNAVAILABLE: ReadonlySet<LedgerFailure['kind']> = new Set(['unsupported', 'unavailable', 'host_unreachable']);

function base<S extends string>(opts: SyncOptions, dir: string, state: S, message: string): SyncResult<S> {
  return {
    state,
    brand: opts.brand,
    skill: opts.skill,
    local_dir: dir,
    revision: null,
    changes: [],
    local_edits: [],
    diverged: [],
    corrupt: [],
    skipped: [],
    local_files: 0,
    message,
  };
}

function serverSummary(ledger: WireLedger) {
  return {
    revision: ledger.revision,
    updated_at: ledger.updated_at ?? null,
    updated_by_actor: ledger.updated_by_actor ?? null,
    file_count: ledger.files.length,
  };
}

function failureOf(f: LedgerFailure) {
  return { kind: f.kind, message: f.friendly, ...(f.http_status !== undefined ? { http_status: f.http_status } : {}) };
}

/**
 * A cache synced under a different MixShift sign-in (another tenant on this machine)
 * is never merged into, or uploaded to, the current account.
 */
function otherAccount(state: SkillSyncState | null, tenant: string | null): boolean {
  return !!(state?.tenant && tenant && state.tenant !== tenant);
}

const OTHER_ACCOUNT_MESSAGE =
  "This computer's run ledger for this brand was synced under a different MixShift sign-in. " +
  'Nothing was read into it or uploaded. Sign in to the account that owns this brand, or ask which account is right.';

export async function pullLedger(opts: SyncOptions): Promise<SyncResult<PullState>> {
  const dir = ledgerDir(opts.brand, opts.skill, opts.dataDirOverride);
  const local = await readLocalLedger(dir);
  const got = await opts.client.get(opts.brand, opts.skill);

  if (!got.ok) {
    if (UNAVAILABLE.has(got.kind)) {
      return {
        ...base(opts, dir, 'gateway_unavailable', unavailableMessage(local)),
        local_files: local.files.size,
        skipped: local.skipped,
        failure: failureOf(got),
      };
    }
    return {
      ...base(opts, dir, 'error', got.friendly),
      local_files: local.files.size,
      skipped: local.skipped,
      failure: failureOf(got),
    };
  }

  const state = await readSyncState(opts.brand, opts.skill, opts.dataDirOverride);
  if (otherAccount(state, got.tenant)) {
    return {
      ...base(opts, dir, 'other_account', OTHER_ACCOUNT_MESSAGE),
      local_files: local.files.size,
      skipped: local.skipped,
    };
  }

  if (got.ledger === null) {
    // Checked first: a cache that synced before is a sign of prior runs even when its
    // files are gone, so it must never read as a quiet `absent`.
    if (state && state.revision > 0) {
      return {
        ...base(
          opts,
          dir,
          'server_missing',
          'This computer synced the run ledger with the MixShift service before, but the service has none now. ' +
            'Nothing was uploaded. Check that you are signed in to the right MixShift account before publishing.',
        ),
        revision: 0,
        local_files: local.files.size,
        skipped: local.skipped,
      };
    }
    if (local.files.size === 0) {
      // A revision-0 sync point, so the push after this run's first publish creates the
      // service ledger (base 0) instead of asking for a pull.
      await writeSyncState(
        opts.brand,
        opts.skill,
        { revision: 0, files: {}, tenant: got.tenant, synced_at: (opts.now ?? (() => new Date()))().toISOString() },
        opts.dataDirOverride,
      );
      return {
        ...base(opts, dir, 'absent', 'No run ledger for this brand on the MixShift service or on this computer.'),
        revision: 0,
        skipped: local.skipped,
      };
    }
    const corrupt = corruptJsonFiles(local.files);
    return {
      ...base(
        opts,
        dir,
        'local_only',
        `The MixShift service has no run ledger for this brand, but this computer has one (${local.files.size} files). ` +
          'Nothing was uploaded. Confirm with the user that its hub URLs are the brand\'s, then run ' +
          '`mixshift report ledger push` to save it as the service copy.',
      ),
      revision: 0,
      corrupt,
      local_files: local.files.size,
      skipped: local.skipped,
    };
  }

  return applyServer(opts, dir, local, got.ledger, state, got.tenant);
}

function unavailableMessage(local: LocalLedger): string {
  return local.files.size > 0
    ? 'The MixShift service run ledger is not available, so the local ledger on this computer is used.'
    : 'The MixShift service run ledger is not available, and this computer has no local ledger for this brand.';
}

/**
 * The first upload: the service has no ledger, the cache does. Only `push` runs it
 * (after the user confirmed the local ledger at run start, or after this run's first
 * publish), always at base revision 0, so it can never overwrite a service ledger.
 */
async function uploadFirst(
  opts: SyncOptions,
  dir: string,
  local: LocalLedger,
  tenant: string | null,
): Promise<SyncResult<PushState>> {
  const corrupt = corruptJsonFiles(local.files);
  if (corrupt.length > 0) {
    return {
      ...base(
        opts,
        dir,
        'local_corrupt',
        'The local run ledger has JSON files that do not parse, so it was not saved to the MixShift service. ' +
          'Fix or remove them, then push again.',
      ),
      revision: 0,
      corrupt,
      local_files: local.files.size,
      skipped: local.skipped,
    };
  }
  const tooBig = overCaps(local);
  if (tooBig) {
    return { ...base(opts, dir, 'error', tooBig), revision: 0, local_files: local.files.size, skipped: local.skipped };
  }
  const files = [...local.files].map(([path, f]) => ({ path, content: f.content }));
  const put = await opts.client.put({ brand_slug: opts.brand, skill_id: opts.skill, base_revision: 0, files });
  if (!put.ok) {
    const unavailable = UNAVAILABLE.has(put.kind);
    return {
      ...base(
        opts,
        dir,
        put.kind === 'revision_conflict' ? 'conflict' : unavailable ? 'gateway_unavailable' : 'error',
        put.kind === 'revision_conflict'
          ? 'Another session saved this brand\'s run ledger to the MixShift service a moment ago. Nothing was ' +
            'overwritten. Pull again, reconcile, and push.'
          : unavailable
            ? 'The MixShift service run ledger is not available, so the ledger was saved on this computer only.'
            : put.friendly,
      ),
      revision: 0,
      local_files: local.files.size,
      skipped: local.skipped,
      failure: failureOf(put),
    };
  }
  await writeSyncState(
    opts.brand,
    opts.skill,
    {
      revision: put.revision,
      files: Object.fromEntries([...local.files].map(([p, f]) => [p, f.hash])),
      tenant: put.tenant ?? tenant,
      synced_at: (opts.now ?? (() => new Date()))().toISOString(),
    },
    opts.dataDirOverride,
  );
  return {
    ...base(
      opts,
      dir,
      'pushed',
      `Saved this run ledger to the MixShift service as its first revision (${local.files.size} files). ` +
        'From now on the service copy is the one every session reads.',
    ),
    revision: put.revision,
    changes: files.map((f) => ({ path: f.path, change: 'added' as const })),
    local_files: local.files.size,
    skipped: local.skipped,
  };
}

function overCaps(local: LocalLedger): string | null {
  let bytes = 0;
  for (const f of local.files.values()) bytes += f.bytes;
  if (bytes > MAX_LEDGER_BYTES || local.files.size > MAX_LEDGER_FILES) {
    return (
      `The local run ledger is larger than the MixShift service holds (${MAX_LEDGER_BYTES / 1_048_576} MB, ` +
      `${MAX_LEDGER_FILES} files), so it was not uploaded.`
    );
  }
  return null;
}

/** Bring the cache to the service's ledger, three-way against the last sync. */
async function applyServer(
  opts: SyncOptions,
  dir: string,
  local: LocalLedger,
  ledger: WireLedger,
  state: SkillSyncState | null,
  tenant: string | null,
): Promise<SyncResult<PullState>> {
  // SECURITY: a server-controlled name becomes a local path below. Refuse the whole
  // pull, before anything is written, if any name is unsafe.
  const unsafe = ledger.files.map((f) => f.path).filter((p) => !isSafeLedgerPath(p));
  // Two names that differ only in case are one file on a macOS or Windows cache.
  const folded = new Set(ledger.files.map((f) => f.path.toLowerCase()));
  if (unsafe.length > 0 || folded.size !== ledger.files.length) {
    return {
      ...base(
        opts,
        dir,
        'error',
        'The MixShift service sent run ledger file names this plugin will not write. Nothing was changed.',
      ),
      local_files: local.files.size,
      skipped: local.skipped,
    };
  }
  const synced = state?.files ?? {};
  const server = new Map(ledger.files.map((f) => [f.path, f]));
  const paths = new Set<string>([...server.keys(), ...local.files.keys(), ...Object.keys(synced)]);

  const writes: Array<{ path: string; content: string | null; change: FileChange['change'] }> = [];
  const localEdits: string[] = [];
  const diverged: string[] = [];
  // Local files the cache holds but cannot read as ledger text (binary, too large):
  // never overwritten unseen. One the service also has is a divergence.
  const unreadable = new Set(local.skipped.filter((k) => !k.path.endsWith('/')).map((k) => k.path));

  for (const path of [...paths].sort()) {
    const s = server.get(path);
    const l = local.files.get(path);
    if (unreadable.has(path)) {
      if (s) diverged.push(path);
      continue;
    }
    const sHash = s?.content_hash;
    const lHash = l?.hash;
    if (sHash === lHash) continue; // same on both sides (or absent on both)
    const localChanged = lHash !== synced[path];
    const serverChanged = sHash !== synced[path];
    if (!localChanged) {
      // The cache still holds what was last synced: take the service version.
      if (s && typeof s.content !== 'string') {
        return { ...base(opts, dir, 'error', 'The MixShift service sent a ledger file without its content.'), revision: null };
      }
      writes.push({ path, content: s ? (s.content as string) : null, change: !s ? 'deleted' : l ? 'updated' : 'added' });
    } else if (!serverChanged) {
      if (!l && s) {
        // Gone here, unchanged on the service. Deletes reach the service only with
        // push --prune, so a missing file is restored rather than left missing.
        if (typeof s.content !== 'string') {
          return { ...base(opts, dir, 'error', 'The MixShift service sent a ledger file without its content.'), revision: null };
        }
        writes.push({ path, content: s.content, change: 'added' });
      } else {
        localEdits.push(path); // newer here than on the service: a push will carry it
      }
    } else {
      diverged.push(path);
    }
  }

  if (diverged.length > 0 && !opts.force) {
    return {
      ...base(
        opts,
        dir,
        'diverged',
        'Some run ledger files changed both on this computer and on the MixShift service since the last sync. ' +
          'Nothing was overwritten. Compare them, then pull with --force to take the service version (your local ' +
          'copies are kept aside), or ask which one is right.',
      ),
      revision: state?.revision ?? null,
      diverged,
      local_edits: localEdits,
      local_files: local.files.size,
      skipped: local.skipped,
      server: serverSummary(ledger),
    };
  }

  let keptAside: string | undefined;
  if (diverged.length > 0) {
    const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
    keptAside = conflictsDir(opts.brand, opts.skill, stamp, opts.dataDirOverride);
    for (const path of diverged) {
      const aside = join(keptAside, ...path.split('/'));
      if (local.files.has(path) || unreadable.has(path)) {
        await mkdir(dirname(aside), { recursive: true });
        // Byte for byte, so a binary or oversized local file is kept exactly.
        await copyFile(localPathFor(dir, path), aside);
      }
      const s = server.get(path);
      if (s && typeof s.content !== 'string') {
        return { ...base(opts, dir, 'error', 'The MixShift service sent a ledger file without its content.'), revision: null };
      }
      writes.push({ path, content: s ? (s.content as string) : null, change: s ? 'updated' : 'deleted' });
    }
  }

  for (const w of writes) {
    if (w.content === null) await deleteLedgerFile(dir, w.path);
    else await writeLedgerFile(dir, w.path, w.content);
  }

  // The new sync point is the service's revision. Files kept as local edits keep their
  // OLD synced hash so the next push sees them as changed and carries them.
  const nextFiles: Record<string, string> = {};
  for (const f of ledger.files) nextFiles[f.path] = f.content_hash;
  for (const path of localEdits) {
    if (synced[path] !== undefined) nextFiles[path] = synced[path]!;
    else delete nextFiles[path];
  }
  await writeSyncState(
    opts.brand,
    opts.skill,
    {
      revision: ledger.revision,
      files: nextFiles,
      tenant,
      synced_at: (opts.now ?? (() => new Date()))().toISOString(),
    },
    opts.dataDirOverride,
  );

  const after = await readLocalLedger(dir);
  const changes = writes.map((w) => ({ path: w.path, change: w.change }));
  return {
    ...base(
      opts,
      dir,
      changes.length > 0 ? 'pulled' : 'up_to_date',
      changes.length > 0
        ? `Pulled the run ledger from the MixShift service (revision ${ledger.revision}, ${changes.length} files changed).`
        : `The local run ledger already matches the MixShift service (revision ${ledger.revision}).`,
    ),
    revision: ledger.revision,
    changes,
    local_edits: localEdits,
    local_files: after.files.size,
    skipped: after.skipped,
    server: serverSummary(ledger),
    ...(keptAside ? { kept_aside: keptAside, diverged } : {}),
  };
}

export async function pushLedger(opts: SyncOptions): Promise<SyncResult<PushState>> {
  const dir = ledgerDir(opts.brand, opts.skill, opts.dataDirOverride);
  const local = await readLocalLedger(dir);
  const prior = await readSyncState(opts.brand, opts.skill, opts.dataDirOverride);

  const corrupt = corruptJsonFiles(local.files);
  if (corrupt.length > 0) {
    return {
      ...base(
        opts,
        dir,
        'local_corrupt',
        'The local run ledger has JSON files that do not parse, so nothing was pushed. Fix them, then push again.',
      ),
      corrupt,
      local_files: local.files.size,
      skipped: local.skipped,
    };
  }
  const tooBig = overCaps(local);
  if (tooBig) return { ...base(opts, dir, 'error', tooBig), local_files: local.files.size, skipped: local.skipped };

  // No sync point (the run started while the service was unavailable, or never
  // pulled): a first upload is safe only if the service has no ledger, so ask it.
  if (!prior) return firstPush(opts, dir, local);

  if (otherAccount(prior, await opts.client.tenant())) {
    return {
      ...base(opts, dir, 'other_account', OTHER_ACCOUNT_MESSAGE),
      revision: prior.revision,
      local_files: local.files.size,
      skipped: local.skipped,
    };
  }

  const synced = prior.files;
  const files: Array<{ path: string; content: string | null }> = [];
  const missingLocally: string[] = [];
  const changes: FileChange[] = [];
  for (const [path, f] of local.files) {
    if (synced[path] === f.hash) continue;
    files.push({ path, content: f.content });
    changes.push({ path, change: synced[path] === undefined ? 'added' : 'updated' });
  }
  // A file the last sync had but this computer does not: deleted on the service only
  // when asked (prune). A half-written cache must never erase the service copy.
  for (const path of Object.keys(synced).sort()) {
    if (local.files.has(path) || local.skipped.some((s) => s.path === path)) continue;
    if (opts.prune) {
      files.push({ path, content: null });
      changes.push({ path, change: 'deleted' });
    } else {
      missingLocally.push(path);
    }
  }
  const missing = missingLocally.length > 0 ? { missing_locally: missingLocally } : {};
  if (files.length === 0) {
    return {
      ...base(opts, dir, 'up_to_date', 'Nothing to push: the local run ledger has no changes since the last sync.'),
      revision: prior.revision,
      local_files: local.files.size,
      skipped: local.skipped,
      ...missing,
    };
  }

  const put = await opts.client.put({
    brand_slug: opts.brand,
    skill_id: opts.skill,
    base_revision: prior.revision,
    files,
  });
  if (!put.ok) {
    if (put.kind === 'revision_conflict') {
      return {
        ...base(
          opts,
          dir,
          'conflict',
          'The run ledger on the MixShift service changed since this computer last pulled it' +
            (put.server?.updated_by_actor ? ` (last saved by ${put.server.updated_by_actor})` : '') +
            '. Nothing was overwritten. Pull, reconcile, and push again.',
        ),
        revision: prior.revision,
        changes,
        local_files: local.files.size,
        skipped: local.skipped,
        failure: failureOf(put),
        ...(put.server ? { server: { ...put.server, file_count: 0 } } : {}),
      };
    }
    return {
      ...base(
        opts,
        dir,
        UNAVAILABLE.has(put.kind) ? 'gateway_unavailable' : 'error',
        UNAVAILABLE.has(put.kind)
          ? 'The MixShift service run ledger is not available, so the ledger was saved on this computer only.'
          : put.friendly,
      ),
      revision: prior.revision,
      changes,
      local_files: local.files.size,
      skipped: local.skipped,
      failure: failureOf(put),
    };
  }

  const nextFiles = { ...synced };
  for (const f of files) {
    if (f.content === null) delete nextFiles[f.path];
    else nextFiles[f.path] = local.files.get(f.path)!.hash;
  }
  await writeSyncState(
    opts.brand,
    opts.skill,
    {
      revision: put.revision,
      files: nextFiles,
      tenant: put.tenant ?? prior.tenant,
      synced_at: (opts.now ?? (() => new Date()))().toISOString(),
    },
    opts.dataDirOverride,
  );
  return {
    ...base(
      opts,
      dir,
      put.status === 'noop' ? 'up_to_date' : 'pushed',
      put.status === 'noop'
        ? `The MixShift service already had these changes (revision ${put.revision}).`
        : `Pushed ${changes.length} run ledger files to the MixShift service (revision ${put.revision}).`,
    ),
    revision: put.revision,
    changes: put.status === 'noop' ? [] : changes,
    local_files: local.files.size,
    skipped: local.skipped,
    ...missing,
  };
}

/** Push with no sync point: create the service ledger, but only if it has none. */
async function firstPush(opts: SyncOptions, dir: string, local: LocalLedger): Promise<SyncResult<PushState>> {
  const got = await opts.client.get(opts.brand, opts.skill);
  if (!got.ok) {
    const unavailable = UNAVAILABLE.has(got.kind);
    return {
      ...base(
        opts,
        dir,
        unavailable ? 'gateway_unavailable' : 'error',
        unavailable
          ? 'The MixShift service run ledger is not available, so the ledger was saved on this computer only.'
          : got.friendly,
      ),
      local_files: local.files.size,
      skipped: local.skipped,
      failure: failureOf(got),
    };
  }
  if (got.ledger !== null) {
    return {
      ...base(
        opts,
        dir,
        'pull_first',
        'The MixShift service already has a run ledger for this brand that this computer has not pulled. ' +
          'Run `mixshift report ledger pull`, reconcile, then push.',
      ),
      local_files: local.files.size,
      skipped: local.skipped,
      server: serverSummary(got.ledger),
    };
  }
  if (local.files.size === 0) {
    return {
      ...base(opts, dir, 'up_to_date', 'Nothing to push: there is no run ledger on this computer.'),
      revision: 0,
      skipped: local.skipped,
    };
  }
  return uploadFirst(opts, dir, local, got.tenant);
}

export interface StatusResult {
  brand: string;
  skill: string;
  local_dir: string;
  local_files: number;
  skipped: SkippedFile[];
  synced_revision: number | null;
  /** The cache was synced under a different MixShift sign-in. */
  other_account: boolean;
  service: { available: true; revision: number | null; file_count: number } | { available: false; reason: string };
  /** Files that differ from the last sync point, locally. */
  local_edits: string[];
}

export async function ledgerStatus(opts: SyncOptions): Promise<StatusResult> {
  const dir = ledgerDir(opts.brand, opts.skill, opts.dataDirOverride);
  const local = await readLocalLedger(dir);
  const got = await opts.client.get(opts.brand, opts.skill);
  const prior = await readSyncState(opts.brand, opts.skill, opts.dataDirOverride);
  const foreign = got.ok && otherAccount(prior, got.tenant);
  const state = foreign ? null : prior;
  const synced = state?.files ?? {};
  const localEdits = [...local.files]
    .filter(([path, f]) => synced[path] !== f.hash)
    .map(([path]) => path)
    .concat(Object.keys(synced).filter((p) => !local.files.has(p)))
    .sort();
  return {
    brand: opts.brand,
    skill: opts.skill,
    local_dir: dir,
    local_files: local.files.size,
    skipped: local.skipped,
    synced_revision: state?.revision ?? null,
    other_account: foreign,
    service: got.ok
      ? { available: true, revision: got.ledger?.revision ?? null, file_count: got.ledger?.files.length ?? 0 }
      : { available: false, reason: got.friendly },
    local_edits: localEdits,
  };
}
