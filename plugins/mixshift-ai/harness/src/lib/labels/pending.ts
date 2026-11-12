/**
 * The approval of a previewed label change, kept on this machine so nobody retypes a 64-character hash.
 *
 * A preview returns a change set id and an approval hash. The hash is the proof that whoever commits
 * saw THAT preview, so `mixshift labels commit <id> --commit` reads it back from here rather than
 * asking the person to copy it. A record holds the id, the hash, the account, the scope and the expiry:
 * never a label value and never an item or campaign id. It lives at
 * `<data dir>/labels/pending/<change set id>.json` (owner-only), is removed once the change set is
 * committed or cancelled, and any record past its expiry is swept the next time one is saved.
 *
 * The file is created owner-only (0600) on macOS and Linux. On Windows those mode bits do not apply, so the
 * record relies on the permissions of the user profile folder, which also holds the other MixShift files.
 *
 * A change set previewed on another machine has no record here; `commit` then asks for
 * `--approval-hash` (printed by that preview in --json) or a fresh preview.
 */

import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveDataDir } from '../paths/resolve.js';

export interface PendingApproval {
  change_set_id: string;
  approval_hash: string;
  account: number;
  kind: string;
  scope: string;
  created_at: string;
  expires_at: string;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HASH_RE = /^[0-9a-f]{64}$/i;

export const pendingDir = (dataDirOverride?: string): string => join(resolveDataDir(dataDirOverride), 'labels', 'pending');
const fileFor = (id: string, dataDirOverride?: string): string => join(pendingDir(dataDirOverride), `${id.toLowerCase()}.json`);

/** Remember a preview's approval. Returns false (never throws) when the record could not be written. */
export async function savePending(rec: PendingApproval, dataDirOverride?: string): Promise<boolean> {
  if (!UUID_RE.test(rec.change_set_id) || !HASH_RE.test(rec.approval_hash)) return false;
  try {
    const path = fileFor(rec.change_set_id, dataDirOverride);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, JSON.stringify({ ...rec, approval_hash: rec.approval_hash.toLowerCase() }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await sweepExpired(dataDirOverride);
    return true;
  } catch {
    return false;
  }
}

/** The approval recorded for a change set, or null when there is none (or it is unreadable). */
export async function loadPending(id: string, dataDirOverride?: string): Promise<PendingApproval | null> {
  if (!UUID_RE.test(id)) return null;
  try {
    const j = JSON.parse(await readFile(fileFor(id, dataDirOverride), 'utf8')) as Partial<PendingApproval>;
    if (typeof j.change_set_id !== 'string' || j.change_set_id.toLowerCase() !== id.toLowerCase()) return null;
    if (typeof j.approval_hash !== 'string' || !HASH_RE.test(j.approval_hash)) return null;
    return {
      change_set_id: j.change_set_id,
      approval_hash: j.approval_hash.toLowerCase(),
      account: Number(j.account),
      kind: String(j.kind ?? ''),
      scope: String(j.scope ?? ''),
      created_at: String(j.created_at ?? ''),
      expires_at: String(j.expires_at ?? ''),
    };
  } catch {
    return null;
  }
}

export async function removePending(id: string, dataDirOverride?: string): Promise<void> {
  if (!UUID_RE.test(id)) return;
  await rm(fileFor(id, dataDirOverride), { force: true }).catch(() => undefined);
}

/** Drop records whose preview expired more than a day ago. Best effort. */
async function sweepExpired(dataDirOverride?: string, now = Date.now()): Promise<void> {
  const dir = pendingDir(dataDirOverride);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const j = JSON.parse(await readFile(join(dir, name), 'utf8')) as { expires_at?: string };
      const at = Date.parse(String(j.expires_at ?? ''));
      if (!Number.isFinite(at) || now - at > 24 * 3600 * 1000) await rm(join(dir, name), { force: true });
    } catch {
      await rm(join(dir, name), { force: true }).catch(() => undefined);
    }
  }
}
