/**
 * Stub helper — used by every command that isn't yet implemented.
 * Prints the resolved arguments so we can verify the CLI surface
 * matches HARNESS-REWRITE.md without actually running anything.
 *
 * Exit code 2 = "command exists, implementation pending" — distinct from
 * exit 1 (real error) and exit 0 (success).
 *
 * Sets `process.exitCode` instead of calling `process.exit()` so that
 * cli.ts's `finally { await maybeFlush(); }` runs before the process
 * terminates. See the exit / telemetry-flush contract at the top of
 * cli.ts.
 */

export function notYetImplemented(
  command: string,
  args: Record<string, unknown>,
): void {
  const isJson = process.argv.includes('--json');
  if (isJson) {
    process.stdout.write(
      JSON.stringify(
        {
          status: 'not_implemented',
          command,
          args,
          message: `Command "${command}" exists but is not yet implemented. See HARNESS-REWRITE.md milestones.`,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stderr.write(
      `[stub] ${command} — not yet implemented\n` +
        `       args: ${JSON.stringify(args, null, 2).replace(/\n/g, '\n              ')}\n` +
        `       see docs/productization/HARNESS-REWRITE.md\n`,
    );
  }
  process.exitCode = 2;
}
