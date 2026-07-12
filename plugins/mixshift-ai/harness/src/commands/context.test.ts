/**
 * Command-level tests for `mixshift context ...` option wiring.
 *
 * Two guards live in the command layer (not the engine) and are pinned here:
 *
 *   - `--force` without `--brand` is rejected before anything runs: forced
 *     resolution overwrites diverged docs wholesale, so its blast radius
 *     must be one explicitly named brand, never "every local brand".
 *   - `--brand <slug>` naming a brand that exists neither locally nor in
 *     the org manifest is an error (exit 1), not a "(no syncable docs)"
 *     no-op — a typo must not exit 0.
 *
 * The HTTP client factory is mocked (no network, no credentials); commander
 * parsing, the action handlers, and the real engine/local/state modules run
 * for real against a temp data dir. Telemetry's track() is stubbed so
 * nothing touches the data dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerContextCommands } from './context.js';
import { createContextSyncClient, type ContextSyncClient } from '../lib/context-sync/client.js';
import type { WireManifestBrand } from '../lib/context-sync/types.js';

vi.mock('../lib/context-sync/client.js', () => ({
  createContextSyncClient: vi.fn(),
}));

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return {
    ...actual, // keep EventName real
    track: vi.fn(async () => {}),
  };
});

function fakeClient(brands: WireManifestBrand[]): ContextSyncClient {
  return {
    fetchManifest: async () => ({ ok: true, brands }),
    fetchDoc: async () => ({
      ok: false,
      kind: 'not_found',
      message: 'not found',
      friendly: 'No such doc.',
    }),
    putDoc: async () => ({ ok: true, status: 'created', revision: 1 }),
    putAssignment: async () => ({ ok: true }),
  };
}

/** Mirror the cli.ts wiring the context group hangs off in production. */
function buildProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw CommanderError instead of process.exit
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'emit machine-readable JSON to stdout', false)
    .option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR');
  registerContextCommands(program);
  return program;
}

async function runContext(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', 'context', ...args]);
}

let tmpDataDir: string;
let stderrChunks: string[];
let exitCodeBefore: typeof process.exitCode;

beforeEach(async () => {
  vi.clearAllMocks();
  exitCodeBefore = process.exitCode;
  stderrChunks = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    stderrChunks.push(String(chunk));
    return true;
  });
  tmpDataDir = await mkdtemp(join(tmpdir(), 'mx-context-cmd-'));
  await mkdir(join(tmpDataDir, 'clients', 'acme'), { recursive: true });
  vi.mocked(createContextSyncClient).mockReturnValue(
    fakeClient([{ brand_slug: 'acme', docs: [] }]),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = exitCodeBefore;
  await rm(tmpDataDir, { recursive: true, force: true });
});

const stderrText = (): string => stderrChunks.join('');

// ---------------------------------------------------------------------------
// --force requires --brand (M4)
// ---------------------------------------------------------------------------

describe('--force blast radius', () => {
  it('rejects pull --force without --brand before touching the network', async () => {
    await runContext('pull', '--force', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('--force requires --brand');
    expect(createContextSyncClient).not.toHaveBeenCalled();
  });

  it('rejects push --force without --brand before touching the network', async () => {
    await runContext('push', '--force', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('--force requires --brand');
    expect(createContextSyncClient).not.toHaveBeenCalled();
  });

  it('accepts --force when --brand is given', async () => {
    await runContext('push', '--force', '--brand', 'acme', '--data-dir', tmpDataDir);

    expect(stderrText()).toBe('');
    expect(process.exitCode).toBe(exitCodeBefore ?? 0);
  });
});

// ---------------------------------------------------------------------------
// Unknown --brand is an error, not a no-op (m3)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// sync --quiet (P2 machine-friendly post-run form)
// ---------------------------------------------------------------------------

describe('sync --quiet', () => {
  let stdoutChunks: string[];

  beforeEach(() => {
    stdoutChunks = [];
    vi.mocked(process.stdout.write).mockImplementation((chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    });
  });

  it('prints nothing when nothing happened', async () => {
    await runContext('sync', '--brand', 'acme', '--quiet', '--data-dir', tmpDataDir);
    expect(stdoutChunks.join('')).toBe('');
    expect(stderrText()).toBe('');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('still prints when a doc moved (server-only pull)', async () => {
    const content = 'server narrative\n';
    const hash = (await import('../lib/context-sync/local.js')).hashContent(content);
    const client: ContextSyncClient = {
      fetchManifest: async () => ({
        ok: true,
        brands: [
          {
            brand_slug: 'acme',
            docs: [
              {
                doc_type: 'narrative',
                revision: 1,
                content_hash: hash,
                sensitivity: 'internal',
                updated_at: '2026-07-04T00:00:00.000Z',
                updated_by_actor: 'jane@example.com',
              },
            ],
          },
        ],
      }),
      fetchDoc: async () => ({
        ok: true,
        doc: {
          brand_slug: 'acme',
          doc_type: 'narrative',
          revision: 1,
          content_hash: hash,
          content,
          sensitivity: 'internal',
          updated_at: '2026-07-04T00:00:00.000Z',
          updated_by_actor: 'jane@example.com',
        },
      }),
      putDoc: async () => ({ ok: true, status: 'created', revision: 1 }),
      putAssignment: async () => ({ ok: true }),
    };
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runContext('sync', '--brand', 'acme', '--quiet', '--data-dir', tmpDataDir);
    const out = stdoutChunks.join('');
    expect(out).toContain('pulled');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('conflicts print but still exit 0 (machine flows keep going)', async () => {
    // Local file + no ledger + differing server content = diverged.
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(tmpDataDir, 'clients', 'acme', 'narrative.md'), 'local\n', 'utf8');
    const serverContent = 'server\n';
    const hash = (await import('../lib/context-sync/local.js')).hashContent(serverContent);
    const client: ContextSyncClient = {
      fetchManifest: async () => ({
        ok: true,
        brands: [
          {
            brand_slug: 'acme',
            docs: [
              {
                doc_type: 'narrative',
                revision: 3,
                content_hash: hash,
                sensitivity: 'internal',
                updated_at: '2026-07-04T00:00:00.000Z',
                updated_by_actor: 'jane@example.com',
              },
            ],
          },
        ],
      }),
      fetchDoc: async () => {
        throw new Error('diverged docs must not be fetched by sync');
      },
      putDoc: async () => {
        throw new Error('diverged docs must not be pushed by sync');
      },
      putAssignment: async () => ({ ok: true }),
    };
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runContext('sync', '--brand', 'acme', '--quiet', '--data-dir', tmpDataDir);
    expect(stdoutChunks.join('')).toContain('conflict');
    expect(process.exitCode ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// autosync command wiring
// ---------------------------------------------------------------------------

describe('autosync command', () => {
  it('is registered and reports the disabled no-op under the test runner', async () => {
    let stdout = '';
    vi.mocked(process.stdout.write).mockImplementation((chunk: unknown): boolean => {
      stdout += String(chunk);
      return true;
    });
    // maybeAutoSync's VITEST guard yields the quiet 'disabled' path here —
    // this pins the command wiring (arg parsing, JSON envelope) without
    // any network.
    await runContext('autosync', 'acme', '--json', '--data-dir', tmpDataDir);
    const parsed = JSON.parse(stdout) as { status: string; ran: boolean; reason?: string };
    expect(parsed).toEqual({ status: 'ok', ran: false, reason: 'disabled' });
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('unknown --brand', () => {
  it('errors when the slug exists neither locally nor in the manifest', async () => {
    await runContext('push', '--brand', 'tpyo', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain("brand 'tpyo' not found locally or in the org store");
  });

  it('accepts a brand that exists only locally', async () => {
    vi.mocked(createContextSyncClient).mockReturnValue(fakeClient([]));
    await runContext('status', '--brand', 'acme', '--data-dir', tmpDataDir);

    expect(stderrText()).toBe('');
    expect(process.exitCode).toBe(exitCodeBefore);
  });

  it('accepts a brand that exists only in the manifest (server-side brand)', async () => {
    vi.mocked(createContextSyncClient).mockReturnValue(
      fakeClient([{ brand_slug: 'server-brand', docs: [] }]),
    );
    await runContext('status', '--brand', 'server-brand', '--data-dir', tmpDataDir);

    expect(stderrText()).toBe('');
    expect(process.exitCode).toBe(exitCodeBefore);
  });

  it('migrate errors when the slug has no local directory', async () => {
    await runContext('migrate', '--brand', 'tpyo', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain("brand 'tpyo' has no local directory");
  });
});

// ---------------------------------------------------------------------------
// status: unshared (local-only) work gets a call-to-action + a --json count
// ---------------------------------------------------------------------------

describe('status unshared CTA', () => {
  let stdoutChunks: string[];

  beforeEach(() => {
    stdoutChunks = [];
    vi.mocked(process.stdout.write).mockImplementation((chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    });
  });

  /** A local file with no matching manifest doc + no ledger = 'local-only'
   *  (the default acme manifest has zero docs). */
  async function writeLocalOnlyDoc(): Promise<void> {
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(tmpDataDir, 'clients', 'acme', 'narrative.md'), 'local only\n', 'utf8');
  }

  it('renders the "not yet shared ... context push" CTA for a local-only doc', async () => {
    await writeLocalOnlyDoc();

    await runContext('status', '--brand', 'acme', '--data-dir', tmpDataDir);

    const out = stdoutChunks.join('');
    expect(out).toContain('1 doc(s) not yet shared with your team');
    expect(out).toContain('mixshift context push --brand acme');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('includes an unshared count alongside conflicts in --json', async () => {
    await writeLocalOnlyDoc();

    await runContext('status', '--brand', 'acme', '--json', '--data-dir', tmpDataDir);

    const parsed = JSON.parse(stdoutChunks.join('')) as { unshared: number; conflicts: number };
    expect(parsed.unshared).toBe(1);
    expect(parsed.conflicts).toBe(0);
  });

  it('no CTA and unshared:0 when nothing is local-only', async () => {
    await runContext('status', '--brand', 'acme', '--json', '--data-dir', tmpDataDir);

    const parsed = JSON.parse(stdoutChunks.join('')) as { unshared: number };
    expect(parsed.unshared).toBe(0);
  });
});
