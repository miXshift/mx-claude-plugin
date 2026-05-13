/**
 * Load and validate a brand context.yaml from
 * ~/.mixshift/clients/<brand-slug>/context.yaml.
 *
 * Returns the parsed + Zod-validated object on success. Throws with a
 * human-readable summary on schema violation or malformed YAML.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { contextPath } from '../paths/resolve.js';
import { formatZodError } from '../profile/format-error.js';
import { contextSchema, type BrandContext } from './schema.js';

export interface LoadResult {
  context: BrandContext;
  path: string;
}

export interface ValidationFailure {
  ok: false;
  path: string;
  errors: string[];
  kind: 'file_missing' | 'malformed_yaml' | 'schema_violation';
}

export interface ValidationSuccess {
  ok: true;
  path: string;
  context: BrandContext;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

/**
 * Load + validate. Returns a structured result so callers can render rich
 * error output rather than just catching exceptions.
 */
export async function validateBrandContext(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<ValidationResult> {
  const path = contextPath(brandSlug, dataDirOverride);

  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return {
        ok: false,
        path,
        kind: 'file_missing',
        errors: [
          `No brand context found at ${path}.`,
          `Run \`mixshift brand add ${brandSlug}\` to onboard this brand.`,
        ],
      };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      path,
      kind: 'malformed_yaml',
      errors: [`Malformed YAML: ${message}`],
    };
  }

  const result = contextSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues.map((i) => {
      const p = i.path.length > 0 ? i.path.join('.') : '(root)';
      return `${p}: ${i.message}`;
    });
    return {
      ok: false,
      path,
      kind: 'schema_violation',
      errors,
    };
  }

  return { ok: true, path, context: result.data };
}

/**
 * Convenience wrapper that throws on failure. Use this from skill code
 * where you want the exception to propagate; use validateBrandContext
 * directly when you want to render errors yourself.
 */
export async function loadBrandContext(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<LoadResult> {
  const result = await validateBrandContext(brandSlug, dataDirOverride);
  if (!result.ok) {
    throw new Error(
      `Brand context for "${brandSlug}" failed validation (${result.kind}):\n` +
        result.errors.map((e) => `  - ${e}`).join('\n'),
    );
  }
  return { context: result.context, path: result.path };
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

// Re-export for command modules that want to expose ZodError formatting
export { formatZodError };
