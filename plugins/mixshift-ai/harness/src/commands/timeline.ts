/**
 * `mixshift timeline <list|add|corroborate>` — the brand timeline
 * (ORG-BRAIN.md 2b).
 *
 * list        — read the per-brand event stream (knowledge revisions, audited
 *               Ads actions, structural stakes, comments), filterable by brand
 *               / family / kind / time window, plus the stake filters
 *               (--stakes / --category / --source / --status / --affects /
 *               --overlap / --include-future).
 * add         — append a human annotation: a `structural.*` stake in the
 *               ground (price change, stockout, Prime Day, creative refresh)
 *               or a `comment` attached to any target ref. Passing --category
 *               makes it a typed stake (org brain P2.5). `knowledge.*` events
 *               are server-emitted only and `action.*` events come from
 *               instrumented write paths — both are rejected here.
 * corroborate — append a corroboration to an existing stake, moving its
 *               verification status / closing its range / attaching evidence.
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
import {
  STAKE_CATEGORIES,
  STAKE_SOURCES,
  STAKE_STATUSES,
  type CorroborateEventInput,
  type PostTimelineEventInput,
  type StakeCategory,
  type StakeSource,
  type StakeStatus,
  type TimelineListQuery,
  type WireTimelineEvent,
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
        'every surface: context revisions, committed Ads changes, ' +
        'structural stakes (price change, stockout, Prime Day), and comments.',
    );

  registerList(timeline);
  registerAdd(timeline);
  registerCorroborate(timeline);
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
  // Stake filters (org brain P2.5).
  stakes?: boolean;
  category?: string;
  source?: string;
  status?: string;
  affects?: string;
  overlap?: boolean;
  includeFuture?: boolean;
}

function registerList(timeline: Command): void {
  timeline
    .command('list')
    .description(
      'List timeline events, newest-first per the server ordering. One line ' +
        'per event: ts, family.kind, actor, brand, payload digest. Stakes ' +
        'show [category] status and their range; corroborations show their ' +
        'target.',
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
    .option('--stakes', 'restrict to stakes (structural events carrying a category)', false)
    .option('--category <enum>', 'filter to one stake category')
    .option('--source <src>', "trust axis: 'declared' | 'system' | 'suggested'")
    .option(
      '--status <status>',
      "verification axis: 'unverified' | 'corroborated' | 'disputed' | 'no_effect'",
    )
    .option('--affects <ref>', "match stakes whose affects contains this ref (e.g. 'marketplace:US')")
    .option(
      '--overlap',
      'treat --since/--until as an interval overlap against the stake range, not a point window',
      false,
    )
    .option('--include-future', 'include scheduled stakes dated beyond now+24h', false)
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
        // Stake filters — pass-through; the server validates enum values and
        // maps anything unrecognized to a friendly bad_params. Booleans are
        // only sent when set (an unset flag must not narrow the query, and
        // any stake filter also skips the ads-changes projection merge).
        if (opts.stakes) query.stakes = true;
        if (opts.category) query.category = opts.category as StakeCategory;
        if (opts.source) query.source = opts.source as StakeSource;
        if (opts.status) query.status = opts.status as StakeStatus;
        if (opts.affects) query.affects = opts.affects;
        if (opts.overlap) query.overlap = true;
        if (opts.includeFuture) query.include_future = true;

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
            `More events available; re-run with --all to follow pagination (cap ${LIST_ALL_CAP}).`,
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

/** Client-side note cap, aligned with the service's 32KB payload limit
 *  (the note is the payload's dominant field by construction here). */
export const MAX_NOTE_CHARS = 32_768;

/** Stake field caps — mirror the frozen wire contract so an oversized input
 *  fails fast with a clear message instead of a server bounce. */
export const MAX_INTERPRETATION_CHARS = 4_000;
export const MAX_EVIDENCE_CHARS = 4_096;

interface AddCliOptions {
  brand: string;
  kind: string;
  note?: string;
  target?: string;
  // Stake flags (org brain P2.5).
  ts?: string;
  end?: string;
  category?: string;
  affects?: string[];
  intensity?: string;
  source?: string;
  interpretation?: string;
  evidence?: string;
}

function registerAdd(timeline: Command): void {
  timeline
    .command('add')
    .description(
      'Append a human annotation to a brand timeline: a structural.* stake ' +
        "in the ground (e.g. structural.price_change, structural.stockout) or " +
        "a 'comment'. Pass --category to record it as a typed stake (requires " +
        '--interpretation). --note lands in payload.note; --target attaches ' +
        'the annotation to a specific fact/event/run. The acting person and ' +
        'surface are derived from your session automatically.',
    )
    .requiredOption('--brand <slug>', 'the brand this event belongs to')
    .requiredOption(
      '--kind <kind>',
      "dot-namespaced kind: 'structural.<what>' or 'comment'",
    )
    .option('--note <text>', 'the annotation text (payload.note)')
    .option('--target <ref>', 'target ref the annotation attaches to')
    .option('--ts <iso>', 'event time (backdate or schedule); defaults to now server-side')
    .option('--end <iso>', 'range close for a ranged stake (>= --ts)')
    .option('--category <enum>', 'stake category (makes this a typed stake; requires --interpretation)')
    .option('--affects <ref>', 'type-prefixed ref the stake touches (repeatable)', collect, [] as string[])
    .option('--intensity <number>', 'optional magnitude scalar for the stake')
    .option('--source <src>', "trust axis: 'declared' | 'system' | 'suggested' (default declared)")
    .option('--interpretation <text>', 'what the org read into the stake (required on a stake)')
    .option('--evidence <json>', 'initial evidence ref as a JSON object string')
    .action(async (opts: AddCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const t0 = Date.now();
      try {
        const family = familyForKind(opts.kind);
        if (family === null) {
          emitError(
            `--kind must be 'comment' or 'structural.<what>' (got '${opts.kind}'). ` +
              "knowledge.* events are emitted by the context service and action.* " +
              'events by instrumented write paths; neither can be added by hand.',
            root,
          );
          return;
        }
        // Client-side cap matching the service's 32KB payload limit, so an
        // oversized note fails fast with a clear message instead of a
        // too_large bounce after the request.
        if (opts.note !== undefined && opts.note.length > MAX_NOTE_CHARS) {
          emitError(
            `--note is too long (${opts.note.length} characters; the cap is ` +
              `${MAX_NOTE_CHARS}). Trim it, or store the full text as a corpus ` +
              'doc and reference it with --target.',
            root,
          );
          return;
        }

        const isStake = opts.category !== undefined;

        // Stake validation — fail fast + friendly (the server would 400
        // anyway). All checks fire only when a stake field is present, so a
        // legacy add takes the identical path.
        if (isStake) {
          if (!STAKE_CATEGORIES.includes(opts.category as StakeCategory)) {
            emitError(
              `--category must be one of: ${STAKE_CATEGORIES.join(', ')} (got '${opts.category}').`,
              root,
            );
            return;
          }
          if (family !== 'structural') {
            emitError(
              `a --category stake requires a 'structural.<what>' --kind (got '${opts.kind}').`,
              root,
            );
            return;
          }
          if (opts.interpretation === undefined || opts.interpretation.length === 0) {
            emitError(
              '--interpretation is required when --category is given (a stake ' +
                'records what the org read into the event).',
              root,
            );
            return;
          }
          if (opts.interpretation.length > MAX_INTERPRETATION_CHARS) {
            emitError(
              `--interpretation is too long (${opts.interpretation.length} characters; ` +
                `the cap is ${MAX_INTERPRETATION_CHARS}).`,
              root,
            );
            return;
          }
          if (opts.source !== undefined && !STAKE_SOURCES.includes(opts.source as StakeSource)) {
            emitError(
              `--source must be one of: ${STAKE_SOURCES.join(', ')} (got '${opts.source}').`,
              root,
            );
            return;
          }
        } else if (
          opts.end !== undefined ||
          opts.affects!.length > 0 ||
          opts.intensity !== undefined ||
          opts.source !== undefined ||
          opts.interpretation !== undefined ||
          opts.evidence !== undefined
        ) {
          // A non-stake carrying stake fields is a 400 server-side; name the
          // missing flag rather than bounce.
          emitError(
            '--end / --affects / --intensity / --source / --interpretation / ' +
              '--evidence describe a stake; add --category to record one.',
            root,
          );
          return;
        }

        // --intensity: parse to a finite number (a stake magnitude scalar).
        let intensity: number | undefined;
        if (opts.intensity !== undefined) {
          intensity = Number(opts.intensity);
          if (!Number.isFinite(intensity)) {
            emitError(`--intensity must be a finite number, got '${opts.intensity}'.`, root);
            return;
          }
        }

        // --ts / --end: light ISO sanity check (the server owns the exact
        // range rules; this only catches typos before the round trip).
        for (const [flag, value] of [
          ['--ts', opts.ts],
          ['--end', opts.end],
        ] as const) {
          if (value !== undefined && Number.isNaN(Date.parse(value))) {
            emitError(`${flag} must be an ISO-8601 timestamp, got '${value}'.`, root);
            return;
          }
        }

        // --evidence: JSON object (never an array/scalar), within the 4KB cap.
        let evidence: Record<string, unknown> | undefined;
        if (opts.evidence !== undefined) {
          const parsed = parseEvidence(opts.evidence);
          if (!parsed.ok) {
            emitError(parsed.message, root);
            return;
          }
          evidence = parsed.value;
        }

        const input: PostTimelineEventInput = {
          brand_slug: opts.brand,
          family,
          kind: opts.kind,
          ...(opts.note !== undefined ? { payload: { note: opts.note } } : {}),
          ...(opts.target !== undefined ? { target_ref: opts.target } : {}),
          ...(opts.ts !== undefined ? { ts: opts.ts } : {}),
          ...(isStake ? { category: opts.category as StakeCategory } : {}),
          ...(isStake ? { interpretation: opts.interpretation } : {}),
          ...(opts.end !== undefined ? { end_ts: opts.end } : {}),
          ...(opts.affects!.length > 0 ? { affects: opts.affects } : {}),
          ...(intensity !== undefined ? { intensity } : {}),
          ...(opts.source !== undefined ? { source: opts.source as StakeSource } : {}),
          ...(evidence !== undefined ? { evidence } : {}),
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
              is_stake: isStake,
              ...(isStake
                ? {
                    category: opts.category,
                    ...(opts.source !== undefined ? { source: opts.source } : {}),
                    has_end: opts.end !== undefined,
                    affects_count: opts.affects!.length,
                    has_evidence: evidence !== undefined,
                    has_intensity: intensity !== undefined,
                    has_ts: opts.ts !== undefined,
                  }
                : {}),
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
        } else if (isStake) {
          const rangeText = opts.end
            ? `range ${opts.ts ?? 'now'} → ${opts.end}`
            : opts.ts
              ? `point at ${opts.ts}`
              : 'point event';
          process.stdout.write(
            `✓ Recorded ${opts.category} stake for ${opts.brand} (${rangeText}, unverified). ` +
              `Event ${result.id}. Corroborate it later with ` +
              `\`mixshift timeline corroborate ${result.id}\`.\n`,
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
// timeline corroborate
// ---------------------------------------------------------------------------

/** Server cap on a corroboration note. */
export const MAX_CORROBORATE_NOTE_CHARS = 2_000;

interface CorroborateCliOptions {
  status?: string;
  end?: string;
  note?: string;
  evidence?: string;
}

function registerCorroborate(timeline: Command): void {
  timeline
    .command('corroborate <event-id>')
    .description(
      'Corroborate an existing stake: move its verification status, close its ' +
        'range, or attach evidence. Appends a corroboration to the stake and ' +
        'refreshes its status/end. At least one of --status / --end / ' +
        '--evidence is required (a --note alone is not a corroboration).',
    )
    .option(
      '--status <status>',
      "'unverified' | 'corroborated' | 'disputed' | 'no_effect'",
    )
    .option('--end <iso>', 'close the stake range at this timestamp (>= the stake ts)')
    .option('--note <text>', 'a human note recorded on the corroboration')
    .option('--evidence <json>', "this corroboration's evidence as a JSON object string")
    .action(async (eventId: string, opts: CorroborateCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const t0 = Date.now();
      try {
        // At least one of status/end/evidence — a note alone changes nothing.
        if (
          opts.status === undefined &&
          opts.end === undefined &&
          opts.evidence === undefined
        ) {
          emitError(
            'a corroboration needs at least one of --status, --end, or ' +
              '--evidence (a --note alone is not a corroboration).',
            root,
          );
          return;
        }
        if (
          opts.status !== undefined &&
          !STAKE_STATUSES.includes(opts.status as StakeStatus)
        ) {
          emitError(
            `--status must be one of: ${STAKE_STATUSES.join(', ')} (got '${opts.status}').`,
            root,
          );
          return;
        }
        if (opts.end !== undefined && Number.isNaN(Date.parse(opts.end))) {
          emitError(`--end must be an ISO-8601 timestamp, got '${opts.end}'.`, root);
          return;
        }
        if (opts.note !== undefined && opts.note.length > MAX_CORROBORATE_NOTE_CHARS) {
          emitError(
            `--note is too long (${opts.note.length} characters; the cap is ` +
              `${MAX_CORROBORATE_NOTE_CHARS}).`,
            root,
          );
          return;
        }
        let evidence: Record<string, unknown> | undefined;
        if (opts.evidence !== undefined) {
          const parsed = parseEvidence(opts.evidence);
          if (!parsed.ok) {
            emitError(parsed.message, root);
            return;
          }
          evidence = parsed.value;
        }

        const input: CorroborateEventInput = {
          ...(opts.status !== undefined ? { status: opts.status as StakeStatus } : {}),
          ...(opts.end !== undefined ? { end_ts: opts.end } : {}),
          ...(opts.note !== undefined ? { note: opts.note } : {}),
          ...(evidence !== undefined ? { evidence } : {}),
        };

        const client = createTimelineClient({ dataDirOverride: root.dataDir });
        const result = await client.corroborateEvent(eventId, input);

        await track(
          {
            event_name: EventName.TimelineEventCorroborated,
            outcome: result.ok ? 'ok' : 'failed',
            duration_ms: Date.now() - t0,
            ...(result.ok ? {} : { error_class: result.kind }),
            payload: {
              has_status: opts.status !== undefined,
              ...(opts.status !== undefined ? { status: opts.status } : {}),
              has_end: opts.end !== undefined,
              has_note: opts.note !== undefined,
              has_evidence: evidence !== undefined,
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
              {
                status: 'ok',
                corroboration_id: result.corroboration_id,
                event: result.event,
              },
              null,
              2,
            ) + '\n',
          );
        } else {
          const ev = result.event;
          const closes =
            typeof ev.end_ts === 'string' && ev.end_ts.length > 0
              ? `, range closes ${ev.end_ts}`
              : '';
          process.stdout.write(
            `✓ Corroborated ${eventId}: status now ${ev.status ?? 'unchanged'}${closes}. ` +
              `Corroboration ${result.corroboration_id}.\n`,
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

/** Repeatable-option accumulator for commander. */
function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

type ParseEvidenceResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

/** Parse --evidence: must be a JSON object (not an array/scalar/null) within
 *  the 4KB serialized cap. */
function parseEvidence(raw: string): ParseEvidenceResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      message: `--evidence must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: '--evidence must be a JSON object (e.g. \'{"metric":"acos"}\').' };
  }
  if (raw.length > MAX_EVIDENCE_CHARS) {
    return {
      ok: false,
      message: `--evidence is too large (${raw.length} characters; the cap is ${MAX_EVIDENCE_CHARS}).`,
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** The `add` surface only writes annotations: comment or structural.*.
 *  Returns null for anything else (incl. knowledge.* / action.*). */
export function familyForKind(kind: string): 'structural' | 'comment' | null {
  if (kind === 'comment') return 'comment';
  if (/^structural\.[a-z0-9_.-]+$/i.test(kind)) return 'structural';
  return null;
}

/** `ts  family.kind  actor  brand  summary` — one line per event. Legacy
 *  events render exactly as before; stakes and corroboration children get a
 *  stake-aware summary in the last column (the column layout is unchanged). */
export function formatEventLine(e: WireTimelineEvent): string {
  return [
    e.ts.padEnd(24),
    e.kind.padEnd(32),
    e.actor.padEnd(24),
    e.brand_slug.padEnd(20),
    summarizeEvent(e),
  ]
    .join('  ')
    .trimEnd();
}

/** Route the summary column: corroboration children and stakes get their own
 *  compact digests; everything else keeps the legacy payload digest verbatim. */
function summarizeEvent(e: WireTimelineEvent): string {
  if (e.kind === 'structural.corroboration') return summarizeCorroboration(e);
  if (e.category !== undefined) return summarizeStake(e);
  return summarizePayload(e);
}

/** `[category] status  ts → end_ts  <interpretation>  affects×N  evidence(N)` */
function summarizeStake(e: WireTimelineEvent): string {
  const parts: string[] = [`[${e.category}]${e.status ? ` ${e.status}` : ''}`];
  if (isNonEmpty(e.end_ts)) parts.push(`${e.ts} → ${e.end_ts}`);
  if (isNonEmpty(e.interpretation)) parts.push(truncate(e.interpretation, 60));
  if (Array.isArray(e.affects) && e.affects.length > 0) {
    parts.push(`affects×${e.affects.length}`);
  }
  const evidenceKeys =
    e.evidence && typeof e.evidence === 'object' ? Object.keys(e.evidence).length : 0;
  if (evidenceKeys > 0) parts.push(`evidence(${evidenceKeys})`);
  return parts.join('  ');
}

/** `corroborates <target>  <status>  <note>` — a compact lifecycle child. */
function summarizeCorroboration(e: WireTimelineEvent): string {
  const parts: string[] = ['corroborates'];
  if (isNonEmpty(e.target_ref)) parts.push(e.target_ref);
  const p = e.payload ?? {};
  if (typeof p.status === 'string' && p.status.length > 0) parts.push(p.status);
  if (typeof p.note === 'string' && p.note.length > 0) parts.push(truncate(p.note, 60));
  return parts.join('  ');
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

function isNonEmpty(v: string | undefined): v is string {
  return typeof v === 'string' && v.length > 0;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
    ...(query.stakes !== undefined ? { stakes: query.stakes } : {}),
    ...(query.category !== undefined ? { category: query.category } : {}),
    ...(query.source !== undefined ? { source: query.source } : {}),
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.affects !== undefined ? { affects: query.affects } : {}),
    ...(query.overlap !== undefined ? { overlap: query.overlap } : {}),
    ...(query.include_future !== undefined ? { include_future: query.include_future } : {}),
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
