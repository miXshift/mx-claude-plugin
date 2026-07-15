import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Control the telemetry defaults so we can force a small batch_size (2) and a
// known endpoint/apikey without depending on the shipped .mixshift-defaults.yaml.
// Isolated to this file so the real loader still runs for the other suites.
vi.mock('../defaults/load.js', () => ({
  loadPluginDefaults: vi.fn(async () => ({
    schema_version: 1,
    telemetry: {
      enabled: true,
      endpoint: 'https://example.test/rest/v1/events',
      apikey: 'test-anon-key',
      batch_size: 2,
    },
  })),
}));

import { flushQueue } from './client.js';
import { enqueueEvent, readQueue } from './queue.js';
import type { TelemetryEventRecord } from './events.js';

async function makeTempDataDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'mxs-flush-test-'));
}

function makeRecord(name: string): TelemetryEventRecord {
  return {
    event_name: name,
    install_id: '00000000-0000-0000-0000-000000000001',
    plugin_version: '0.0.0-test',
    install_path: 'cli',
    surface: 'cli',
    os: 'test',
    node_version: 'v20.0.0',
    ts: new Date().toISOString(),
    payload: {},
  };
}

// Pull the event_name array out of a captured fetch() call's JSON body.
function bodyEventNames(call: unknown[]): string[] {
  const init = call[1] as { body: string };
  const rows = JSON.parse(init.body) as Array<{ event_name: string }>;
  return rows.map((r) => r.event_name);
}

describe('flushQueue incremental per-batch clearing', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('does NOT resend an already-accepted batch when a later batch fails', async () => {
    // Four events, batch_size 2 -> batch A = [e1,e2], batch B = [e3,e4].
    for (const n of ['e1', 'e2', 'e3', 'e4']) {
      await enqueueEvent(makeRecord(n), dataDir);
    }

    // First flush: batch A (call 1) succeeds, batch B (call 2) fails hard.
    const fetch1 = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK' })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        text: async () => 'boom',
      });
    vi.stubGlobal('fetch', fetch1);

    const first = await flushQueue(dataDir);
    expect(first.status).toBe('failed');
    expect(first.events_sent).toBe(2); // only batch A counted
    expect(fetch1).toHaveBeenCalledTimes(2);

    // Batch A was accepted and must be gone from disk; only e3,e4 remain.
    const remaining = await readQueue(dataDir);
    expect(remaining.map((r) => r.event_name)).toEqual(['e3', 'e4']);

    // Second flush: everything succeeds. It must POST ONLY e3,e4 — batch A
    // (e1,e2) must NOT be resent.
    const fetch2 = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetch2);

    const second = await flushQueue(dataDir);
    expect(second.status).toBe('sent');
    expect(second.events_sent).toBe(2);
    expect(fetch2).toHaveBeenCalledTimes(1); // single batch of the 2 survivors

    const posted = bodyEventNames(fetch2.mock.calls[0]!);
    expect(posted).toEqual(['e3', 'e4']);
    expect(posted).not.toContain('e1');
    expect(posted).not.toContain('e2');

    // Queue fully drained.
    expect(await readQueue(dataDir)).toEqual([]);
  });

  it('clears the whole queue when every batch succeeds', async () => {
    for (const n of ['a', 'b', 'c']) {
      await enqueueEvent(makeRecord(n), dataDir);
    }
    const fetchOk = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchOk);

    const res = await flushQueue(dataDir);
    expect(res.status).toBe('sent');
    expect(res.events_sent).toBe(3);
    // 3 events, batch_size 2 -> 2 batches.
    expect(fetchOk).toHaveBeenCalledTimes(2);
    expect(await readQueue(dataDir)).toEqual([]);
  });

  it('never throws and reports failed when the very first batch fails', async () => {
    for (const n of ['x', 'y']) {
      await enqueueEvent(makeRecord(n), dataDir);
    }
    const fetchBad = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchBad);

    const res = await flushQueue(dataDir);
    expect(res.status).toBe('failed');
    expect(res.events_sent).toBe(0);
    // Nothing accepted -> full queue preserved for the next invocation.
    expect((await readQueue(dataDir)).map((r) => r.event_name)).toEqual(['x', 'y']);
  });
});
