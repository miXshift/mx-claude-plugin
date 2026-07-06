/**
 * `mixshift timeline <list|add>` — the brand timeline (ORG-BRAIN.md 2b).
 *
 * list — read the per-brand event stream (knowledge revisions, audited Ads
 *        actions, structural stakes, comments), filterable by brand /
 *        family / kind / time window.
 * add  — append a human annotation: a `structural.*` stake in the ground
 *        (price change, stockout, Prime Day, creative refresh) or a
 *        `comment` attached to any target ref. `knowledge.*` events are
 *        server-emitted only and `action.*` events come from instrumented
 *        write paths (e.g. `mixshift ads call --commit`) — both are
 *        rejected here.
 *
 * All wire logic lives in lib/timeline/; this file parses options and
 * formats results (house pattern: commands/context.ts).
 */

import type { Command } from 'commander';
import {
  createTimelineClient,
  listAllEvents,
  LIST_ALL_CAP,
} from '../lib/timeline/client.js';
import { parseSince } from '../lib/timeline/since.js';
import type {
  PostTimelineEventInput,
  TimelineListQuery,
  WireTimelineEvent,
} from '../lib/timeline/types.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerTimelineCommands(program: Command): void {
  const timeline = program
    .command('timeline')
    .description(
      'The brand timeline: one append-only event stream per brand across ' +
        'every surface — context revisions, committed Ads changes, ' +
        'structural stakes (price change, stockout, Prime Day), and comments.',
    );

  registerList(timeline);
  registerAdd(timeline);
}

// ---------------------------------------------------------------------------
// timeline list
// ---------------------------------------------------------------------------

interface ListCliOptions {
  brand?: string;
  family?: string;
  kind?: string;
  since?: string;
  limit?: string;
  all?: boolean;
}

function registerList(timeline: Command): void {
  timeline
    .command('list')
    .description(
      'List timeline events, newest-first per the server ordering. One line ' +
        'per event: ts, family.kind, actor, brand, payload digest.',
    )
    .option('--brand <slug>', 'limit to one brand')
    .option('--family <f>', "event family: 'knowledge' | 'action' | 'structural' | 'comment'")
    .option('--kind <k>', "exact kind, e.g. 'action.ads_change_committed'")
    .option(
      '--since <when>',
      'ISO timestamp (2026-07-01) or relative: 24h, 7d, 2w',
    )
    .option('--limit <n>', 'max events per page (server default applies when omitted)')
    .option(
      '--all',
      `follow pagination to exhaustion (capped at ${LIST_ALL_CAP} events)`,
      false,
    )
    .action(async (opts: ListCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const t0 = Date.now();
      try {
        const query: TimelineListQuery = {};
        if (opts.brand) query.brand = opts.brand;
        if (opts.family) query.family = opts.family;
        if (opts.kind) query.kind = opts.kind;
        if (opts.since) {
          const since = parseSince(opts.since);
          if (!since.ok) {
            emitError(since.message, root);
            return;
          }
          query.since = since.iso;
        }
        if (opts.limit !== undefined) {
          const n = Number(opts.limit);
          if (!Number.isInteger(n) || n <= 0) {
            emitError(`--limit must be a positive integer, got '${opts.limit}'`, root);
            return;
          }
          query.limit = n;
        }

        const client = createTimelineClient({ dataDirOverride: root.dataDir });
        const result = opts.all
          ? await listAllEvents(client, query)
          : await client.listEvents(query);

        if (!result.ok) {
          await track(
            {
              event_name: EventName.TimelineListed,
              outcome: 'failed',
              duration_ms: Date.now() - t0,
              error_class: result.kind,
              payload: filtersPayload(query, opts.all ?? false),
            },
            root.dataDir,
          );
          emitError(result.friendly, root);
          return;
        }

        await track(
          {
            event_name: EventName.TimelineListed,
            outcome: 'ok',
            duration_ms: Date.now() - t0,
            payload: {
              ...filtersPayload(query, opts.all ?? false),
              count: result.events.length,
            },
          },
          root.dataDir,
        );

        if (root.json) {
          process.stdout.write(
            JSON.stringify(
              {
                status: 'ok',
                count: result.events.length,
                events: result.events,
                ...('next_cursor' in result && result.next_cursor !== undefined
                  ? { next_cursor: result.next_cursor }
                  : {}),
              },
              null,
              2,
            ) + '\n',
          );
          return;
        }

        if (result.events.length === 0) {
          process.stdout.write('No timeline events matched.\n');
          return;
        }
        const lines = result.events.map(formatEventLine);
        if ('next_cursor' in result && result.next_cursor !== undefined) {
          lines.push('');
          lines.push(
            `More events available — re-run with --all to follow pagination (cap ${LIST_ALL_CAP}).`,
          );
        }
        process.stdout.write(lines.join('\n') + '\n');
        return;
      } catch (err) {
        emitError(err instanceof Error ? err.message : String(err), root);
        return;
      }
    });
}

// ---------------------------------------------------------------------------
// timeline add
// ---------------------------------------------------------------------------

interface AddCliOptions {
  brand: string;
  kind: string;
  note?: string;
  target?: string;
}

function registerAdd(timeline: Command): void {
  timeline
    .command('add')
    .description(
      'Append a human annotation to a brand timeline: a structural.* stake ' +
        "in the ground (e.g. structural.price_change, structural.stockout) or " +
        "a 'comment'. --note lands in payload.note; --target attaches the " +
        'annotation to a specific fact/event/run. The acting person and ' +
        'surface are derived from your session automatically.',
    )
    .requiredOption('--brand <slug>', 'the brand this event belongs to')
    .requiredOption(
      '--kind <kind>',
      "dot-namespaced kind: 'structural.<what>' or 'comment'",
    )
    .option('--note <text>', 'the annotation text (payload.note)')
    .option('--target <ref>', 'target ref the annotation attaches to')
    .action(async (opts: AddCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const t0 = Date.now();
      try {
        const family = familyForKind(opts.kind);
        if (family === null) {
          emitError(
            `--kind must be 'comment' or 'structural.<what>' (got '${opts.kind}'). ` +
              "knowledge.* events are emitted by the context service and action.* " +
              'events by instrumented write paths — neither can be added by hand.',
            root,
          );
          return;
        }

        const input: PostTimelineEventInput = {
          brand_slug: opts.brand,
          family,
          kind: opts.kind,
          ...(opts.note !== undefined ? { payload: { note: opts.note } } : {}),
          ...(opts.target !== undefined ? { target_ref: opts.target } : {}),
        };

        const client = createTimelineClient({ dataDirOverride: root.dataDir });
        const result = await client.postEvent(input);

        await track(
          {
            event_name: EventName.TimelineEventAdded,
            outcome: result.ok ? 'ok' : 'failed',
            duration_ms: Date.now() - t0,
            ...(result.ok ? {} : { error_class: result.kind }),
            payload: {
              brand: opts.brand,
              family,
              kind: opts.kind,
              has_note: opts.note !== undefined,
              has_target: opts.target !== undefined,
            },
          },
          root.dataDir,
        );

        if (!result.ok) {
          emitError(result.friendly, root);
          return;
        }
        if (root.json) {
          process.stdout.write(
            JSON.stringify(
              { status: 'ok', id: result.id, brand: opts.brand, kind: opts.kind },
              null,
              2,
            ) + '\n',
          );
        } else {
          process.stdout.write(
            `✓ Added ${opts.kind} to ${opts.brand}'s timeline (event ${result.id}).\n`,
          );
        }
        return;
      } catch (err) {
        emitError(err instanceof Error ? err.message : String(err), root);
        return;
      }
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The `add` surface only writes annotations: comment or structural.*.
 *  Returns null for anything else (incl. knowledge.* / action.*). */
export function familyForKind(kind: string): 'structural' | 'comment' | null {
  if (kind === 'comment') return 'comment';
  if (/^structural\.[a-z0-9_.-]+$/i.test(kind)) return 'structural';
  return null;
}

/** `ts  family.kind  actor  brand  summary` — one line per event. */
export function formatEventLine(e: WireTimelineEvent): string {
  return [
    e.ts.padEnd(24),
    e.kind.padEnd(32),
    e.actor.padEnd(24),
    e.brand_slug.padEnd(20),
    summarizePayload(e),
  ]
    .join('  ')
    .trimEnd();
}

/** Compact digest of the payload for the human list line. */
function summarizePayload(e: WireTimelineEvent): string {
  const p = e.payload ?? {};
  const pick = (key: string): string | null => {
    const v = p[key];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  const parts: string[] = [];
  const text = pick('title') ?? pick('note');
  if (text !== null) parts.push(text);
  const docType = pick('doc_type');
  if (docType !== null) parts.push(`doc:${docType}`);
  const entity = pick('entity_type');
  if (entity !== null) {
    const ids = Array.isArray(p.entity_ids) ? p.entity_ids.length : null;
    parts.push(ids !== null ? `${entity}×${ids}` : entity);
  }
  const operation = pick('operation');
  if (operation !== null) parts.push(operation);
  const summary = parts.join('  ');
  return summary.length > 100 ? `${summary.slice(0, 99)}…` : summary;
}

function filtersPayload(
  query: TimelineListQuery,
  all: boolean,
): Record<string, unknown> {
  return {
    ...(query.brand !== undefined ? { brand: query.brand } : {}),
    ...(query.family !== undefined ? { family: query.family } : {}),
    ...(query.kind !== undefined ? { kind: query.kind } : {}),
    ...(query.since !== undefined ? { since: query.since } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    all,
  };
}

function emitError(message: string, root: RootOptions): void {
  if (root.json) {
    process.stdout.write(JSON.stringify({ status: 'error', message }, null, 2) + '\n');
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}
