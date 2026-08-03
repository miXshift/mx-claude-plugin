/**
 * Command-level tests for `mixshift timeline ...` option wiring.
 *
 * The HTTP client factory is mocked (no network, no credentials); commander
 * parsing, the action handlers, the real parseSince, and the real
 * listAllEvents pagination run for real. Telemetry's track() is stubbed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { CommanderError } from 'commander';

import {
  registerTimelineCommands,
  familyForKind,
  formatEventLine,
  MAX_NOTE_CHARS,
  MAX_EVIDENCE_CHARS,
} from './timeline.js';
import { createTimelineClient, type TimelineClient } from '../lib/timeline/client.js';
import type {
  CorroborateEventInput,
  PostTimelineEventInput,
  TimelineListQuery,
  WireTimelineEvent,
} from '../lib/timeline/types.js';

vi.mock('../lib/timeline/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/timeline/client.js')>();
  return {
    ...actual, // keep listAllEvents + LIST_ALL_CAP real
    createTimelineClient: vi.fn(),
  };
});

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return {
    ...actual, // keep EventName real
    track: vi.fn(async () => {}),
  };
});

function sampleEvent(overrides: Partial<WireTimelineEvent> = {}): WireTimelineEvent {
  return {
    id: 'evt_1',
    brand_slug: 'acme',
    family: 'structural',
    kind: 'structural.price_change',
    ts: '2026-07-04T12:00:00.000Z',
    actor: 'sam@example.com',
    client_id: 'mx-claude-plugin',
    payload: { note: 'MAP change' },
    sensitivity: 'internal',
    ...overrides,
  };
}

interface FakeState {
  listQueries: TimelineListQuery[];
  posts: PostTimelineEventInput[];
  corroborations: Array<{ eventId: string; input: CorroborateEventInput }>;
}

function fakeClient(pages: WireTimelineEvent[][]): { client: TimelineClient; state: FakeState } {
  const state: FakeState = { listQueries: [], posts: [], corroborations: [] };
  const client: TimelineClient = {
    listEvents: async (query: TimelineListQuery = {}) => {
      state.listQueries.push(query);
      const idx = query.cursor === undefined ? 0 : Number(query.cursor);
      const events = pages[idx] ?? [];
      const next = idx + 1 < pages.length ? String(idx + 1) : undefined;
      return { ok: true, events, ...(next !== undefined ? { next_cursor: next } : {}) };
    },
    postEvent: async (input: PostTimelineEventInput) => {
      state.posts.push(input);
      return { ok: true, id: 'evt_new' };
    },
    corroborateEvent: async (eventId: string, input: CorroborateEventInput) => {
      state.corroborations.push({ eventId, input });
      return {
        ok: true,
        event: sampleEvent({
          id: eventId,
          category: 'launch',
          status: input.status ?? 'corroborated',
          ...(input.end_ts !== undefined ? { end_ts: input.end_ts } : {}),
        }),
        corroboration_id: 'corr_new',
      };
    },
  };
  return { client, state };
}

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'emit machine-readable JSON to stdout', false)
    .option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR');
  registerTimelineCommands(program);
  return program;
}

async function runTimeline(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', 'timeline', ...args]);
}

let stdoutChunks: string[];
let stderrChunks: string[];
let exitCodeBefore: typeof process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  exitCodeBefore = process.exitCode;
  stdoutChunks = [];
  stderrChunks = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    stderrChunks.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = exitCodeBefore;
});

const stdoutText = (): string => stdoutChunks.join('');
const stderrText = (): string => stderrChunks.join('');

// ---------------------------------------------------------------------------
// timeline add
// ---------------------------------------------------------------------------

describe('timeline add', () => {
  it('requires --brand (commander-level)', async () => {
    const { client } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await expect(runTimeline('add', '--kind', 'comment')).rejects.toThrow(CommanderError);
  });

  it('requires --kind (commander-level)', async () => {
    const { client } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await expect(runTimeline('add', '--brand', 'acme')).rejects.toThrow(CommanderError);
  });

  it.each(['knowledge.fact_added', 'action.ads_change_committed', 'nonsense'])(
    "rejects kind '%s' before any network call",
    async (kind) => {
      const { client, state } = fakeClient([]);
      vi.mocked(createTimelineClient).mockReturnValue(client);
      await runTimeline('add', '--brand', 'acme', '--kind', kind);
      expect(process.exitCode).toBe(1);
      expect(stderrText()).toContain("--kind must be 'comment' or 'structural.<what>'");
      expect(state.posts).toHaveLength(0);
    },
  );

  it('rejects a --note beyond the 32KB cap before any network call', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'add',
      '--brand',
      'acme',
      '--kind',
      'comment',
      '--note',
      'x'.repeat(MAX_NOTE_CHARS + 1),
    );
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('--note is too long');
    expect(state.posts).toHaveLength(0);
  });

  it('accepts a note exactly at the cap', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'add',
      '--brand',
      'acme',
      '--kind',
      'comment',
      '--note',
      'x'.repeat(MAX_NOTE_CHARS),
    );
    expect(state.posts).toHaveLength(1);
  });

  it('posts a structural stake with note + target and derives the family', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'add',
      '--brand',
      'acme',
      '--kind',
      'structural.price_change',
      '--note',
      'MAP moved to $24.99',
      '--target',
      'asin:B000XYZ',
    );
    expect(process.exitCode ?? 0).toBe(0);
    expect(state.posts).toEqual([
      {
        brand_slug: 'acme',
        family: 'structural',
        kind: 'structural.price_change',
        payload: { note: 'MAP moved to $24.99' },
        target_ref: 'asin:B000XYZ',
      },
    ]);
    expect(stdoutText()).toContain('evt_new');
  });

  it("posts a bare 'comment' with family comment", async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('add', '--brand', 'acme', '--kind', 'comment', '--note', 'watch this');
    expect(state.posts).toEqual([
      {
        brand_slug: 'acme',
        family: 'comment',
        kind: 'comment',
        payload: { note: 'watch this' },
      },
    ]);
  });

  it('surfaces a server rejection as exit 1', async () => {
    const client: TimelineClient = {
      listEvents: async () => ({ ok: true, events: [] }),
      postEvent: async () => ({
        ok: false,
        kind: 'insufficient_scope',
        message: 'no timeline:write',
        friendly: 'Your credential lacks timeline:write.',
      }),
      corroborateEvent: async () => ({
        ok: false,
        kind: 'unknown',
        message: 'unused',
        friendly: 'unused',
      }),
    };
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('add', '--brand', 'acme', '--kind', 'comment');
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('timeline:write');
  });
});

// ---------------------------------------------------------------------------
// timeline add — stakes (org brain P2.5)
// ---------------------------------------------------------------------------

describe('timeline add (stakes)', () => {
  it('requires --interpretation when --category is given (fail fast, no network)', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'add',
      '--brand',
      'acme',
      '--kind',
      'structural.launch',
      '--category',
      'launch',
    );
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('--interpretation is required');
    expect(state.posts).toHaveLength(0);
  });

  it('rejects an unknown --category before any network call', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'add',
      '--brand',
      'acme',
      '--kind',
      'structural.launch',
      '--category',
      'not_a_category',
      '--interpretation',
      'x',
    );
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('--category must be one of');
    expect(state.posts).toHaveLength(0);
  });

  it('rejects a --category stake on a comment kind', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'add',
      '--brand',
      'acme',
      '--kind',
      'comment',
      '--category',
      'launch',
      '--interpretation',
      'x',
    );
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain("requires a 'structural.<what>'");
    expect(state.posts).toHaveLength(0);
  });

  it('rejects stake fields on a non-stake (no --category)', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'add',
      '--brand',
      'acme',
      '--kind',
      'structural.price_change',
      '--intensity',
      '3',
    );
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('add --category to record one');
    expect(state.posts).toHaveLength(0);
  });

  it('rejects a non-finite --intensity', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'add',
      '--brand',
      'acme',
      '--kind',
      'structural.launch',
      '--category',
      'launch',
      '--interpretation',
      'big launch',
      '--intensity',
      'huge',
    );
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('--intensity must be a finite number');
    expect(state.posts).toHaveLength(0);
  });

  it('rejects --evidence that is not a JSON object', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'add',
      '--brand',
      'acme',
      '--kind',
      'structural.launch',
      '--category',
      'launch',
      '--interpretation',
      'big launch',
      '--evidence',
      '[1,2,3]',
    );
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('--evidence must be a JSON object');
    expect(state.posts).toHaveLength(0);
  });

  it('rejects malformed --evidence JSON with a friendly message and no stack trace', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'add',
      '--brand',
      'acme',
      '--kind',
      'structural.launch',
      '--category',
      'launch',
      '--interpretation',
      'big launch',
      '--evidence',
      '{not json}',
    );
    expect(process.exitCode).toBe(1);
    const err = stderrText();
    expect(err).toContain('--evidence must be valid JSON');
    // A friendly one-liner, not a leaked stack trace.
    expect(err).not.toMatch(/\n\s+at /);
    expect(state.posts).toHaveLength(0);
  });

  it('accepts --evidence whose SERIALIZED form is within the cap even when the raw input is padded past it', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    // Raw length far exceeds the cap (whitespace padding), but the compact
    // serialized object is tiny — the old raw-length check wrongly rejected it.
    const padded = '{' + ' '.repeat(MAX_EVIDENCE_CHARS + 100) + '"metric":"acos"}';
    expect(padded.length).toBeGreaterThan(MAX_EVIDENCE_CHARS);
    await runTimeline(
      'add',
      '--brand',
      'acme',
      '--kind',
      'structural.launch',
      '--category',
      'launch',
      '--interpretation',
      'big launch',
      '--evidence',
      padded,
    );
    expect(process.exitCode ?? 0).toBe(0);
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0]!.evidence).toEqual({ metric: 'acos' });
  });

  it('rejects --evidence whose serialized form exceeds the cap', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    const big = JSON.stringify({ blob: 'x'.repeat(MAX_EVIDENCE_CHARS) });
    expect(big.length).toBeGreaterThan(MAX_EVIDENCE_CHARS);
    await runTimeline(
      'add',
      '--brand',
      'acme',
      '--kind',
      'structural.launch',
      '--category',
      'launch',
      '--interpretation',
      'big launch',
      '--evidence',
      big,
    );
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('--evidence is too large');
    expect(state.posts).toHaveLength(0);
  });

  it('posts a full stake with every field and confirms it as a stake', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'add',
      '--brand',
      'acme',
      '--kind',
      'structural.promo',
      '--category',
      'promotional_window',
      '--interpretation',
      'Prime Day promo push',
      '--ts',
      '2026-07-10T00:00:00.000Z',
      '--end',
      '2026-07-12T00:00:00.000Z',
      '--affects',
      'marketplace:US',
      '--affects',
      'asin:B000XYZ',
      '--intensity',
      '2.5',
      '--source',
      'system',
      '--evidence',
      '{"metric":"acos","magnitude":0.4}',
    );
    expect(process.exitCode ?? 0).toBe(0);
    expect(state.posts).toEqual([
      {
        brand_slug: 'acme',
        family: 'structural',
        kind: 'structural.promo',
        ts: '2026-07-10T00:00:00.000Z',
        category: 'promotional_window',
        interpretation: 'Prime Day promo push',
        end_ts: '2026-07-12T00:00:00.000Z',
        affects: ['marketplace:US', 'asin:B000XYZ'],
        intensity: 2.5,
        source: 'system',
        evidence: { metric: 'acos', magnitude: 0.4 },
      },
    ]);
    const out = stdoutText();
    expect(out).toContain('promotional_window stake');
    expect(out).toContain('unverified');
    expect(out).toContain('evt_new');
  });

  it('leaves the legacy structural add path byte-for-byte unchanged', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'add',
      '--brand',
      'acme',
      '--kind',
      'structural.stockout',
      '--note',
      'OOS on hero SKU',
    );
    expect(state.posts).toEqual([
      {
        brand_slug: 'acme',
        family: 'structural',
        kind: 'structural.stockout',
        payload: { note: 'OOS on hero SKU' },
      },
    ]);
    expect(stdoutText()).toBe(
      "✓ Added structural.stockout to acme's timeline (event evt_new).\n",
    );
  });
});

// ---------------------------------------------------------------------------
// timeline corroborate (org brain P2.5)
// ---------------------------------------------------------------------------

describe('timeline corroborate', () => {
  it('requires at least one of --status / --end / --evidence', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('corroborate', 'evt_1', '--note', 'just a note');
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('at least one of --status');
    expect(state.corroborations).toHaveLength(0);
  });

  it('rejects an unknown --status', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('corroborate', 'evt_1', '--status', 'maybe');
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('--status must be one of');
    expect(state.corroborations).toHaveLength(0);
  });

  it('posts a corroboration with status + end + evidence and confirms it', async () => {
    const { client, state } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'corroborate',
      'evt_42',
      '--status',
      'corroborated',
      '--end',
      '2026-07-15T00:00:00.000Z',
      '--note',
      'confirmed by second anomaly',
      '--evidence',
      '{"metric":"units"}',
    );
    expect(process.exitCode ?? 0).toBe(0);
    expect(state.corroborations).toEqual([
      {
        eventId: 'evt_42',
        input: {
          status: 'corroborated',
          end_ts: '2026-07-15T00:00:00.000Z',
          note: 'confirmed by second anomaly',
          evidence: { metric: 'units' },
        },
      },
    ]);
    const out = stdoutText();
    expect(out).toContain('Corroborated evt_42');
    expect(out).toContain('corr_new');
  });

  it('emits the updated stake + corroboration id in --json mode', async () => {
    const { client } = fakeClient([]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('corroborate', 'evt_42', '--status', 'disputed', '--json');
    const parsed = JSON.parse(stdoutText()) as {
      status: string;
      corroboration_id: string;
      event: { id: string; status: string };
    };
    expect(parsed.status).toBe('ok');
    expect(parsed.corroboration_id).toBe('corr_new');
    expect(parsed.event.id).toBe('evt_42');
    expect(parsed.event.status).toBe('disputed');
  });

  it('surfaces a server not_found as exit 1', async () => {
    const client: TimelineClient = {
      listEvents: async () => ({ ok: true, events: [] }),
      postEvent: async () => ({ ok: true, id: 'x' }),
      corroborateEvent: async () => ({
        ok: false,
        kind: 'not_found',
        message: 'no such stake',
        friendly: 'No stake with that id on your tenant.',
      }),
    };
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('corroborate', 'evt_missing', '--status', 'corroborated');
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('No stake with that id');
  });
});

describe('familyForKind', () => {
  it('maps comment and structural.*; rejects everything else', () => {
    expect(familyForKind('comment')).toBe('comment');
    expect(familyForKind('structural.stockout')).toBe('structural');
    expect(familyForKind('structural.prime-day.prep_2026')).toBe('structural');
    expect(familyForKind('knowledge.fact_added')).toBeNull();
    expect(familyForKind('action.anything')).toBeNull();
    expect(familyForKind('structural.')).toBeNull();
    expect(familyForKind('comment.reply')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// timeline list
// ---------------------------------------------------------------------------

describe('timeline list', () => {
  it('passes filters through and prints one line per event', async () => {
    const { client, state } = fakeClient([[sampleEvent()]]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'list',
      '--brand',
      'acme',
      '--family',
      'structural',
      '--kind',
      'structural.price_change',
      '--limit',
      '25',
    );
    expect(state.listQueries).toEqual([
      { brand: 'acme', family: 'structural', kind: 'structural.price_change', limit: 25 },
    ]);
    const out = stdoutText();
    expect(out).toContain('structural.price_change');
    expect(out).toContain('sam@example.com');
    expect(out).toContain('acme');
    expect(out).toContain('MAP change');
  });

  it('resolves a relative --since against now before calling the client', async () => {
    const { client, state } = fakeClient([[]]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    const before = Date.now();
    await runTimeline('list', '--since', '24h');
    const after = Date.now();
    const since = state.listQueries[0]?.since;
    expect(typeof since).toBe('string');
    const sinceMs = Date.parse(since!);
    expect(sinceMs).toBeGreaterThanOrEqual(before - 24 * 3600_000 - 1000);
    expect(sinceMs).toBeLessThanOrEqual(after - 24 * 3600_000 + 1000);
  });

  it('rejects an unparseable --since with exit 1 and no network call', async () => {
    const { client, state } = fakeClient([[]]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('list', '--since', 'yesterday');
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain("invalid --since 'yesterday'");
    expect(state.listQueries).toHaveLength(0);
  });

  it('threads --until into the query and composes with --since + --overlap', async () => {
    const { client, state } = fakeClient([[]]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'list',
      '--since',
      '2026-07-01',
      '--until',
      '2026-07-31',
      '--overlap',
    );
    expect(state.listQueries).toHaveLength(1);
    const q = state.listQueries[0]!;
    expect(q.since).toBe('2026-07-01T00:00:00.000Z');
    expect(q.until).toBe('2026-07-31T00:00:00.000Z');
    expect(q.overlap).toBe(true);
  });

  it('resolves a relative --until against now before calling the client', async () => {
    const { client, state } = fakeClient([[]]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    const before = Date.now();
    await runTimeline('list', '--until', '24h');
    const after = Date.now();
    const until = state.listQueries[0]?.until;
    expect(typeof until).toBe('string');
    const untilMs = Date.parse(until!);
    expect(untilMs).toBeGreaterThanOrEqual(before - 24 * 3600_000 - 1000);
    expect(untilMs).toBeLessThanOrEqual(after - 24 * 3600_000 + 1000);
  });

  it('rejects an unparseable --until with exit 1, labelled --until, and no network call', async () => {
    const { client, state } = fakeClient([[]]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('list', '--until', 'someday');
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain("invalid --until 'someday'");
    expect(state.listQueries).toHaveLength(0);
  });

  it('rejects a non-positive --limit', async () => {
    const { client, state } = fakeClient([[]]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('list', '--limit', '0');
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('--limit must be a positive integer');
    expect(state.listQueries).toHaveLength(0);
  });

  it('--all follows next_cursor to exhaustion', async () => {
    const pages = [
      [sampleEvent({ id: 'a' }), sampleEvent({ id: 'b' })],
      [sampleEvent({ id: 'c' })],
    ];
    const { client, state } = fakeClient(pages);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('list', '--brand', 'acme', '--all', '--json');
    expect(state.listQueries).toHaveLength(2);
    const parsed = JSON.parse(stdoutText()) as { count: number; events: unknown[] };
    expect(parsed.count).toBe(3);
    expect(parsed.events).toHaveLength(3);
  });

  it('without --all, a next_cursor surfaces as a hint instead of being followed', async () => {
    const pages = [[sampleEvent({ id: 'a' })], [sampleEvent({ id: 'b' })]];
    const { client, state } = fakeClient(pages);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('list', '--brand', 'acme');
    expect(state.listQueries).toHaveLength(1);
    expect(stdoutText()).toContain('--all');
  });

  it('passes the stake filters through with wire param names', async () => {
    const { client, state } = fakeClient([[]]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'list',
      '--stakes',
      '--category',
      'stockout',
      '--source',
      'suggested',
      '--status',
      'unverified',
      '--affects',
      'marketplace:US',
      '--overlap',
      '--include-future',
      '--since',
      '2026-07-01',
    );
    expect(state.listQueries).toHaveLength(1);
    expect(state.listQueries[0]).toMatchObject({
      stakes: true,
      category: 'stockout',
      source: 'suggested',
      status: 'unverified',
      affects: 'marketplace:US',
      overlap: true,
      include_future: true,
    });
  });

  it('omits the boolean stake flags entirely when they are not set', async () => {
    const { client, state } = fakeClient([[]]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('list', '--brand', 'acme');
    const q = state.listQueries[0]!;
    expect('stakes' in q).toBe(false);
    expect('overlap' in q).toBe(false);
    expect('include_future' in q).toBe(false);
  });

  it('renders a stake row with [category] status and range', async () => {
    const stake = sampleEvent({
      kind: 'structural.promo',
      category: 'promotional_window',
      status: 'corroborated',
      ts: '2026-07-10T00:00:00.000Z',
      end_ts: '2026-07-12T00:00:00.000Z',
      interpretation: 'Prime Day promo push',
      affects: ['marketplace:US', 'asin:B000XYZ'],
      evidence: { metric: 'acos' },
    });
    const { client } = fakeClient([[stake]]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('list', '--stakes');
    const out = stdoutText();
    expect(out).toContain('[promotional_window] corroborated');
    expect(out).toContain('2026-07-10T00:00:00.000Z → 2026-07-12T00:00:00.000Z');
    expect(out).toContain('affects×2');
    expect(out).toContain('evidence(1)');
  });

  it('renders a corroboration child compactly with its target', async () => {
    const child = sampleEvent({
      kind: 'structural.corroboration',
      target_ref: 'evt_stake_1',
      payload: { status: 'corroborated', note: 'second anomaly confirms' },
    });
    const { client } = fakeClient([[child]]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('list');
    const out = stdoutText();
    expect(out).toContain('corroborates');
    expect(out).toContain('evt_stake_1');
    expect(out).toContain('corroborated');
  });

  it('--json emits the full stake fields verbatim (nothing dropped in the shape)', async () => {
    const stake = sampleEvent({
      kind: 'structural.promo',
      category: 'promotional_window',
      status: 'corroborated',
      source: 'system',
      ts: '2026-07-10T00:00:00.000Z',
      end_ts: '2026-07-12T00:00:00.000Z',
      interpretation: 'Prime Day promo push',
      intensity: 2.5,
      affects: ['marketplace:US', 'asin:B000XYZ'],
      evidence: { metric: 'acos', magnitude: 0.4 },
    });
    const { client } = fakeClient([[stake]]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('list', '--stakes', '--json');
    const parsed = JSON.parse(stdoutText()) as {
      status: string;
      count: number;
      events: WireTimelineEvent[];
    };
    expect(parsed.status).toBe('ok');
    expect(parsed.count).toBe(1);
    expect(parsed.events[0]).toMatchObject({
      category: 'promotional_window',
      status: 'corroborated',
      source: 'system',
      end_ts: '2026-07-12T00:00:00.000Z',
      interpretation: 'Prime Day promo push',
      intensity: 2.5,
      affects: ['marketplace:US', 'asin:B000XYZ'],
      evidence: { metric: 'acos', magnitude: 0.4 },
    });
  });
});

describe('formatEventLine', () => {
  it('renders ts, kind, actor, brand and a payload digest', () => {
    const line = formatEventLine(
      sampleEvent({
        payload: {
          operation: 'sp.update_keywords',
          entity_type: 'keywords',
          entity_ids: ['1', '2'],
        },
        kind: 'action.ads_change_committed',
        family: 'action',
      }),
    );
    expect(line).toContain('2026-07-04T12:00:00.000Z');
    expect(line).toContain('action.ads_change_committed');
    expect(line).toContain('sam@example.com');
    expect(line).toContain('acme');
    expect(line).toContain('keywords×2');
    expect(line).toContain('sp.update_keywords');
  });

  it('renders a legacy structural event identically to the pre-stake format', () => {
    const line = formatEventLine(
      sampleEvent({
        kind: 'structural.price_change',
        payload: { note: 'MAP moved' },
      }),
    );
    // Column layout (ts,kind,actor,brand) + payload digest, unchanged.
    expect(line).toBe(
      '2026-07-04T12:00:00.000Z  ' +
        'structural.price_change'.padEnd(32) +
        '  ' +
        'sam@example.com'.padEnd(24) +
        '  ' +
        'acme'.padEnd(20) +
        '  MAP moved',
    );
  });

  it('renders a stake with [category] status, range, affects and evidence', () => {
    const line = formatEventLine(
      sampleEvent({
        kind: 'structural.launch',
        category: 'launch',
        status: 'unverified',
        end_ts: '2026-07-20T12:00:00.000Z',
        interpretation: 'new hydration line',
        affects: ['item_group:hydration'],
        evidence: { metric: 'units', window: '14d' },
      }),
    );
    expect(line).toContain('[launch] unverified');
    expect(line).toContain('2026-07-04T12:00:00.000Z → 2026-07-20T12:00:00.000Z');
    expect(line).toContain('new hydration line');
    expect(line).toContain('affects×1');
    expect(line).toContain('evidence(2)');
  });

  it('renders a corroboration child with its target ref', () => {
    const line = formatEventLine(
      sampleEvent({
        kind: 'structural.corroboration',
        target_ref: 'evt_stake_9',
        payload: { status: 'disputed' },
      }),
    );
    expect(line).toContain('corroborates');
    expect(line).toContain('evt_stake_9');
    expect(line).toContain('disputed');
  });
});

// ---------------------------------------------------------------------------
// timeline list/add --tag + timeline sync (#37499)
// ---------------------------------------------------------------------------

vi.mock('../lib/timeline/stake-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/timeline/stake-sync.js')>();
  return { ...actual, syncStakes: vi.fn() };
});

describe('--tag wiring (#37499)', () => {
  it('list --tag forwards the tag filter', async () => {
    const { client, state } = fakeClient([[]]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('list', '--tag', 'mmm');
    expect(state.listQueries[0].tag).toBe('mmm');
  });

  it('add --tag (repeatable) lands tags on the stake POST', async () => {
    const { client, state } = fakeClient([[]]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline(
      'add',
      '--brand', 'acme',
      '--kind', 'structural.demand_gen',
      '--category', 'off_amazon_media',
      '--interpretation', 'Backbone Media runs off-Amazon demand gen.',
      '--tag', 'mmm',
      '--tag', 'backbone-media',
    );
    expect(state.posts[0].tags).toEqual(['mmm', 'backbone-media']);
    expect(state.posts[0].category).toBe('off_amazon_media');
  });

  it('a non-stake add carrying --tag fails fast naming the fix', async () => {
    const { client, state } = fakeClient([[]]);
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('add', '--brand', 'acme', '--kind', 'comment', '--note', 'x', '--tag', 'mmm');
    expect(state.posts).toHaveLength(0);
    expect(stderrText()).toContain('add --category to record one');
  });
});

describe('timeline sync (#37499)', () => {
  it('reports per-event outcomes and the summary line', async () => {
    const { syncStakes } = await import('../lib/timeline/stake-sync.js');
    vi.mocked(syncStakes).mockResolvedValue({
      ok: true,
      brand: 'acme',
      total: 2,
      created: 1,
      duplicates: 1,
      failed: 0,
      reports: [
        { id: 'dsp-ramp', outcome: 'created', event_id: 'evt-1', category: 'launch', date_known: true },
        { id: 'rotation', outcome: 'duplicate', event_id: 'evt-2', category: 'assortment_change', date_known: false },
      ],
    });
    await runTimeline('sync', '--brand', 'acme');
    expect(vi.mocked(syncStakes)).toHaveBeenCalledWith('acme', {
      dataDirOverride: undefined,
      dryRun: false,
    });
    const out = stdoutText();
    expect(out).toContain('created   [launch] dsp-ramp  evt-1');
    expect(out).toContain('(no event date; recorded as of now)');
    expect(out).toContain('✓ Synced acme: 1 created, 1 already on the timeline.');
  });

  it('--dry-run passes through and prints the plan summary', async () => {
    const { syncStakes } = await import('../lib/timeline/stake-sync.js');
    vi.mocked(syncStakes).mockResolvedValue({
      ok: true,
      brand: 'acme',
      total: 1,
      created: 0,
      duplicates: 0,
      failed: 0,
      reports: [
        { id: 'dsp-ramp', outcome: 'planned', category: 'launch', date_known: true },
      ],
    });
    await runTimeline('sync', '--brand', 'acme', '--dry-run');
    expect(vi.mocked(syncStakes)).toHaveBeenCalledWith('acme', {
      dataDirOverride: undefined,
      dryRun: true,
    });
    expect(stdoutText()).toContain('Dry run: 1 event(s) would sync');
  });

  it('a whole-run error goes to the error surface', async () => {
    const { syncStakes } = await import('../lib/timeline/stake-sync.js');
    vi.mocked(syncStakes).mockResolvedValue({
      ok: false,
      brand: 'nope',
      total: 0,
      created: 0,
      duplicates: 0,
      failed: 0,
      reports: [],
      error: 'No brand context found for "nope".',
    });
    await runTimeline('sync', '--brand', 'nope');
    expect(stderrText()).toContain('No brand context found');
  });
});
