import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listIntelligenceRuns,
  recordIntelligenceRun,
  updateIntelligenceRunStatus,
} from './ledger.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mx-intelligence-ledger-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function handle(runId: string) {
  return {
    run_id: runId,
    insight_id: 'INS-MONTHLY-01',
    status: 'IN_QUEUE',
    brand: 'acme',
  };
}

describe('intelligence run handle ledger', () => {
  it('records a run and lists it newest-first with timestamps', async () => {
    await recordIntelligenceRun(handle('run-a'), dataDir);
    await recordIntelligenceRun(handle('run-b'), dataDir);
    const { runs, path } = await listIntelligenceRuns(dataDir);
    expect(runs.map((r) => r.run_id)).toEqual(['run-b', 'run-a']);
    expect(runs[0]!.submitted_at).toBeTruthy();
    expect(runs[0]!.insight_id).toBe('INS-MONTHLY-01');
    expect(path).toContain('intelligence-runs.json');
  });

  it('re-recording the same runId replaces instead of duplicating', async () => {
    await recordIntelligenceRun(handle('run-a'), dataDir);
    await recordIntelligenceRun(handle('run-a'), dataDir);
    const { runs } = await listIntelligenceRuns(dataDir);
    expect(runs).toHaveLength(1);
  });

  it('updates last-seen status in place; unknown runId is a no-op', async () => {
    await recordIntelligenceRun(handle('run-a'), dataDir);
    await updateIntelligenceRunStatus('run-a', 'DONE', dataDir);
    await updateIntelligenceRunStatus('run-zzz', 'DONE', dataDir);
    const { runs } = await listIntelligenceRuns(dataDir);
    expect(runs[0]!.status).toBe('DONE');
    expect(runs).toHaveLength(1);
  });

  it('caps the ledger at 50, dropping the oldest', async () => {
    for (let i = 0; i < 55; i++) {
      await recordIntelligenceRun(handle(`run-${i}`), dataDir);
    }
    const { runs } = await listIntelligenceRuns(dataDir);
    expect(runs).toHaveLength(50);
    expect(runs[0]!.run_id).toBe('run-54');
    expect(runs.some((r) => r.run_id === 'run-0')).toBe(false);
  });

  it('missing file lists empty; corrupt file resets instead of throwing', async () => {
    const empty = await listIntelligenceRuns(dataDir);
    expect(empty.runs).toEqual([]);
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'intelligence-runs.json'), '{not json', 'utf8');
    const corrupt = await listIntelligenceRuns(dataDir);
    expect(corrupt.runs).toEqual([]);
    // A record after corruption rewrites a clean ledger.
    await recordIntelligenceRun(handle('run-after'), dataDir);
    const recovered = await listIntelligenceRuns(dataDir);
    expect(recovered.runs.map((r) => r.run_id)).toEqual(['run-after']);
    const raw = await readFile(join(dataDir, 'intelligence-runs.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Cross-process lock — loadLedger -> mutate -> saveLedger is otherwise an
// unsynchronized read-modify-write across concurrent CLI processes sharing
// a data dir (e.g. two scheduled tasks). recordIntelligenceRun /
// updateIntelligenceRunStatus take a minimal `<ledger>.lock` mutex around
// that critical section.
// ---------------------------------------------------------------------------

describe('ledger lock', () => {
  function lockPathFor(dir: string): string {
    return join(dir, 'intelligence-runs.json.lock');
  }

  it('a second writer waits for the lock and still succeeds', async () => {
    const lockPath = lockPathFor(dataDir);
    await mkdir(dataDir, { recursive: true });
    await writeFile(lockPath, '', { flag: 'wx' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const pending = recordIntelligenceRun(handle('run-a'), dataDir);
    // Release well within the retry budget (15 x 100ms) — simulating the
    // first writer finishing its own critical section.
    await new Promise((r) => setTimeout(r, 250));
    await rm(lockPath, { force: true });
    await pending;

    expect(warnSpy).not.toHaveBeenCalled(); // acquired via retry, not the give-up path
    warnSpy.mockRestore();
    const { runs } = await listIntelligenceRuns(dataDir);
    expect(runs.map((r) => r.run_id)).toEqual(['run-a']);
  });

  it('evicts a stale lock (older than ~2s) instead of waiting out the retry budget', async () => {
    const lockPath = lockPathFor(dataDir);
    await mkdir(dataDir, { recursive: true });
    await writeFile(lockPath, '');
    const old = new Date(Date.now() - 5_000);
    await utimes(lockPath, old, old);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const startedAt = Date.now();
    await recordIntelligenceRun(handle('run-a'), dataDir);

    expect(Date.now() - startedAt).toBeLessThan(1_000); // evicted, not waited out
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    const { runs } = await listIntelligenceRuns(dataDir);
    expect(runs.map((r) => r.run_id)).toEqual(['run-a']);
  });

  it('proceeds best-effort and logs one warning once the retry budget is exhausted', async () => {
    const lockPath = lockPathFor(dataDir);
    await mkdir(dataDir, { recursive: true });
    await writeFile(lockPath, ''); // held for the whole test: never released, never stale
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The command still completes — and the ledger still gets written —
    // even though the lock could never be acquired.
    await recordIntelligenceRun(handle('run-a'), dataDir);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain('lock');
    warnSpy.mockRestore();
    const { runs } = await listIntelligenceRuns(dataDir);
    expect(runs.map((r) => r.run_id)).toEqual(['run-a']);
  }, 10_000);

  it('always releases the lock it acquired, across sequential writes', async () => {
    await recordIntelligenceRun(handle('run-a'), dataDir);
    await recordIntelligenceRun(handle('run-b'), dataDir);
    await expect(readFile(lockPathFor(dataDir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const { runs } = await listIntelligenceRuns(dataDir);
    expect(runs.map((r) => r.run_id)).toEqual(['run-b', 'run-a']);
  });
});
