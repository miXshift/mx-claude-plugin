import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendFlushLog, tailFlushLog, flushLogPath } from './flush-log.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `mxtest-flushlog-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('appendFlushLog', () => {
  it('writes a tab-separated line per flush event', async () => {
    await appendFlushLog({ status: 'sent', events_sent: 3 }, testDir);
    const raw = await readFile(flushLogPath(testDir), 'utf-8');
    expect(raw).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\tsent\t3\t\n$/);
  });

  it('appends across multiple calls (oldest first)', async () => {
    await appendFlushLog({ status: 'sent', events_sent: 1 }, testDir);
    await appendFlushLog({ status: 'no_events', events_sent: 0 }, testDir);
    await appendFlushLog({ status: 'failed', events_sent: 2, error: 'network timeout' }, testDir);

    const raw = await readFile(flushLogPath(testDir), 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('sent\t1');
    expect(lines[1]).toContain('no_events\t0');
    expect(lines[2]).toContain('failed\t2\tnetwork timeout');
  });

  it('collapses tabs/newlines in error strings so they don\'t corrupt the column format', async () => {
    await appendFlushLog(
      { status: 'failed', events_sent: 0, error: 'multi\nline\twith\ttabs' },
      testDir,
    );
    const raw = await readFile(flushLogPath(testDir), 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    // The 4 tab-separated columns should be intact — error gets sanitized
    expect(lines[0]!.split('\t')).toHaveLength(4);
    expect(lines[0]).toMatch(/multi line with tabs/);
  });

  it('truncates very long error messages', async () => {
    const longError = 'x'.repeat(500);
    await appendFlushLog({ status: 'failed', events_sent: 0, error: longError }, testDir);
    const raw = await readFile(flushLogPath(testDir), 'utf-8');
    const errCol = raw.split('\t')[3] ?? '';
    expect(errCol.replace(/\n$/, '').length).toBeLessThanOrEqual(300);
  });

  it('never throws even on a read-only path', async () => {
    // Should silently swallow; the diagnostic logging must never break
    // user-facing commands.
    await expect(
      appendFlushLog({ status: 'sent', events_sent: 1 }, '/nonexistent/readonly/path'),
    ).resolves.toBeUndefined();
  });
});

describe('tailFlushLog', () => {
  it('returns empty array when file does not exist', async () => {
    expect(await tailFlushLog(10, testDir)).toEqual([]);
  });

  it('returns the last N lines, oldest first within window', async () => {
    for (let i = 0; i < 10; i++) {
      await appendFlushLog({ status: 'sent', events_sent: i }, testDir);
    }
    const last3 = await tailFlushLog(3, testDir);
    expect(last3).toHaveLength(3);
    expect(last3[0]).toContain('sent\t7');
    expect(last3[1]).toContain('sent\t8');
    expect(last3[2]).toContain('sent\t9');
  });

  it('returns all lines when N > total', async () => {
    await appendFlushLog({ status: 'sent', events_sent: 1 }, testDir);
    await appendFlushLog({ status: 'sent', events_sent: 2 }, testDir);
    const all = await tailFlushLog(10, testDir);
    expect(all).toHaveLength(2);
  });
});
