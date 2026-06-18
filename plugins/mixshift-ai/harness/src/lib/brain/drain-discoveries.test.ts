import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { drainPendingDiscoveries } from './observe.js';
import { appendCaptureDiscoveries, type CaptureInput } from './discoveries.js';
import { assembleBrain } from './assemble.js';
import { saveBrain, loadBrain } from './read.js';
import { pendingDiscoveriesPath } from '../paths/resolve.js';

let testDir: string;
const NOW = new Date('2026-06-18T10:00:00.000Z');

async function seedBrain(): Promise<void> {
  const brain = assembleBrain({
    brandSlug: 'summit',
    sellerRows: [{ ID: 7, MerchantAlias: 'Summit', ACOSTarget: '25.0' }],
    sellerSproc: 'sp',
    generator: 'plugin@test',
    now: NOW,
  });
  await saveBrain(brain, testDir);
}

async function appendProposal(over: Partial<CaptureInput> = {}): Promise<void> {
  await appendCaptureDiscoveries(
    'summit',
    [
      {
        field: 'management.acos_target_pct',
        proposed_value: 22,
        source_skill: 'mx-keyword-bid-health',
        observed_by: 'confirm-flow',
        observed_at: '2026-06-18T10:00:00.000Z',
        confidence: 0.95,
        ...over,
      },
    ],
    testDir,
  );
}

beforeEach(async () => {
  testDir = join(tmpdir(), `mxtest-drain-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(join(testDir, 'clients', 'summit'), { recursive: true });
});
afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('drainPendingDiscoveries', () => {
  it('folds proposals into brain observations and clears the pending file', async () => {
    await seedBrain();
    await appendProposal();
    const r = await drainPendingDiscoveries('summit', testDir);
    expect(r.ok).toBe(true);
    expect(r.drained).toBe(1);

    const brain = await loadBrain('summit', testDir);
    expect(brain.ok).toBe(true);
    if (brain.ok) {
      const obs = brain.brain.observations['management.acos_target_pct'];
      expect(obs?.value).toBe(22);
      expect(obs?.count).toBe(1);
    }
    // Pending file cleared after a successful drain.
    await expect(
      readFile(pendingDiscoveriesPath('summit', testDir), 'utf-8'),
    ).rejects.toThrow();
  });

  it('is idempotent — a second drain finds nothing', async () => {
    await seedBrain();
    await appendProposal();
    await drainPendingDiscoveries('summit', testDir);
    const r2 = await drainPendingDiscoveries('summit', testDir);
    expect(r2.ok).toBe(true);
    expect(r2.drained).toBe(0);
  });

  it('count-weights repeated captures of the same field (latest value wins)', async () => {
    await seedBrain();
    await appendProposal({ proposed_value: 22 });
    await drainPendingDiscoveries('summit', testDir);
    await appendProposal({ proposed_value: 18, observed_at: '2026-06-18T11:00:00.000Z' });
    await drainPendingDiscoveries('summit', testDir);

    const brain = await loadBrain('summit', testDir);
    expect(brain.ok).toBe(true);
    if (brain.ok) {
      const obs = brain.brain.observations['management.acos_target_pct'];
      expect(obs?.count).toBe(2);
      expect(obs?.value).toBe(18);
    }
  });

  it('keeps proposals when the brain is unavailable (never loses them)', async () => {
    // No brain seeded — recordObservations no-ops, drain must not clear.
    await appendProposal();
    const r = await drainPendingDiscoveries('summit', testDir);
    expect(r.ok).toBe(false);
    const raw = await readFile(pendingDiscoveriesPath('summit', testDir), 'utf-8');
    expect(raw).toContain('management.acos_target_pct');
  });
});
