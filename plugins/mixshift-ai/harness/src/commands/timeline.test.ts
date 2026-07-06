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

import { registerTimelineCommands, familyForKind, formatEventLine } from './timeline.js';
import { createTimelineClient, type TimelineClient } from '../lib/timeline/client.js';
import type {
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
}

function fakeClient(pages: WireTimelineEvent[][]): { client: TimelineClient; state: FakeState } {
  const state: FakeState = { listQueries: [], posts: [] };
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
    };
    vi.mocked(createTimelineClient).mockReturnValue(client);
    await runTimeline('add', '--brand', 'acme', '--kind', 'comment');
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('timeline:write');
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
});
