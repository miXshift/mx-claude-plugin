/**
 * `mixshift dayparting ...` -- read when in the day an Ads profile's campaigns earn clearly less or
 * more than their own average, through the MixShift service (lib/dayparting/client.ts).
 *
 * Command shape:
 *   dayparting diagnose --seller-id <id> [--profile-id <id>] [--lookback-days 56] [--target-acos 0.28]
 *                       [--exclude-dates 2026-10-06,2026-10-07] [--campaign-ids a,b] [--verbose] [--json]
 *   dayparting hours    --seller-id <id> [--profile-id <id>] --from <date> --to <date> [--json]
 *
 * `--seller-id` is the legacy seller id (digits) from `mixshift amazon merchants`. When that seller has
 * one Ads profile it is used; with several, `--profile-id` (from `mixshift ads profiles`) picks one.
 *
 * Reads only. Nothing here writes, schedules or applies a window: approving and scheduling arrive in a
 * later release.
 *
 * Output contract: `--json` prints the service's answer unchanged as ONE compact JSON object on one
 * line, last on stdout, and nothing else on stdout (human notes go to stderr). A refusal under --json is
 * the service's refusal body, also unchanged. Handlers set process.exitCode and return (never
 * process.exit). Telemetry carries the call kind, counts and outcome; never an id, a figure or the answer.
 */

import type { Command } from 'commander';
import { listAdsProfiles, type AdsProfileView } from '../lib/amazon/ads-call.js';
import { isReportFailure } from '../lib/amazon/reports.js';
import {
  daypartingDiagnose,
  daypartingHours,
  exitCodeForDaypartingKind,
  isDaypartingFailure,
  type DaypartingFailure,
} from '../lib/dayparting/client.js';
import { renderDiagnose, renderFailure, renderHours } from '../lib/dayparting/render.js';
import { track, EventName } from '../lib/telemetry/index.js';

export interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export const DEFAULT_LOOKBACK_DAYS = 56;
export const MIN_LOOKBACK_DAYS = 7;
export const MAX_LOOKBACK_DAYS = 62;

type CallKind = 'diagnose' | 'hours';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isRealDay(s: string): boolean {
  if (!DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function parseDays(raw: string): string[] | null {
  const days = raw.split(/[\s,]+/).filter(Boolean);
  if (days.length === 0 || !days.every(isRealDay)) return null;
  return [...new Set(days)];
}

export function parseIds(raw: string): string[] | null {
  const ids = raw.split(/[\s,]+/).filter(Boolean);
  if (ids.length === 0 || !ids.every((id) => /^\d{1,20}$/.test(id))) return null;
  return [...new Set(ids)];
}

/**
 * `--target-acos` as the service wants it, a whole-number percent. People write the target as a
 * fraction (0.28) or as a percent (28); a value up to 1 is a fraction.
 */
export function parseTargetAcos(raw: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(raw.trim())) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const percent = n <= 1 ? n * 100 : n;
  if (percent > 1000) return null;
  return Number(percent.toFixed(4));
}

export function registerDaypartingCommands(program: Command): void {
  const dayparting = program
    .command('dayparting')
    .description(
      'Find the times of day and days of the week when an Ads profile earns clearly less or more than its own average, ' +
        'and what a bid change in that window would touch. Read only: diagnose proposes windows, hours shows the hourly data. ' +
        'Nothing is changed, scheduled or applied. Needs hourly data (Amazon Marketing Stream) turned on for the profile. ' +
        '--seller-id is the legacy seller id from `mixshift amazon merchants`.',
    );

  dayparting
    .command('diagnose')
    .description('Which windows of the day are worth a bid change, in one sentence each: the ACOS in the window, what a change touches, and how far to trust it.')
    .requiredOption('--seller-id <id>', 'legacy seller id (digits), from `mixshift amazon merchants`')
    .option('--profile-id <id>', 'Ads profile id from `mixshift ads profiles`; needed only when the seller has more than one profile')
    .option('--lookback-days <n>', `days of history to read, ${MIN_LOOKBACK_DAYS} to ${MAX_LOOKBACK_DAYS} (default ${DEFAULT_LOOKBACK_DAYS}, eight whole weeks)`)
    .option('--target-acos <n>', 'the ACOS the brand aims for, as 0.28 or 28; a cut is only proposed against a target')
    .option('--exclude-dates <list>', 'comma-separated days to leave out (a launch, a sale, an outage), as YYYY-MM-DD')
    .option('--campaign-ids <list>', 'comma-separated campaign ids to narrow the read to')
    .option('--verbose', 'also show the reasons, the drivers, the service notes and the hour and weekday tables')
    .action(
      async (
        opts: { sellerId: string; profileId?: string; lookbackDays?: string; targetAcos?: string; excludeDates?: string; campaignIds?: string; verbose?: boolean },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        const startedAt = Date.now();
        if (!/^\d+$/.test(opts.sellerId)) return badInput('--seller-id is the legacy seller id: digits only. Run `mixshift amazon merchants` for the ids.', root);
        let lookbackDays: number | undefined;
        if (opts.lookbackDays !== undefined) {
          lookbackDays = /^\d+$/.test(opts.lookbackDays) ? Number(opts.lookbackDays) : NaN;
          if (!(lookbackDays >= MIN_LOOKBACK_DAYS && lookbackDays <= MAX_LOOKBACK_DAYS)) {
            return badInput(`--lookback-days is a whole number from ${MIN_LOOKBACK_DAYS} to ${MAX_LOOKBACK_DAYS}.`, root);
          }
        }
        let target: number | undefined;
        if (opts.targetAcos !== undefined) {
          const t = parseTargetAcos(opts.targetAcos);
          if (t === null) return badInput('--target-acos is a positive number: 0.28 or 28 both mean 28%.', root);
          target = t;
        }
        let excludedDates: string[] | undefined;
        if (opts.excludeDates !== undefined) {
          const days = parseDays(opts.excludeDates);
          if (!days) return badInput('--exclude-dates is a comma-separated list of real dates, like 2026-10-06,2026-10-07.', root);
          if (days.length > 62) return badInput('--exclude-dates takes at most 62 days.', root);
          excludedDates = days;
        }
        let campaignIds: string[] | undefined;
        if (opts.campaignIds !== undefined) {
          const ids = parseIds(opts.campaignIds);
          if (!ids) return badInput('--campaign-ids is a comma-separated list of campaign ids (digits only).', root);
          if (ids.length > 200) return badInput('--campaign-ids takes at most 200 ids.', root);
          campaignIds = ids;
        }
        if (opts.profileId !== undefined && !/^\d{1,20}$/.test(opts.profileId)) return badInput('--profile-id is the Ads profile id: digits only. Run `mixshift ads profiles`.', root);

        const profile = await resolveProfile(opts.sellerId, opts.profileId, root);
        if (!profile.ok) return;

        const result = await daypartingDiagnose(
          {
            profileId: profile.profileId,
            ...(lookbackDays !== undefined ? { lookbackDays } : {}),
            ...(target !== undefined ? { objective: { metric: 'acos' as const, target } } : {}),
            ...(excludedDates ? { excludedDates } : {}),
            ...(campaignIds ? { campaignIds } : {}),
          },
          { dataDirOverride: root.dataDir },
        );
        if (isDaypartingFailure(result)) return fail(result, 'diagnose', startedAt, root);
        const suggestions = Array.isArray(result.json.suggestions) ? result.json.suggestions.length : 0;
        await trackDayparting('diagnose', 'ok', startedAt, root.dataDir, { suggestions, status: typeof result.json.status === 'string' ? result.json.status : undefined });
        if (root.json) return writeJson(result.json);
        process.stdout.write(renderDiagnose(result.json, { verbose: opts.verbose === true }) + '\n');
      },
    );

  dayparting
    .command('hours')
    .description('The hourly Ads data behind a diagnosis for one profile and window (up to 62 days), rolled up by hour of the day; --json carries every row.')
    .requiredOption('--seller-id <id>', 'legacy seller id (digits), from `mixshift amazon merchants`')
    .option('--profile-id <id>', 'Ads profile id from `mixshift ads profiles`; needed only when the seller has more than one profile')
    .requiredOption('--from <date>', 'first day, YYYY-MM-DD')
    .requiredOption('--to <date>', 'last day, YYYY-MM-DD (at most 62 days from --from)')
    .action(async (opts: { sellerId: string; profileId?: string; from: string; to: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      if (!/^\d+$/.test(opts.sellerId)) return badInput('--seller-id is the legacy seller id: digits only. Run `mixshift amazon merchants` for the ids.', root);
      if (!isRealDay(opts.from) || !isRealDay(opts.to)) return badInput('--from and --to are real dates written YYYY-MM-DD.', root);
      const span = (Date.parse(`${opts.to}T00:00:00Z`) - Date.parse(`${opts.from}T00:00:00Z`)) / 86_400_000 + 1;
      if (span < 1) return badInput('--to must be on or after --from.', root);
      if (span > 62) return badInput(`That window is ${span} days; this reads at most 62. Narrow --from and --to.`, root);
      if (opts.profileId !== undefined && !/^\d{1,20}$/.test(opts.profileId)) return badInput('--profile-id is the Ads profile id: digits only. Run `mixshift ads profiles`.', root);

      const profile = await resolveProfile(opts.sellerId, opts.profileId, root);
      if (!profile.ok) return;

      const result = await daypartingHours({ profileId: profile.profileId, from: opts.from, to: opts.to }, { dataDirOverride: root.dataDir });
      if (isDaypartingFailure(result)) return fail(result, 'hours', startedAt, root);
      const rows = Array.isArray(result.json.rows) ? result.json.rows.length : 0;
      await trackDayparting('hours', 'ok', startedAt, root.dataDir, { rows });
      if (root.json) return writeJson(result.json);
      process.stdout.write(renderHours(result.json) + '\n');
    });
}

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

type Resolved = { ok: true; profileId: string } | { ok: false };

/**
 * The Ads profile to read. With --profile-id it is used as given. Otherwise the seller's profiles are
 * listed (the same list as `mixshift ads profiles`): exactly one is used; none or several stop with
 * the choices, because guessing a profile would read the wrong marketplace.
 */
export async function resolveProfile(sellerId: string, profileId: string | undefined, root: RootOptions): Promise<Resolved> {
  if (profileId !== undefined) return { ok: true, profileId };
  const listed = await listAdsProfiles({ dataDirOverride: root.dataDir });
  if (isReportFailure(listed)) {
    const failure: DaypartingFailure = { ok: false, kind: listed.kind, friendly: listed.friendly, ...(listed.message ? { message: listed.message } : {}) };
    if (root.json) writeJson({ ok: false, kind: failure.kind, friendly: failure.friendly });
    else process.stderr.write(`\n${failure.friendly}\n`);
    process.exitCode = exitCodeForDaypartingKind(failure.kind);
    return { ok: false };
  }
  const mine = listed.profiles.filter((p) => String(p.legacySellerId) === sellerId);
  if (mine.length === 1) return { ok: true, profileId: mine[0]!.profileId };
  if (mine.length === 0) {
    badInput(`No Ads profile for seller ${sellerId}. Run \`mixshift ads profiles\` and \`mixshift amazon merchants\` for the ids you can use.`, root);
    return { ok: false };
  }
  badInput(`Seller ${sellerId} has ${mine.length} Ads profiles. Pick one with --profile-id:\n${mine.map(describeProfile).join('\n')}`, root);
  return { ok: false };
}

function describeProfile(p: AdsProfileView): string {
  const where = [p.countryCode, p.marketplaceName ?? p.marketplaceId].filter((s): s is string => !!s).join(' ');
  return `  ${p.profileId}  ${p.name}${where ? ` (${where})` : ''}`;
}

// ---------------------------------------------------------------------------
// Output plumbing
// ---------------------------------------------------------------------------

function writeJson(obj: unknown): void {
  // One compact object on one line, last on stdout: a parent that reads the last line gets all of it.
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function badInput(message: string, root: RootOptions): void {
  if (root.json) writeJson({ ok: false, kind: 'invalid_input', friendly: message });
  else process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}

async function fail(failure: DaypartingFailure, kind: CallKind, startedAt: number, root: RootOptions): Promise<void> {
  await trackDayparting(kind, 'failed', startedAt, root.dataDir, {
    kind_failed: failure.kind,
    ...(failure.httpStatus ? { http_status: failure.httpStatus } : {}),
  });
  if (root.json) writeJson(failure.body ?? { ok: false, kind: failure.kind, friendly: failure.friendly });
  else process.stderr.write(`\n${renderFailure(failure)}\n`);
  process.exitCode = exitCodeForDaypartingKind(failure.kind);
}

async function trackDayparting(kind: CallKind, outcome: 'ok' | 'failed', startedAt: number, dataDir: string | undefined, payload: Record<string, unknown>): Promise<void> {
  await track(
    {
      event_name: EventName.DaypartingCalled,
      outcome,
      duration_ms: Date.now() - startedAt,
      ...(outcome === 'failed' && typeof payload.kind_failed === 'string' ? { error_class: payload.kind_failed } : {}),
      payload: { kind, ...payload },
    },
    dataDir,
  );
}
