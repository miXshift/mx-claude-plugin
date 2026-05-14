/**
 * Format Zod validation errors as human-readable multi-line strings.
 *
 * Zod's default `.message` dumps the issues array as JSON, which is
 * unhelpful when surfaced to users (or to Claude reading the error in
 * a skill execution). This helper produces the same shape we use in
 * loadProfile's validation path.
 */

import type { z } from 'zod';

export function formatZodError(error: z.ZodError, prefix = 'Validation failed'): string {
  const issueSummary = error.issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join('.') : '(root)';
      return `  - ${path}: ${i.message}`;
    })
    .join('\n');
  return `${prefix}:\n${issueSummary}`;
}
