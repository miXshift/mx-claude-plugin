/**
 * Load and save ~/.mixshift/auth/credentials.json.
 *
 * Writes are atomic (tmp + rename) and use mode 0600 so other users on a
 * shared system can't read the credentials.
 */

import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { credentialsPath } from '../paths/resolve.js';
import { formatZodError } from '../profile/format-error.js';
import {
  credentialsSchema,
  newCredentials,
  type Credentials,
} from './schema.js';

export interface LoadResult {
  credentials: Credentials | null;
  path: string;
}

/**
 * Load credentials. Returns { credentials: null } if the file doesn't exist
 * yet (first-run state). Throws if the file is malformed.
 */
export async function loadCredentials(
  dataDirOverride?: string,
): Promise<LoadResult> {
  const path = credentialsPath(dataDirOverride);

  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isFileNotFoundError(err)) return { credentials: null, path };
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Credentials file at ${path} is malformed JSON: ${message}\n` +
        `Hint: delete the file and re-run \`mixshift auth setup\` to recreate it.`,
    );
  }

  const result = credentialsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${formatZodError(result.error, `Credentials at ${path} are invalid`)}\n` +
        `Hint: delete the file and re-run \`mixshift auth setup\` to recreate it.`,
    );
  }

  return { credentials: result.data, path };
}

/**
 * Save credentials atomically at mode 0600. Validates before write.
 */
export async function saveCredentials(
  credentials: Credentials,
  dataDirOverride?: string,
): Promise<{ path: string }> {
  const validated = credentialsSchema.parse(credentials);
  const path = credentialsPath(dataDirOverride);

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(validated, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  // Ensure mode is 0600 even when umask interferes.
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, path);

  return { path };
}

/**
 * Convenience: load existing credentials or start a fresh skeleton.
 * Use when a flow may need to merge new fields into an existing creds set.
 */
export async function loadOrInit(
  dataDirOverride?: string,
): Promise<Credentials> {
  const { credentials } = await loadCredentials(dataDirOverride);
  return credentials ?? newCredentials();
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
