/**
 * CLI registration drift guard — NOT a functional test of cli.ts itself.
 *
 * cli.ts has real top-level side effects (env/proxy setup, a telemetry
 * consent notice, `program.parseAsync(process.argv)`, and finally
 * `process.exit()`) by design (see its own "Exit / telemetry-flush
 * contract" header comment) — importing it in a test would run the real
 * CLI against the test runner's argv and terminate the process. So this
 * checks the SOURCE, the same mechanical-drift approach check-docs.mjs
 * uses for other doc/registration currency questions, rather than
 * exercising a live Command tree.
 *
 * Covers D-034 (slice 2, mx-ops#17): `mixshift bootstrap` was a stub
 * (`commands/bootstrap.ts`, registered but `notYetImplemented`) with zero
 * tests, zero docs outside SKILL.md, and zero real usage. Deleted — the
 * merchant-not-found flow is now a no-op + guidance (SKILL.md Phase 0.25),
 * never a shell command. This guards against either half of that deletion
 * silently coming back.
 */

import { describe, it, expect } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, 'cli.ts');
const bootstrapCommandPath = join(here, 'commands', 'bootstrap.ts');

describe('cli.ts registration — bootstrap command is gone (D-034)', () => {
  it('cli.ts source has no reference to the bootstrap command (import or registration)', async () => {
    const source = await readFile(cliPath, 'utf-8');
    expect(source).not.toMatch(/bootstrap/i);
  });

  it('commands/bootstrap.ts no longer exists on disk', async () => {
    await expect(stat(bootstrapCommandPath)).rejects.toThrow();
  });
});
