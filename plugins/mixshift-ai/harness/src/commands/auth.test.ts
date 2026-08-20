/**
 * Command-level tests for `mixshift auth setup`'s login-success org-brand-
 * count line (D-032, slice 2 piece B). The command already appends a LOCAL
 * brand-count line after a successful sign-in (post-auth discovery); this
 * extends it with a budgeted org-manifest fetch (getCachedOrgManifest, see
 * lib/context-sync/autosync.ts) rendering "Your org has N brands set up.
 * M not yet on this machine." Quiet no-op on offline/timeout: the local
 * line stays exactly as before, the org line just never prints.
 *
 * Mirrors commands/brand-add.test.ts's conventions: mock telemetry + the
 * network-touching dependencies, drive the real Command registration
 * end to end, capture stdout/stderr.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return { ...actual, track: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../lib/clients/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/clients/index.js')>();
  return { ...actual, runDiscoveryAndPersist: vi.fn() };
});

vi.mock('../lib/context-sync/autosync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/context-sync/autosync.js')>();
  return { ...actual, getCachedOrgManifest: vi.fn() };
});

// FIX D: wraps the REAL listLocalBrands by default (existing tests below
// rely on it actually reading the temp data dir), so only a test that
// explicitly overrides it (mockImplementationOnce) diverges from real
// behavior — see "computeOrgAwareness bounds the local read (FIX D)".
vi.mock('../lib/context-sync/local.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/context-sync/local.js')>();
  return { ...actual, listLocalBrands: vi.fn(actual.listLocalBrands) };
});

vi.mock('../lib/auth/login-flow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/auth/login-flow.js')>();
  return { ...actual, runAuthLogin: vi.fn(), pollDeviceFlow: vi.fn() };
});

import { registerAuthCommands } from './auth.js';
import { runDiscoveryAndPersist } from '../lib/clients/index.js';
import { getCachedOrgManifest } from '../lib/context-sync/autosync.js';
import { runAuthLogin, pollDeviceFlow } from '../lib/auth/login-flow.js';
import type { AuthLoginResult } from '../lib/auth/login-flow.js';
import type { ClientsIndex, IndexBrand } from '../lib/clients/index-schema.js';
import type { OrgManifestResult } from '../lib/context-sync/autosync.js';
import { listLocalBrands } from '../lib/context-sync/local.js';
import { clientsDir } from '../lib/paths/resolve.js';

const mockedDiscovery = vi.mocked(runDiscoveryAndPersist);
const mockedManifest = vi.mocked(getCachedOrgManifest);
const mockedListLocalBrands = vi.mocked(listLocalBrands);

function indexBrand(slug: string): IndexBrand {
  return {
    slug,
    display_name: slug,
    ads_active: true,
    retail_active: true,
    is_dormant: false,
    cold_started: false,
    cold_started_at: null,
    accounts: [
      {
        seller_id: 1,
        seller_name: slug,
        merchant_alias: null,
        account_type: 'SC',
        marketplace: 'United States',
        region: 'NA',
        is_active: true,
        is_mws_user: true,
        ads_active: true,
        retail_active: true,
      },
    ],
  };
}

function fakeIndex(slugs: string[]): ClientsIndex {
  return {
    schema_version: 1,
    discovered_at: new Date().toISOString(),
    brands: slugs.map(indexBrand),
  };
}

let dataDir: string;
let fromFilePath: string;
let stdout: string;
let priorExitCode: typeof process.exitCode;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function newProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option('--json', 'emit JSON', false);
  program.option('--data-dir <dir>', 'data dir override');
  registerAuthCommands(program);
  return program;
}

async function runSetup(extraArgs: string[] = []): Promise<void> {
  const program = newProgram();
  try {
    await program.parseAsync(
      [
        'auth',
        'setup',
        '--from-file',
        fromFilePath,
        '--skip-connection-test',
        '--data-dir',
        dataDir,
        ...extraArgs,
      ],
      { from: 'user' },
    );
  } catch {
    // exitOverride throws on non-zero exit; assertions read stdout/stderr instead.
  }
}

/**
 * Extract the Nth (0-indexed) balanced top-level JSON object from stdout,
 * or return null when there is no Nth value. Used both to read the single
 * document commands print AND to prove `auth setup --json` never prints a
 * second one (its whole-stdout single-document contract predates slice 2
 * and must survive it). Brace-counts rather than assuming no '{'/'}'
 * appear inside string values, which holds for every field these commands
 * actually emit (slugs, counts, paths).
 */
function nthJsonValue(index: number): Record<string, unknown> | null {
  let searchFrom = 0;
  for (let i = 0; i <= index; i++) {
    const start = stdout.indexOf('{', searchFrom);
    if (start < 0) return null;
    let depth = 0;
    let end = -1;
    for (let pos = start; pos < stdout.length; pos++) {
      if (stdout[pos] === '{') depth++;
      else if (stdout[pos] === '}') {
        depth--;
        if (depth === 0) {
          end = pos;
          break;
        }
      }
    }
    expect(end, `unbalanced JSON value #${i} in stdout: ${stdout}`).toBeGreaterThan(0);
    if (i === index) return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
    searchFrom = end + 1;
  }
  throw new Error('unreachable');
}

function emittedJson(): Record<string, unknown> {
  const first = nthJsonValue(0);
  expect(first, `no JSON value in stdout: ${stdout}`).not.toBeNull();
  return first as Record<string, unknown>;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mx-authsetup-'));
  fromFilePath = join(dataDir, 'inputs.yaml');
  await writeFile(
    fromFilePath,
    'email: sam@example.com\n' +
      'mysql:\n' +
      '  host: db.example.test\n' +
      '  port: 3306\n' +
      '  user: sam\n' +
      '  password: secret\n' +
      '  database: dashamazon\n',
    'utf-8',
  );
  stdout = '';
  priorExitCode = process.exitCode;
  process.exitCode = undefined;
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  mockedDiscovery.mockReset();
  mockedDiscovery.mockResolvedValue({ index: fakeIndex([]), previousDiscoveredAt: null });
  mockedManifest.mockReset();
  mockedManifest.mockResolvedValue({ ok: false });
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  process.exitCode = priorExitCode;
  await rm(dataDir, { recursive: true, force: true });
});

describe('auth setup — org-manifest awareness line (non-JSON)', () => {
  it('prints "Your org has N brands set up. M not yet on this machine" after the local brand-count line', async () => {
    mockedDiscovery.mockResolvedValue({
      index: fakeIndex(['acme']),
      previousDiscoveredAt: null,
    });
    // Local: only 'acme' is on this machine (a real clients/acme dir).
    await mkdir(join(clientsDir(dataDir), 'acme'), { recursive: true });
    const manifestResult: OrgManifestResult = {
      ok: true,
      fromCache: false,
      brands: [
        { brand_slug: 'acme', docs: [] },
        { brand_slug: 'other-brand', docs: [] },
        { brand_slug: 'third-brand', docs: [] },
      ],
    };
    mockedManifest.mockResolvedValue(manifestResult);

    await runSetup();

    expect(stdout).toContain('Brand registry populated at ~/.mixshift/clients/index.yaml:');
    expect(stdout).toContain('Your org has 3 brands set up. 2 not yet on this machine.');
    // The org line comes AFTER the existing local-count block, not instead of it.
    expect(stdout.indexOf('Brand registry populated')).toBeLessThan(
      stdout.indexOf('Your org has 3 brands'),
    );
  });

  it('offline/timeout: the local line stays exactly as before, the org line silently does not print', async () => {
    mockedDiscovery.mockResolvedValue({
      index: fakeIndex(['acme']),
      previousDiscoveredAt: null,
    });
    mockedManifest.mockResolvedValue({ ok: false });

    await runSetup();

    expect(stdout).toContain('Brand registry populated at ~/.mixshift/clients/index.yaml:');
    expect(stdout).toContain('1 active brand(s), 0 dormant, 0 set up');
    expect(stdout).not.toContain('Your org has');
    expect(stdout).not.toContain('not yet on this machine');
  });

  it('never throws and never surfaces an error when the manifest fetch rejects the whole call', async () => {
    mockedManifest.mockRejectedValue(new Error('boom'));
    await runSetup();
    // getCachedOrgManifest is documented to never throw; if a mock forces
    // it to anyway, this proves the command doesn't crash the auth flow —
    // the outer catch still reports a clean, expected outcome either way.
    expect(process.exitCode ?? 0).not.toBe(1);
  });
});

describe('auth setup --json — single-document contract preserved', () => {
  it('prints EXACTLY ONE JSON document even when discovery and the manifest fetch both succeed', async () => {
    mockedDiscovery.mockResolvedValue({
      index: fakeIndex(['acme']),
      previousDiscoveredAt: null,
    });
    await mkdir(join(clientsDir(dataDir), 'acme'), { recursive: true });
    mockedManifest.mockResolvedValue({
      ok: true,
      fromCache: false,
      brands: [
        { brand_slug: 'acme', docs: [] },
        { brand_slug: 'other-brand', docs: [] },
      ],
    });

    await runSetup(['--json']);

    // `auth setup --json`'s stdout contract predates slice 2: ONE base
    // SetupResult document, parseable via a whole-stdout JSON.parse. Org
    // awareness must never add a second document here — it lives on
    // `auth login --json` as the additive org_brands field instead.
    const first = emittedJson();
    expect(first.status).toBe('ok');
    expect(nthJsonValue(1)).toBeNull();
    expect(stdout).not.toContain('org_brands');
    expect(stdout).not.toContain('"org"');
  });
});

// FIX G: `auth setup`'s --json output never consumed org awareness (see the
// single-document test above) — computing it unconditionally cost a
// budgeted getCachedOrgManifest call on every --json run for a value that
// was always thrown away. Pinned as its own mock-call assertion so a future
// regression that reintroduces the unconditional call fails loudly, not just
// as a wasted-budget observation.
describe('auth setup --json — never computes org awareness (FIX G)', () => {
  it('never calls getCachedOrgManifest when --json is passed, even though discovery + the mocked manifest would both succeed', async () => {
    mockedDiscovery.mockResolvedValue({
      index: fakeIndex(['acme']),
      previousDiscoveredAt: null,
    });
    await mkdir(join(clientsDir(dataDir), 'acme'), { recursive: true });
    mockedManifest.mockResolvedValue({
      ok: true,
      fromCache: false,
      brands: [{ brand_slug: 'acme', docs: [] }],
    });

    await runSetup(['--json']);

    expect(mockedManifest).not.toHaveBeenCalled();
  });

  it('non-JSON setup still calls it exactly once (the guard is --json-scoped, not a blanket removal)', async () => {
    mockedDiscovery.mockResolvedValue({
      index: fakeIndex(['acme']),
      previousDiscoveredAt: null,
    });
    await mkdir(join(clientsDir(dataDir), 'acme'), { recursive: true });
    mockedManifest.mockResolvedValue({ ok: false });

    await runSetup();

    expect(mockedManifest).toHaveBeenCalledTimes(1);
  });
});

describe('auth login — org awareness (D-032 sign-in line)', () => {
  const loginResult: AuthLoginResult = {
    ok: true,
    mode: 'device',
    apiBase: 'https://svc.example.test',
    personLabel: 'sam@example.com',
    email: 'tenant@example.com',
    userId: '42',
    clientId: 'test-cli',
    durationMs: 1234,
  };

  async function runLogin(extraArgs: string[] = []): Promise<void> {
    const program = newProgram();
    try {
      await program.parseAsync(
        [
          'auth',
          'login',
          '--person-label',
          'sam@example.com',
          '--mode',
          'device',
          '--data-dir',
          dataDir,
          ...extraArgs,
        ],
        { from: 'user' },
      );
    } catch {
      // exitOverride throws on non-zero exit; assertions read stdout instead.
    }
  }

  it('human output appends "Your org has N brands set up. M not yet on this machine."', async () => {
    vi.mocked(runAuthLogin).mockResolvedValue(loginResult);
    await mkdir(join(clientsDir(dataDir), 'acme'), { recursive: true });
    mockedManifest.mockResolvedValue({
      ok: true,
      fromCache: false,
      brands: [
        { brand_slug: 'acme', docs: [] },
        { brand_slug: 'other-brand', docs: [] },
        { brand_slug: 'third-brand', docs: [] },
      ],
    });

    await runLogin();

    expect(stdout).toContain('✓ Signed in via device-code.');
    expect(stdout).toContain('Your org has 3 brands set up. 2 not yet on this machine.');
  });

  it('--json merges org_brands into the SINGLE result document (no second document)', async () => {
    vi.mocked(runAuthLogin).mockResolvedValue(loginResult);
    mockedManifest.mockResolvedValue({
      ok: true,
      fromCache: false,
      brands: [{ brand_slug: 'acme', docs: [] }],
    });

    await runLogin(['--json']);

    const doc = emittedJson();
    expect(doc.ok).toBe(true);
    expect(doc.org_brands).toEqual({ total: 1, not_local: 1 });
    expect(nthJsonValue(1)).toBeNull();
  });

  it('offline: no org line, no org_brands field, sign-in output otherwise unchanged', async () => {
    vi.mocked(runAuthLogin).mockResolvedValue(loginResult);
    mockedManifest.mockResolvedValue({ ok: false });

    await runLogin();
    expect(stdout).toContain('✓ Signed in via device-code.');
    expect(stdout).not.toContain('Your org has');

    stdout = '';
    await runLogin(['--json']);
    const doc = emittedJson();
    expect(doc.ok).toBe(true);
    expect(doc.org_brands).toBeUndefined();
  });
});

// FIX D: computeOrgAwareness's own doc promises it "never delays sign-in
// beyond the manifest budget" — but the LOCAL listLocalBrands() read (after
// a successful, budgeted getCachedOrgManifest call) had no bound of its own.
// A separate describe block (not nested in "org awareness" above) needs its
// own copy of the run-login helper — `it()` callbacks only close over
// declarations from their OWN describe callback, not a sibling's.
describe('auth login — computeOrgAwareness bounds the local listLocalBrands read (FIX D)', () => {
  async function runLogin(extraArgs: string[] = []): Promise<void> {
    const program = newProgram();
    try {
      await program.parseAsync(
        [
          'auth',
          'login',
          '--person-label',
          'sam@example.com',
          '--mode',
          'device',
          '--data-dir',
          dataDir,
          ...extraArgs,
        ],
        { from: 'user' },
      );
    } catch {
      // exitOverride throws on non-zero exit; assertions read stdout instead.
    }
  }

  it('a never-resolving listLocalBrands does not hang login: the org line is simply omitted, everything else unaffected', async () => {
    vi.mocked(runAuthLogin).mockResolvedValue({
      ok: true,
      mode: 'device',
      apiBase: 'https://svc.example.test',
      personLabel: 'sam@example.com',
      email: 'tenant@example.com',
      userId: '42',
      clientId: 'test-cli',
      durationMs: 1234,
    });
    mockedManifest.mockResolvedValue({
      ok: true,
      fromCache: false,
      brands: [{ brand_slug: 'acme', docs: [] }],
    });
    mockedListLocalBrands.mockImplementationOnce(() => new Promise(() => {}));

    const t0 = Date.now();
    await runLogin();
    const elapsed = Date.now() - t0;

    // Sign-in itself, and its own local brand-count reporting elsewhere, are
    // entirely unaffected — only the org-awareness line is missing.
    expect(stdout).toContain('✓ Signed in via device-code.');
    expect(stdout).not.toContain('Your org has');
    // Bounded well under a real hang (the test runner's own timeout), and
    // comfortably above the ~1s bound so this isn't a flaky race.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('--json form: a never-resolving listLocalBrands omits org_brands but still emits the single result document', async () => {
    vi.mocked(runAuthLogin).mockResolvedValue({
      ok: true,
      mode: 'device',
      apiBase: 'https://svc.example.test',
      personLabel: 'sam@example.com',
      email: 'tenant@example.com',
      userId: '42',
      clientId: 'test-cli',
      durationMs: 1234,
    });
    mockedManifest.mockResolvedValue({
      ok: true,
      fromCache: false,
      brands: [{ brand_slug: 'acme', docs: [] }],
    });
    mockedListLocalBrands.mockImplementationOnce(() => new Promise(() => {}));

    await runLogin(['--json']);

    const doc = emittedJson();
    expect(doc.ok).toBe(true);
    expect(doc.org_brands).toBeUndefined();
    expect(nthJsonValue(1)).toBeNull();
  });
});

describe('auth device-poll — additive org_brands on the approved result only', () => {
  async function runPoll(): Promise<void> {
    const program = newProgram();
    try {
      await program.parseAsync(
        [
          'auth',
          'device-poll',
          'code-123',
          '--person-label',
          'sam@example.com',
          '--data-dir',
          dataDir,
        ],
        { from: 'user' },
      );
    } catch {
      // exitOverride throws on non-zero exit codes (pending = 3).
    }
  }

  it('approved: org_brands merged into the same single document', async () => {
    vi.mocked(pollDeviceFlow).mockResolvedValue({ state: 'approved', result: loginResultFor() });
    mockedManifest.mockResolvedValue({
      ok: true,
      fromCache: false,
      brands: [
        { brand_slug: 'acme', docs: [] },
        { brand_slug: 'other-brand', docs: [] },
      ],
    });

    await runPoll();

    const doc = emittedJson();
    expect(doc.state).toBe('approved');
    expect(doc.org_brands).toEqual({ total: 2, not_local: 2 });
    expect(nthJsonValue(1)).toBeNull();
  });

  it('pending: untouched — no manifest fetch, no org_brands', async () => {
    vi.mocked(pollDeviceFlow).mockResolvedValue({ state: 'pending' });

    await runPoll();

    const doc = emittedJson();
    expect(doc.state).toBe('pending');
    expect(doc.org_brands).toBeUndefined();
    expect(mockedManifest).not.toHaveBeenCalled();
  });

  function loginResultFor(): AuthLoginResult {
    return {
      ok: true,
      mode: 'device',
      apiBase: 'https://svc.example.test',
      personLabel: 'sam@example.com',
      email: 'tenant@example.com',
      userId: '42',
      clientId: 'test-cli',
      durationMs: 1234,
    };
  }
});
