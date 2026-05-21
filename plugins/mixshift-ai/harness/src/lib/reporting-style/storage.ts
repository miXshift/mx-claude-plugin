/**
 * Reporting-style file read/write.
 *
 * Path: `~/.mixshift/clients/<brand-slug>/reporting-style.yaml` (optional).
 *
 * Absence is meaningful — when the file doesn't exist, MPR uses canonical
 * defaults. `readReportingStyle` returns `{ source: 'absent' }` in that
 * case so callers can branch cleanly without try/catch around ENOENT.
 *
 * Writes are atomic (temp + rename) and bump `last_updated` to today's
 * date so the freshness signal stays honest.
 */

import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { brandDir } from '../paths/resolve.js';
import { formatZodError } from '../profile/format-error.js';
import {
  reportingStyleSchema,
  type ReportingStyle,
} from './schema.js';

export interface LoadReportingStyleResult {
  style: ReportingStyle | null;
  source: 'file' | 'absent';
  path: string;
}

/**
 * Load and validate the brand's reporting-style.yaml. Returns
 * `{ source: 'absent' }` when the file doesn't exist — the canonical
 * defaults branch in MPR. Throws on malformed YAML or schema violations.
 */
export async function readReportingStyle(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<LoadReportingStyleResult> {
  const path = reportingStylePath(brandSlug, dataDirOverride);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return { style: null, source: 'absent', path };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Reporting style at ${path} is malformed YAML: ${message}\n` +
        `Hint: open the file and fix the YAML, or remove the file to fall ` +
        `back to canonical defaults.`,
    );
  }
  if (parsed === null || parsed === undefined) {
    return { style: null, source: 'absent', path };
  }

  const result = reportingStyleSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      formatZodError(
        result.error,
        `Reporting style at ${path} failed schema validation`,
      ),
    );
  }
  return { style: result.data, source: 'file', path };
}

/**
 * Write the brand's reporting-style.yaml. Bumps `last_updated` to today.
 * Caller is responsible for shape — the zod validator runs to fail-closed
 * before the file lands.
 */
export async function writeReportingStyle(
  brandSlug: string,
  style: Omit<ReportingStyle, 'last_updated'> & { last_updated?: string },
  dataDirOverride?: string,
): Promise<{ path: string }> {
  const path = reportingStylePath(brandSlug, dataDirOverride);
  const today = new Date().toISOString().slice(0, 10);
  const next: ReportingStyle = {
    ...style,
    last_updated: today,
  } as ReportingStyle;
  const validated = reportingStyleSchema.parse(next);
  await mkdir(dirname(path), { recursive: true });
  const yamlText = stringifyYaml(validated, { indent: 2, lineWidth: 0 });
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, yamlText, 'utf-8');
  try {
    await chmod(tmpPath, 0o600);
  } catch {
    // Windows tolerant.
  }
  await rename(tmpPath, path);
  return { path };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function reportingStylePath(
  brandSlug: string,
  dataDirOverride?: string,
): string {
  return join(brandDir(brandSlug, dataDirOverride), 'reporting-style.yaml');
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: string }).code === 'ENOENT'
  );
}
