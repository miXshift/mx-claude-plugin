/**
 * Command-level tests for `mixshift dayparting ...`, run through the REAL client against a mocked
 * gateway (a stubbed fetch and a stubbed sign-in): flag-to-request mapping, Ads profile resolution,
 * the human verdicts, refusals in the service's words with a next step, the --json passthrough and its
 * last-line rule, exit codes, and telemetry that carries counts and outcome but never an id or a figure.
 * Made-up ids and figures throughout: this repo is public.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';

import { parseDays, parseIds, parseTargetAcos, isRealDay, registerDaypartingCommands } from './dayparting.js';
import { track } from '../lib/telemetry/index.js';
import { DIAGNOSE_ANSWER, FAKE_PROFILE_ID, FAKE_SELLER_ID, HOURS_ANSWER, NO_SUGGESTIONS_ANSWER, SOURCE_NOT_ENABLED } from '../lib/dayparting/fixtures.js';

vi.mock('../lib/auth/credentials.js', () => ({
  loadCredentials: vi.fn(async () => ({ credentials: { datahub: { api_base: 'https://svc.test' } } })),
  getValidAccessToken: vi.fn(async () => 'tok-secret-123'),
}));

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return { ...actual, track: vi.fn(async () => {}) };
});

type Reply = { status: number; body: unknown };
let gateway: (url: URL, init: RequestInit) => Reply;
const fetchMock = vi.fn(async (u: unknown, init?: RequestInit) => {
  const r = gateway(new URL(String(u)), init ?? {});
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
});

const profile = (profileId: string, sellerId: number, name: string, country: string) => ({
  profileId,
  legacySellerId: sellerId,
  amazonSellerId: null,
  name,
  merchantType: 'Seller',
  merchantRegion: 'NA',
  marketplaceId: null,
  countryCode: country,
});

const ONE_PROFILE = { ok: true, profiles: [profile(FAKE_PROFILE_ID, Number(FAKE_SELLER_ID), 'Example Brand', 'US'), profile('4000000002', 999, 'Other Seller', 'US')] };
const TWO_PROFILES = {
  ok: true,
  profiles: [profile(FAKE_PROFILE_ID, Number(FAKE_SELLER_ID), 'Example Brand', 'US'), profile('4000000003', Number(FAKE_SELLER_ID), 'Example Brand', 'CA')],
};

/** Routes the profile list and the two dayparting calls; everything else is an error. */
function serve(opts: { profiles?: unknown; diagnose?: Reply; hours?: Reply }): void {
  gateway = (url) => {
    if (url.pathname === '/api/amazon/ads/profiles') return { status: 200, body: opts.profiles ?? ONE_PROFILE };
    if (url.pathname === '/api/dayparting/diagnose' && opts.diagnose) return opts.diagnose;
    if (url.pathname === '/api/dayparting/hours' && opts.hours) return opts.hours;
    throw new Error(`unexpected gateway call ${url.pathname}`);
  };
}

let stdout = '';
let stderr = '';

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.option('--json', 'emit machine-readable JSON to stdout', false).option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR').option('--surface <surface>', 'telemetry host flag');
  registerDaypartingCommands(program);
  return program;
}

async function run(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', ...args]);
}

function lastLineJson(): Record<string, unknown> {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  return JSON.parse(lines.at(-1) as string) as Record<string, unknown>;
}

const calls = (): Array<{ url: URL; init: RequestInit }> => fetchMock.mock.calls.map((c) => ({ url: new URL(String(c[0])), init: (c[1] ?? {}) as RequestInit }));
const dayCalls = () => calls().filter((c) => c.url.pathname.startsWith('/api/dayparting/'));
const lastTrack = () => vi.mocked(track).mock.calls.at(-1)![0] as { event_name: string; outcome?: string; error_class?: string; payload: Record<string, unknown> };

beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.stubGlobal('fetch', fetchMock);
  gateway = () => {
    throw new Error('unexpected gateway call');
  };
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
  vi.unstubAllGlobals();
  fetchMock.mockClear();
  vi.mocked(track).mockClear();
  process.exitCode = undefined;
});

describe('option parsing', () => {
  it('reads a target ACOS as a fraction or a percent', () => {
    expect(parseTargetAcos('0.28')).toBe(28);
    expect(parseTargetAcos('28')).toBe(28);
    expect(parseTargetAcos('0.215')).toBe(21.5);
    expect(parseTargetAcos('0')).toBeNull();
    expect(parseTargetAcos('abc')).toBeNull();
    expect(parseTargetAcos('-3')).toBeNull();
    expect(parseTargetAcos('5000')).toBeNull();
  });
  it('checks dates and id lists', () => {
    expect(isRealDay('2026-10-06')).toBe(true);
    expect(isRealDay('2026-02-30')).toBe(false);
    expect(isRealDay('10/06/2026')).toBe(false);
    expect(parseDays('2026-10-06, 2026-10-07,2026-10-06')).toEqual(['2026-10-06', '2026-10-07']);
    expect(parseDays('2026-10-06,soon')).toBeNull();
    expect(parseIds('9000000001,9000000002')).toEqual(['9000000001', '9000000002']);
    expect(parseIds('9000000001,abc')).toBeNull();
  });
});

describe('dayparting diagnose', () => {
  it('maps the flags to one POST and resolves the seller\'s only profile', async () => {
    serve({ diagnose: { status: 200, body: DIAGNOSE_ANSWER } });
    await run('dayparting', 'diagnose', '--seller-id', FAKE_SELLER_ID, '--lookback-days', '42', '--target-acos', '0.28', '--exclude-dates', '2026-10-06,2026-10-07', '--campaign-ids', '9000000001');
    const [c] = dayCalls();
    expect(c!.init.method).toBe('POST');
    expect(c!.url.pathname).toBe('/api/dayparting/diagnose');
    expect(JSON.parse(String(c!.init.body))).toEqual({
      profile_id: FAKE_PROFILE_ID,
      lookback_days: 42,
      objective: { metric: 'acos', target: 28 },
      excluded_dates: ['2026-10-06', '2026-10-07'],
      campaign_ids: ['9000000001'],
    });
    expect((c!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok-secret-123');
    expect(process.exitCode).toBeUndefined();
  });

  it('sends only the profile when no option is given, and skips the profile list when --profile-id is given', async () => {
    serve({ diagnose: { status: 200, body: DIAGNOSE_ANSWER } });
    await run('dayparting', 'diagnose', '--seller-id', FAKE_SELLER_ID, '--profile-id', '4000000003');
    expect(calls().filter((c) => c.url.pathname === '/api/amazon/ads/profiles')).toHaveLength(0);
    expect(JSON.parse(String(dayCalls()[0]!.init.body))).toEqual({ profile_id: '4000000003' });
  });

  it('prints one sentence per proposed window first, with the hour table only under --verbose', async () => {
    serve({ diagnose: { status: 200, body: DIAGNOSE_ANSWER } });
    await run('dayparting', 'diagnose', '--seller-id', FAKE_SELLER_ID);
    expect(stdout).toContain('- Every day, midnight to 4 am (00:00 to 04:00) runs at 34% ACOS against your 21%; a 30% bid cut touches about $1,200 a week and risks about $1,100 of sales; confidence medium');
    expect(stdout).toContain('- Saturday and Sunday, 9 am to noon (09:00 to 12:00) runs at 19.6% ACOS against your 21%; a 15% bid raise touches about $300 a week; confidence low');
    expect(stdout).toContain('Held back:');
    expect(stdout).toContain('Tuesday, 2 pm to 4 pm (14:00 to 16:00): the weekday pattern shows in fewer than 6 weeks of data');
    expect(stdout).toContain('Nothing was changed.');
    expect(stdout).not.toContain('| Hour |');
    expect(stdout).not.toContain('Why:');

    stdout = '';
    await run('dayparting', 'diagnose', '--seller-id', FAKE_SELLER_ID, '--verbose');
    expect(stdout).toContain('| Hour | Spend | Clicks | Orders | Sales | ROAS | Share of spend |');
    expect(stdout).toContain('| 00:00 |');
    expect(stdout).toContain('Why: Every day, midnight to 4 am');
    expect(stdout).toContain('What drives it: conversion rate 60%, cost per click 30%, order value 10%');
    // the verdict lines still come first
    expect(stdout.indexOf('runs at 34% ACOS')).toBeLessThan(stdout.indexOf('| Hour |'));
  });

  it('says so plainly when no window stands out', async () => {
    serve({ diagnose: { status: 200, body: NO_SUGGESTIONS_ANSWER } });
    await run('dayparting', 'diagnose', '--seller-id', FAKE_SELLER_ID);
    expect(stdout).toContain('No window stands out');
    expect(process.exitCode).toBeUndefined();
  });

  it('--json prints the gateway answer unchanged, as one line, last on stdout', async () => {
    serve({ diagnose: { status: 200, body: DIAGNOSE_ANSWER } });
    await run('--json', 'dayparting', 'diagnose', '--seller-id', FAKE_SELLER_ID);
    expect(lastLineJson()).toEqual(DIAGNOSE_ANSWER);
    expect(stdout.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1);
    expect(stderr).toBe('');
  });

  it('records a count and the outcome, never an id or a figure', async () => {
    serve({ diagnose: { status: 200, body: DIAGNOSE_ANSWER } });
    await run('dayparting', 'diagnose', '--seller-id', FAKE_SELLER_ID);
    const t = lastTrack();
    expect(t.event_name).toBe('dayparting.called');
    expect(t.outcome).toBe('ok');
    expect(t.payload).toEqual({ kind: 'diagnose', suggestions: 3, status: 'ok' });
    expect(JSON.stringify(t)).not.toContain(FAKE_PROFILE_ID);
  });

  it('renders a refusal in the service\'s words, with how to ask for Marketing Stream', async () => {
    serve({ diagnose: { status: 409, body: SOURCE_NOT_ENABLED } });
    await run('dayparting', 'diagnose', '--seller-id', FAKE_SELLER_ID);
    expect(stderr).toContain(SOURCE_NOT_ENABLED.friendly);
    expect(stderr).toContain('ask to turn on Marketing Stream for our account');
    expect(stdout).toBe('');
    expect(process.exitCode).toBe(6);
    expect(lastTrack().outcome).toBe('failed');
    expect(lastTrack().error_class).toBe('source_not_enabled');
  });

  it('--json on a refusal prints the service\'s refusal body unchanged', async () => {
    serve({ diagnose: { status: 409, body: SOURCE_NOT_ENABLED } });
    await run('--json', 'dayparting', 'diagnose', '--seller-id', FAKE_SELLER_ID);
    expect(lastLineJson()).toEqual(SOURCE_NOT_ENABLED);
    expect(process.exitCode).toBe(6);
  });

  it('keeps the service\'s sentence for a kind this build has never seen', async () => {
    serve({ diagnose: { status: 502, body: { ok: false, kind: 'mx2_refused', friendly: 'The data service said no. Try again later.' } } });
    await run('dayparting', 'diagnose', '--seller-id', FAKE_SELLER_ID);
    expect(stderr).toContain('The data service said no. Try again later.');
    expect(process.exitCode).toBe(1);
  });

  it('a lapsed feed is a refusal with a next step, exit 6', async () => {
    serve({ diagnose: { status: 409, body: { ok: false, kind: 'source_not_current', friendly: 'The Marketing Stream subscription has lapsed.' } } });
    await run('dayparting', 'diagnose', '--seller-id', FAKE_SELLER_ID);
    expect(stderr).toContain('has lapsed');
    expect(stderr).toContain('check the Marketing Stream activation');
    expect(process.exitCode).toBe(6);
  });

  it('stops with the choices when the seller has several profiles, and when it has none', async () => {
    serve({ profiles: TWO_PROFILES });
    await run('dayparting', 'diagnose', '--seller-id', FAKE_SELLER_ID);
    expect(stderr).toContain('has 2 Ads profiles');
    expect(stderr).toContain(FAKE_PROFILE_ID);
    expect(stderr).toContain('4000000003');
    expect(dayCalls()).toHaveLength(0);
    expect(process.exitCode).toBe(1);

    stderr = '';
    serve({ profiles: ONE_PROFILE });
    await run('dayparting', 'diagnose', '--seller-id', '55555');
    expect(stderr).toContain('No Ads profile for seller 55555');
    expect(dayCalls()).toHaveLength(0);
  });

  it('rejects bad input before any call', async () => {
    serve({});
    for (const args of [
      ['--seller-id', 'abc'],
      ['--seller-id', FAKE_SELLER_ID, '--lookback-days', '3'],
      ['--seller-id', FAKE_SELLER_ID, '--lookback-days', '90'],
      ['--seller-id', FAKE_SELLER_ID, '--target-acos', 'high'],
      ['--seller-id', FAKE_SELLER_ID, '--exclude-dates', '2026-13-40'],
      ['--seller-id', FAKE_SELLER_ID, '--campaign-ids', 'x1'],
      ['--seller-id', FAKE_SELLER_ID, '--profile-id', 'p1'],
    ]) {
      process.exitCode = undefined;
      stderr = '';
      await run('dayparting', 'diagnose', ...args);
      expect(stderr).toContain('error:');
      expect(process.exitCode).toBe(1);
    }
    expect(calls()).toHaveLength(0);
  });

  it('is read only: the only requests are the profile list and the diagnose POST', async () => {
    serve({ diagnose: { status: 200, body: DIAGNOSE_ANSWER } });
    await run('dayparting', 'diagnose', '--seller-id', FAKE_SELLER_ID);
    expect(calls().map((c) => `${c.init.method} ${c.url.pathname}`)).toEqual(['GET /api/amazon/ads/profiles', 'POST /api/dayparting/diagnose']);
  });
});

describe('dayparting hours', () => {
  it('maps the flags to one GET and rolls the rows up by hour', async () => {
    serve({ hours: { status: 200, body: HOURS_ANSWER } });
    await run('dayparting', 'hours', '--seller-id', FAKE_SELLER_ID, '--from', '2026-11-10', '--to', '2026-11-11');
    const [c] = dayCalls();
    expect(c!.init.method).toBe('GET');
    expect(c!.url.searchParams.get('profile_id')).toBe(FAKE_PROFILE_ID);
    expect(c!.url.searchParams.get('from')).toBe('2026-11-10');
    expect(c!.url.searchParams.get('to')).toBe('2026-11-11');
    expect(stdout).toContain('3 campaign-hour rows');
    expect(stdout).toContain('| 01:00 | $70 | 70 | 3 | $70 |');
    expect(stdout).toContain('1 of these rows would be left out of a diagnosis');
    expect(lastTrack().payload).toEqual({ kind: 'hours', rows: 3 });
  });

  it('--json prints the gateway answer unchanged', async () => {
    serve({ hours: { status: 200, body: HOURS_ANSWER } });
    await run('--json', 'dayparting', 'hours', '--seller-id', FAKE_SELLER_ID, '--from', '2026-11-10', '--to', '2026-11-11');
    expect(lastLineJson()).toEqual(HOURS_ANSWER);
    // the root --json flag works after the subcommand too
    stdout = '';
    await run('dayparting', 'hours', '--seller-id', FAKE_SELLER_ID, '--from', '2026-11-10', '--to', '2026-11-11', '--json');
    expect(lastLineJson()).toEqual(HOURS_ANSWER);
  });

  it('refuses a window over 62 days, a reversed window and a bad date before any call', async () => {
    serve({});
    await run('dayparting', 'hours', '--seller-id', FAKE_SELLER_ID, '--from', '2026-08-01', '--to', '2026-11-11');
    expect(stderr).toContain('at most 62');
    stderr = '';
    await run('dayparting', 'hours', '--seller-id', FAKE_SELLER_ID, '--from', '2026-11-11', '--to', '2026-11-10');
    expect(stderr).toContain('on or after');
    stderr = '';
    await run('dayparting', 'hours', '--seller-id', FAKE_SELLER_ID, '--from', 'yesterday', '--to', '2026-11-10');
    expect(stderr).toContain('YYYY-MM-DD');
    expect(calls()).toHaveLength(0);
  });

  it('renders a refusal the same way', async () => {
    serve({ hours: { status: 403, body: { ok: false, kind: 'account_not_in_scope', friendly: 'This Ads profile is not in the hourly feed scope.' } } });
    await run('dayparting', 'hours', '--seller-id', FAKE_SELLER_ID, '--from', '2026-11-10', '--to', '2026-11-11');
    expect(stderr).toContain('not in the hourly feed scope');
    expect(stderr).toContain('add this Ads profile to Marketing Stream');
    expect(process.exitCode).toBe(6);
  });
});
