import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * On Windows with Node 24, process.exit() in the ~50 ms after a fetch completes
 * aborts on a libuv assertion (UV_HANDLE_CLOSING, src/win/async.c) and the shell
 * sees exit 127 on a command that worked (mx-claude-plugin#211). The CLI flushes
 * telemetry and the session-start hook runs its version check right before they
 * end, so both end by letting the event loop drain; the only process.exit( left
 * is the unref'd backstop. CI runs Linux and cannot reproduce the abort, so this
 * guards the pattern statically.
 */
const files = {
  'src/cli.ts': fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
  'hooks/session-start.mjs': fileURLToPath(new URL('../../hooks/session-start.mjs', import.meta.url)),
};

function exitCalls(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
    .filter((l) => l.includes('process.exit('));
}

describe('entry points end without process.exit() after network I/O', () => {
  for (const [name, path] of Object.entries(files)) {
    it(`${name}: the only process.exit( is the unref'd backstop`, () => {
      const calls = exitCalls(path);
      expect(calls.length, calls.join('\n')).toBeGreaterThan(0);
      for (const line of calls) expect(line, `${name}: ${line}`).toMatch(/setTimeout\(\(\) => process\.exit\(.*\)\.unref\(\)/);
    });
  }
});
