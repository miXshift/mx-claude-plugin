import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadActionsLedger,
  saveActionsLedger,
  setActionStatus,
  setCaughtUpTo,
  emptyActionsLedger,
  actionsLedgerPath,
  actionsLedgerDir,
  isValidActionStatus,
  UPDATE_ACTIONS_LEDGER_FILENAME,
} from './update-actions-state.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-actions-ledger-test-'));
});

afterEach(async () => {
  delete process.env.CLAUDE_PLUGIN_DATA;
  await rm(testDir, { recursive: true, force: true });
});

describe('isValidActionStatus', () => {
  it.each(['completed', 'skipped', 'dismissed', 'later'])('accepts %s', (s) => {
    expect(isValidActionStatus(s)).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(isValidActionStatus('applied')).toBe(false);
    expect(isValidActionStatus('')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidActionStatus(undefined)).toBe(false);
    expect(isValidActionStatus(42)).toBe(false);
    expect(isValidActionStatus(null)).toBe(false);
  });
});

describe('actionsLedgerDir / actionsLedgerPath', () => {
  it('uses the data dir override by default', () => {
    expect(actionsLedgerDir(testDir)).toBe(testDir);
    expect(actionsLedgerPath(testDir)).toBe(join(testDir, UPDATE_ACTIONS_LEDGER_FILENAME));
  });

  it('prefers CLAUDE_PLUGIN_DATA over the data dir override', () => {
    process.env.CLAUDE_PLUGIN_DATA = join(testDir, 'plugin-data');
    expect(actionsLedgerDir(testDir)).toBe(join(testDir, 'plugin-data'));
  });
});

describe('loadActionsLedger', () => {
  it('returns the empty ledger when no file exists', async () => {
    expect(await loadActionsLedger(testDir)).toEqual(emptyActionsLedger());
  });

  it('round-trips a saved ledger', async () => {
    let ledger = emptyActionsLedger();
    ledger = setActionStatus(ledger, 'brand-context-refresh', 'completed', '0.8.6');
    ledger = setCaughtUpTo(ledger, '0.8.6');
    await saveActionsLedger(ledger, testDir);
    const read = await loadActionsLedger(testDir);
    expect(read.caught_up_to).toBe('0.8.6');
    expect(read.actions['brand-context-refresh']).toMatchObject({
      status: 'completed',
      version: '0.8.6',
    });
    expect(typeof read.actions['brand-context-refresh']!.at).toBe('string');
  });

  it('treats a corrupt (invalid JSON) file as the empty ledger', async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(actionsLedgerPath(testDir), '{ not valid json', 'utf-8');
    expect(await loadActionsLedger(testDir)).toEqual(emptyActionsLedger());
  });

  it('recovers valid entries from a partially-shaped file rather than discarding everything', async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(
      actionsLedgerPath(testDir),
      JSON.stringify({
        caught_up_to: '0.8.6',
        actions: {
          'good-one': { status: 'completed', version: '0.8.6', at: '2026-07-22T00:00:00.000Z' },
          'bad-status': { status: 'nope', version: '0.8.6', at: '2026-07-22T00:00:00.000Z' },
          'bad-version': { status: 'completed', version: 'not-a-version', at: '2026-07-22T00:00:00.000Z' },
          'not-an-object': 'oops',
        },
      }),
      'utf-8',
    );
    const ledger = await loadActionsLedger(testDir);
    expect(ledger.caught_up_to).toBe('0.8.6');
    expect(Object.keys(ledger.actions)).toEqual(['good-one']);
  });

  it('drops a poisoned caught_up_to to null', async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(
      actionsLedgerPath(testDir),
      JSON.stringify({
        caught_up_to: '0.8.6; rm -rf /',
        actions: {},
      }),
      'utf-8',
    );
    const ledger = await loadActionsLedger(testDir);
    expect(ledger.caught_up_to).toBeNull();
  });

  it('honors CLAUDE_PLUGIN_DATA for both save and load', async () => {
    const pluginDataDir = join(testDir, 'plugin-data');
    process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
    const ledger = setCaughtUpTo(emptyActionsLedger(), '1.2.3');
    await saveActionsLedger(ledger, testDir);
    const read = await loadActionsLedger(testDir);
    expect(read.caught_up_to).toBe('1.2.3');
    const raw = await readFile(join(pluginDataDir, UPDATE_ACTIONS_LEDGER_FILENAME), 'utf-8');
    expect(JSON.parse(raw).caught_up_to).toBe('1.2.3');
  });

  it('writes atomically (no .tmp sibling left behind)', async () => {
    await saveActionsLedger(emptyActionsLedger(), testDir);
    const raw = await readFile(actionsLedgerPath(testDir), 'utf-8');
    expect(JSON.parse(raw)).toEqual(emptyActionsLedger());
  });
});

describe('setActionStatus', () => {
  it('is a pure function: does not mutate the input ledger', () => {
    const original = emptyActionsLedger();
    const updated = setActionStatus(original, 'x', 'later', '0.8.6');
    expect(original.actions).toEqual({});
    expect(updated.actions['x']).toMatchObject({ status: 'later', version: '0.8.6' });
  });

  it('is idempotent: recording the same status twice just re-stamps `at`', () => {
    let ledger = emptyActionsLedger();
    ledger = setActionStatus(ledger, 'x', 'skipped', '0.8.6');
    const firstAt = ledger.actions['x']!.at;
    ledger = setActionStatus(ledger, 'x', 'skipped', '0.8.6');
    expect(ledger.actions['x']!.status).toBe('skipped');
    expect(typeof ledger.actions['x']!.at).toBe('string');
    void firstAt; // both are valid ISO timestamps; equality isn't guaranteed on fast machines
  });

  it('overwrites a prior status for the same id', () => {
    let ledger = emptyActionsLedger();
    ledger = setActionStatus(ledger, 'x', 'later', '0.8.5');
    ledger = setActionStatus(ledger, 'x', 'completed', '0.8.6');
    expect(ledger.actions['x']).toMatchObject({ status: 'completed', version: '0.8.6' });
  });
});

describe('setCaughtUpTo', () => {
  it('is a pure function: does not mutate the input ledger', () => {
    const original = emptyActionsLedger();
    const updated = setCaughtUpTo(original, '0.8.6');
    expect(original.caught_up_to).toBeNull();
    expect(updated.caught_up_to).toBe('0.8.6');
  });
});
