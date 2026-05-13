/**
 * Save ~/.mixshift/profile.yaml atomically. Validates before writing so we
 * never persist a broken profile.
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { profilePath } from '../paths/resolve.js';
import { profileSchema, type Profile } from './schema.js';

/**
 * Write the profile to disk. Validates first; if invalid, throws and does
 * not touch the existing file. Write is atomic — content lands at a tmp
 * path then renames over the target (POSIX + Windows both support atomic
 * rename within the same directory).
 */
export async function saveProfile(
  profile: Profile,
  dataDirOverride?: string,
): Promise<{ path: string }> {
  const validated = profileSchema.parse(profile);
  const path = profilePath(dataDirOverride);

  await mkdir(dirname(path), { recursive: true });

  const yaml = stringifyYaml(validated, {
    lineWidth: 0, // don't wrap long strings
    indent: 2,
    aliasDuplicateObjects: false,
  });

  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, yaml, { encoding: 'utf-8', mode: 0o600 });
  await rename(tmpPath, path);

  return { path };
}
