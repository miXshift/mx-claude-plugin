import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendCaptureDiscoveries,
  discoveriesDocSchema,
  type CaptureInput,
} from './discoveries.js';
import { pendingDiscoveriesPath } from '../paths/resolve.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `mxtest-disc-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(join(testDir, 'clients', 'summit'), { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

const cap = (over: Partial<CaptureInput> = {}): CaptureInput => ({
  field: 'management.acos_target_pct',
  proposed_value: 22,
  source_skill: 'mx-keyword-bid-health',
  observed_by: 'confirm-flow',
  observed_at: '2026-06-18T10:00:00.000Z',
  ...over,
});

describe('appendCaptureDiscoveries', () => {
  it('returns ok:false on empty captures (writes nothing)', async () => {
    const r = await appendCaptureDiscoveries('summit', [], testDir);
    expect(r.ok).toBe(false);
    await expect(
      readFile(pendingDiscoveriesPath('summit', testDir), 'utf-8'),
    ).rejects.toThrow();
  });

  it('writes a schema-valid doc with the proposal (confidence defaults to 0.95)', async () => {
    const r = await appendCaptureDiscoveries('summit', [cap()], testDir);
    expect(r.ok).toBe(true);
    const raw = await readFile(pendingDiscoveriesPath('summit', testDir), 'utf-8');
    const doc = discoveriesDocSchema.parse(JSON.parse(raw)); // throws if invalid
    const props = doc.discoveries.context_field_proposals!;
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({
      field: 'management.acos_target_pct',
      proposed_value: 22,
      confidence: 0.95,
      source_skill: 'mx-keyword-bid-health',
      observed_by: 'confirm-flow',
    });
  });

  it('upserts by field — a newer capture supersedes the older proposal', async () => {
    await appendCaptureDiscoveries('summit', [cap({ proposed_value: 22 })], testDir);
    await appendCaptureDiscoveries(
      'summit',
      [cap({ proposed_value: 18, observed_at: '2026-06-18T11:00:00.000Z' })],
      testDir,
    );
    const raw = await readFile(pendingDiscoveriesPath('summit', testDir), 'utf-8');
    const doc = discoveriesDocSchema.parse(JSON.parse(raw));
    expect(doc.discoveries.context_field_proposals).toHaveLength(1);
    expect(doc.discoveries.context_field_proposals![0]!.proposed_value).toBe(18);
  });

  it('accumulates distinct fields across appends', async () => {
    await appendCaptureDiscoveries('summit', [cap()], testDir);
    await appendCaptureDiscoveries(
      'summit',
      [cap({ field: 'posture.stance', proposed_value: 'scale' })],
      testDir,
    );
    const raw = await readFile(pendingDiscoveriesPath('summit', testDir), 'utf-8');
    const doc = discoveriesDocSchema.parse(JSON.parse(raw));
    expect(doc.discoveries.context_field_proposals).toHaveLength(2);
  });
});
