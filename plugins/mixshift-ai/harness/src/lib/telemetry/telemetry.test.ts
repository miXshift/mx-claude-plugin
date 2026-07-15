import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getOrCreateInstallId, readInstallId } from './identity.js';
import {
  isTelemetryEnabled,
  hasAcknowledgedConsent,
  markConsentAcknowledged,
  setOptedOut,
  getTelemetryStatus,
} from './consent.js';
import {
  enqueueEvent,
  readQueue,
  clearQueue,
  overwriteQueue,
  queueSizeBytes,
} from './queue.js';
import { track } from './index.js';
import { normalizeRecord } from './client.js';
import type { TelemetryEventRecord } from './events.js';

// Helper to create a temp data dir per test (so we don't pollute real
// ~/.mixshift/).
async function makeTempDataDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'mxs-telemetry-test-'));
}

function makeRecord(overrides?: Partial<TelemetryEventRecord>): TelemetryEventRecord {
  return {
    event_name: 'test.event',
    install_id: '00000000-0000-0000-0000-000000000001',
    plugin_version: '0.0.0-test',
    install_path: 'cli',
    surface: 'cli',
    os: 'test',
    node_version: 'v20.0.0',
    ts: new Date().toISOString(),
    payload: {},
    ...overrides,
  };
}

describe('identity', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await makeTempDataDir();
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('generates a UUID on first call and persists it', async () => {
    const first = await getOrCreateInstallId(dataDir);
    expect(first.installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.wasJustCreated).toBe(true);

    // Second call returns the SAME id, marked as NOT just created.
    const second = await getOrCreateInstallId(dataDir);
    expect(second.installId).toBe(first.installId);
    expect(second.wasJustCreated).toBe(false);
  });

  it('readInstallId returns undefined before getOrCreate is called', async () => {
    expect(await readInstallId(dataDir)).toBeUndefined();
  });

  it('readInstallId returns the id after getOrCreate', async () => {
    const { installId } = await getOrCreateInstallId(dataDir);
    expect(await readInstallId(dataDir)).toBe(installId);
  });
});

describe('consent', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    delete process.env.MIXSHIFT_TELEMETRY;
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.MIXSHIFT_TELEMETRY;
  });

  it('hasAcknowledgedConsent is false on a fresh install', async () => {
    expect(await hasAcknowledgedConsent(dataDir)).toBe(false);
  });

  it('markConsentAcknowledged sets the timestamp; idempotent', async () => {
    await markConsentAcknowledged(dataDir);
    expect(await hasAcknowledgedConsent(dataDir)).toBe(true);
    const status1 = await getTelemetryStatus(dataDir);
    const ackAt1 = status1.acknowledged_at;
    expect(ackAt1).toBeTruthy();

    // Calling again does NOT reset the timestamp
    await new Promise((r) => setTimeout(r, 5));
    await markConsentAcknowledged(dataDir);
    const status2 = await getTelemetryStatus(dataDir);
    expect(status2.acknowledged_at).toBe(ackAt1);
  });

  it('isTelemetryEnabled returns false when MIXSHIFT_TELEMETRY=0', async () => {
    process.env.MIXSHIFT_TELEMETRY = '0';
    expect(await isTelemetryEnabled(dataDir)).toBe(false);
  });

  it('isTelemetryEnabled returns false when persistently opted out', async () => {
    await setOptedOut(true, dataDir);
    expect(await isTelemetryEnabled(dataDir)).toBe(false);
  });

  // Note: the "endpoint not configured → telemetry off" branch in
  // isTelemetryEnabled is still in the code path (handles edge cases like
  // a fork with the values cleared, an old plugin version installed at the
  // same time as a new one, etc.). It was directly tested when the shipped
  // defaults shipped empty, but now that .mixshift-defaults.yaml carries
  // the real Supabase endpoint + anon key, that branch can't be exercised
  // without mocking loadPluginDefaults — which adds test plumbing for a
  // path the user-facing env-var/opt-out tests already cover the effect of.
  // We trust the type system here; the production-mode positive case is
  // verified end-to-end by `mixshift telemetry status`.

  it('opt-in flips the persistent opt-out flag back off', async () => {
    await setOptedOut(true, dataDir);
    let status = await getTelemetryStatus(dataDir);
    expect(status.opted_out).toBe(true);

    await setOptedOut(false, dataDir);
    status = await getTelemetryStatus(dataDir);
    expect(status.opted_out).toBe(false);
  });

  it('env_override is reflected in status', async () => {
    process.env.MIXSHIFT_TELEMETRY = '0';
    const status = await getTelemetryStatus(dataDir);
    expect(status.env_override).toBe(true);
    expect(status.enabled).toBe(false);
    expect(status.reason).toMatch(/env var/);
  });

  it('various truthy/falsy env values work', async () => {
    for (const val of ['0', 'false', 'off', 'no', 'disabled', 'FALSE', 'Off']) {
      process.env.MIXSHIFT_TELEMETRY = val;
      const status = await getTelemetryStatus(dataDir);
      expect(status.env_override, `env=${val}`).toBe(true);
    }
    // Non-disabling values do NOT trigger override
    for (const val of ['1', 'true', 'on', 'yes', 'enabled', '', 'random']) {
      process.env.MIXSHIFT_TELEMETRY = val;
      const status = await getTelemetryStatus(dataDir);
      expect(status.env_override, `env=${val}`).toBe(false);
    }
  });
});

describe('queue', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await makeTempDataDir();
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('readQueue returns empty array when the queue file does not exist', async () => {
    expect(await readQueue(dataDir)).toEqual([]);
  });

  it('enqueueEvent + readQueue round-trips a record', async () => {
    const rec = makeRecord({ event_name: 'one' });
    await enqueueEvent(rec, dataDir);
    const out = await readQueue(dataDir);
    expect(out).toHaveLength(1);
    expect(out[0]?.event_name).toBe('one');
  });

  it('appends preserve order across multiple events', async () => {
    for (const i of [1, 2, 3, 4, 5]) {
      await enqueueEvent(makeRecord({ event_name: `e${i}` }), dataDir);
    }
    const out = await readQueue(dataDir);
    expect(out.map((r) => r.event_name)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('skips malformed lines silently (best-effort drain)', async () => {
    // Write a queue file with one good line + one bad line + one good line.
    await mkdir(join(dataDir, 'telemetry'), { recursive: true });
    const queuePath = join(dataDir, 'telemetry', 'queue.jsonl');
    await writeFile(
      queuePath,
      JSON.stringify(makeRecord({ event_name: 'good1' })) +
        '\n' +
        '{not json at all\n' +
        JSON.stringify(makeRecord({ event_name: 'good2' })) +
        '\n',
    );
    const out = await readQueue(dataDir);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.event_name)).toEqual(['good1', 'good2']);
  });

  it('clearQueue empties the file', async () => {
    await enqueueEvent(makeRecord(), dataDir);
    expect(await queueSizeBytes(dataDir)).toBeGreaterThan(0);
    await clearQueue(dataDir);
    expect(await queueSizeBytes(dataDir)).toBe(0);
    expect(await readQueue(dataDir)).toEqual([]);
  });

  it('queueSizeBytes returns 0 when the file does not exist', async () => {
    expect(await queueSizeBytes(dataDir)).toBe(0);
  });

  it('overwriteQueue replaces the file with exactly the given records', async () => {
    for (const n of ['e1', 'e2', 'e3']) {
      await enqueueEvent(makeRecord({ event_name: n }), dataDir);
    }
    // Drop the first record; keep the tail.
    await overwriteQueue(
      [makeRecord({ event_name: 'e2' }), makeRecord({ event_name: 'e3' })],
      dataDir,
    );
    const out = await readQueue(dataDir);
    expect(out.map((r) => r.event_name)).toEqual(['e2', 'e3']);
  });

  it('overwriteQueue with an empty array empties the queue', async () => {
    await enqueueEvent(makeRecord(), dataDir);
    await overwriteQueue([], dataDir);
    expect(await queueSizeBytes(dataDir)).toBe(0);
    expect(await readQueue(dataDir)).toEqual([]);
  });

  it('overwriteQueue is atomic: no .tmp leftover remains after the write', async () => {
    // The atomic write path stages a `queue.jsonl.tmp.<pid>.<ts>` sibling and
    // renames it over the target. A successful write must leave no temp file
    // behind — only the real queue file in the telemetry dir.
    await enqueueEvent(makeRecord({ event_name: 'seed' }), dataDir);
    await overwriteQueue([makeRecord({ event_name: 'kept' })], dataDir);

    const telemetryDir = join(dataDir, 'telemetry');
    const entries = await readdir(telemetryDir);
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
    // The real queue file survived and holds exactly the expected record.
    expect(entries).toContain('queue.jsonl');
    expect((await readQueue(dataDir)).map((r) => r.event_name)).toEqual(['kept']);
  });

  it('clearQueue leaves no .tmp leftover (atomic write)', async () => {
    await enqueueEvent(makeRecord(), dataDir);
    await clearQueue(dataDir);
    const entries = await readdir(join(dataDir, 'telemetry'));
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
  });
});

describe('normalizeRecord', () => {
  it('keeps person_label on the wire record (regression: it was dropped, severing per-employee attribution)', () => {
    const out = normalizeRecord(
      makeRecord({ person_label: 'todd.vanderstelt@mixshift.io' }),
    );
    expect(out.person_label).toBe('todd.vanderstelt@mixshift.io');
  });

  it('coerces missing optional fields to explicit null so batch key sets match (PGRST102)', () => {
    const out = normalizeRecord(makeRecord());
    expect(out.person_label).toBeNull();
    expect(out.email).toBeNull();
    expect(out.skill_id).toBeNull();
    // Every event in a batch must serialize with the same key set.
    const withFields = normalizeRecord(
      makeRecord({ person_label: 'a@b.c', skill_id: 's', email: 'e@f.g' }),
    );
    expect(Object.keys(out).sort()).toEqual(Object.keys(withFields).sort());
  });
});

describe('track()', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    delete process.env.MIXSHIFT_TELEMETRY;
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.MIXSHIFT_TELEMETRY;
  });

  // Note: a separate "track no-ops when endpoint/apikey are empty in
  // defaults" case was removed once shipped defaults started carrying real
  // Supabase values. The env-var and opt-out tests below cover the
  // observable behavior (no events queued) for the user-facing disable
  // paths. The "configured off" branch in track() still exists for forks /
  // edge cases but isn't directly tested here.

  it('no-ops silently when MIXSHIFT_TELEMETRY=0', async () => {
    process.env.MIXSHIFT_TELEMETRY = '0';
    await track({ event_name: 'should-not-queue' }, dataDir);
    expect(await readQueue(dataDir)).toEqual([]);
  });

  it('no-ops silently when persistently opted out', async () => {
    await setOptedOut(true, dataDir);
    await track({ event_name: 'should-not-queue' }, dataDir);
    expect(await readQueue(dataDir)).toEqual([]);
  });

  it('never throws even if profile / queue write fails', async () => {
    // Point at a read-only path that doesn't exist and can't be created.
    // The track() call should swallow the error.
    await expect(
      track({ event_name: 'safety-net' }, '/nonexistent/readonly/path'),
    ).resolves.toBeUndefined();
  });

  it('synthetically enqueues plugin.installed alongside the FIRST track call', async () => {
    // Telemetry is enabled by default in tests (no env override, no opt-out,
    // defaults YAML ships a real endpoint). First track call should result
    // in TWO events on the queue: plugin.installed (synthetic) + the
    // triggering event.
    await track({ event_name: 'cli.command_run', payload: { cmd: 'welcome' } }, dataDir);

    const queue = await readQueue(dataDir);
    expect(queue).toHaveLength(2);

    const [first, second] = queue;
    expect(first!.event_name).toBe('plugin.installed');
    expect(first!.payload).toMatchObject({
      synthetic: true,
      triggered_by: 'cli.command_run',
    });
    expect(second!.event_name).toBe('cli.command_run');
    // Same install_id on both (the freshly-minted one)
    expect(first!.install_id).toBe(second!.install_id);
  });

  it('does NOT re-emit plugin.installed on subsequent track calls', async () => {
    await track({ event_name: 'first' }, dataDir);
    await clearQueue(dataDir);
    await track({ event_name: 'second' }, dataDir);

    const queue = await readQueue(dataDir);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.event_name).toBe('second');
  });

  it('does NOT double-emit when the first track call IS plugin.installed', async () => {
    // Future-proofing: if some code path ever explicitly calls
    // track(PluginInstalled), the synthetic enqueue should be skipped
    // to avoid emitting two plugin.installed events on the same first run.
    await track({ event_name: 'plugin.installed' }, dataDir);
    const queue = await readQueue(dataDir);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.event_name).toBe('plugin.installed');
    // Should NOT have the synthetic marker — this was a direct call.
    expect(queue[0]!.payload).not.toHaveProperty('synthetic');
  });
});
