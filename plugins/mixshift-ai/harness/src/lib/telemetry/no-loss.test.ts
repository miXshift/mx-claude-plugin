import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir, utimes, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Same defaults stub as flush.test.ts: batch_size 2, a fixed endpoint.
vi.mock('../defaults/load.js', () => ({
  loadPluginDefaults: vi.fn(async () => ({
    schema_version: 1,
    telemetry: {
      enabled: true,
      endpoint: 'https://example.test/telemetry/events',
      apikey: 'test-key',
      batch_size: 2,
    },
  })),
}));

import { flushQueue, normalizeRecord, toInt4 } from './client.js';
import { enqueueEvent, readQueue, queueSizeBytes, deadLetterPath, deadLetterCount, isNewerVersion } from './queue.js';
import type { TelemetryEventRecord } from './events.js';

function makeRecord(name: string, extra: Partial<TelemetryEventRecord> = {}): TelemetryEventRecord {
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
    ...extra,
  };
}

function names(call: unknown[]): string[] {
  return (JSON.parse((call[1] as { body: string }).body) as Array<{ event_name: string }>).map((r) => r.event_name);
}

const ok = () => ({ ok: true, status: 200, statusText: 'OK' });
const status = (s: number) => ({ ok: false, status: s, statusText: 'x', text: async () => `status ${s}` });

async function telemetryFiles(dataDir: string): Promise<string[]> {
  try {
    return (await readdir(join(dataDir, 'telemetry'))).sort();
  } catch {
    return [];
  }
}

describe('telemetry flush never loses events', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'mxs-noloss-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('keeps an event another process appends while a flush is in flight', async () => {
    for (const n of ['a', 'b', 'c']) await enqueueEvent(makeRecord(n), dataDir);

    // While the first POST is in flight, a concurrent `mixshift` run tracks an event.
    let appended = false;
    const fetchMock = vi.fn(async () => {
      if (!appended) {
        appended = true;
        await enqueueEvent(makeRecord('concurrent'), dataDir);
      }
      return ok();
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await flushQueue(dataDir);
    expect(res.status).toBe('sent');
    expect(res.events_sent).toBe(3);
    // Before the claim-based drain, the flusher's rewrite truncated this away.
    expect((await readQueue(dataDir)).map((r) => r.event_name)).toEqual(['concurrent']);
    // No in-flight file is left behind.
    expect((await telemetryFiles(dataDir)).filter((f) => f.startsWith('queue.inflight.'))).toEqual([]);
  });

  it('two flushes running at once send every event exactly once', async () => {
    for (const n of ['e1', 'e2', 'e3', 'e4', 'e5']) await enqueueEvent(makeRecord(n), dataDir);
    const fetchMock = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return ok();
    });
    vi.stubGlobal('fetch', fetchMock);

    const [x, y] = await Promise.all([flushQueue(dataDir), flushQueue(dataDir)]);
    const posted = fetchMock.mock.calls.flatMap((c) => names(c as unknown[]));
    expect(posted.sort()).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(x.events_sent + y.events_sent).toBe(5);
    expect(await readQueue(dataDir)).toEqual([]);
  });

  it('a permanently rejected row is dead-lettered and no longer blocks the rows behind it', async () => {
    for (const n of ['good1', 'bad', 'good2']) await enqueueEvent(makeRecord(n), dataDir);
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const rows = JSON.parse(init.body) as Array<{ event_name: string }>;
      return rows.some((r) => r.event_name === 'bad') ? status(400) : ok();
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await flushQueue(dataDir);
    expect(res.status).toBe('sent');
    expect(res.events_sent).toBe(2);
    expect(res.dead_lettered).toBe(1);
    expect(await readQueue(dataDir)).toEqual([]);

    const dl = (await readFile(deadLetterPath(dataDir), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(dl).toHaveLength(1);
    expect(dl[0].status).toBe(400);
    expect(dl[0].record.event_name).toBe('bad');

    // Batch [good1,bad] -> 400, then good1 alone, bad alone, then [good2].
    expect(fetchMock.mock.calls.map((c) => names(c as unknown[]))).toEqual([['good1', 'bad'], ['good1'], ['bad'], ['good2']]);
  });

  it('a transient failure keeps every unsent event queued, in order, and dead-letters nothing', async () => {
    for (const n of ['x', 'y', 'z']) await enqueueEvent(makeRecord(n), dataDir);
    for (const s of [500, 503, 429, 404, 401]) {
      vi.stubGlobal('fetch', vi.fn(async () => status(s)));
      const res = await flushQueue(dataDir);
      expect(res.status).toBe('failed');
      expect((await readQueue(dataDir)).map((r) => r.event_name)).toEqual(['x', 'y', 'z']);
    }
    await expect(readFile(deadLetterPath(dataDir), 'utf-8')).rejects.toThrow();
  });

  it('adopts an in-flight file orphaned by a killed flusher', async () => {
    const dir = join(dataDir, 'telemetry');
    await mkdir(dir, { recursive: true });
    const orphan = join(dir, 'queue.inflight.99999.1.deadbeef.jsonl');
    await writeFile(orphan, [makeRecord('orphan1'), makeRecord('orphan2')].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(orphan, old, old);
    await enqueueEvent(makeRecord('live'), dataDir);
    expect(await queueSizeBytes(dataDir)).toBeGreaterThan(0);

    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    const res = await flushQueue(dataDir);
    expect(res.events_sent).toBe(3);
    expect(fetchMock.mock.calls.flatMap((c) => names(c as unknown[])).sort()).toEqual(['live', 'orphan1', 'orphan2']);
    expect(await telemetryFiles(dataDir)).toEqual([]);
  });

  it('does NOT adopt a fresh in-flight file (a live flusher owns it)', async () => {
    const dir = join(dataDir, 'telemetry');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'queue.inflight.1.2.cafe.jsonl'), JSON.stringify(makeRecord('owned')) + '\n');
    await enqueueEvent(makeRecord('live'), dataDir);
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    await flushQueue(dataDir);
    expect(fetchMock.mock.calls.flatMap((c) => names(c as unknown[]))).toEqual(['live']);
    expect(await telemetryFiles(dataDir)).toEqual(['queue.inflight.1.2.cafe.jsonl']);
  });

  it('when the dead-letter file is full, a rejected row stays queued instead of being dropped', async () => {
    const dir = join(dataDir, 'telemetry');
    await mkdir(dir, { recursive: true });
    await writeFile(deadLetterPath(dataDir), 'x'.repeat(5 * 1024 * 1024));
    for (const n of ['bad', 'good']) await enqueueEvent(makeRecord(n), dataDir);
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) =>
      (JSON.parse(init.body) as Array<{ event_name: string }>).some((r) => r.event_name === 'bad') ? status(422) : ok()));

    const res = await flushQueue(dataDir);
    expect(res.events_sent).toBe(1);
    expect(res.dead_lettered).toBeUndefined();
    expect((await readQueue(dataDir)).map((r) => r.event_name)).toEqual(['bad']);
  });

  it('bytes written into the claimed file after it was read are handed back, not destroyed', async () => {
    for (const n of ['a', 'b']) await enqueueEvent(makeRecord(n), dataDir);
    const dir = join(dataDir, 'telemetry');
    // During the first POST, a writer that opened queue.jsonl before the rename
    // finishes its append into what is now the claimed in-flight file.
    let done = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (!done) {
        done = true;
        const inflight = (await readdir(dir)).find((f) => f.startsWith('queue.inflight.') && !f.includes('.tmp.'))!;
        await appendFile(join(dir, inflight), JSON.stringify(makeRecord('late')) + '\n');
      }
      return ok();
    }));
    const res = await flushQueue(dataDir);
    expect(res.events_sent).toBe(2);
    expect((await readQueue(dataDir)).map((r) => r.event_name)).toEqual(['late']);
  });

  it('a claimed queue that was last written long ago is not adopted by a second flusher', async () => {
    for (const n of ['e1', 'e2', 'e3']) await enqueueEvent(makeRecord(n), dataDir);
    const q = join(dataDir, 'telemetry', 'queue.jsonl');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(q, old, old);
    const fetchMock = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return ok();
    });
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([flushQueue(dataDir), flushQueue(dataDir)]);
    const posted = fetchMock.mock.calls.flatMap((c) => names(c as unknown[]));
    expect(posted.sort()).toEqual(['e1', 'e2', 'e3']);
  });

  it('an unparseable queue line is set aside verbatim, not dropped', async () => {
    const dir = join(dataDir, 'telemetry');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'queue.jsonl'), JSON.stringify(makeRecord('fine')) + '\n{"torn":\n');
    vi.stubGlobal('fetch', vi.fn(async () => ok()));
    const res = await flushQueue(dataDir);
    expect(res.events_sent).toBe(1);
    const dl = (await readFile(deadLetterPath(dataDir), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(dl).toEqual([expect.objectContaining({ status: 0, raw_line: '{"torn":' })]);
    expect(await deadLetterCount(dataDir)).toBe(1);
  });

  it('set-aside events are sent again once after the plugin version changes', async () => {
    const dir = join(dataDir, 'telemetry');
    await mkdir(dir, { recursive: true });
    await writeFile(
      deadLetterPath(dataDir),
      JSON.stringify({ dead_lettered_at: 'x', status: 400, error: 'e', record: makeRecord('retry-me') }) + '\n' +
        JSON.stringify({ dead_lettered_at: 'x', status: 0, error: 'unparseable queue line', raw_line: '{' }) + '\n',
    );
    await writeFile(join(dir, 'deadletter.version'), '0.0.0-older');
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);

    const first = await flushQueue(dataDir);
    expect(first.events_sent).toBe(1);
    expect(fetchMock.mock.calls.flatMap((c) => names(c as unknown[]))).toEqual(['retry-me']);
    // The unreplayable line stays; the replay does not repeat on the same version.
    expect(await deadLetterCount(dataDir)).toBe(1);
    await enqueueEvent(makeRecord('next'), dataDir);
    await flushQueue(dataDir);
    expect(fetchMock.mock.calls.flatMap((c) => names(c as unknown[]))).toEqual(['retry-me', 'next']);
  });

  it('a torn half-line handed back never glues onto the next event', async () => {
    for (const n of ['a', 'b']) await enqueueEvent(makeRecord(n), dataDir);
    const dir = join(dataDir, 'telemetry');
    let done = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (!done) {
        done = true;
        const inflight = (await readdir(dir)).find((f) => f.startsWith('queue.inflight.') && !f.includes('.tmp.'))!;
        await appendFile(join(dir, inflight), '{"event_name":"spl'); // a write that never finishes
      }
      return ok();
    }));
    await flushQueue(dataDir);
    await enqueueEvent(makeRecord('next'), dataDir);
    const raw = await readFile(join(dir, 'queue.jsonl'), 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    expect(lines).toContain('{"event_name":"spl');
    expect((await readQueue(dataDir)).map((r) => r.event_name)).toEqual(['next']);
  });

  it('an unparseable line goes back into the queue when it cannot be set aside', async () => {
    const dir = join(dataDir, 'telemetry');
    await mkdir(dir, { recursive: true });
    await writeFile(deadLetterPath(dataDir), 'x'.repeat(5 * 1024 * 1024));
    await writeFile(join(dir, 'queue.jsonl'), '{"torn":\n' + JSON.stringify(makeRecord('fine')) + '\n');
    vi.stubGlobal('fetch', vi.fn(async () => ok()));
    const res = await flushQueue(dataDir);
    expect(res.events_sent).toBe(1);
    expect((await readFile(join(dir, 'queue.jsonl'), 'utf-8')).split('\n')).toContain('{"torn":');
  });

  it('stops isolating when the server refuses everything (systemic), keeping the rest queued', async () => {
    for (let n = 0; n < 8; n++) await enqueueEvent(makeRecord(`r${n}`), dataDir);
    const fetchMock = vi.fn(async () => status(400));
    vi.stubGlobal('fetch', fetchMock);
    const res = await flushQueue(dataDir);
    expect(res.status).toBe('failed');
    expect(res.dead_lettered).toBe(4); // two batches of 2, isolated, then the breaker trips
    expect((await readQueue(dataDir)).map((r) => r.event_name)).toEqual(['r4', 'r5', 'r6', 'r7']);
    expect(fetchMock).toHaveBeenCalledTimes(6); // 2 x (batch + 2 singles)
  });

  it('a flush past its time budget leaves the rest queued instead of running on', async () => {
    for (let n = 0; n < 6; n++) await enqueueEvent(makeRecord(`t${n}`), dataDir);
    let now = 5_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      vi.stubGlobal('fetch', vi.fn(async () => {
        now += 3_000;
        return ok();
      }));
      const res = await flushQueue(dataDir);
      expect(res.status).toBe('sent');
      expect(res.events_sent).toBe(4);
      expect((await readQueue(dataDir)).map((r) => r.event_name)).toEqual(['t4', 't5']);
    } finally {
      spy.mockRestore();
    }
  });

  it('an older or equal plugin version never replays what a newer one set aside', async () => {
    const dir = join(dataDir, 'telemetry');
    await mkdir(dir, { recursive: true });
    await writeFile(deadLetterPath(dataDir), JSON.stringify({ status: 400, error: 'e', record: makeRecord('held') }) + '\n');
    await writeFile(join(dir, 'deadletter.version'), '999.0.0');
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    expect((await flushQueue(dataDir)).status).toBe('no_events');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await deadLetterCount(dataDir)).toBe(1);
  });

  it('an empty queue is a no-op and leaves no files', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect((await flushQueue(dataDir)).status).toBe('no_events');
    expect((await telemetryFiles(dataDir)).filter((f) => f.startsWith('queue.inflight.'))).toEqual([]);
  });
});

describe('normalizeRecord makes every value storable', () => {
  it('removes NUL and replaces unpaired surrogates, everywhere, keeping valid pairs', () => {
    const rec = makeRecord('plugin.crashed', {
      error_class: 'boom\u0000',
      payload: {
        message: 'bad\u0000byte',
        args: ['ok', 'lone\uD800high', 'lone\uDC00low'],
        nested: { 'k\u0000ey': 'emoji 😀 stays' },
        when: new Date('2026-09-28T01:10:31.544Z'),
      },
    });
    const out = normalizeRecord(rec) as { error_class: string; payload: Record<string, any> };
    expect(out.error_class).toBe('boom');
    expect(out.payload.message).toBe('badbyte');
    expect(out.payload.args).toEqual(['ok', 'lone�high', 'lone�low']);
    expect(out.payload.nested).toEqual({ key: 'emoji 😀 stays' });
    expect(out.payload.when).toBe('2026-09-28T01:10:31.544Z');
    expect(JSON.stringify(out)).not.toMatch(/\\u0000|\\ud[89ab]/i);
  });

  it('keeps every row under the ingest size cap', () => {
    const huge = normalizeRecord(makeRecord('feedback.submitted', {
      event_name: 'x'.repeat(300),
      payload: { message: 'y'.repeat(100_000), a: 'z'.repeat(40_000), b: 'z'.repeat(40_000), c: 'z'.repeat(40_000), d: 'z'.repeat(40_000), e: 'z'.repeat(40_000), f: 'z'.repeat(40_000), g: 'z'.repeat(40_000) },
    })) as { event_name: string; payload: Record<string, unknown> };
    expect(huge.event_name).toHaveLength(128);
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThan(256 * 1024);
    expect(huge.payload.payload_truncated).toBe(true);
    expect(huge.payload.keys).toContain('message');
    const oneLong = normalizeRecord(makeRecord('plugin.crashed', { payload: { message: 'm'.repeat(50_000) } })) as { payload: { message: string } };
    expect(oneLong.payload.message.endsWith('...[truncated]')).toBe(true);
    expect(oneLong.payload.message.length).toBeLessThan(33_000);
  });

  it('compares plugin versions numerically', () => {
    expect(isNewerVersion('0.8.16', '0.8.15')).toBe(true);
    expect(isNewerVersion('0.8.10', '0.8.9')).toBe(true);
    expect(isNewerVersion('0.8.15', '0.8.15')).toBe(false);
    expect(isNewerVersion('0.8.14', '0.8.15')).toBe(false);
    expect(isNewerVersion('0.9.0', '0.8.99')).toBe(true);
    expect(isNewerVersion('0.8.15', '0.8.15-rc.1')).toBe(true);
    expect(isNewerVersion('garbage', '0.8.15')).toBe(false);
  });

  it('integer columns are rounded, or null when they cannot be an int4', () => {
    expect(toInt4(12.6)).toBe(13);
    expect(toInt4('42')).toBe(42);
    expect(toInt4(undefined)).toBeNull();
    expect(toInt4(Number.NaN)).toBeNull();
    expect(toInt4(3_000_000_000)).toBeNull();
    expect(toInt4('abc')).toBeNull();
    const out = normalizeRecord(makeRecord('query.executed', { duration_ms: 1534.4, row_count: 7 }));
    expect(out.duration_ms).toBe(1534);
    expect(out.row_count).toBe(7);
  });
});
