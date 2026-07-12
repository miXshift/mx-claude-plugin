import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  pushAfterWrite,
  PUSH_AFTER_WRITE_ENV,
  PUSH_AFTER_WRITE_BUDGET_MS,
  __resetPushAfterWriteNotices,
} from './push-after-write.js';
import { push } from './engine.js';
import type { DocActionReport } from './types.js';
import type { ContextSyncState } from './state.js';
import { brandDir, contextSyncStatePath, credentialsPath } from '../paths/resolve.js';

// engine.push is the safety-critical delegate. Stub it so we can (a) assert
// the exact options it is handed (never-force) and (b) drive its outcome
// (reject / not-ok / success) without a network. One test (the budget race)
// swaps in the REAL push via vi.importActual so the AbortController wiring is
// genuinely exercised.
vi.mock('./engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine.js')>();
  return { ...actual, push: vi.fn() };
});

let testDir: string;
let stderrChunks: string[];
let stderrSpy: { mockRestore: () => void };

/** Fake env WITHOUT VITEST so the test-runner guard doesn't short-circuit
 *  (push-after-write opts back in explicitly; see push-after-write.ts). */
const LIVE_ENV: NodeJS.ProcessEnv = {};

/** A ledger with one tracked doc — the minimum that clears the participant
 *  gate (a brand already in the org store). */
const SAMPLE_DOCS: ContextSyncState['docs'] = {
  context: {
    server_revision: 1,
    last_synced_hash: 'a'.repeat(64),
    last_synced_at: '2026-07-01T00:00:00.000Z',
  },
};

beforeEach(async () => {
  // The notice dedup is a module-level Set that outlives one test; clear it so
  // each case starts with a clean slate (and dedup can be asserted directly).
  __resetPushAfterWriteNotices();
  stderrChunks = [];
  // Capture the user-facing notice (and keep it out of the real suite output).
  // No test sets MIXSHIFT_DEBUG, so nothing else writes here.
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      stderrChunks.push(String(chunk));
      return true;
    });
  testDir = join(
    tmpdir(),
    `mxtest-pushafterwrite-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  stderrSpy.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(push).mockReset();
  await rm(testDir, { recursive: true, force: true });
});

const stderrText = (): string => stderrChunks.join('');

/** Auto-publish serves EXISTING local brands only; most tests need the dir. */
async function makeBrandDir(slug: string): Promise<void> {
  await mkdir(brandDir(slug, testDir), { recursive: true });
}

async function writeLedger(slug: string, docs: ContextSyncState['docs']): Promise<void> {
  const path = contextSyncStatePath(slug, testDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ schema: 2, docs }), 'utf8');
}

async function writeCredentials(): Promise<void> {
  const path = credentialsPath(testDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      schema_version: 2,
      created_at: '2026-07-01T00:00:00.000Z',
      datahub: {
        api_base: 'https://mcp.example.test',
        access_token: 'test-token',
        refresh_token: 'refresh-token',
        expires_at: '2099-01-01T00:00:00.000Z',
        refresh_expires_at: '2099-01-01T00:00:00.000Z',
        user_id: 'u1',
        email: 'ops@example.com',
        person_label: 'sam@example.com',
        device_label: 'test-device',
        client_id: 'mx-claude-plugin',
      },
    }),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Kill switch (before any fs / network / push)
// ---------------------------------------------------------------------------

describe('kill switch', () => {
  it.each(['off', 'OFF', '0', 'false'])(
    `returns disabled before any fs/network when ${PUSH_AFTER_WRITE_ENV}=%s`,
    async (value) => {
      // No brand dir, no ledger: if the kill switch did NOT win, the slug
      // checks would return 'skipped', not 'disabled' — so 'disabled' proves
      // it short-circuited first.
      const result = await pushAfterWrite('acme', {
        dataDirOverride: testDir,
        env: { [PUSH_AFTER_WRITE_ENV]: value },
      });
      expect(result).toEqual({ published: false, reason: 'disabled' });
      expect(vi.mocked(push)).not.toHaveBeenCalled();
      expect(await readdir(testDir)).toEqual([]);
    },
  );

  it('is disabled by default under the test runner (VITEST guard) when no env is passed', async () => {
    await makeBrandDir('acme');
    await writeLedger('acme', SAMPLE_DOCS);
    // No env passed → options.env undefined → process.env.VITEST applies.
    const result = await pushAfterWrite('acme', { dataDirOverride: testDir });
    expect(result).toEqual({ published: false, reason: 'disabled' });
    expect(vi.mocked(push)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Write-path safety: slug + brand-dir existence (a write stays a write)
// ---------------------------------------------------------------------------

describe('write-path safety', () => {
  it.each(['../x', 'a/b', '', 'a\\b', '..'])(
    'unsafe slug %j: skipped, filesystem untouched, no push',
    async (slug) => {
      const result = await pushAfterWrite(slug, {
        dataDirOverride: testDir,
        env: LIVE_ENV,
      });
      expect(result).toEqual({
        published: false,
        reason: 'skipped',
        detail: 'not a valid brand slug',
      });
      expect(vi.mocked(push)).not.toHaveBeenCalled();
      // Nothing created anywhere under the data dir: no clients/ tree, and
      // nothing that could have escaped upward.
      expect(await readdir(testDir)).toEqual([]);
    },
  );

  it('missing brand directory: skipped, no push', async () => {
    const result = await pushAfterWrite('ghost', {
      dataDirOverride: testDir,
      env: LIVE_ENV,
    });
    expect(result).toEqual({
      published: false,
      reason: 'skipped',
      detail: 'no local brand directory',
    });
    expect(vi.mocked(push)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Participant gate: enrich only brands already in the org store
// ---------------------------------------------------------------------------

describe('participant gate (sync ledger)', () => {
  it('brand dir exists but no ledger file: skipped with the participant reason, no push', async () => {
    await makeBrandDir('newbie');
    const result = await pushAfterWrite('newbie', {
      dataDirOverride: testDir,
      env: LIVE_ENV,
    });
    expect(result).toEqual({
      published: false,
      reason: 'skipped',
      detail:
        'brand not yet in the org store; publish it explicitly first ' +
        '(context push / context migrate)',
    });
    expect(vi.mocked(push)).not.toHaveBeenCalled();
  });

  it('ledger present but with zero tracked docs: skipped, no push', async () => {
    await makeBrandDir('newbie');
    await writeLedger('newbie', {});
    const result = await pushAfterWrite('newbie', {
      dataDirOverride: testDir,
      env: LIVE_ENV,
    });
    expect(result.published).toBe(false);
    if (!result.published) {
      expect(result.reason).toBe('skipped');
      if (result.reason === 'skipped') {
        expect(result.detail).toContain('not yet in the org store');
      }
    }
    expect(vi.mocked(push)).not.toHaveBeenCalled();
  });

  it('a brand with tracked docs passes the gate and reaches engine.push', async () => {
    await makeBrandDir('acme');
    await writeLedger('acme', SAMPLE_DOCS);
    vi.mocked(push).mockResolvedValue({ ok: true, brand: 'acme', reports: [] });
    const result = await pushAfterWrite('acme', {
      dataDirOverride: testDir,
      env: LIVE_ENV,
    });
    expect(result).toEqual({
      published: true,
      pushed: 0,
      created: 0,
      conflicts: 0,
      errors: 0,
      reports: [],
    });
    expect(vi.mocked(push)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Delegation to engine.push: never force, thread the data dir
// ---------------------------------------------------------------------------

describe('delegation to engine.push', () => {
  it('never passes a force flag (diverged docs stay conflicts by design)', async () => {
    await makeBrandDir('acme');
    await writeLedger('acme', SAMPLE_DOCS);
    vi.mocked(push).mockResolvedValue({ ok: true, brand: 'acme', reports: [] });

    await pushAfterWrite('acme', { dataDirOverride: testDir, env: LIVE_ENV });

    expect(vi.mocked(push)).toHaveBeenCalledTimes(1);
    const [slug, opts] = vi.mocked(push).mock.calls[0]!;
    expect(slug).toBe('acme');
    expect(opts).toBeDefined();
    // The load-bearing assertion: no `force` reaches the engine, ever.
    expect(opts).not.toHaveProperty('force');
  });

  it('threads dataDirOverride through to engine.push', async () => {
    await makeBrandDir('acme');
    await writeLedger('acme', SAMPLE_DOCS);
    vi.mocked(push).mockResolvedValue({ ok: true, brand: 'acme', reports: [] });

    await pushAfterWrite('acme', { dataDirOverride: testDir, env: LIVE_ENV });

    const [, opts] = vi.mocked(push).mock.calls[0]!;
    expect(opts).toMatchObject({ dataDirOverride: testDir });
  });
});

// ---------------------------------------------------------------------------
// Failure isolation: never throws out of the hook
// ---------------------------------------------------------------------------

describe('failure isolation (never throws)', () => {
  it('a rejected engine.push resolves as a quiet failure', async () => {
    await makeBrandDir('acme');
    await writeLedger('acme', SAMPLE_DOCS);
    vi.mocked(push).mockRejectedValue(new Error('boom'));

    const result = await pushAfterWrite('acme', {
      dataDirOverride: testDir,
      env: LIVE_ENV,
    });
    expect(result).toEqual({ published: false, reason: 'failed', detail: 'boom' });
  });

  it('a not-ok engine.push result maps to a quiet failure with the engine message', async () => {
    await makeBrandDir('acme');
    await writeLedger('acme', SAMPLE_DOCS);
    vi.mocked(push).mockResolvedValue({
      ok: false,
      brand: 'acme',
      message: 'the auth service is unreachable',
    });

    const result = await pushAfterWrite('acme', {
      dataDirOverride: testDir,
      env: LIVE_ENV,
    });
    expect(result).toEqual({
      published: false,
      reason: 'failed',
      detail: 'the auth service is unreachable',
    });
  });
});

// ---------------------------------------------------------------------------
// Budget: 2s wall-clock bound + AbortController
// ---------------------------------------------------------------------------

describe('budget', () => {
  it('pins the default budget so a regression cannot silently widen it', () => {
    expect(PUSH_AFTER_WRITE_BUDGET_MS).toBe(2_000);
  });

  it('a push that hangs past the budget resolves as a timed-out failure and fires the abort', async () => {
    await makeBrandDir('acme');
    await writeLedger('acme', SAMPLE_DOCS);
    await writeCredentials();

    // Run the REAL push against a never-resolving fetch so the AbortController
    // the hook wires through budgetedFetch is genuinely exercised end to end.
    const engineActual = await vi.importActual<typeof import('./engine.js')>('./engine.js');
    vi.mocked(push).mockImplementation(engineActual.push);

    // Never settles — not even on abort — so the deadline race is what
    // resolves the hook (a fetch that rejected on abort would let push settle
    // as host_unreachable and win the race first). The abort listener only
    // records that the budget's AbortController fired.
    let aborted = false;
    const hangingFetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>(() => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
      })) as typeof fetch;

    const t0 = Date.now();
    const result = await pushAfterWrite('acme', {
      dataDirOverride: testDir,
      env: LIVE_ENV,
      fetchImpl: hangingFetch,
      budgetMs: 50,
    });
    const elapsed = Date.now() - t0;

    expect(result).toEqual({
      published: false,
      reason: 'failed',
      detail: 'timed out after 50ms',
    });
    // The budget's AbortController actually fired against the in-flight fetch.
    expect(aborted).toBe(true);
    // And it resolved promptly — nowhere near a hang into the suite timeout.
    expect(elapsed).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------
// Success shape: report actions map to counts
// ---------------------------------------------------------------------------

describe('success shape', () => {
  it('maps push reports to pushed / created / conflicts / errors counts', async () => {
    await makeBrandDir('acme');
    await writeLedger('acme', SAMPLE_DOCS);
    const reports: DocActionReport[] = [
      { key: 'context', docType: 'context', action: 'pushed', detail: 'rev 2' },
      { key: 'narrative', docType: 'narrative', action: 'created', detail: 'rev 1' },
      { key: 'brain', docType: 'brain', action: 'conflict', detail: 'diverged' },
      { key: 'config', docType: 'config', action: 'error', detail: 'push failed' },
      // noop is neither pushed/created/conflict/error — must not be counted.
      { key: 'corpus/tone.md', docType: 'corpus', corpusName: 'tone.md', action: 'noop' },
    ];
    vi.mocked(push).mockResolvedValue({ ok: true, brand: 'acme', reports });

    const result = await pushAfterWrite('acme', {
      dataDirOverride: testDir,
      env: LIVE_ENV,
    });
    expect(result).toEqual({
      published: true,
      pushed: 1,
      created: 1,
      conflicts: 1,
      errors: 1,
      reports,
    });
  });
});

// ---------------------------------------------------------------------------
// User-facing notice (STDERR) — "staged + visible": confirm a share, nudge an
// unshared brand toward `context push`, or note a transient failure. Never
// STDOUT; deduped per brand; suppressible; silent for no-news outcomes.
// ---------------------------------------------------------------------------

describe('user-facing notice (stderr)', () => {
  /** A push that actually moved a doc (one pushed + one created = 2 shared). */
  function stubSharedPush(): void {
    vi.mocked(push).mockResolvedValue({
      ok: true,
      brand: 'acme',
      reports: [
        { key: 'context', docType: 'context', action: 'pushed', detail: 'rev 2' },
        { key: 'narrative', docType: 'narrative', action: 'created', detail: 'rev 1' },
      ],
    });
  }

  it('published with docs shared: prints the "Shared ... to your team" confirmation', async () => {
    await makeBrandDir('acme');
    await writeLedger('acme', SAMPLE_DOCS);
    stubSharedPush();

    await pushAfterWrite('acme', { dataDirOverride: testDir, env: LIVE_ENV });

    expect(stderrText()).toBe(`✓ Shared acme to your team's brand context (2 doc(s)).\n`);
  });

  it('participant-gate skip (brand not yet shared): prints the "context push" nudge', async () => {
    await makeBrandDir('newbie'); // brand dir but no ledger → participant gate skip

    await pushAfterWrite('newbie', { dataDirOverride: testDir, env: LIVE_ENV });

    expect(stderrText()).toBe(
      'Saved locally. newbie is not shared with your team yet. ' +
        'Run `mixshift context push --brand newbie` to commit it.\n',
    );
  });

  it('failed push: prints the "could not sync, saved locally" line', async () => {
    await makeBrandDir('acme');
    await writeLedger('acme', SAMPLE_DOCS);
    vi.mocked(push).mockResolvedValue({
      ok: false,
      brand: 'acme',
      message: 'the auth service is unreachable',
    });

    await pushAfterWrite('acme', { dataDirOverride: testDir, env: LIVE_ENV });

    expect(stderrText()).toBe(
      'Could not sync acme to your team just now; your work is saved locally. ' +
        'Retry with `mixshift context push --brand acme`.\n',
    );
  });

  it('disabled (kill switch): silent', async () => {
    const result = await pushAfterWrite('acme', {
      dataDirOverride: testDir,
      env: { [PUSH_AFTER_WRITE_ENV]: 'off' },
    });
    expect(result).toEqual({ published: false, reason: 'disabled' });
    expect(stderrText()).toBe('');
  });

  it('unsafe slug: silent (nothing the user did wrong to hear about)', async () => {
    await pushAfterWrite('../x', { dataDirOverride: testDir, env: LIVE_ENV });
    expect(stderrText()).toBe('');
  });

  it('missing brand directory: silent', async () => {
    await pushAfterWrite('ghost', { dataDirOverride: testDir, env: LIVE_ENV });
    expect(stderrText()).toBe('');
  });

  it('published but nothing changed (all noop): silent — no news', async () => {
    await makeBrandDir('acme');
    await writeLedger('acme', SAMPLE_DOCS);
    vi.mocked(push).mockResolvedValue({
      ok: true,
      brand: 'acme',
      reports: [{ key: 'context', docType: 'context', action: 'noop' }],
    });

    const result = await pushAfterWrite('acme', { dataDirOverride: testDir, env: LIVE_ENV });

    expect(result.published).toBe(true);
    expect(stderrText()).toBe('');
  });

  it('deduped per brand per process: two shares of one brand print one line', async () => {
    await makeBrandDir('acme');
    await writeLedger('acme', SAMPLE_DOCS);
    stubSharedPush();

    await pushAfterWrite('acme', { dataDirOverride: testDir, env: LIVE_ENV });
    await pushAfterWrite('acme', { dataDirOverride: testDir, env: LIVE_ENV });

    expect(stderrChunks.filter((c) => c.includes('✓ Shared acme')).length).toBe(1);

    // Dedup is per BRAND: a different brand still prints its own line.
    await makeBrandDir('other');
    await writeLedger('other', SAMPLE_DOCS);
    await pushAfterWrite('other', { dataDirOverride: testDir, env: LIVE_ENV });

    expect(stderrText()).toContain('✓ Shared other');
  });

  it('notify:false suppresses the notice even on a real share', async () => {
    await makeBrandDir('acme');
    await writeLedger('acme', SAMPLE_DOCS);
    stubSharedPush();

    const result = await pushAfterWrite('acme', {
      dataDirOverride: testDir,
      env: LIVE_ENV,
      notify: false,
    });

    expect(result.published).toBe(true);
    expect(stderrText()).toBe('');
  });
});
