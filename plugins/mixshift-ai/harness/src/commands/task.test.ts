/**
 * Tests for `mixshift task preflight` (commands/task.ts).
 *
 * Two families:
 *
 *   - Discovery unit tests: discoverCredentialFiles / pickNewestCandidate /
 *     dataDirFromCredentialPath run against real mkdtemp fixture trees with
 *     injectable roots — no test ever touches a real /sessions. Pinned:
 *     the fixed `.mixshift/auth/credentials` shape (decoys rejected), the
 *     depth bound (a file exactly at maxDepth is found; one level past it
 *     is not), newest-mtime selection with all candidates reported,
 *     missing/unreadable roots skipped without throwing, and symlinked
 *     directories never followed.
 *
 *   - Command-level tests: commander wiring + the blocker/exit-code
 *     contract (0 ready, 6 credential_missing, 7 credential_invalid,
 *     8 endpoint_unreachable, 9 context_unavailable), the JSON shape, the
 *     human READY/BLOCKED rendering, present-vs-pulled brand statuses
 *     (including the pull-ok-but-still-no-context.yaml edge), the
 *     interactive-credential warning, and the single telemetry emit.
 *     The auth credentials module, the context-sync client factory, the
 *     engine's pull, and track() are mocked; everything else (paths,
 *     commander parsing, the action handler) runs for real against a temp
 *     data dir passed via --data-dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  classifyMintError,
  dataDirFromCredentialPath,
  discoverCredentialFiles,
  pickNewestCandidate,
  registerTaskCommands,
  shellQuoteSingle,
  sortCandidatesByMtime,
} from './task.js';
import { getValidAccessToken, loadCredentials } from '../lib/auth/credentials.js';
import type { Credentials } from '../lib/auth/schema.js';
import { createContextSyncClient, type ContextSyncClient } from '../lib/context-sync/client.js';
import { pull, type BrandActionResult } from '../lib/context-sync/engine.js';
import { contextPath, credentialsPath } from '../lib/paths/resolve.js';
import { track, EventName } from '../lib/telemetry/index.js';

vi.mock('../lib/auth/credentials.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/auth/credentials.js')>();
  return {
    ...actual, // keep serviceTokenCachePath etc. real
    loadCredentials: vi.fn(),
    getValidAccessToken: vi.fn(),
  };
});

vi.mock('../lib/context-sync/client.js', () => ({
  createContextSyncClient: vi.fn(),
}));

vi.mock('../lib/context-sync/engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/context-sync/engine.js')>();
  return {
    ...actual,
    pull: vi.fn(),
  };
});

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return {
    ...actual, // keep EventName real
    track: vi.fn(async () => {}),
  };
});

// ---------------------------------------------------------------------------
// Discovery fixtures
// ---------------------------------------------------------------------------

/** Create `<root>/<...segments>/.mixshift/auth/credentials` and return the
 *  credentials file path. */
async function plantCredentials(root: string, ...segments: string[]): Promise<string> {
  const dir = join(root, ...segments, '.mixshift', 'auth');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'credentials');
  await writeFile(file, '{}', 'utf8');
  return file;
}

describe('discoverCredentialFiles', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mx-task-disc-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds a nested hit and rejects decoys that do not match .mixshift/auth/credentials', async () => {
    const hit = await plantCredentials(root, 'a', 'b'); // depth 5
    // Decoys: right filename, wrong parent shape.
    await writeFile(join(root, 'credentials'), '{}', 'utf8');
    await mkdir(join(root, 'auth'), { recursive: true });
    await writeFile(join(root, 'auth', 'credentials'), '{}', 'utf8');
    // Right shape, wrong filename.
    await writeFile(join(root, 'a', 'b', '.mixshift', 'auth', 'notcredentials'), '{}', 'utf8');

    const found = await discoverCredentialFiles([root], 9);
    expect(found).toEqual([hit]);
  });

  it('respects the depth bound: found exactly at maxDepth, pruned one past it', async () => {
    const hit = await plantCredentials(root, 'a', 'b'); // file depth = 5

    expect(await discoverCredentialFiles([root], 5)).toEqual([hit]);
    expect(await discoverCredentialFiles([root], 4)).toEqual([]);
  });

  it('skips a missing root and a file-as-root without throwing', async () => {
    const plainFile = join(root, 'not-a-dir');
    await writeFile(plainFile, 'x', 'utf8');

    const found = await discoverCredentialFiles(
      [join(root, 'does-not-exist'), plainFile],
      9,
    );
    expect(found).toEqual([]);
  });

  it('returns [] for an empty root', async () => {
    expect(await discoverCredentialFiles([root], 9)).toEqual([]);
  });

  it('never follows a symlinked directory', async () => {
    // Real credentials live under target/, reachable from scan/ only via a
    // symlink (junction on Windows — creatable without elevation).
    const target = join(root, 'target');
    await plantCredentials(target);
    const scanRoot = join(root, 'scan');
    await mkdir(scanRoot, { recursive: true });
    try {
      await symlink(target, join(scanRoot, 'link'), 'junction');
    } catch {
      return; // platform can't create symlinks here — nothing to assert
    }

    expect(await discoverCredentialFiles([scanRoot], 9)).toEqual([]);
  });

  it('skips entries whose names carry control characters', async () => {
    // A newline in a discovered path would corrupt the printed export line a
    // task shell executes verbatim. Windows filesystems refuse such names, so
    // this only exercises on platforms that can create them.
    let dir: string;
    try {
      dir = join(root, 'evil\n$(id)');
      await mkdir(join(dir, '.mixshift', 'auth'), { recursive: true });
      await writeFile(join(dir, '.mixshift', 'auth', 'credentials'), '{}', 'utf8');
    } catch {
      return; // platform can't create the fixture — nothing to assert
    }

    expect(await discoverCredentialFiles([root], 9)).toEqual([]);
  });
});

describe('shellQuoteSingle', () => {
  it('single-quotes and neutralizes shell metacharacters', () => {
    expect(shellQuoteSingle('/sessions/x/mnt/anchor/.mixshift')).toBe(
      "'/sessions/x/mnt/anchor/.mixshift'",
    );
    // $ ` " \ are inert inside single quotes; they pass through untouched.
    expect(shellQuoteSingle('/a/$HOME/`id`/"q"/b\\c')).toBe('\'/a/$HOME/`id`/"q"/b\\c\'');
    // The single quote itself is the only character needing the '\'' dance.
    expect(shellQuoteSingle("/a/it's/.mixshift")).toBe("'/a/it'\\''s/.mixshift'");
  });
});

describe('classifyMintError', () => {
  it('buckets known credential-shaped failures as credential_invalid', () => {
    expect(classifyMintError(new Error(
      'Service credential rejected (revoked, or rotated without updating this machine).',
    ))).toBe('credential_invalid');
    expect(classifyMintError(new Error(
      'Your MixShift session expired. Run `mixshift auth login` to sign in again.',
    ))).toBe('credential_invalid');
    expect(classifyMintError(new Error(
      'Token mint returned HTTP 401 (invalid_client).',
    ))).toBe('credential_invalid');
  });

  it('defaults ambiguous failures to endpoint_unreachable', () => {
    expect(classifyMintError(new Error('Token mint returned HTTP 500'))).toBe(
      'endpoint_unreachable',
    );
    expect(classifyMintError(new Error('Could not reach https://x/oauth/token: fetch failed.'))).toBe(
      'endpoint_unreachable',
    );
    expect(classifyMintError('a bare string mystery')).toBe('endpoint_unreachable');
  });
});

describe('pickNewestCandidate', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mx-task-pick-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('picks the newest hit by mtime while discovery reports all candidates', async () => {
    const older = await plantCredentials(root, 'old');
    const newer = await plantCredentials(root, 'new');
    await utimes(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    await utimes(newer, new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));

    const found = await discoverCredentialFiles([root], 9);
    expect(found.sort()).toEqual([older, newer].sort());

    // mtime decides, not input order.
    expect(await pickNewestCandidate([older, newer])).toBe(newer);
    expect(await pickNewestCandidate([newer, older])).toBe(newer);
  });

  it('drops candidates that fail stat; null when empty or all dropped', async () => {
    const real = await plantCredentials(root, 'x');
    const gone = join(root, 'vanished', '.mixshift', 'auth', 'credentials');

    expect(await pickNewestCandidate([gone, real])).toBe(real);
    expect(await pickNewestCandidate([gone])).toBeNull();
    expect(await pickNewestCandidate([])).toBeNull();
  });

  it('sortCandidatesByMtime orders newest first and drops failed stats', async () => {
    const older = await plantCredentials(root, 'older');
    const newer = await plantCredentials(root, 'newer');
    const gone = join(root, 'nope', '.mixshift', 'auth', 'credentials');
    await utimes(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    await utimes(newer, new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));

    expect(await sortCandidatesByMtime([older, gone, newer])).toEqual([newer, older]);
  });
});

describe('dataDirFromCredentialPath', () => {
  it('derives the .mixshift dir (dataDir) from a hit path', () => {
    const hit = join('sessions', 'x', 'mnt', 'MixShift-Scheduled', '.mixshift', 'auth', 'credentials');
    expect(dataDirFromCredentialPath(hit)).toBe(
      join('sessions', 'x', 'mnt', 'MixShift-Scheduled', '.mixshift'),
    );
  });
});

// ---------------------------------------------------------------------------
// Command-level tests
// ---------------------------------------------------------------------------

const SERVICE_ENVELOPE: Credentials = {
  schema_version: 2,
  created_at: '2026-07-01T00:00:00.000Z',
  service: {
    api_base: 'https://svc.test',
    client_id: 'svc_testcred123',
    client_secret: 's'.repeat(43),
    label: 'svc:test-cron',
  },
};

/** Schema-valid envelope with NEITHER a datahub nor a service block: the
 *  legacy mysql-only file, or the remnant clearDatahub leaves behind. Must
 *  never suppress the sandbox scan. */
const EMPTY_ENVELOPE: Credentials = {
  schema_version: 2,
  created_at: '2026-07-01T00:00:00.000Z',
};

const DATAHUB_ENVELOPE: Credentials = {
  schema_version: 2,
  created_at: '2026-07-01T00:00:00.000Z',
  datahub: {
    api_base: 'https://svc.test',
    access_token: 'at-1',
    refresh_token: 'rt-1',
    expires_at: '2027-01-01T00:00:00.000Z',
    refresh_expires_at: '2027-01-01T00:00:00.000Z',
    user_id: 'u1',
    email: 'ops@tenant.test',
    person_label: 'sam@tenant.test',
    device_label: 'test-box',
    client_id: 'mx-claude-plugin',
  },
};

/** The exact revoked-credential message doMintServiceToken throws on 401. */
const MINT_REJECTED_MESSAGE =
  'Service credential rejected (revoked, or rotated without updating this ' +
  'machine). Ask your tenant admin to check the credential at ' +
  'https://svc.test/admin, then re-run `mixshift auth service-setup` with ' +
  'the current secret.';

/** The fetch-level wrap doMintServiceToken throws on a transport failure. */
const MINT_UNREACHABLE_MESSAGE =
  'Could not reach https://svc.test/oauth/token: fetch failed. Check your ' +
  'network or try again in a minute.';

function fakeClient(): ContextSyncClient {
  return {
    fetchManifest: async () => ({ ok: true, brands: [] }),
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

/** Mirror the cli.ts wiring the task group hangs off in production. */
function buildProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw CommanderError instead of process.exit
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'emit machine-readable JSON to stdout', false)
    .option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR');
  registerTaskCommands(program);
  return program;
}

async function runTask(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', 'task', ...args]);
}

describe('task preflight (command)', () => {
  let tmpDataDir: string;
  /** What the command reports as data_dir: resolveDataDir() normalizes. */
  let expectedDataDir: string;
  /** Hermetic sessions root: every command test runs with
   *  MIXSHIFT_PREFLIGHT_SESSIONS_ROOT stubbed to an empty temp dir, so the
   *  scan never touches a real /sessions (the machine these tests most need
   *  to pass on — a Cowork sandbox — HAS one, full of credentials). */
  let emptySessionsRoot: string;
  /** Extra temp dirs a test creates; cleaned in afterEach. */
  let extraTmp: string[];
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let exitCodeBefore: typeof process.exitCode;

  beforeEach(async () => {
    vi.clearAllMocks();
    exitCodeBefore = process.exitCode;
    stdoutChunks = [];
    stderrChunks = [];
    extraTmp = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      stderrChunks.push(String(chunk));
      return true;
    });
    tmpDataDir = await mkdtemp(join(tmpdir(), 'mx-task-cmd-'));
    expectedDataDir = resolve(tmpDataDir);
    emptySessionsRoot = await mkdtemp(join(tmpdir(), 'mx-task-sess-'));
    vi.stubEnv('MIXSHIFT_PREFLIGHT_SESSIONS_ROOT', emptySessionsRoot);

    vi.mocked(loadCredentials).mockResolvedValue({
      credentials: SERVICE_ENVELOPE,
      path: credentialsPath(tmpDataDir),
    });
    vi.mocked(getValidAccessToken).mockResolvedValue('token-abc');
    vi.mocked(createContextSyncClient).mockReturnValue(fakeClient());
    vi.mocked(pull).mockResolvedValue({ ok: true, brand: 'unused', reports: [] });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = exitCodeBefore;
    await rm(tmpDataDir, { recursive: true, force: true });
    await rm(emptySessionsRoot, { recursive: true, force: true });
    for (const dir of extraTmp) await rm(dir, { recursive: true, force: true });
  });

  const stdoutText = (): string => stdoutChunks.join('');
  const stderrText = (): string => stderrChunks.join('');

  it('READY: exit 0 with the full JSON shape and one telemetry emit', async () => {
    await runTask('preflight', '--json', '--data-dir', tmpDataDir);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stderrText()).toBe('');

    const parsed = JSON.parse(stdoutText()) as Record<string, unknown>;
    expect(parsed).toEqual({
      ready: true,
      data_dir: expectedDataDir,
      export_line: `export MIXSHIFT_DATA_DIR='${expectedDataDir}'`,
      discovered_via: 'flag',
      candidates: [credentialsPath(expectedDataDir)],
      credential: {
        path: credentialsPath(expectedDataDir),
        kind: 'service',
        label: 'svc:test-cron',
        verified: true,
      },
      brands: [],
      blockers: [],
      warnings: [],
    });

    // Mint was a REAL forced round trip against the discovered dir.
    expect(getValidAccessToken).toHaveBeenCalledWith(expectedDataDir, true);

    // Exactly one track() per invocation, after the outcome is known.
    expect(track).toHaveBeenCalledTimes(1);
    const [input, dataDirArg] = vi.mocked(track).mock.calls[0];
    expect(input.event_name).toBe(EventName.TaskPreflightCompleted);
    expect(input.outcome).toBe('ok');
    expect(input.error_class).toBeUndefined();
    expect(typeof input.duration_ms).toBe('number');
    expect(input.payload).toEqual({
      discovered_via: 'flag',
      candidates_found: 1,
      brand_count: 0,
      brands_pulled: 0,
      warnings_count: 0,
      mint_attempts: 1,
      fallback_used: false,
    });
    // The DISCOVERED/resolved dir, deliberately not the raw root option:
    // attribution and the offline queue must ride the dir that actually
    // holds the credential. [red-team fix]
    expect(dataDirArg).toBe(expectedDataDir);
  });

  it('READY: human output renders the checklist, verdict, and export line', async () => {
    await mkdir(join(tmpDataDir, 'clients', 'acme'), { recursive: true });
    await writeFile(join(tmpDataDir, 'clients', 'acme', 'context.yaml'), 'brand_slug: acme\n', 'utf8');

    await runTask('preflight', '--brand', 'acme', '--data-dir', tmpDataDir);

    expect(process.exitCode ?? 0).toBe(0);
    const expected =
      [
        `ok      data dir: ${expectedDataDir}  (via flag; 1 candidate(s) found)`,
        `          ${credentialsPath(expectedDataDir)}`,
        'ok      credential: service (svc:test-cron)',
        'ok      auth verify: minted a fresh access token',
        'ok      brand acme: present',
        '',
        'READY',
        `export MIXSHIFT_DATA_DIR='${expectedDataDir}'`,
      ].join('\n') + '\n';
    expect(stdoutText()).toBe(expected);
    expect(pull).not.toHaveBeenCalled(); // present short-circuits the pull
  });

  it('no credential anywhere: exit 6, credential_missing, no export line', async () => {
    vi.mocked(loadCredentials).mockResolvedValue({
      credentials: null,
      path: credentialsPath(tmpDataDir),
    });
    // Hermetic discovery: point cwd at a fresh empty dir so the real scan
    // (which runs when the resolved dir has no credentials) finds nothing.
    const emptyCwd = await mkdtemp(join(tmpdir(), 'mx-task-cwd-'));
    vi.spyOn(process, 'cwd').mockReturnValue(emptyCwd);

    await runTask('preflight', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(6);
    const out = stdoutText();
    expect(out).toContain('BLOCKED credential: No credentials file found');
    expect(out).toContain('BLOCKED: credential_missing - No credentials file found');
    expect(out).toContain(
      'Remediation: Run `mixshift auth service-setup` (recommended for unattended/scheduled runs)',
    );
    expect(out).not.toContain('export MIXSHIFT_DATA_DIR');
    expect(getValidAccessToken).not.toHaveBeenCalled();

    expect(track).toHaveBeenCalledTimes(1);
    const [input] = vi.mocked(track).mock.calls[0];
    expect(input.outcome).toBe('failed');
    expect(input.error_class).toBe('credential_missing');

    await rm(emptyCwd, { recursive: true, force: true });
  });

  it('mint rejected: exit 7 and the representative blocked JSON shape', async () => {
    vi.mocked(getValidAccessToken).mockRejectedValue(new Error(MINT_REJECTED_MESSAGE));
    // Rejection now triggers the fall-through scan; keep it hermetic (the
    // stubbed sessions root from beforeEach is empty, and so is this cwd).
    const emptyCwd = await mkdtemp(join(tmpdir(), 'mx-task-cwd7-'));
    extraTmp.push(emptyCwd);
    vi.spyOn(process, 'cwd').mockReturnValue(emptyCwd);

    await runTask('preflight', '--json', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(7);
    const parsed = JSON.parse(stdoutText()) as Record<string, unknown>;
    expect(parsed).toEqual({
      ready: false,
      data_dir: expectedDataDir,
      export_line: `export MIXSHIFT_DATA_DIR='${expectedDataDir}'`,
      discovered_via: 'flag',
      candidates: [credentialsPath(expectedDataDir)],
      credential: {
        path: credentialsPath(expectedDataDir),
        kind: 'service',
        label: 'svc:test-cron',
        verified: false,
      },
      brands: [],
      blockers: [
        {
          class: 'credential_invalid',
          message: MINT_REJECTED_MESSAGE,
          remediation:
            'Re-run `mixshift auth service-setup` with a fresh setup code (service ' +
            'credential), or `mixshift auth login` (interactive credential).',
        },
      ],
      warnings: [],
    });

    expect(track).toHaveBeenCalledTimes(1);
    const [input] = vi.mocked(track).mock.calls[0];
    expect(input.outcome).toBe('failed');
    expect(input.error_class).toBe('credential_invalid');
  });

  it('network-shaped mint failure: exit 8, endpoint_unreachable', async () => {
    vi.mocked(getValidAccessToken).mockRejectedValue(new Error(MINT_UNREACHABLE_MESSAGE));

    await runTask('preflight', '--json', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(8);
    const parsed = JSON.parse(stdoutText()) as {
      ready: boolean;
      credential: { verified: boolean };
      blockers: Array<{ class: string; remediation: string }>;
    };
    expect(parsed.ready).toBe(false);
    expect(parsed.credential.verified).toBe(false);
    expect(parsed.blockers[0].class).toBe('endpoint_unreachable');
    expect(parsed.blockers[0].remediation).toContain('mcp.mixshift.io');
  });

  it('brand pull failure: exit 9, context_unavailable, brand unavailable', async () => {
    vi.mocked(pull).mockResolvedValue({
      ok: false,
      brand: 'ghost',
      message: "brand 'ghost' not found locally or in the org store",
    });

    await runTask('preflight', '--brand', 'ghost', '--json', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(9);
    const parsed = JSON.parse(stdoutText()) as {
      ready: boolean;
      export_line: string | null;
      brands: Array<{ slug: string; status: string }>;
      blockers: Array<{ class: string; message: string }>;
    };
    expect(parsed.ready).toBe(false);
    // Credential verified fine, so the export line still prints for the
    // task's later steps even though a brand blocked the run.
    expect(parsed.export_line).toBe(`export MIXSHIFT_DATA_DIR='${expectedDataDir}'`);
    expect(parsed.brands).toEqual([{ slug: 'ghost', status: 'unavailable' }]);
    expect(parsed.blockers[0].class).toBe('context_unavailable');
    expect(parsed.blockers[0].message).toContain("brand 'ghost'");
    expect(parsed.blockers[0].message).toContain('not found locally or in the org store');
  });

  it('--brand accumulates: present skips the pull, missing pulls and re-checks', async () => {
    await mkdir(join(tmpDataDir, 'clients', 'acme'), { recursive: true });
    await writeFile(join(tmpDataDir, 'clients', 'acme', 'context.yaml'), 'brand_slug: acme\n', 'utf8');
    vi.mocked(pull).mockImplementation(async (slug: string): Promise<BrandActionResult> => {
      // A successful pull materializes context.yaml (satisfies the post-pull
      // existence re-check).
      const dir = join(tmpDataDir, 'clients', slug);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'context.yaml'), `brand_slug: ${slug}\n`, 'utf8');
      return { ok: true, brand: slug, reports: [] };
    });

    await runTask(
      'preflight',
      '--brand', 'acme',
      '--brand', 'zeta',
      '--json',
      '--data-dir', tmpDataDir,
    );

    expect(process.exitCode ?? 0).toBe(0);
    const parsed = JSON.parse(stdoutText()) as {
      ready: boolean;
      brands: Array<{ slug: string; status: string }>;
    };
    expect(parsed.ready).toBe(true);
    expect(parsed.brands).toEqual([
      { slug: 'acme', status: 'present' },
      { slug: 'zeta', status: 'pulled' },
    ]);

    // Only the missing brand hit the engine, threaded with the resolved dir.
    expect(pull).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pull).mock.calls[0][0]).toBe('zeta');
    expect(vi.mocked(pull).mock.calls[0][1]).toMatchObject({ dataDirOverride: expectedDataDir });
    expect(createContextSyncClient).toHaveBeenCalledWith({ dataDirOverride: expectedDataDir });

    const [input] = vi.mocked(track).mock.calls[0];
    expect(input.payload).toMatchObject({ brand_count: 2, brands_pulled: 1 });
  });

  it('pull ok but context.yaml still absent: unavailable + exit 9', async () => {
    // The org store knew the brand (pull returns ok) but held no context doc,
    // so nothing materialized locally — still a blocker.
    vi.mocked(pull).mockResolvedValue({ ok: true, brand: 'hollow', reports: [] });

    await runTask('preflight', '--brand', 'hollow', '--json', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(9);
    const parsed = JSON.parse(stdoutText()) as {
      ready: boolean;
      brands: Array<{ slug: string; status: string }>;
      blockers: Array<{ class: string; message: string }>;
    };
    expect(parsed.ready).toBe(false);
    expect(parsed.brands).toEqual([{ slug: 'hollow', status: 'unavailable' }]);
    expect(parsed.blockers[0].class).toBe('context_unavailable');
    expect(parsed.blockers[0].message).toContain('context.yaml still does not exist');
  });

  it('interactive credential: warns but stays READY (exit 0)', async () => {
    vi.mocked(loadCredentials).mockResolvedValue({
      credentials: DATAHUB_ENVELOPE,
      path: credentialsPath(tmpDataDir),
    });

    await runTask('preflight', '--json', '--data-dir', tmpDataDir);

    expect(process.exitCode ?? 0).toBe(0);
    const parsed = JSON.parse(stdoutText()) as {
      ready: boolean;
      credential: { kind: string; label?: string; verified: boolean };
      blockers: unknown[];
      warnings: string[];
    };
    expect(parsed.ready).toBe(true);
    expect(parsed.blockers).toEqual([]);
    expect(parsed.credential.kind).toBe('interactive');
    expect(parsed.credential.label).toBe('sam@tenant.test');
    expect(parsed.credential.verified).toBe(true);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('service credential');

    const [input] = vi.mocked(track).mock.calls[0];
    expect(input.outcome).toBe('ok');
    expect(input.payload).toMatchObject({ warnings_count: 1 });
  });

  it('context.yaml path check honors the discovered data dir (contextPath wiring)', async () => {
    // Sanity pin: the 'present' check reads <dataDir>/clients/<slug>/context.yaml.
    await mkdir(join(tmpDataDir, 'clients', 'acme'), { recursive: true });
    await writeFile(contextPath('acme', tmpDataDir), 'brand_slug: acme\n', 'utf8');

    await runTask('preflight', '--brand', 'acme', '--json', '--data-dir', tmpDataDir);

    const parsed = JSON.parse(stdoutText()) as { brands: Array<{ status: string }> };
    expect(parsed.brands[0].status).toBe('present');
  });

  it('unusable envelope at the resolved dir does NOT suppress the sessions scan', async () => {
    // The regression this command exists to prevent: a legacy/remnant file
    // at the resolved dir (mysql-only or empty envelope) while the REAL
    // service credential sits in the granted anchor under the sessions tree.
    const sessRoot = await mkdtemp(join(tmpdir(), 'mx-task-sess2-'));
    extraTmp.push(sessRoot);
    vi.stubEnv('MIXSHIFT_PREFLIGHT_SESSIONS_ROOT', sessRoot);
    const hit = await plantCredentials(sessRoot, 'ws', 'mnt', 'anchor');
    const discoveredDir = dataDirFromCredentialPath(hit);
    const emptyCwd = await mkdtemp(join(tmpdir(), 'mx-task-cwd2-'));
    extraTmp.push(emptyCwd);
    vi.spyOn(process, 'cwd').mockReturnValue(emptyCwd);

    vi.mocked(loadCredentials).mockImplementation(async (dir?: string) => {
      if (dir && resolve(dir) === resolve(discoveredDir)) {
        return { credentials: SERVICE_ENVELOPE, path: credentialsPath(dir) };
      }
      return { credentials: EMPTY_ENVELOPE, path: credentialsPath(dir ?? tmpDataDir) };
    });

    await runTask('preflight', '--json', '--data-dir', tmpDataDir);

    expect(process.exitCode ?? 0).toBe(0);
    const parsed = JSON.parse(stdoutText()) as {
      ready: boolean;
      data_dir: string;
      discovered_via: string;
      candidates: string[];
      credential: { kind: string; verified: boolean };
    };
    expect(parsed.ready).toBe(true);
    expect(parsed.discovered_via).toBe('sessions_scan');
    expect(parsed.data_dir).toBe(discoveredDir);
    // Both the unusable resolved-dir file and the real hit are reported.
    expect(parsed.candidates).toEqual([credentialsPath(expectedDataDir), hit]);
    expect(parsed.credential).toMatchObject({ kind: 'service', verified: true });
    // The mint ran against the DISCOVERED dir.
    expect(getValidAccessToken).toHaveBeenCalledWith(discoveredDir, true);
  });

  it('cwd scan discovers the credential and dedupes overlapping roots', async () => {
    // <cwd>/outputs/.mixshift/auth/credentials is within depth of BOTH scan
    // roots (cwd and cwd/outputs) — it must surface exactly once.
    const cwdRoot = await mkdtemp(join(tmpdir(), 'mx-task-cwd3-'));
    extraTmp.push(cwdRoot);
    vi.spyOn(process, 'cwd').mockReturnValue(cwdRoot);
    const hit = await plantCredentials(cwdRoot, 'outputs');
    const discoveredDir = dataDirFromCredentialPath(hit);

    vi.mocked(loadCredentials).mockImplementation(async (dir?: string) => {
      if (dir && resolve(dir) === resolve(discoveredDir)) {
        return { credentials: SERVICE_ENVELOPE, path: credentialsPath(dir) };
      }
      return { credentials: null, path: credentialsPath(dir ?? tmpDataDir) };
    });

    await runTask('preflight', '--json', '--data-dir', tmpDataDir);

    expect(process.exitCode ?? 0).toBe(0);
    const parsed = JSON.parse(stdoutText()) as {
      ready: boolean;
      data_dir: string;
      discovered_via: string;
      candidates: string[];
      export_line: string;
    };
    expect(parsed.ready).toBe(true);
    expect(parsed.discovered_via).toBe('cwd_scan');
    expect(parsed.data_dir).toBe(discoveredDir);
    expect(parsed.candidates).toEqual([hit]); // deduped: found via two roots, listed once
    expect(parsed.export_line).toBe(`export MIXSHIFT_DATA_DIR='${discoveredDir}'`);
  });

  it('malformed file at the resolved dir demotes to a warning when discovery succeeds, and never leaks contents', async () => {
    const sessRoot = await mkdtemp(join(tmpdir(), 'mx-task-sess3-'));
    extraTmp.push(sessRoot);
    vi.stubEnv('MIXSHIFT_PREFLIGHT_SESSIONS_ROOT', sessRoot);
    const hit = await plantCredentials(sessRoot, 'ws', 'anchor');
    const discoveredDir = dataDirFromCredentialPath(hit);
    const emptyCwd = await mkdtemp(join(tmpdir(), 'mx-task-cwd4-'));
    extraTmp.push(emptyCwd);
    vi.spyOn(process, 'cwd').mockReturnValue(emptyCwd);

    vi.mocked(loadCredentials).mockImplementation(async (dir?: string) => {
      if (dir && resolve(dir) === resolve(discoveredDir)) {
        return { credentials: SERVICE_ENVELOPE, path: credentialsPath(dir) };
      }
      // Simulates JSON.parse embedding raw file text around the error site.
      throw new Error('Unexpected token B in JSON: ..."client_secret":"BOOM_SECRET_FRAGMENT...');
    });

    await runTask('preflight', '--json', '--data-dir', tmpDataDir);

    expect(process.exitCode ?? 0).toBe(0);
    const out = stdoutText();
    expect(out).not.toContain('BOOM_SECRET_FRAGMENT');
    const parsed = JSON.parse(out) as {
      ready: boolean;
      warnings: string[];
      blockers: unknown[];
      discovered_via: string;
    };
    expect(parsed.ready).toBe(true);
    expect(parsed.blockers).toEqual([]);
    expect(parsed.discovered_via).toBe('sessions_scan');
    expect(parsed.warnings.some((w) => w.includes('could not be parsed'))).toBe(true);
  });

  it('malformed file with nothing discovered: exit 7, sanitized message', async () => {
    const emptyCwd = await mkdtemp(join(tmpdir(), 'mx-task-cwd5-'));
    extraTmp.push(emptyCwd);
    vi.spyOn(process, 'cwd').mockReturnValue(emptyCwd);
    vi.mocked(loadCredentials).mockRejectedValue(
      new Error('Unexpected token B in JSON: ..."client_secret":"BOOM_SECRET_FRAGMENT...'),
    );

    await runTask('preflight', '--json', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(7);
    const out = stdoutText();
    expect(out).not.toContain('BOOM_SECRET_FRAGMENT');
    const parsed = JSON.parse(out) as {
      ready: boolean;
      blockers: Array<{ class: string; message: string; remediation: string }>;
    };
    expect(parsed.ready).toBe(false);
    expect(parsed.blockers[0].class).toBe('credential_invalid');
    expect(parsed.blockers[0].message).toContain('could not be parsed');
    expect(parsed.blockers[0].message).toContain(credentialsPath(expectedDataDir));
    expect(parsed.blockers[0].remediation).toContain('Delete the malformed credentials file');
  });

  it('multi-blocker run: first blocker in priority order wins the exit code', async () => {
    vi.mocked(getValidAccessToken).mockRejectedValue(new Error(MINT_REJECTED_MESSAGE));
    const emptyCwd = await mkdtemp(join(tmpdir(), 'mx-task-cwd8-'));
    extraTmp.push(emptyCwd);
    vi.spyOn(process, 'cwd').mockReturnValue(emptyCwd);
    vi.mocked(pull).mockResolvedValue({
      ok: false,
      brand: 'ghost',
      message: "brand 'ghost' not found locally or in the org store",
    });

    await runTask('preflight', '--brand', 'ghost', '--json', '--data-dir', tmpDataDir);

    // credential_invalid (7) outranks context_unavailable (9) even though
    // both blockers are present and reported.
    expect(process.exitCode).toBe(7);
    const parsed = JSON.parse(stdoutText()) as {
      blockers: Array<{ class: string }>;
    };
    expect(parsed.blockers.map((b) => b.class)).toEqual([
      'credential_invalid',
      'context_unavailable',
    ]);

    const [input] = vi.mocked(track).mock.calls[0];
    expect(input.outcome).toBe('failed');
    expect(input.error_class).toBe('credential_invalid');
  });

  // --- Verify fall-through on mint rejection (Cartology field case) --------
  // A structurally-usable credential can be REVOKED; preflight must try the
  // next discovered candidate instead of dying on the stale one.

  /** SERVICE_ENVELOPE with a distinguishable label, for asserting WHICH
   *  credential the run ends up using. */
  function serviceEnvelope(label: string): Credentials {
    return {
      ...SERVICE_ENVELOPE,
      service: { ...SERVICE_ENVELOPE.service!, label },
    };
  }

  /** Wire loadCredentials + getValidAccessToken by data dir: `creds` maps a
   *  dir to its envelope (missing dir => no file); `rejects` lists dirs whose
   *  mint is rejected (everything else mints fine). */
  function wireByDir(
    creds: Array<{ dir: string; envelope: Credentials | null }>,
    rejects: string[],
    rejectError: () => Error = () => new Error(MINT_REJECTED_MESSAGE),
  ): void {
    vi.mocked(loadCredentials).mockImplementation(async (dir?: string) => {
      const hit = creds.find((c) => resolve(c.dir) === resolve(dir ?? ''));
      return { credentials: hit?.envelope ?? null, path: credentialsPath(dir ?? '') };
    });
    vi.mocked(getValidAccessToken).mockImplementation(async (dir?: string) => {
      if (rejects.some((r) => resolve(r) === resolve(dir ?? ''))) throw rejectError();
      return 'token-abc';
    });
  }

  it('SECURITY: a revoked credential at an EXPLICITLY PINNED --data-dir is terminal — no scan, no fall-through', async () => {
    // The red-team HIGH: a rejection on a pinned/resolved dir must NOT trigger
    // a /sessions scan that could adopt a planted credential. Plant a VALID
    // credential in the sessions tree; it must be ignored because the caller
    // pinned a specific dir. exit 7, one blocker, the pinned dir stands.
    const sessRoot = await mkdtemp(join(tmpdir(), 'mx-task-ft1-'));
    extraTmp.push(sessRoot);
    vi.stubEnv('MIXSHIFT_PREFLIGHT_SESSIONS_ROOT', sessRoot);
    const plantedHit = await plantCredentials(sessRoot, 'ws', 'anchor');
    const plantedDir = dataDirFromCredentialPath(plantedHit);
    const emptyCwd = await mkdtemp(join(tmpdir(), 'mx-task-ft1cwd-'));
    extraTmp.push(emptyCwd);
    vi.spyOn(process, 'cwd').mockReturnValue(emptyCwd);

    wireByDir(
      [
        { dir: tmpDataDir, envelope: serviceEnvelope('svc:pinned-revoked') },
        { dir: plantedDir, envelope: serviceEnvelope('svc:planted-valid') },
      ],
      [tmpDataDir], // only the pinned one is revoked; the planted one WOULD verify
    );

    await runTask('preflight', '--json', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(7);
    const parsed = JSON.parse(stdoutText()) as {
      ready: boolean;
      data_dir: string;
      credential: { label?: string; verified: boolean };
      candidates: string[];
      blockers: Array<{ class: string }>;
    };
    expect(parsed.ready).toBe(false);
    expect(parsed.data_dir).toBe(expectedDataDir); // the pin, unchanged
    expect(parsed.credential).toMatchObject({ label: 'svc:pinned-revoked', verified: false });
    expect(parsed.blockers.map((b) => b.class)).toEqual(['credential_invalid']);
    // The planted /sessions credential was never scanned for or adopted.
    expect(parsed.candidates).toEqual([credentialsPath(expectedDataDir)]);
    expect(getValidAccessToken).toHaveBeenCalledTimes(1); // only the pinned dir minted
    expect(getValidAccessToken).not.toHaveBeenCalledWith(plantedDir, true);

    const [input] = vi.mocked(track).mock.calls[0];
    expect(input.outcome).toBe('failed');
    expect(input.payload).toMatchObject({ mint_attempts: 1, fallback_used: false });
  });

  it('scan path: newest candidate revoked, older one verifies', async () => {
    const sessRoot = await mkdtemp(join(tmpdir(), 'mx-task-ft2-'));
    extraTmp.push(sessRoot);
    vi.stubEnv('MIXSHIFT_PREFLIGHT_SESSIONS_ROOT', sessRoot);
    const newerHit = await plantCredentials(sessRoot, 'newer');
    const olderHit = await plantCredentials(sessRoot, 'older');
    await utimes(olderHit, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    await utimes(newerHit, new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));
    const newerDir = dataDirFromCredentialPath(newerHit);
    const olderDir = dataDirFromCredentialPath(olderHit);
    const emptyCwd = await mkdtemp(join(tmpdir(), 'mx-task-ft2cwd-'));
    extraTmp.push(emptyCwd);
    vi.spyOn(process, 'cwd').mockReturnValue(emptyCwd);

    wireByDir(
      [
        { dir: tmpDataDir, envelope: null }, // resolved dir: no file -> scan
        { dir: newerDir, envelope: serviceEnvelope('svc:stale-newest') },
        { dir: olderDir, envelope: serviceEnvelope('svc:older-valid') },
      ],
      [newerDir],
    );

    await runTask('preflight', '--json', '--data-dir', tmpDataDir);

    expect(process.exitCode ?? 0).toBe(0);
    const parsed = JSON.parse(stdoutText()) as {
      ready: boolean;
      data_dir: string;
      credential: { label?: string };
      warnings: string[];
    };
    expect(parsed.ready).toBe(true);
    expect(parsed.data_dir).toBe(olderDir);
    expect(parsed.credential.label).toBe('svc:older-valid');
    expect(parsed.warnings.some((w) => w.includes('rejected'))).toBe(true);

    const [input] = vi.mocked(track).mock.calls[0];
    expect(input.payload).toMatchObject({ mint_attempts: 2, fallback_used: true });
  });

  it('scan path, all discovered credentials rejected: exit 7, primary blocker, extra-rejection warning', async () => {
    const sessRoot = await mkdtemp(join(tmpdir(), 'mx-task-ft3-'));
    extraTmp.push(sessRoot);
    vi.stubEnv('MIXSHIFT_PREFLIGHT_SESSIONS_ROOT', sessRoot);
    // Both discovered by scan (resolved dir empty). Newest = the "primary"
    // the failure report describes.
    const primaryHit = await plantCredentials(sessRoot, 'primary');
    const altHit = await plantCredentials(sessRoot, 'alt');
    await utimes(altHit, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    await utimes(primaryHit, new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));
    const primaryDir = dataDirFromCredentialPath(primaryHit);
    const altDir = dataDirFromCredentialPath(altHit);
    const emptyCwd = await mkdtemp(join(tmpdir(), 'mx-task-ft3cwd-'));
    extraTmp.push(emptyCwd);
    vi.spyOn(process, 'cwd').mockReturnValue(emptyCwd);

    wireByDir(
      [
        { dir: tmpDataDir, envelope: null }, // resolved dir empty -> scan
        { dir: primaryDir, envelope: serviceEnvelope('svc:primary') },
        { dir: altDir, envelope: serviceEnvelope('svc:alt') },
      ],
      [primaryDir, altDir], // both reject
    );

    await runTask('preflight', '--json', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(7);
    const parsed = JSON.parse(stdoutText()) as {
      ready: boolean;
      data_dir: string;
      credential: { path: string; label?: string; verified: boolean };
      blockers: Array<{ class: string; message: string }>;
      warnings: string[];
    };
    expect(parsed.ready).toBe(false);
    // Blocker + summary describe the PRIMARY (newest scan hit); fallback
    // attempts are a warning, not the headline.
    expect(parsed.blockers).toHaveLength(1);
    expect(parsed.blockers[0].class).toBe('credential_invalid');
    expect(parsed.blockers[0].message).toBe(MINT_REJECTED_MESSAGE);
    expect(parsed.data_dir).toBe(primaryDir);
    expect(parsed.credential).toMatchObject({
      path: credentialsPath(primaryDir),
      label: 'svc:primary',
      verified: false,
    });
    expect(parsed.warnings.some((w) => w.includes('also rejected'))).toBe(true);

    const [input] = vi.mocked(track).mock.calls[0];
    expect(input.outcome).toBe('failed');
    expect(input.error_class).toBe('credential_invalid');
    expect(input.payload).toMatchObject({ mint_attempts: 2, fallback_used: false });
  });

  it('scan path, rejection then endpoint failure on the fallback: both blockers, exit 7 by priority', async () => {
    const sessRoot = await mkdtemp(join(tmpdir(), 'mx-task-ft4-'));
    extraTmp.push(sessRoot);
    vi.stubEnv('MIXSHIFT_PREFLIGHT_SESSIONS_ROOT', sessRoot);
    const primaryHit = await plantCredentials(sessRoot, 'primary');
    const altHit = await plantCredentials(sessRoot, 'alt');
    await utimes(altHit, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    await utimes(primaryHit, new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));
    const primaryDir = dataDirFromCredentialPath(primaryHit);
    const altDir = dataDirFromCredentialPath(altHit);
    const emptyCwd = await mkdtemp(join(tmpdir(), 'mx-task-ft4cwd-'));
    extraTmp.push(emptyCwd);
    vi.spyOn(process, 'cwd').mockReturnValue(emptyCwd);

    vi.mocked(loadCredentials).mockImplementation(async (dir?: string) => {
      const map = [
        { dir: primaryDir, envelope: serviceEnvelope('svc:primary') },
        { dir: altDir, envelope: serviceEnvelope('svc:alt') },
      ];
      const hit = map.find((c) => resolve(c.dir) === resolve(dir ?? ''));
      return { credentials: hit?.envelope ?? null, path: credentialsPath(dir ?? '') };
    });
    vi.mocked(getValidAccessToken).mockImplementation(async (dir?: string) => {
      if (resolve(dir ?? '') === resolve(primaryDir)) throw new Error(MINT_REJECTED_MESSAGE);
      throw new Error(MINT_UNREACHABLE_MESSAGE); // the older fallback hits a network failure
    });

    await runTask('preflight', '--json', '--data-dir', tmpDataDir);

    // credential_invalid (7) outranks endpoint_unreachable (8).
    expect(process.exitCode).toBe(7);
    const parsed = JSON.parse(stdoutText()) as { blockers: Array<{ class: string }> };
    expect(parsed.blockers.map((b) => b.class)).toEqual([
      'credential_invalid',
      'endpoint_unreachable',
    ]);
  });

  it('scan path caps total mint attempts at 3 even with more candidates available', async () => {
    const sessRoot = await mkdtemp(join(tmpdir(), 'mx-task-ft5-'));
    extraTmp.push(sessRoot);
    vi.stubEnv('MIXSHIFT_PREFLIGHT_SESSIONS_ROOT', sessRoot);
    const dirs: string[] = [];
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      dirs.push(dataDirFromCredentialPath(await plantCredentials(sessRoot, name)));
    }
    const emptyCwd = await mkdtemp(join(tmpdir(), 'mx-task-ft5cwd-'));
    extraTmp.push(emptyCwd);
    vi.spyOn(process, 'cwd').mockReturnValue(emptyCwd);

    wireByDir(
      [
        { dir: tmpDataDir, envelope: null }, // resolved dir empty -> scan
        ...dirs.map((dir, i) => ({ dir, envelope: serviceEnvelope(`svc:alt${i}`) })),
      ],
      dirs, // every discovered credential rejects; the cap must stop the run
    );

    await runTask('preflight', '--json', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(7);
    expect(vi.mocked(getValidAccessToken)).toHaveBeenCalledTimes(3);
    const [input] = vi.mocked(track).mock.calls[0];
    expect(input.payload).toMatchObject({ mint_attempts: 3, fallback_used: false });
  });

  it('unexpected throw hits the top-level catch: exit 1 and the {status:error} JSON shape', async () => {
    // Any unexpected rejection (here: telemetry itself exploding) must land
    // in the generic error contract — exit 1 tells a task wrapper "bug",
    // as opposed to 6-9 "known blocker, follow the remediation".
    vi.mocked(track).mockRejectedValueOnce(new Error('telemetry exploded'));

    await runTask('preflight', '--json', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(stdoutText()) as { status: string; message: string };
    expect(parsed).toEqual({ status: 'error', message: 'telemetry exploded' });
  });
});
