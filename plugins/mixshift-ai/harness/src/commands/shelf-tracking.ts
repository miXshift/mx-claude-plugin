/**
 * `mixshift shelf tracking ...`: the organization's rank tracking sets, the
 * keywords, shopper locations (zips), views and ASINs MixShift searches once a
 * day so `shelf rank-history` can answer (lib/shelf/tracking.ts).
 *
 *   tracking list                       every set, then the projected monthly use against the allowance
 *   tracking show <id>                  one set in full: keywords, ASINs, zips, views, last run
 *   tracking create <id> --keyword K... --zip Z... [--view V...] [--asin A...] [--pages N] [--note T] [--replace]
 *   tracking add <id> [--keyword K...] [--asin A...]
 *   tracking remove <id> [--keyword K...] [--asin A...]
 *   tracking pause <id> | resume <id>
 *   tracking delete <id> --yes
 *
 * Anyone in the organization can list and show; an owner, admin, manager or builder
 * signed in as a person can change the sets (the service refuses anyone else,
 * and every machine credential: forbidden, exit 11). A paused set keeps its
 * rank history readable; only a deleted set, or a keyword removed from a set,
 * stops answering (unless another set lists it).
 * Reading and changing are free, but every running set takes keywords x zips x
 * views x pages shelf answers a day from the monthly allowance, and a change
 * that would push the projected monthly use past the allowance is refused
 * (tracking_over_allowance, exit 10). After every write the command prints
 * what changed, the set's calls a day and the projected monthly use against
 * the allowance.
 *
 * `--view`, not `--surface`: the root program owns `--surface` (the telemetry
 * host flag), and commander hands a parent's flag to the parent.
 *
 * Telemetry: which action, counts (keywords and ASINs asked for, added and
 * removed; the set's sizes and calls a day; the projection and the allowance)
 * and the outcome. Never a set id, a note, a keyword, a zip or an ASIN.
 */

import type { Command } from 'commander';
import {
  SHELF_COUNTRIES,
  SHELF_SURFACES,
  isShelfFailure,
  type ShelfClientOptions,
  type ShelfCountry,
  type ShelfFailure,
  type ShelfSurface,
} from '../lib/shelf/client.js';
import {
  TRACKING_ID_RE,
  TRACKING_MAX_KEYWORDS,
  TRACKING_MAX_PAGES,
  TRACKING_MAX_ZIPS,
  normalizeKeyword,
  shelfTrackingDelete,
  shelfTrackingGet,
  shelfTrackingList,
  shelfTrackingPatch,
  shelfTrackingPut,
  type ShelfTrackingList,
  type ShelfTrackingSet,
  type ShelfTrackingWritten,
} from '../lib/shelf/tracking.js';
import { emitError, emitFailure, failurePayload, trackShelf, writeJson } from './_shelf-output.js';
import { EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

interface TrackingOptions {
  keyword?: string[];
  zip?: string[];
  view?: string[];
  asin?: string[];
  pages?: string;
  note?: string;
  country?: string;
  replace?: boolean;
  yes?: boolean;
}

export type TrackingAction = 'create' | 'replace' | 'add' | 'remove' | 'pause' | 'resume' | 'delete';

/** What a write changed. Values are the user's own and only ever printed locally; telemetry gets the counts. */
export interface TrackingChanges {
  keywords_added: string[];
  keywords_removed: string[];
  asins_added: string[];
  asins_removed: string[];
  /** Asked for with nothing to do: already on the set (add), or not on it (remove). */
  keywords_unchanged: string[];
  asins_unchanged: string[];
  /** On a replace: what the set had before, where it differs. */
  zips_before?: string[];
  views_before?: ShelfSurface[];
  pages_before?: number;
}

const ASIN_RE = /^[A-Z0-9]{10}$/;
const KEYWORD_MAX_LENGTH = 200;

function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export function registerShelfTracking(shelf: Command): void {
  const tracking = shelf
    .command('tracking')
    .description(
      "Your organization's rank tracking: the keywords MixShift searches once a day at each tracked zip and view, which " +
        '`shelf rank-history` reads back. Anyone can list and show the sets; an owner, admin, manager or builder, signed in as a ' +
        'person, can create, add, remove, pause, resume and delete (a machine credential never can). Free to read and change, ' +
        'but every running set takes keywords x zips x views x pages shelf requests a day from the monthly allowance. To stop ' +
        'paying for a set and keep its history readable, pause it.',
    );

  tracking
    .command('list')
    .description(
      'Every tracking set: its note, keyword count, zips, views, pages, calls a day, whether it is enabled and its last run; ' +
        'then the projected monthly use against the allowance, and whether you can change the sets. Free.',
    )
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = context(cmd);
      try {
        const r = await shelfTrackingList(ctx.client);
        if (isShelfFailure(r)) return failed(ctx, EventName.ShelfTrackingRead, r, { action: 'list' });
        const running = r.sets.filter(isRunning);
        await trackShelf(EventName.ShelfTrackingRead, 'ok', ctx.startedAt, ctx.dataDir, {
          action: 'list',
          sets: r.sets.length,
          running: running.length,
          can_edit: r.can_edit,
          keywords: r.sets.reduce((n, s) => n + s.keywords.length, 0),
          calls_per_day: running.reduce((n, s) => n + s.calls_per_day, 0),
          projected_calls_per_month: r.projected_calls_per_month,
          allowance: r.allowance,
        });
        if (ctx.json) return writeJson({ status: 'ok', ...r });
        process.stderr.write(`\n✓ ${r.sets.length} rank tracking set(s), ${running.length} running\n\n`);
        process.stdout.write(renderTrackingList(r) + '\n');
      } catch (err) {
        emitError(err, ctx.json);
      }
    });

  tracking
    .command('show <id>')
    .description('One tracking set in full: every keyword and ASIN, its zips, views and pages, calls a day, last run, and who changed it last. Free.')
    .action(async (rawId: string, _opts: unknown, cmd: Command) => {
      const ctx = context(cmd);
      try {
        const id = parseId(rawId);
        const r = await shelfTrackingGet(id, ctx.client);
        if (isShelfFailure(r)) return failed(ctx, EventName.ShelfTrackingRead, r, { action: 'show' });
        await trackShelf(EventName.ShelfTrackingRead, 'ok', ctx.startedAt, ctx.dataDir, { action: 'show', ...setCounts(r.set) });
        if (ctx.json) return writeJson({ status: 'ok', ...r });
        process.stderr.write(`\n✓ tracking set ${r.set.id}\n\n`);
        process.stdout.write(renderTrackingSet(r.set) + '\n');
      } catch (err) {
        emitError(err, ctx.json);
      }
    });

  tracking
    .command('create <id>')
    .description(
      'Create a tracking set (owners, admins, managers and builders): the keywords to search once a day at each zip, on each view. ' +
        'The id is yours to pick: lower-case letters, digits and hyphens, 2 to 63 characters. The set takes keywords x zips x ' +
        'views x pages shelf requests a day; a set over the per-set limit of calls a day, or one that would push the projected ' +
        'monthly use past the allowance, is refused. An id that is taken is refused unless --replace, except when that set ' +
        'already has these keywords and zips (and any other values given): a create run again after a lost answer, which ' +
        'answers that nothing changed, or that the set is paused and how to resume it.',
    )
    .option('--keyword <keyword>', `a keyword to track (repeatable; 1 to ${TRACKING_MAX_KEYWORDS})`, collect)
    .option('--zip <zip>', `a shopper location from \`shelf zips\` (repeatable; 1 to ${TRACKING_MAX_ZIPS})`, collect)
    .option('--view <view>', 'desktop or mobile (repeatable; default both)', collect)
    .option('--asin <asin>', 'an ASIN whose rank to read back (repeatable)', collect)
    .option('--pages <n>', `results pages per search, 1 (default) to ${TRACKING_MAX_PAGES}`)
    .option('--note <text>', 'what the set is for, shown by `tracking list`')
    .option('--country <code>', 'marketplace country: us (default for a new set), ca, uk, de, fr, it, es, in')
    .option('--replace', 'overwrite the set if the id is taken: its keywords and zips become these; views, ASINs, pages and note you leave out keep their values')
    .action(async (rawId: string, opts: TrackingOptions, cmd: Command) => {
      const ctx = context(cmd);
      try {
        const id = parseId(rawId);
        const keywords = parseKeywords(opts.keyword);
        if (keywords.length === 0) throw new Error('--keyword is required: at least one keyword to track (repeat the flag for more).');
        if (keywords.length > TRACKING_MAX_KEYWORDS) throw new Error(`A set tracks at most ${TRACKING_MAX_KEYWORDS} keywords; split them into more sets.`);
        const zips = parseZips(opts.zip);
        if (zips.length === 0) throw new Error('--zip is required: at least one shopper location from `mixshift shelf zips` (repeat the flag for more).');
        if (zips.length > TRACKING_MAX_ZIPS) throw new Error(`A set tracks at most ${TRACKING_MAX_ZIPS} zips; split them into more sets.`);
        const views = parseViews(opts.view);
        const asins = parseAsins(opts.asin);
        const pages = parsePages(opts.pages);
        const note = opts.note?.trim() || undefined;
        const country = parseCountry(opts.country);
        const asked = { keywords_asked: keywords.length, zips_asked: zips.length, views_asked: views.length, asins_asked: asins.length, has_note: !!note, ...(country ? { country } : {}) };

        const prior = await shelfTrackingGet(id, ctx.client);
        if (isShelfFailure(prior) && !isNotFound(prior)) return failed(ctx, EventName.ShelfTrackingChanged, prior, { action: 'create', stage: 'lookup', ...asked });
        const before = isShelfFailure(prior) ? null : prior.set;
        if (before && !opts.replace && sameAsAsked(before, { keywords, zips, views, asins, pages, note, country })) {
          // A create run again after a lost answer: the set already has what was asked. Nothing to write; say so, with
          // the projection. A paused (or cadence-off) set is not "as asked": it answers paused, with the way to resume it.
          const running = isRunning(before);
          const all = await shelfTrackingList(ctx.client);
          const projection = isShelfFailure(all) ? { projected_calls_per_month: null, allowance: null } : { projected_calls_per_month: all.projected_calls_per_month, allowance: all.allowance };
          const state = running ? { unchanged: true } : { paused: true };
          await trackShelf(EventName.ShelfTrackingChanged, 'ok', ctx.startedAt, ctx.dataDir, { action: 'create', ...state, ...asked, ...setCounts(before), ...projection });
          if (ctx.json) return writeJson({ status: 'ok', action: 'create', id, ...state, set: before, ...projection });
          process.stderr.write(`\n✓ tracking set ${id} already exists with these keywords and zips${running ? '' : ', paused'}\n\n`);
          process.stdout.write(renderUnchanged(before, projection.projected_calls_per_month, projection.allowance) + '\n');
          return;
        }
        if (before && !opts.replace) {
          return failed(
            ctx,
            EventName.ShelfTrackingChanged,
            {
              ok: false,
              kind: 'tracking_set_exists',
              friendly: `A tracking set "${id}" already exists, with other keywords, zips or settings (${plural(before.keywords.length, 'keyword')}, ${before.calls_per_day} calls a day). Nothing was changed.`,
              message: `To change it: \`mixshift shelf tracking add ${id}\` or \`remove ${id}\`. To overwrite it, run create again with --replace.`,
            },
            { action: 'create', stage: 'lookup', ...asked },
          );
        }
        const action: TrackingAction = before ? 'replace' : 'create';
        const r = await shelfTrackingPut(
          id,
          {
            keywords,
            zips,
            ...(views.length ? { surfaces: views } : {}),
            ...(asins.length ? { asins } : {}),
            ...(pages !== undefined ? { pages } : {}),
            ...(note ? { note } : {}),
            ...(country ? { country } : {}),
          },
          ctx.client,
        );
        if (isShelfFailure(r)) return failed(ctx, EventName.ShelfTrackingChanged, r, { action, stage: 'write', ...asked });
        await written(ctx, action, id, r, diffSets(before, r.set), asked);
      } catch (err) {
        emitError(err, ctx.json);
      }
    });

  for (const mode of ['add', 'remove'] as const) {
    tracking
      .command(`${mode} <id>`)
      .description(
        mode === 'add'
          ? 'Add keywords or ASINs to a tracking set (owners, admins, managers and builders). Each keyword adds zips x views x pages ' +
              'calls a day; a change that would take the set over the per-set limit of calls a day, or the projected monthly use ' +
              'past the allowance, is refused. ASINs cost nothing.'
          : 'Remove keywords or ASINs from a tracking set (owners, admins, managers and builders). The allowance never blocks a removal, ' +
              'and each keyword removed saves zips x views x pages calls a day. `shelf rank-history` stops answering for a removed ' +
              'keyword unless another set lists it. A set keeps at least one keyword: pause or delete the set instead.',
      )
      .option('--keyword <keyword>', `a keyword to ${mode} (repeatable)`, collect)
      .option('--asin <asin>', `an ASIN to ${mode} (repeatable)`, collect)
      .action(async (rawId: string, opts: TrackingOptions, cmd: Command) => {
        const ctx = context(cmd);
        try {
          const id = parseId(rawId);
          const keywords = parseKeywords(opts.keyword);
          const asins = parseAsins(opts.asin);
          if (keywords.length === 0 && asins.length === 0) throw new Error(`Name at least one --keyword or --asin to ${mode}.`);
          const asked = { keywords_asked: keywords.length, asins_asked: asins.length };

          const prior = await shelfTrackingGet(id, ctx.client);
          if (isShelfFailure(prior)) return failed(ctx, EventName.ShelfTrackingChanged, prior, { action: mode, stage: 'lookup', ...asked });
          if (mode === 'remove') {
            const drop = new Set(keywords.map(normalizeKeyword));
            if (prior.set.keywords.length > 0 && prior.set.keywords.every((k) => drop.has(normalizeKeyword(k)))) {
              throw new Error(
                `That would leave "${id}" with no keywords, and a set keeps at least one. To stop paying for it and keep its history ` +
                  `readable, pause it (\`mixshift shelf tracking pause ${id}\`); to remove it, delete it (\`mixshift shelf tracking delete ${id} --yes\`).`,
              );
            }
          }
          const r = await shelfTrackingPatch(
            id,
            mode === 'add' ? { add_keywords: keywords, add_asins: asins } : { remove_keywords: keywords, remove_asins: asins },
            ctx.client,
          );
          if (isShelfFailure(r)) return failed(ctx, EventName.ShelfTrackingChanged, r, { action: mode, stage: 'write', ...asked });
          await written(ctx, mode, id, r, diffSets(prior.set, r.set, { mode, keywords, asins }), asked);
        } catch (err) {
          emitError(err, ctx.json);
        }
      });
  }

  for (const mode of ['pause', 'resume'] as const) {
    tracking
      .command(`${mode} <id>`)
      .description(
        mode === 'pause'
          ? 'Pause a tracking set (owners, admins, managers and builders): its daily searches stop and it uses none of the allowance, and ' +
              'its rank history stays readable with `shelf rank-history --set <id>` (the default read covers running sets only). The way to ' +
              'stop paying for a set and keep its history.'
          : 'Resume a paused tracking set (owners, admins, managers and builders): the next daily run searches it again, and it uses its ' +
              'calls a day from the allowance again. Refused if that would push the projected monthly use past the allowance.',
      )
      .action(async (rawId: string, _opts: unknown, cmd: Command) => {
        const ctx = context(cmd);
        try {
          const id = parseId(rawId);
          // Resume also sets the cadence back to daily, so a set whose cadence was off really runs again.
          const r = await shelfTrackingPatch(id, mode === 'resume' ? { enabled: true, cadence: 'daily' } : { enabled: false }, ctx.client);
          if (isShelfFailure(r)) return failed(ctx, EventName.ShelfTrackingChanged, r, { action: mode, stage: 'write' });
          await written(ctx, mode, id, r, null, {});
        } catch (err) {
          emitError(err, ctx.json);
        }
      });
  }

  tracking
    .command('delete <id>')
    .description(
      'Delete a tracking set (owners, admins, managers and builders): its daily searches stop, and `shelf rank-history` no longer answers ' +
        'for its keywords unless another set (running or paused) lists them. Needs --yes. To stop paying and keep the history ' +
        'readable, pause it instead.',
    )
    .option('--yes', 'confirm the delete (without it nothing is deleted)')
    .action(async (rawId: string, opts: TrackingOptions, cmd: Command) => {
      const ctx = context(cmd);
      try {
        const id = parseId(rawId);
        if (!opts.yes) {
          await trackShelf(EventName.ShelfTrackingChanged, 'failed', ctx.startedAt, ctx.dataDir, { action: 'delete', stage: 'confirm', kind_failed: 'confirmation_required' });
          throw new Error(
            `Nothing was deleted. Deleting "${id}" stops its daily searches, and rank-history no longer answers for its keywords ` +
              `unless another set lists them. To stop paying and keep its history readable, pause it instead: ` +
              `\`mixshift shelf tracking pause ${id}\`. To delete it, run \`mixshift shelf tracking delete ${id} --yes\`.`,
          );
        }
        const prior = await shelfTrackingGet(id, ctx.client);
        if (isShelfFailure(prior)) return failed(ctx, EventName.ShelfTrackingChanged, prior, { action: 'delete', stage: 'lookup' });
        const r = await shelfTrackingDelete(id, ctx.client);
        if (isShelfFailure(r)) return failed(ctx, EventName.ShelfTrackingChanged, r, { action: 'delete', stage: 'write', ...setCounts(prior.set) });
        // The delete answers only ok; the projection after it is one free read away. A failure there leaves the delete done.
        const after = await shelfTrackingList(ctx.client);
        const projection = isShelfFailure(after) ? { projected_calls_per_month: null, allowance: null } : { projected_calls_per_month: after.projected_calls_per_month, allowance: after.allowance };
        await trackShelf(EventName.ShelfTrackingChanged, 'ok', ctx.startedAt, ctx.dataDir, { action: 'delete', ...setCounts(prior.set), ...projection });
        if (ctx.json) return writeJson({ status: 'ok', action: 'delete', id, deleted: prior.set, ...projection });
        process.stderr.write(`\n✓ deleted tracking set ${id}\n\n`);
        process.stdout.write(renderDeleted(prior.set, projection.projected_calls_per_month, projection.allowance) + '\n');
      } catch (err) {
        emitError(err, ctx.json);
      }
    });
}

// ---------------------------------------------------------------------------
// Flow helpers
// ---------------------------------------------------------------------------

interface Ctx {
  json: boolean;
  dataDir: string | undefined;
  startedAt: number;
  client: ShelfClientOptions;
}

function context(cmd: Command): Ctx {
  const root = cmd.optsWithGlobals<RootOptions>();
  return { json: !!root.json, dataDir: root.dataDir, startedAt: Date.now(), client: { dataDirOverride: root.dataDir } };
}

async function failed(ctx: Ctx, eventName: string, f: ShelfFailure, base: Record<string, unknown>): Promise<void> {
  await trackShelf(eventName, 'failed', ctx.startedAt, ctx.dataDir, failurePayload(f, base));
  emitFailure(f, ctx.json);
  // "No such set" makes sense only where a set is named and may be missing: never for `list`, never for a create's PUT.
  const namesASet = base.action !== 'list' && !((base.action === 'create' || base.action === 'replace') && base.stage === 'write');
  if (!ctx.json && isNotFound(f) && namesASet) {
    process.stderr.write('  `mixshift shelf tracking list` shows the sets your organization has.\n');
    if (base.action === 'delete') process.stderr.write('  If you deleted it a moment ago and the answer was lost, it may already be deleted.\n');
  }
  if (!ctx.json && f.kind === 'host_unreachable' && base.stage === 'write') {
    process.stderr.write(
      '  The change may or may not have been made: `mixshift shelf tracking show <set>` says. Running it again is safe: a create that ' +
        'went through answers that the set is already as asked, and a delete that went through answers not_found.\n',
    );
  }
}

async function written(ctx: Ctx, action: TrackingAction, id: string, r: ShelfTrackingWritten, changes: TrackingChanges | null, asked: Record<string, unknown>): Promise<void> {
  await trackShelf(EventName.ShelfTrackingChanged, 'ok', ctx.startedAt, ctx.dataDir, {
    action,
    ...asked,
    ...(changes
      ? {
          keywords_added: changes.keywords_added.length,
          keywords_removed: changes.keywords_removed.length,
          asins_added: changes.asins_added.length,
          asins_removed: changes.asins_removed.length,
        }
      : {}),
    ...setCounts(r.set),
    projected_calls_per_month: r.projected_calls_per_month,
    allowance: r.allowance,
  });
  if (ctx.json) return writeJson({ status: 'ok', action, id, ...(changes ? { changes } : {}), set: r.set, projected_calls_per_month: r.projected_calls_per_month, allowance: r.allowance });
  const verb = { create: 'created', replace: 'replaced', add: 'changed', remove: 'changed', pause: 'paused', resume: 'resumed', delete: 'deleted' }[action];
  process.stderr.write(`\n✓ ${verb} tracking set ${id}\n\n`);
  process.stdout.write(renderWritten(action, r, changes) + '\n');
}

/** No such set (the routes missing on the service read as tracking_unavailable, never as this). */
function isNotFound(f: ShelfFailure): boolean {
  return f.kind === 'not_found';
}

/** Whether a set already is what a create asks for: keywords and zips as sets, and each optional field only when given (the service keeps the rest). */
function sameAsAsked(
  s: ShelfTrackingSet,
  a: { keywords: string[]; zips: string[]; views: ShelfSurface[]; asins: string[]; pages?: number; note?: string; country?: ShelfCountry },
): boolean {
  const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((v) => y.includes(v));
  if (!same([...new Set(s.keywords.map(normalizeKeyword))], a.keywords)) return false;
  if (!same([...new Set(s.zips.map((z) => z.trim().replace(/\s+/g, ' ').toUpperCase()))], a.zips)) return false;
  if (a.views.length > 0 && !same(s.surfaces, a.views)) return false;
  if (a.asins.length > 0 && !same([...new Set(s.asins.map((x) => x.toUpperCase()))], a.asins)) return false;
  if (a.pages !== undefined && s.pages !== a.pages) return false;
  if (a.note !== undefined && s.note !== a.note) return false;
  if (a.country !== undefined && s.country !== a.country) return false;
  return true;
}

function isRunning(s: ShelfTrackingSet): boolean {
  return s.enabled && s.cadence === 'daily';
}

/** Counts only, for telemetry. */
function setCounts(s: ShelfTrackingSet): Record<string, unknown> {
  return {
    keywords: s.keywords.length,
    asins: s.asins.length,
    zips: s.zips.length,
    views: s.surfaces.length,
    pages: s.pages,
    calls_per_day: s.calls_per_day,
    enabled: s.enabled,
    cadence: s.cadence,
  };
}

export function diffSets(before: ShelfTrackingSet | null, after: ShelfTrackingSet, asked?: { mode: 'add' | 'remove'; keywords: string[]; asins: string[] }): TrackingChanges {
  const bk = new Set((before?.keywords ?? []).map(normalizeKeyword));
  const ak = new Set(after.keywords.map(normalizeKeyword));
  const ba = new Set((before?.asins ?? []).map((a) => a.toUpperCase()));
  const aa = new Set(after.asins.map((a) => a.toUpperCase()));
  const changes: TrackingChanges = {
    keywords_added: after.keywords.filter((k) => !bk.has(normalizeKeyword(k))),
    keywords_removed: (before?.keywords ?? []).filter((k) => !ak.has(normalizeKeyword(k))),
    asins_added: after.asins.filter((a) => !ba.has(a.toUpperCase())),
    asins_removed: (before?.asins ?? []).filter((a) => !aa.has(a.toUpperCase())),
    keywords_unchanged: [],
    asins_unchanged: [],
  };
  if (asked) {
    const present = (k: string) => bk.has(normalizeKeyword(k));
    changes.keywords_unchanged = asked.keywords.filter((k) => (asked.mode === 'add' ? present(k) : !present(k)));
    changes.asins_unchanged = asked.asins.filter((a) => (asked.mode === 'add' ? ba.has(a) : !ba.has(a)));
  }
  if (before && !asked) {
    if (before.zips.join('\n') !== after.zips.join('\n')) changes.zips_before = before.zips;
    if (before.surfaces.join('\n') !== after.surfaces.join('\n')) changes.views_before = before.surfaces;
    if (before.pages !== after.pages) changes.pages_before = before.pages;
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Input checks (a typo never leaves the machine)
// ---------------------------------------------------------------------------

function parseId(raw: string): string {
  const id = raw.trim();
  if (!TRACKING_ID_RE.test(id)) {
    throw new Error('A set id is 2 to 63 lower-case letters, digits or hyphens, starting with a letter or digit (for example trail-snacks).');
  }
  return id;
}

/** Trimmed, single-spaced, lower-cased (how the service stores a keyword), deduplicated. */
function parseKeywords(raw: string[] | undefined): string[] {
  const out: string[] = [];
  for (const k of raw ?? []) {
    const n = normalizeKeyword(k);
    if (!n) throw new Error('--keyword cannot be empty.');
    if (n.length > KEYWORD_MAX_LENGTH) throw new Error(`A keyword is at most ${KEYWORD_MAX_LENGTH} characters.`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Trimmed, single-spaced, upper-cased (postal codes such as M5V 3L9), deduplicated; checked against the zip list by the service. */
function parseZips(raw: string[] | undefined): string[] {
  const out: string[] = [];
  for (const z of raw ?? []) {
    const n = z.trim().replace(/\s+/g, ' ').toUpperCase();
    if (n.length < 3 || n.length > 10) throw new Error(`--zip "${z}" is not a zip or postal code (3 to 10 characters; \`mixshift shelf zips\` lists them).`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function parseViews(raw: string[] | undefined): ShelfSurface[] {
  const out: ShelfSurface[] = [];
  for (const v of raw ?? []) {
    if (!(SHELF_SURFACES as readonly string[]).includes(v)) throw new Error(`--view must be ${SHELF_SURFACES.join(' or ')}.`);
    if (!out.includes(v as ShelfSurface)) out.push(v as ShelfSurface);
  }
  return out;
}

function parseAsins(raw: string[] | undefined): string[] {
  const out: string[] = [];
  for (const a of raw ?? []) {
    const n = a.trim().toUpperCase();
    if (!ASIN_RE.test(n)) throw new Error(`--asin "${a}" is not an ASIN (10 letters or digits).`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function parseCountry(raw: string | undefined): ShelfCountry | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (!(SHELF_COUNTRIES as readonly string[]).includes(v)) throw new Error(`--country must be one of ${SHELF_COUNTRIES.join(', ')}.`);
  return v as ShelfCountry;
}

function parsePages(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > TRACKING_MAX_PAGES) throw new Error(`--pages must be a whole number from 1 to ${TRACKING_MAX_PAGES}.`);
  return n;
}

// ---------------------------------------------------------------------------
// Rendering (chat markdown; --json carries the full envelope)
// ---------------------------------------------------------------------------

const cell = (s: string | null | undefined): string => (s ? s.replace(/\|/g, '/').replace(/\s*\r?\n\s*/g, ' ') : '-');
const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : '-');
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const viewsText = (v: readonly ShelfSurface[]): string => (v.length ? v.join(' and ') : '-');
const quoted = (list: readonly string[]): string => list.map((k) => `"${k}"`).join(', ');

function enabledText(s: ShelfTrackingSet): string {
  if (!s.enabled) return 'no (paused)';
  return s.cadence === 'off' ? 'yes (cadence off)' : 'yes';
}

function callsBreakdown(s: ShelfTrackingSet): string {
  return `${s.calls_per_day} (${plural(s.keywords.length, 'keyword')} x ${plural(s.zips.length, 'zip')} x ${plural(s.surfaces.length, 'view')} x ${plural(s.pages, 'page')})`;
}

export function lastRunText(s: ShelfTrackingSet): string {
  if (s.last_run_at) {
    const r = s.last_run_summary;
    if (!r) return day(s.last_run_at);
    const parts = [`${r.ok} of ${r.calls} ok`];
    if (r.failed) parts.push(`${r.failed} failed`);
    if (r.stale) parts.push(`${r.stale} from an earlier observation`);
    if (r.exhausted) parts.push(`${r.exhausted} refused, allowance used up`);
    if (r.stopped_reason) parts.push(`stopped: ${r.stopped_reason}`);
    return `${day(s.last_run_at)} (${parts.join(', ')})`;
  }
  if (s.last_run_date) return `${s.last_run_date} (running)`;
  return 'not yet';
}

export function projectionText(projected: number | null, allowance: number | null): string {
  if (projected === null) return 'Projected monthly use: not available here; `mixshift shelf tracking list` shows it.';
  if (allowance === null) return `Projected monthly use: ${projected} shelf requests a month for rank tracking.`;
  const base = `Projected monthly use: ${projected} of ${allowance} shelf requests a month for rank tracking`;
  if (projected > allowance) {
    return `${base}, ${projected - allowance} over the allowance. A change that adds tracking is refused until it fits; removing and pausing always go through.`;
  }
  return `${base}. On-demand shelf answers count against the same allowance.`;
}

function editHint(canEdit: boolean): string {
  return canEdit
    ? 'You can change these sets (owner, admin, manager or builder): `mixshift shelf tracking add <set> --keyword "<keyword>"`, `remove`, `pause`, `resume`, `create`, `delete`.'
    : 'Only an owner, admin, manager or builder can change these sets. Ask one of them, or say "track these keywords" to ask MixShift.';
}

export function renderTrackingList(r: ShelfTrackingList): string {
  const L: string[] = [];
  const running = r.sets.filter(isRunning).length;
  L.push(`**Rank tracking: ${plural(r.sets.length, 'set')}, ${running} running**`);
  if (r.sets.length === 0) {
    L.push('', '_(no rank tracking sets yet)_');
    if (r.can_edit) L.push('', 'Start one: `mixshift shelf tracking create <set> --keyword "<keyword>" --zip <zip>` (both views, page 1, daily).');
  } else {
    L.push('', '| set | note | keywords | zips | views | pages | calls a day | enabled | last run |', '|---|---|---|---|---|---|---|---|---|');
    for (const s of r.sets) {
      L.push(
        `| ${s.id} | ${cell(s.note)} | ${s.keywords.length} | ${cell(s.zips.join(', '))} | ${cell(s.surfaces.join(', '))} | ${s.pages} | ${s.calls_per_day} | ${enabledText(s)} | ${cell(lastRunText(s))} |`,
      );
    }
    L.push(
      '',
      'A paused set uses none of the allowance and its rank history stays readable with `mixshift shelf rank-history "<keyword>" --zip <zip> --set <set>` ' +
        '(the default read covers running sets only). `mixshift shelf tracking show <set>` lists its keywords and ASINs.',
    );
  }
  L.push('', projectionText(r.projected_calls_per_month, r.allowance));
  if (r.warning) L.push('', `Heads-up: ${r.warning.message}`);
  L.push('', editHint(r.can_edit));
  if (r.can_edit) {
    const cap = r.limits.max_calls_per_day_per_set !== null ? `, and at most ${r.limits.max_calls_per_day_per_set} calls a day` : '';
    L.push(`A set holds up to ${r.limits.max_keywords} keywords, ${r.limits.max_zips} zips and ${r.limits.max_pages} pages${cap}.`);
  }
  return L.join('\n');
}

export function renderTrackingSet(s: ShelfTrackingSet): string {
  const L: string[] = [];
  L.push(`**Tracking set \`${s.id}\`** (${s.retailer} ${s.country})`, '');
  if (s.note) L.push(`- note: ${s.note}`);
  L.push(`- enabled: ${enabledText(s)}`);
  L.push(`- zips (${s.zips.length}): ${s.zips.join(', ') || '-'}`);
  L.push(`- views: ${viewsText(s.surfaces)}; pages per search: ${s.pages}`);
  L.push(`- calls a day: ${callsBreakdown(s)}${isRunning(s) ? '' : ', none while paused'}`);
  L.push(`- last run: ${lastRunText(s)}`);
  if (s.updated_at || s.updated_by) L.push(`- last changed: ${day(s.updated_at)}${s.updated_by ? ` by ${s.updated_by}` : ''}`);
  L.push('', `**Keywords (${s.keywords.length})**`, '');
  s.keywords.forEach((k, i) => L.push(`${i + 1}. ${k}`));
  L.push('', `**ASINs (${s.asins.length})**`, '');
  L.push(s.asins.length ? s.asins.join(', ') : '_(none listed: `shelf rank-history` then needs `--asin`)_');
  return L.join('\n');
}

export function renderWritten(action: TrackingAction, r: ShelfTrackingWritten, changes: TrackingChanges | null): string {
  const s = r.set;
  const L: string[] = [];
  const title = { create: 'Created', replace: 'Replaced', add: 'Changed', remove: 'Changed', pause: 'Paused', resume: 'Resumed', delete: 'Deleted' }[action];
  L.push(`**${title} tracking set \`${s.id}\`**`, '');
  if (action === 'create') {
    L.push(`- keywords (${s.keywords.length}): ${quoted(s.keywords)}`);
    L.push(`- zips: ${s.zips.join(', ')}`);
    L.push(`- views: ${viewsText(s.surfaces)}; pages per search: ${s.pages}`);
    L.push(`- ASINs: ${s.asins.length ? s.asins.join(', ') : `none listed (\`shelf rank-history\` then needs \`--asin\`; \`shelf tracking add ${s.id} --asin <ASIN>\` adds them)`}`);
    if (s.note) L.push(`- note: ${s.note}`);
    L.push('- the first snapshot lands with the next daily run; `shelf rank-history` has points for these keywords from then on');
  } else if (action === 'pause') {
    L.push('- paused: no daily searches until you resume it, so it uses none of the allowance');
    L.push(`- its rank history stays readable with \`shelf rank-history --set ${s.id}\` (the default read covers running sets only); days while paused have no new points`);
  } else if (action === 'resume') {
    L.push('- resumed: the next daily run searches it again and adds new points to its rank history');
  } else if (changes) {
    if (changes.keywords_added.length) L.push(`- added ${plural(changes.keywords_added.length, 'keyword')}: ${quoted(changes.keywords_added)}`);
    if (changes.keywords_removed.length) {
      L.push(`- removed ${plural(changes.keywords_removed.length, 'keyword')}: ${quoted(changes.keywords_removed)}`);
      L.push('- `shelf rank-history` stops answering for a removed keyword unless another set lists it');
    }
    if (changes.asins_added.length) L.push(`- added ${plural(changes.asins_added.length, 'ASIN')}: ${changes.asins_added.join(', ')}`);
    if (changes.asins_removed.length) L.push(`- removed ${plural(changes.asins_removed.length, 'ASIN')}: ${changes.asins_removed.join(', ')}`);
    const unchanged = [...changes.keywords_unchanged.map((k) => `"${k}"`), ...changes.asins_unchanged];
    if (unchanged.length) L.push(`- ${action === 'add' ? 'already tracked' : 'not on the set'}, so unchanged: ${unchanged.join(', ')}`);
    if (changes.zips_before) L.push(`- zips: ${s.zips.join(', ')} (was ${changes.zips_before.join(', ') || '-'})`);
    if (changes.views_before) L.push(`- views: ${viewsText(s.surfaces)} (was ${viewsText(changes.views_before)})`);
    if (changes.pages_before !== undefined) L.push(`- pages per search: ${s.pages} (was ${changes.pages_before})`);
    if (L.length === 2) L.push('- nothing changed');
    L.push(`- the set now tracks ${plural(s.keywords.length, 'keyword')} and ${plural(s.asins.length, 'ASIN')}`);
  }
  L.push('', `Calls a day for this set: ${callsBreakdown(s)}${isRunning(s) ? '' : ', none while paused'}.`);
  L.push(projectionText(r.projected_calls_per_month, r.allowance));
  return L.join('\n');
}

export function renderUnchanged(s: ShelfTrackingSet, projected: number | null, allowance: number | null): string {
  const running = isRunning(s);
  return [
    `**Tracking set \`${s.id}\` already exists with these keywords and zips${running ? '' : ', but it is paused'}**`,
    '',
    '- nothing changed (running create again after a lost answer is safe)',
    ...(running ? [] : [`- it takes no daily searches while paused; to restart it: \`mixshift shelf tracking resume ${s.id}\``]),
    '',
    `Calls a day for this set: ${callsBreakdown(s)}${isRunning(s) ? '' : ', none while paused'}.`,
    projectionText(projected, allowance),
  ].join('\n');
}

export function renderDeleted(s: ShelfTrackingSet, projected: number | null, allowance: number | null): string {
  return [
    `**Deleted tracking set \`${s.id}\`**`,
    '',
    `- it tracked ${plural(s.keywords.length, 'keyword')} at ${plural(s.zips.length, 'zip')} on ${viewsText(s.surfaces)}, ${s.calls_per_day} calls a day${isRunning(s) ? '' : ' when running'}; those searches stop`,
    '- `shelf rank-history` no longer answers for its keywords unless another set (running or paused) lists them',
    '',
    projectionText(projected, allowance),
  ].join('\n');
}
