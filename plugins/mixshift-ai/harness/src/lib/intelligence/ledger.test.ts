import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
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
