/**
 * Load ~/.mixshift/profile.yaml. Returns defaults if the file doesn't exist
 * (first-run friendly), parses + validates if it does.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { profilePath } from '../paths/resolve.js';
import {
  defaultProfile,
  profileSchema,
  type Profile,
} from './schema.js';
import { formatZodError } from './format-error.js';

export interface LoadResult {
  profile: Profile;
  source: 'file' | 'default';
  path: string;
}

/**
 * Load the profile. Validates against the schema. If the file is missing,
 * returns defaults with `source: 'default'`. If the file is present but
 * malformed, throws — never silently overwrites a broken file.
 */
export async function loadProfile(dataDirOverride?: string): Promise<LoadResult> {
  const path = profilePath(dataDirOverride);

  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return { profile: defaultProfile(), source: 'default', path };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Profile YAML at ${path} is malformed: ${message}\n` +
        `Hint: open the file in an editor, fix the syntax, or delete it to reset to defaults.`,
    );
  }

  const result = profileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${formatZodError(result.error, `Profile at ${path} failed schema validation`)}\n` +
        `Hint: fix the offending fields, or delete the file to reset to defaults.`,
    );
  }

  return { profile: result.data, source: 'file', path };
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
