/**
 * Shared rendering for validation output. Used by both `mixshift validate`
 * and `mixshift brand validate` so the user sees identical output regardless
 * of which command they reached for.
 */

import type { ValidationResult } from '../lib/context/load.js';

export function renderValidationResult(
  brandSlug: string,
  result: ValidationResult,
  json: boolean,
): void {
  if (json) {
    if (result.ok) {
      process.stdout.write(
        JSON.stringify(
          {
            status: 'ok',
            brand_slug: brandSlug,
            path: result.path,
            schema_version: result.context.schema_version,
            account_count: result.context.accounts.length,
            last_updated: result.context.last_updated,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stdout.write(
        JSON.stringify(
          {
            status: 'error',
            brand_slug: brandSlug,
            path: result.path,
            kind: result.kind,
            errors: result.errors,
          },
          null,
          2,
        ) + '\n',
      );
    }
    return;
  }

  if (result.ok) {
    process.stderr.write(
      `\n✓ ${result.path} is valid\n` +
        `    schema version: ${result.context.schema_version}\n` +
        `    accounts: ${result.context.accounts.length}\n` +
        `    last updated: ${result.context.last_updated}\n`,
    );
    return;
  }

  const heading = (() => {
    switch (result.kind) {
      case 'file_missing':
        return `Brand "${brandSlug}" has no context file`;
      case 'malformed_yaml':
        return `${result.path} has malformed YAML`;
      case 'schema_violation':
        return `${result.path} has ${result.errors.length} schema error${
          result.errors.length === 1 ? '' : 's'
        }`;
    }
  })();

  process.stderr.write(`\n✗ ${heading}:\n`);
  for (const err of result.errors) {
    process.stderr.write(`    - ${err}\n`);
  }
}
