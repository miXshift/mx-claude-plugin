/**
 * Command-level tests for `mixshift shelf tracking ...`: the flag-to-call
 * mapping (request shapes), the readable render and the --json shapes the
 * skill reads, the refusals (role, allowance, a taken id, delete without
 * --yes) with their exit codes, and telemetry that carries counts and the
 * outcome but never a set id, a note, a keyword, a zip or an ASIN.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';

import { registerShelfCommands } from './shelf.js';
import { renderTrackingList } from './shelf-tracking.js';
import { shelfTrackingDelete, shelfTrackingGet, shelfTrackingList, shelfTrackingPatch, shelfTrackingPut, type ShelfTrackingSet } from '../lib/shelf/tracking.js';
import type { ShelfFailure } from '../lib/shelf/client.js';
import { track } from '../lib/telemetry/index.js';

vi.mock('../lib/shelf/tracking.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/shelf/tracking.js')>();
  return {
    ...actual,
    shelfTrackingList: vi.fn(),
    shelfTrackingGet: vi.fn(),
    shelfTrackingPut: vi.fn(),
    shelfTrackingPatch: vi.fn(),
    shelfTrackingDelete: vi.fn(),
  };
});

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return { ...actual, track: vi.fn(async () => {}) };
});

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'emit machine-readable JSON to stdout', false)
    .option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR')
    // The real root program owns --surface (cli.ts); declared so a tracking flag can never collide with it unnoticed.
    .option('--surface <surface>', 'telemetry host flag');
  registerShelfCommands(program);
  return program;
}

async function run(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', ...args]);
}

let stdout = '';
let stderr = '';
beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const m of [shelfTrackingList, shelfTrackingGet, shelfTrackingPut, shelfTrackingPatch, shelfTrackingDelete]) vi.mocked(m).mockReset();
  vi.mocked(track).mockClear();
  process.exitCode = undefined;
});

const lastTrack = () =>
  vi.mocked(track).mock.calls.at(-1)![0] as { event_name: string; outcome?: string; error_class?: string; payload: Record<string, unknown> };
/** Every value a user typed or the service returned about the set: none of it may reach telemetry. */
const PRIVATE = /trail|snack|granola|nut mix|10001|60601|B00000000|person@example|Example snack/i;
const noValuesInTelemetry = () => expect(JSON.stringify(vi.mocked(track).mock.calls)).not.toMatch(PRIVATE);

// Made-up values: this repo is public.
const SET: ShelfTrackingSet = {
  id: 'trail-snacks',
  retailer: 'amazon',
  country: 'us',
  keywords: ['trail mix', 'nut mix'],
  zips: ['10001', '60601'],
  surfaces: ['desktop', 'mobile'],
  asins: ['B000000001'],
  pages: 1,
  cadence: 'daily',
  enabled: true,
  note: 'Example snack terms',
  calls_per_day: 8,
  last_run_date: '2026-11-16',
  last_run_at: '2026-11-16T10:04:00.000Z',
  last_run_summary: { calls: 8, ok: 7, failed: 1, stale: 0, exhausted: 0, stopped_reason: null },
  updated_at: '2026-11-15T18:00:00.000Z',
  updated_by: 'person@example.com',
};
const LIMITS = { max_keywords: 50, max_zips: 10, max_pages: 5, max_asins: 100, max_calls_per_day_per_set: 200 };
const PAUSED: ShelfTrackingSet = { ...SET, id: 'granola-test', keywords: ['granola'], zips: ['10001'], surfaces: ['desktop'], asins: [], note: null, calls_per_day: 1, enabled: false, last_run_at: null, last_run_date: null, last_run_summary: null };
const LIST = { ok: true as const, sets: [SET, PAUSED], projected_calls_per_month: 248, allowance: 2000, can_edit: true, limits: LIMITS };
const written = (set: ShelfTrackingSet, projected = 248) => ({ ok: true as const, set, projected_calls_per_month: projected, allowance: 2000 });
const notFound: ShelfFailure = { ok: false, kind: 'not_found', friendly: 'Your organization has no rank tracking set with that id.', httpStatus: 404, source: 'request', retryable: false };
const FORBIDDEN: ShelfFailure = { ok: false, kind: 'forbidden', friendly: 'Only an owner, admin or manager of your organization can change rank tracking.', httpStatus: 403, source: 'account', retryable: false };
/** The per-set cap, as the service answers it: invalid_request with both numbers. */
const CAP: ShelfFailure = {
  ok: false,
  kind: 'invalid_request',
  friendly: 'keywords x zips x surfaces x pages is 240 calls a day; the limit is 200. Split it into more sets or trim it.',
  message: 'keywords x zips x surfaces x pages is 240 calls a day; the limit is 200. Split it into more sets or trim it.',
  httpStatus: 400,
  callsPerDay: 240,
  maxCallsPerDayPerSet: 200,
  source: 'request',
  retryable: false,
};
const OVER: ShelfFailure = {
  ok: false,
  kind: 'tracking_over_allowance',
  friendly: 'This change would bring your rank tracking past your monthly allowance.',
  httpStatus: 402,
  projectedCallsPerMonth: 2232,
  allowance: 2000,
  requestMore: 'Ask MixShift to raise it.',
  source: 'account',
  retryable: false,
};

describe('shelf tracking list', () => {
  it('--json after the subcommand prints the envelope; telemetry carries counts only', async () => {
    vi.mocked(shelfTrackingList).mockResolvedValueOnce(LIST);
    await run('shelf', 'tracking', 'list', '--json');
    expect(shelfTrackingList).toHaveBeenCalledWith({ dataDirOverride: undefined });
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ok', projected_calls_per_month: 248, allowance: 2000, can_edit: true, sets: [{ id: 'trail-snacks' }, { id: 'granola-test' }] });
    expect(process.exitCode).toBeUndefined();
    const t = lastTrack();
    expect(t).toMatchObject({ event_name: 'shelf.tracking_read', outcome: 'ok', payload: { action: 'list', sets: 2, running: 1, can_edit: true, keywords: 3, calls_per_day: 8, projected_calls_per_month: 248, allowance: 2000 } });
    noValuesInTelemetry();
  });

  it('renders each set with note, counts, zips, views, pages, calls a day, enabled and last run, then the projection', async () => {
    vi.mocked(shelfTrackingList).mockResolvedValueOnce(LIST);
    await run('shelf', 'tracking', 'list');
    expect(stderr).toContain('2 rank tracking set(s), 1 running');
    expect(stdout).toContain('| set | note | keywords | zips | views | pages | calls a day | enabled | last run |');
    expect(stdout).toContain('| trail-snacks | Example snack terms | 2 | 10001, 60601 | desktop, mobile | 1 | 8 | yes | 2026-11-16 (7 of 8 ok, 1 failed) |');
    expect(stdout).toContain('| granola-test | - | 1 | 10001 | desktop | 1 | 1 | no (paused) | not yet |');
    expect(stdout).toContain('Projected monthly use: 248 of 2000 shelf requests a month for rank tracking.');
    expect(stdout).toContain('You can change these sets (owner, admin or manager)');
    expect(stdout).toContain('up to 50 keywords, 10 zips and 5 pages, and at most 200 calls a day');
  });

  it('says who can change the sets when you cannot, flags a projection over the allowance, and handles no sets', () => {
    const md = renderTrackingList({ ...LIST, can_edit: false, projected_calls_per_month: 2232 });
    expect(md).toContain('Only an owner, admin or manager can change these sets');
    expect(md).toContain('2232 of 2000 shelf requests a month for rank tracking, 232 over the allowance');
    expect(md).not.toContain('A set holds up to');
    const empty = renderTrackingList({ ...LIST, sets: [], projected_calls_per_month: 0 });
    expect(empty).toContain('_(no rank tracking sets yet)_');
    expect(empty).toContain('mixshift shelf tracking create <set>');
  });

  it('a failure prints the friendly line and its exit code', async () => {
    vi.mocked(shelfTrackingList).mockResolvedValueOnce({ ok: false, kind: 'shelf_not_enabled', friendly: 'Shelf data is not enabled.', httpStatus: 403 });
    await run('--json', 'shelf', 'tracking', 'list');
    expect(JSON.parse(stdout)).toMatchObject({ status: 'error', failure_kind: 'shelf_not_enabled', message: 'Shelf data is not enabled.' });
    expect(process.exitCode).toBe(6);
    expect(lastTrack()).toMatchObject({ outcome: 'failed', error_class: 'shelf_not_enabled', payload: { action: 'list', kind_failed: 'shelf_not_enabled' } });
  });
});

describe('shelf tracking show', () => {
  it('asks for the id and prints every keyword and ASIN', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce({ ok: true, set: SET });
    await run('shelf', 'tracking', 'show', 'trail-snacks');
    expect(shelfTrackingGet).toHaveBeenCalledWith('trail-snacks', { dataDirOverride: undefined });
    expect(stdout).toContain('**Tracking set `trail-snacks`** (amazon us)');
    expect(stdout).toContain('1. trail mix\n2. nut mix');
    expect(stdout).toContain('B000000001');
    expect(stdout).toContain('- calls a day: 8 (2 keywords x 2 zips x 2 views x 1 page)');
    expect(stdout).toContain('- last changed: 2026-11-15 by person@example.com');
    expect(lastTrack()).toMatchObject({ event_name: 'shelf.tracking_read', payload: { action: 'show', keywords: 2, asins: 1, zips: 2, views: 2, pages: 1, calls_per_day: 8, enabled: true } });
    noValuesInTelemetry();
  });

  it('--json is the set; a bad id is refused before any call', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce({ ok: true, set: SET });
    await run('--json', 'shelf', 'tracking', 'show', 'trail-snacks');
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ok', set: { id: 'trail-snacks', keywords: ['trail mix', 'nut mix'], asins: ['B000000001'] } });

    vi.mocked(shelfTrackingGet).mockClear();
    stdout = '';
    await run('--json', 'shelf', 'tracking', 'show', 'Trail Snacks!');
    expect(shelfTrackingGet).not.toHaveBeenCalled();
    expect(JSON.parse(stdout)).toMatchObject({ status: 'error', message: expect.stringContaining('lower-case letters, digits or hyphens') });
    expect(process.exitCode).toBe(1);
  });
});

describe('shelf tracking create', () => {
  it('checks the id is free, then PUTs the normalized set; prints what it holds, calls a day and the projection', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce(notFound);
    vi.mocked(shelfTrackingPut).mockResolvedValueOnce(written(SET));
    await run(
      'shelf', 'tracking', 'create', 'trail-snacks',
      '--keyword', '  Trail   Mix ', '--keyword', 'nut mix', '--keyword', 'trail mix',
      '--zip', '10001', '--zip', '60601',
      '--view', 'desktop', '--view', 'mobile',
      '--asin', 'b000000001',
      '--pages', '1',
      '--note', 'Example snack terms',
    );
    expect(shelfTrackingGet).toHaveBeenCalledWith('trail-snacks', { dataDirOverride: undefined });
    expect(shelfTrackingPut).toHaveBeenCalledWith(
      'trail-snacks',
      { keywords: ['trail mix', 'nut mix'], zips: ['10001', '60601'], surfaces: ['desktop', 'mobile'], asins: ['B000000001'], pages: 1, note: 'Example snack terms' },
      { dataDirOverride: undefined },
    );
    expect(stderr).toContain('created tracking set trail-snacks');
    expect(stdout).toContain('**Created tracking set `trail-snacks`**');
    expect(stdout).toContain('- keywords (2): "trail mix", "nut mix"');
    expect(stdout).toContain('Calls a day for this set: 8 (2 keywords x 2 zips x 2 views x 1 page).');
    expect(stdout).toContain('Projected monthly use: 248 of 2000 shelf requests a month for rank tracking.');
    expect(lastTrack()).toMatchObject({
      event_name: 'shelf.tracking_changed',
      outcome: 'ok',
      payload: { action: 'create', keywords_asked: 2, zips_asked: 2, views_asked: 2, asins_asked: 1, has_note: true, keywords_added: 2, asins_added: 1, keywords: 2, calls_per_day: 8, projected_calls_per_month: 248, allowance: 2000 },
    });
    noValuesInTelemetry();
  });

  it('leaves out what was not given (views, ASINs, pages, note) so the service defaults apply; --json carries the changes', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce(notFound);
    vi.mocked(shelfTrackingPut).mockResolvedValueOnce(written({ ...SET, keywords: ['trail mix'], zips: ['10001'], asins: [], note: null, calls_per_day: 2 }));
    await run('shelf', 'tracking', 'create', 'trail-snacks', '--keyword', 'trail mix', '--zip', '10001', '--json');
    expect(vi.mocked(shelfTrackingPut).mock.calls[0][1]).toEqual({ keywords: ['trail mix'], zips: ['10001'] });
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ok', action: 'create', id: 'trail-snacks', changes: { keywords_added: ['trail mix'], asins_added: [] }, set: { calls_per_day: 2 }, projected_calls_per_month: 248, allowance: 2000 });
  });

  it('refuses an id that is taken without --replace (exit 12, nothing written); with --replace it reports the differences', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce({ ok: true, set: SET });
    await run('shelf', 'tracking', 'create', 'trail-snacks', '--keyword', 'granola', '--zip', '10001');
    expect(shelfTrackingPut).not.toHaveBeenCalled();
    expect(stderr).toContain('A tracking set "trail-snacks" already exists (2 keywords, 8 calls a day). Nothing was changed.');
    expect(stderr).toContain('run create again with --replace');
    expect(process.exitCode).toBe(12);
    expect(lastTrack()).toMatchObject({ outcome: 'failed', error_class: 'tracking_set_exists', payload: { action: 'create', stage: 'lookup' } });

    process.exitCode = undefined;
    stdout = '';
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce({ ok: true, set: SET });
    vi.mocked(shelfTrackingPut).mockResolvedValueOnce(written({ ...SET, keywords: ['granola'], zips: ['10001'], calls_per_day: 2 }, 62));
    await run('shelf', 'tracking', 'create', 'trail-snacks', '--keyword', 'granola', '--zip', '10001', '--replace');
    expect(shelfTrackingPut).toHaveBeenCalledTimes(1);
    expect(stdout).toContain('**Replaced tracking set `trail-snacks`**');
    expect(stdout).toContain('- added 1 keyword: "granola"');
    expect(stdout).toContain('- removed 2 keywords: "trail mix", "nut mix"');
    expect(stdout).toContain('stops answering for a removed keyword unless another set lists it');
    expect(stdout).toContain('- zips: 10001 (was 10001, 60601)');
    expect(lastTrack().payload).toMatchObject({ action: 'replace', keywords_added: 1, keywords_removed: 2 });
  });

  it('refuses bad input before any call', async () => {
    const cases: string[][] = [
      ['create', 'trail-snacks', '--zip', '10001'], // no keyword
      ['create', 'trail-snacks', '--keyword', 'trail mix'], // no zip
      ['create', 'trail-snacks', '--keyword', 'trail mix', '--zip', '10001', '--view', 'tablet'],
      ['create', 'trail-snacks', '--keyword', 'trail mix', '--zip', '10001', '--pages', '6'],
      ['create', 'trail-snacks', '--keyword', 'trail mix', '--zip', '10001', '--asin', 'B0'],
      ['create', 'trail-snacks', '--keyword', '   ', '--zip', '10001'],
      ['create', '-x', '--keyword', 'trail mix', '--zip', '10001'],
    ];
    for (const c of cases) {
      process.exitCode = undefined;
      try {
        await run('--json', 'shelf', 'tracking', ...c);
      } catch {
        // commander refuses `-x` as an unknown option before the action runs: also "before any call"
      }
    }
    expect(shelfTrackingGet).not.toHaveBeenCalled();
    expect(shelfTrackingPut).not.toHaveBeenCalled();
    expect(process.exitCode === 1 || process.exitCode === undefined).toBe(true);
  });

  it('the allowance refusal shows the friendly line, both numbers and how to make room (exit 10)', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce(notFound);
    vi.mocked(shelfTrackingPut).mockResolvedValueOnce(OVER);
    await run('shelf', 'tracking', 'create', 'trail-snacks', '--keyword', 'trail mix', '--zip', '10001');
    expect(stderr).toContain('✗ This change would bring your rank tracking past your monthly allowance.');
    expect(stderr).toContain('projected monthly use: 2232 shelf requests; allowance: 2000 a month');
    expect(stderr).toContain('mixshift shelf tracking pause <set>');
    expect(stderr).toContain('request more shelf requests');
    expect(process.exitCode).toBe(10);
    expect(lastTrack()).toMatchObject({ outcome: 'failed', error_class: 'tracking_over_allowance', payload: { action: 'create', stage: 'write', kind_failed: 'tracking_over_allowance', http_status: 402 } });
    noValuesInTelemetry();
  });

  it('a set over the per-set cap (invalid_request) shows its calls a day and the limit (exit 15), in text and --json', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce(notFound);
    vi.mocked(shelfTrackingPut).mockResolvedValueOnce(CAP);
    await run('shelf', 'tracking', 'create', 'trail-snacks', '--keyword', 'trail mix', '--zip', '10001', '--pages', '5');
    expect(stderr).toContain('✗ keywords x zips x surfaces x pages is 240 calls a day; the limit is 200.');
    expect(stderr).toContain('calls a day for this set: 240; the most one set may make: 200');
    expect(process.exitCode).toBe(15);
    expect(lastTrack()).toMatchObject({ outcome: 'failed', error_class: 'invalid_request', payload: { action: 'create', stage: 'write', http_status: 400 } });

    stdout = '';
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce(notFound);
    vi.mocked(shelfTrackingPut).mockResolvedValueOnce(CAP);
    await run('--json', 'shelf', 'tracking', 'create', 'trail-snacks', '--keyword', 'trail mix', '--zip', '10001', '--pages', '5');
    expect(JSON.parse(stdout)).toMatchObject({ status: 'error', failure_kind: 'invalid_request', calls_per_day: 240, max_calls_per_day_per_set: 200 });
    noValuesInTelemetry();
  });

  it('the allowance refusal in --json carries projected_calls_per_month, allowance and request_more', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce(notFound);
    vi.mocked(shelfTrackingPut).mockResolvedValueOnce(OVER);
    await run('--json', 'shelf', 'tracking', 'create', 'trail-snacks', '--keyword', 'trail mix', '--zip', '10001');
    expect(JSON.parse(stdout)).toMatchObject({
      status: 'error',
      failure_kind: 'tracking_over_allowance',
      message: 'This change would bring your rank tracking past your monthly allowance.',
      projected_calls_per_month: 2232,
      allowance: 2000,
      request_more: 'Ask MixShift to raise it.',
    });
    expect(process.exitCode).toBe(10);
  });
});

describe('shelf tracking add / remove', () => {
  it('add: reads the set, PATCHes add_keywords and add_asins, and says what was added and what was already there', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce({ ok: true, set: SET });
    vi.mocked(shelfTrackingPatch).mockResolvedValueOnce(written({ ...SET, keywords: ['trail mix', 'nut mix', 'granola'], asins: ['B000000001', 'B000000002'], calls_per_day: 12 }, 372));
    await run('shelf', 'tracking', 'add', 'trail-snacks', '--keyword', 'Granola', '--keyword', 'trail mix', '--asin', 'B000000002');
    expect(shelfTrackingPatch).toHaveBeenCalledWith('trail-snacks', { add_keywords: ['granola', 'trail mix'], add_asins: ['B000000002'] }, { dataDirOverride: undefined });
    expect(stdout).toContain('- added 1 keyword: "granola"');
    expect(stdout).toContain('- added 1 ASIN: B000000002');
    expect(stdout).toContain('- already tracked, so unchanged: "trail mix"');
    expect(stdout).toContain('- the set now tracks 3 keywords and 2 ASINs');
    expect(stdout).toContain('Calls a day for this set: 12 (3 keywords x 2 zips x 2 views x 1 page).');
    expect(stdout).toContain('Projected monthly use: 372 of 2000');
    expect(lastTrack().payload).toMatchObject({ action: 'add', keywords_asked: 2, asins_asked: 1, keywords_added: 1, asins_added: 1, keywords: 3, calls_per_day: 12, projected_calls_per_month: 372 });
    noValuesInTelemetry();
  });

  it('remove: PATCHes remove lists; --json carries the changes', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce({ ok: true, set: SET });
    vi.mocked(shelfTrackingPatch).mockResolvedValueOnce(written({ ...SET, keywords: ['trail mix'], asins: [], calls_per_day: 4 }, 124));
    await run('--json', 'shelf', 'tracking', 'remove', 'trail-snacks', '--keyword', 'nut mix', '--keyword', 'granola', '--asin', 'B000000001');
    expect(shelfTrackingPatch).toHaveBeenCalledWith('trail-snacks', { remove_keywords: ['nut mix', 'granola'], remove_asins: ['B000000001'] }, { dataDirOverride: undefined });
    expect(JSON.parse(stdout)).toMatchObject({
      status: 'ok',
      action: 'remove',
      changes: { keywords_removed: ['nut mix'], asins_removed: ['B000000001'], keywords_unchanged: ['granola'] },
      set: { calls_per_day: 4 },
      projected_calls_per_month: 124,
    });
  });

  it('refuses to empty a set (delete or pause instead), and needs something to add or remove', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce({ ok: true, set: SET });
    await run('shelf', 'tracking', 'remove', 'trail-snacks', '--keyword', 'trail mix', '--keyword', 'Nut  Mix');
    expect(shelfTrackingPatch).not.toHaveBeenCalled();
    expect(stderr).toContain('no keywords, and a set keeps at least one');
    expect(stderr).toContain('mixshift shelf tracking pause trail-snacks');
    expect(process.exitCode).toBe(1);

    vi.mocked(shelfTrackingGet).mockClear();
    await run('shelf', 'tracking', 'add', 'trail-snacks');
    expect(shelfTrackingGet).not.toHaveBeenCalled();
    expect(stderr).toContain('Name at least one --keyword or --asin to add.');
  });

  it('the role refusal prints the service line and who can do it (exit 11); --json carries the kind', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce({ ok: true, set: SET });
    vi.mocked(shelfTrackingPatch).mockResolvedValueOnce(FORBIDDEN);
    await run('shelf', 'tracking', 'add', 'trail-snacks', '--keyword', 'granola');
    expect(stderr).toContain('✗ Only an owner, admin or manager of your organization can change rank tracking.');
    expect(stderr).toContain('Ask an owner, admin or manager in your organization');
    expect(stderr).toContain('track these keywords');
    expect(stderr).toContain('a machine credential, such as one a scheduled task uses, never can');
    expect(process.exitCode).toBe(11);
    expect(lastTrack()).toMatchObject({ outcome: 'failed', error_class: 'forbidden', payload: { action: 'add', stage: 'write', kind_failed: 'forbidden', http_status: 403, keywords_asked: 1 } });

    stdout = '';
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce({ ok: true, set: SET });
    vi.mocked(shelfTrackingPatch).mockResolvedValueOnce(FORBIDDEN);
    await run('--json', 'shelf', 'tracking', 'add', 'trail-snacks', '--keyword', 'granola');
    expect(JSON.parse(stdout)).toMatchObject({ status: 'error', failure_kind: 'forbidden', message: FORBIDDEN.friendly, http_status: 403 });
    noValuesInTelemetry();
  });

  it('add over the per-set cap shows both numbers (exit 15)', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce({ ok: true, set: SET });
    vi.mocked(shelfTrackingPatch).mockResolvedValueOnce(CAP);
    await run('shelf', 'tracking', 'add', 'trail-snacks', '--keyword', 'granola');
    expect(stderr).toContain('calls a day for this set: 240; the most one set may make: 200');
    expect(stderr).toContain('Trim it, or split it into more sets.');
    expect(process.exitCode).toBe(15);
  });

  it('a set that does not exist stops before the write, with the list hint', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce(notFound);
    await run('shelf', 'tracking', 'add', 'trail-snacks', '--keyword', 'granola');
    expect(shelfTrackingPatch).not.toHaveBeenCalled();
    expect(stderr).toContain('no rank tracking set with that id');
    expect(stderr).toContain('`mixshift shelf tracking list` shows the sets your organization has.');
    expect(process.exitCode).toBe(7);
    expect(lastTrack().payload).toMatchObject({ action: 'add', stage: 'lookup', kind_failed: 'not_found' });
  });
});

describe('shelf tracking pause / resume', () => {
  it('pause PATCHes enabled false and says what that means for the allowance and rank-history', async () => {
    vi.mocked(shelfTrackingPatch).mockResolvedValueOnce(written({ ...SET, enabled: false }, 0));
    await run('shelf', 'tracking', 'pause', 'trail-snacks');
    expect(shelfTrackingGet).not.toHaveBeenCalled();
    expect(shelfTrackingPatch).toHaveBeenCalledWith('trail-snacks', { enabled: false }, { dataDirOverride: undefined });
    expect(stdout).toContain('**Paused tracking set `trail-snacks`**');
    expect(stdout).toContain('uses none of the allowance');
    expect(stdout).toContain('its rank history stays readable');
    expect(stdout).not.toContain('does not answer');
    expect(stdout).toContain('Calls a day for this set: 8 (2 keywords x 2 zips x 2 views x 1 page), none while paused.');
    expect(stdout).toContain('Projected monthly use: 0 of 2000');
    expect(lastTrack().payload).toMatchObject({ action: 'pause', enabled: false, calls_per_day: 8, projected_calls_per_month: 0 });
    noValuesInTelemetry();
  });

  it('resume PATCHes enabled true; --json is the write envelope', async () => {
    vi.mocked(shelfTrackingPatch).mockResolvedValueOnce(written(SET));
    await run('--json', 'shelf', 'tracking', 'resume', 'trail-snacks');
    expect(shelfTrackingPatch).toHaveBeenCalledWith('trail-snacks', { enabled: true }, { dataDirOverride: undefined });
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ok', action: 'resume', id: 'trail-snacks', set: { enabled: true }, projected_calls_per_month: 248, allowance: 2000 });
  });

  it('a resume refused for the allowance shows both numbers (exit 10)', async () => {
    vi.mocked(shelfTrackingPatch).mockResolvedValueOnce(OVER);
    await run('shelf', 'tracking', 'resume', 'trail-snacks');
    expect(stderr).toContain('projected monthly use: 2232 shelf requests; allowance: 2000 a month');
    expect(process.exitCode).toBe(10);
  });
});

describe('shelf tracking delete', () => {
  it('without --yes deletes nothing and makes no call (exit 1), in text and in --json', async () => {
    await run('shelf', 'tracking', 'delete', 'trail-snacks');
    expect(stderr).toContain('Nothing was deleted.');
    expect(stderr).toContain('keep its history readable, pause it instead');
    expect(stderr).toContain('mixshift shelf tracking delete trail-snacks --yes');
    expect(process.exitCode).toBe(1);

    stdout = '';
    process.exitCode = undefined;
    await run('--json', 'shelf', 'tracking', 'delete', 'trail-snacks');
    expect(JSON.parse(stdout)).toMatchObject({ status: 'error', message: expect.stringContaining('Nothing was deleted.') });
    expect(process.exitCode).toBe(1);
    for (const m of [shelfTrackingGet, shelfTrackingDelete, shelfTrackingList]) expect(m).not.toHaveBeenCalled();
    expect(lastTrack()).toMatchObject({ event_name: 'shelf.tracking_changed', outcome: 'failed', error_class: 'confirmation_required', payload: { action: 'delete', stage: 'confirm' } });
    noValuesInTelemetry();
  });

  it('with --yes reads the set, deletes it, then reads the projection; prints what stopped', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce({ ok: true, set: SET });
    vi.mocked(shelfTrackingDelete).mockResolvedValueOnce({ ok: true });
    vi.mocked(shelfTrackingList).mockResolvedValueOnce({ ...LIST, sets: [PAUSED], projected_calls_per_month: 0 });
    await run('shelf', 'tracking', 'delete', 'trail-snacks', '--yes');
    expect(shelfTrackingDelete).toHaveBeenCalledWith('trail-snacks', { dataDirOverride: undefined });
    expect(stdout).toContain('**Deleted tracking set `trail-snacks`**');
    expect(stdout).toContain('it tracked 2 keywords at 2 zips on desktop and mobile, 8 calls a day; those searches stop');
    expect(stdout).toContain('Projected monthly use: 0 of 2000');
    expect(lastTrack()).toMatchObject({ outcome: 'ok', payload: { action: 'delete', keywords: 2, calls_per_day: 8, projected_calls_per_month: 0, allowance: 2000 } });
    noValuesInTelemetry();
  });

  it('a delete that went through still reports when the projection read fails; --json says deleted', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce({ ok: true, set: SET });
    vi.mocked(shelfTrackingDelete).mockResolvedValueOnce({ ok: true });
    vi.mocked(shelfTrackingList).mockResolvedValueOnce({ ok: false, kind: 'host_unreachable', friendly: 'unreachable' });
    await run('--json', 'shelf', 'tracking', 'delete', 'trail-snacks', '--yes');
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ok', action: 'delete', id: 'trail-snacks', deleted: { id: 'trail-snacks' }, projected_calls_per_month: null, allowance: null });
    expect(process.exitCode).toBeUndefined();
  });

  it('the role refusal on delete is shown and nothing else is called', async () => {
    vi.mocked(shelfTrackingGet).mockResolvedValueOnce({ ok: true, set: SET });
    vi.mocked(shelfTrackingDelete).mockResolvedValueOnce(FORBIDDEN);
    await run('shelf', 'tracking', 'delete', 'trail-snacks', '--yes');
    expect(stderr).toContain(FORBIDDEN.friendly);
    expect(shelfTrackingList).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(11);
  });
});
