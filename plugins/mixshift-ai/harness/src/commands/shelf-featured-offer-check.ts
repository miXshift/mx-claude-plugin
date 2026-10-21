/**
 * `mixshift shelf featured-offer-check ...` — the on-demand featured-offer
 * check (epic mx-ops#158, F2): Amazon's segmented answer for the account's
 * ASINs, a bounded shelf fan-out for the lost ones, one page.
 *
 *   featured-offer-check start  --legacy-seller-id <id> (--asins a,b | --asins-file f)
 *                               [--zips 10001,60601] [--include-held] [--budget 12] [--out <dir>]
 *   featured-offer-check resume [--out <dir>] [--budget 12]
 *   featured-offer-check status [--out <dir>]
 *
 * Resumable on purpose. In chat a shell call has a ceiling of about 45 s, so a
 * check runs in phases and persists its state in <out>/state.json after every
 * phase: the Competitive Summary (sync for up to 20 ASINs, async beyond), then
 * shelf calls in rounds of --budget (each 1 to 3 s and one shelf answer), then
 * the page. The agent calls `resume` until `next` is null.
 *
 * Reads only. Every shelf call counts one against the organization's monthly
 * shelf allowance; hitting the wall pauses the run (resume after more is
 * granted). Telemetry: phase, counts and outcome; never an ASIN, a seller or
 * a price.
 */

import type { Command } from 'commander';
import { promises as fs } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { listMerchants, isReportFailure, exitCodeForKind, type MerchantView, type ReportFailure } from '../lib/amazon/reports.js';
import { getCompetitiveSummaryBatch, startCompetitiveSummaryBatch, pollPricingRun, getPricingRunResult, type CompetitiveSummaryResponseItem } from '../lib/amazon/pricing.js';
import { isShelfFailure, shelfBuybox, shelfOffers, shelfZips, exitCodeForShelfKind, type ShelfBuybox, type ShelfCountry, type ShelfFailure, type ShelfOffers } from '../lib/shelf/client.js';
import {
  diagnose,
  planShelfCalls,
  renderReportHtml,
  renderReportMarkdown,
  reportCounts,
  summarizeCompetitiveSummary,
  type AsinSummary,
  type BuyboxObservation,
  type CheckReport,
  type OffersObservation,
  type ShelfCall,
} from '../lib/shelf/featured-offer-check.js';
import { outputDir } from '../lib/paths/resolve.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

/**
 * Competitive Summary ASINs per sync call. Source: the service caps a sync
 * call at 100 ASINs and works them in Amazon batches of 20 with ~35 s pacing
 * between batches, so one batch is the most a chat shell call can wait for.
 */
const SYNC_ASIN_CAP = 20;

/**
 * Shelf calls per `resume` invocation. Convention: 12 calls at 1 to 3 s each
 * stays inside the ~45 s chat shell ceiling with room for the page render.
 */
const DEFAULT_BUDGET = 12;

const COUNTRY_TO_SHELF: Record<string, ShelfCountry> = { US: 'us', CA: 'ca', GB: 'uk', UK: 'uk', DE: 'de', FR: 'fr', IT: 'it', ES: 'es', IN: 'in' };

interface ShelfResult {
  call: ShelfCall;
  ok: boolean;
  observedAt: string | null;
  kind: string | null;
  data: ShelfBuybox | ShelfOffers | null;
}

export interface CheckState {
  version: 1;
  createdAt: string;
  updatedAt: string;
  merchant: { legacySellerId: string | null; amazonSellerId: string; name: string | null; marketplace: string; shelfCountry: ShelfCountry };
  asins: string[];
  metros: string[] | null;
  includeHeld: boolean;
  phase: 'summary_pending' | 'shelf' | 'done';
  runId: string | null;
  summaryObservedAt: string | null;
  summaries: AsinSummary[] | null;
  plan: ShelfCall[];
  skippedZips: Record<string, string[]>;
  results: ShelfResult[];
  blocked: { kind: string; friendly: string; requestMore?: string } | null;
  report: { html: string; md: string; json: string } | null;
}

export function registerFeaturedOfferCheck(shelf: Command): void {
  const foc = shelf
    .command('featured-offer-check')
    .description(
      "The on-demand featured-offer check: Amazon's featured offer per shopper segment for your ASINs, the shelf " +
        'for the ones you lose (Buy Box by location, the offer list), one page. Runs in resumable phases.',
    );

  foc
    .command('start')
    .description('Start a check: resolve the merchant, fetch the Competitive Summary, plan and begin the shelf fan-out.')
    .option('--legacy-seller-id <id>', 'MixShift seller id (preferred; from `mixshift amazon merchants`)')
    .option('--amazon-seller-id <id>', 'Amazon merchant token (with --marketplace when the token trades in several)')
    .option('--marketplace <code>', 'marketplace country code, e.g. US')
    .option('--asins <list>', 'comma-separated ASINs (up to 100; more than 20 runs the summary async)')
    .option('--asins-file <file>', 'one ASIN per line (# comments allowed)')
    .option('--zips <list>', 'comma-separated metro zips to observe besides the lost segments\' sample zips (default: 10001,60601,75201,90001)')
    .option('--include-held', 'also observe the shelf for ASINs Amazon says you hold (costs allowance; default off)')
    .option('--budget <n>', `shelf calls to make in this invocation (default ${DEFAULT_BUDGET})`)
    .option('--out <dir>', 'output directory (default ~/.mixshift/output/featured-offer-check/<seller>-<date>)')
    .action(async (opts: StartOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        await start(opts, root, startedAt);
      } catch (err) {
        emitError(err, !!root.json);
      }
    });

  foc
    .command('resume')
    .description('Continue a check: poll the summary if pending, make the next round of shelf calls, render when done.')
    .option('--out <dir>', 'the check\'s output directory (default: the most recent one)')
    .option('--budget <n>', `shelf calls to make in this invocation (default ${DEFAULT_BUDGET})`)
    .action(async (opts: { out?: string; budget?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const dir = await resolveOutDir(opts.out, root.dataDir);
        const state = await readState(dir);
        await advance(state, dir, parseBudget(opts.budget), root, startedAt);
      } catch (err) {
        emitError(err, !!root.json);
      }
    });

  foc
    .command('status')
    .description('Where a check stands, without making any call.')
    .option('--out <dir>', 'the check\'s output directory (default: the most recent one)')
    .action(async (opts: { out?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      try {
        const dir = await resolveOutDir(opts.out, root.dataDir);
        const state = await readState(dir);
        emitState(state, dir, !!root.json);
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

interface StartOptions {
  legacySellerId?: string;
  amazonSellerId?: string;
  marketplace?: string;
  asins?: string;
  asinsFile?: string;
  zips?: string;
  includeHeld?: boolean;
  budget?: string;
  out?: string;
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function start(opts: StartOptions, root: RootOptions, startedAt: number): Promise<void> {
  const json = !!root.json;
  const asins = await readAsins(opts);
  if (asins.length === 0) throw new Error('Give the ASINs to check: --asins B0...,B0... or --asins-file <file>.');
  if (asins.length > 100) throw new Error(`${asins.length} ASINs is more than one check takes (100). Split the list.`);
  if (!opts.legacySellerId && !opts.amazonSellerId) throw new Error('Name the merchant: --legacy-seller-id <id> (from `mixshift amazon merchants`) or --amazon-seller-id <id>.');

  const merchants = await listMerchants({ dataDirOverride: root.dataDir });
  if (isReportFailure(merchants)) return emitReportFailure(merchants, json);
  const merchant = pickMerchant(merchants.merchants, opts);
  if (!merchant) throw new Error('No merchant you can act for matches that id. Run `mixshift amazon merchants --json` and pass its legacySellerId.');
  const country = COUNTRY_TO_SHELF[(merchant.countryCode ?? 'US').toUpperCase()];
  if (!country) throw new Error(`Shelf data does not cover marketplace ${merchant.countryCode ?? 'unknown'} yet (us, ca, uk, de, fr, it, es, in).`);

  const dir = opts.out ? resolvePath(opts.out) : join(outputDir(root.dataDir), 'featured-offer-check', `${merchant.legacySellerId ?? merchant.amazonSellerId}-${new Date().toISOString().slice(0, 10)}`);
  await fs.mkdir(dir, { recursive: true });
  const state: CheckState = {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    merchant: {
      legacySellerId: merchant.legacySellerId !== undefined && merchant.legacySellerId !== null ? String(merchant.legacySellerId) : null,
      amazonSellerId: merchant.amazonSellerId,
      name: merchant.name ?? null,
      marketplace: merchant.countryCode ?? 'US',
      shelfCountry: country,
    },
    asins,
    metros: opts.zips ? opts.zips.split(',').map((z) => z.trim()).filter(Boolean) : null,
    includeHeld: !!opts.includeHeld,
    phase: 'summary_pending',
    runId: null,
    summaryObservedAt: null,
    summaries: null,
    plan: [],
    skippedZips: {},
    results: [],
    blocked: null,
    report: null,
  };

  const selection = state.merchant.legacySellerId ? { legacySellerId: state.merchant.legacySellerId, marketplace: state.merchant.marketplace } : { sellerId: state.merchant.amazonSellerId, marketplace: state.merchant.marketplace };
  if (asins.length <= SYNC_ASIN_CAP) {
    const r = await getCompetitiveSummaryBatch({ ...selection, asins, includedData: ['featuredBuyingOptions'] }, { dataDirOverride: root.dataDir });
    if (isReportFailure(r)) return emitReportFailure(r, json);
    await applySummary(state, r.responses, root);
  } else {
    const r = await startCompetitiveSummaryBatch({ ...selection, asins, includedData: ['featuredBuyingOptions'] }, { dataDirOverride: root.dataDir });
    if (isReportFailure(r)) return emitReportFailure(r, json);
    state.runId = r.runId;
  }
  await writeState(dir, state);
  await advance(state, dir, parseBudget(opts.budget), root, startedAt);
}

function pickMerchant(rows: MerchantView[], opts: StartOptions): MerchantView | null {
  const want = (opts.marketplace ?? '').toUpperCase();
  let candidates = rows;
  if (opts.legacySellerId) candidates = rows.filter((m) => String(m.legacySellerId ?? '') === String(opts.legacySellerId));
  else if (opts.amazonSellerId) candidates = rows.filter((m) => m.amazonSellerId === opts.amazonSellerId);
  if (want) candidates = candidates.filter((m) => (m.countryCode ?? '').toUpperCase() === want || (m.marketplaceId ?? '') === want);
  return candidates.find((m) => (m.countryCode ?? '').toUpperCase() === 'US') ?? candidates[0] ?? null;
}

async function readAsins(opts: StartOptions): Promise<string[]> {
  const raw: string[] = [];
  if (opts.asins) raw.push(...opts.asins.split(','));
  if (opts.asinsFile) {
    const text = await fs.readFile(opts.asinsFile, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.replace(/#.*$/, '').trim();
      if (t) raw.push(t);
    }
  }
  const out: string[] = [];
  for (const a of raw) {
    const t = a.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(t)) throw new Error(`"${a.trim()}" is not a 10-character ASIN.`);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the phases
// ---------------------------------------------------------------------------

async function applySummary(state: CheckState, responses: CompetitiveSummaryResponseItem[], root: RootOptions): Promise<void> {
  state.summaries = summarizeCompetitiveSummary(responses, state.merchant.amazonSellerId);
  state.summaryObservedAt = new Date().toISOString();
  const zips = await shelfZips(state.merchant.shelfCountry, { dataDirOverride: root.dataDir });
  const zipList = new Set<string>(isShelfFailure(zips) ? [] : zips.zips);
  if (isShelfFailure(zips)) {
    // Without the list every zip is unknown; plan nothing and say why.
    state.blocked = { kind: zips.kind, friendly: zips.friendly, ...(zips.requestMore ? { requestMore: zips.requestMore } : {}) };
  }
  const planned = planShelfCalls(state.summaries, { zipList, metros: state.metros ?? undefined, includeHeld: state.includeHeld });
  state.plan = planned.calls;
  state.skippedZips = planned.skippedZips;
  state.phase = 'shelf';
}

async function advance(state: CheckState, dir: string, budget: number, root: RootOptions, startedAt: number): Promise<void> {
  const json = !!root.json;
  if (state.phase === 'summary_pending' && state.runId && !state.summaries) {
    const status = await pollPricingRun(state.runId, { dataDirOverride: root.dataDir });
    if (isReportFailure(status)) return emitReportFailure(status, json);
    if (status.status === 'FATAL' || status.status === 'CANCELLED') {
      throw new Error(`The Competitive Summary run ended ${status.status}${status.errorDetail ? `: ${status.errorDetail}` : ''}.`);
    }
    if (status.status !== 'DONE') {
      await writeState(dir, state);
      await trackCheck('summary_pending', state, startedAt, root.dataDir);
      emitState(state, dir, json, { run: status });
      return;
    }
    const result = await getPricingRunResult<CompetitiveSummaryResponseItem>(state.runId, { dataDirOverride: root.dataDir });
    if (isReportFailure(result)) return emitReportFailure(result, json);
    await applySummary(state, result.responses, root);
    await writeState(dir, state);
  }

  if (state.phase === 'shelf') {
    state.blocked = state.blocked && state.blocked.kind !== 'shelf_allowance_exhausted' ? state.blocked : null;
    let made = 0;
    while (state.results.length < state.plan.length && made < budget) {
      const call = state.plan[state.results.length]!;
      const common = { country: state.merchant.shelfCountry, origin: 'featured_offer_check' as const };
      const r = call.kind === 'buybox' ? await shelfBuybox({ asin: call.asin, zip: call.zip, ...common }, { dataDirOverride: root.dataDir }) : await shelfOffers({ asin: call.asin, zip: call.zip, ...common }, { dataDirOverride: root.dataDir });
      made += 1;
      if (isShelfFailure(r)) {
        if (r.kind === 'shelf_allowance_exhausted' || r.kind === 'shelf_not_enabled' || r.kind === 'shelf_not_enrolled' || r.kind === 'shelf_not_configured' || r.kind === 'not_authenticated' || r.kind === 'session_expired') {
          state.blocked = { kind: r.kind, friendly: r.friendly, ...(r.requestMore ? { requestMore: r.requestMore } : {}) };
          await writeState(dir, state);
          await trackCheck('shelf', state, startedAt, root.dataDir, { blocked: r.kind });
          emitState(state, dir, json);
          process.exitCode = exitCodeForShelfKind(r.kind);
          return;
        }
        state.results.push({ call, ok: false, observedAt: null, kind: r.kind, data: null });
        continue;
      }
      state.results.push({ call, ok: true, observedAt: r.observed_at, kind: r.kind, data: r.data as ShelfBuybox | ShelfOffers });
    }
    state.updatedAt = new Date().toISOString();
    if (state.results.length < state.plan.length) {
      await writeState(dir, state);
      await trackCheck('shelf', state, startedAt, root.dataDir);
      emitState(state, dir, json);
      return;
    }
    const report = buildReport(state);
    const html = join(dir, 'report.html');
    const md = join(dir, 'report.md');
    const js = join(dir, 'report.json');
    await fs.writeFile(html, renderReportHtml(report), 'utf8');
    await fs.writeFile(md, renderReportMarkdown(report), 'utf8');
    await fs.writeFile(js, JSON.stringify(report, null, 2), 'utf8');
    state.report = { html, md, json: js };
    state.phase = 'done';
    await writeState(dir, state);
    await trackCheck('done', state, startedAt, root.dataDir, { reasons: reportCounts(report) });
    emitState(state, dir, json);
    return;
  }

  if (state.phase === 'done') {
    emitState(state, dir, json);
  }
}

function buildReport(state: CheckState): CheckReport {
  const byAsin = new Map<string, { buyboxes: BuyboxObservation[]; offers: OffersObservation | null }>();
  for (const r of state.results) {
    if (!r.ok || !r.data || !r.observedAt) continue;
    const slot = byAsin.get(r.call.asin) ?? { buyboxes: [], offers: null };
    if (r.call.kind === 'buybox') slot.buyboxes.push({ zip: r.call.zip, why: r.call.why, observedAt: r.observedAt, data: r.data as ShelfBuybox });
    else slot.offers = { zip: r.call.zip, observedAt: r.observedAt, data: r.data as ShelfOffers };
    byAsin.set(r.call.asin, slot);
  }
  const planned = new Set(state.plan.map((c) => c.asin));
  return {
    generatedAt: new Date().toISOString(),
    merchant: { legacySellerId: state.merchant.legacySellerId, amazonSellerId: state.merchant.amazonSellerId, name: state.merchant.name, marketplace: state.merchant.marketplace },
    summaryObservedAt: state.summaryObservedAt,
    asins: (state.summaries ?? []).map((summary) => {
      const obs = byAsin.get(summary.asin);
      const diagnosis = planned.has(summary.asin) ? diagnose(summary, obs?.buyboxes ?? [], obs?.offers ?? null, state.merchant.amazonSellerId) : null;
      return { summary, diagnosis };
    }),
    shelfAnswersSpent: state.results.filter((r) => r.ok).length,
    skippedZips: state.skippedZips,
  };
}

// ---------------------------------------------------------------------------
// state on disk
// ---------------------------------------------------------------------------

async function writeState(dir: string, state: CheckState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await fs.writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

async function readState(dir: string): Promise<CheckState> {
  let raw: string;
  try {
    raw = await fs.readFile(join(dir, 'state.json'), 'utf8');
  } catch {
    throw new Error(`No check found at ${dir} (no state.json). Start one with \`mixshift shelf featured-offer-check start\`.`);
  }
  const state = JSON.parse(raw) as CheckState;
  if (state.version !== 1) throw new Error(`Unknown check state version ${String((state as { version?: unknown }).version)} at ${dir}.`);
  return state;
}

async function resolveOutDir(out: string | undefined, dataDir: string | undefined): Promise<string> {
  if (out) return resolvePath(out);
  const base = join(outputDir(dataDir), 'featured-offer-check');
  let entries: string[];
  try {
    entries = (await fs.readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    throw new Error('No featured-offer check has been started yet. Run `mixshift shelf featured-offer-check start`.');
  }
  const stamped = await Promise.all(entries.map(async (name) => ({ name, mtime: (await fs.stat(join(base, name))).mtimeMs })));
  stamped.sort((a, b) => b.mtime - a.mtime);
  if (!stamped[0]) throw new Error('No featured-offer check has been started yet. Run `mixshift shelf featured-offer-check start`.');
  return join(base, stamped[0].name);
}

function parseBudget(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BUDGET;
  const n = Number(raw);
  // 0 = make no shelf call this invocation (the demo's "Amazon's part only" step).
  if (!Number.isInteger(n) || n < 0 || n > 200) throw new Error('--budget must be a whole number from 0 to 200.');
  return n;
}

// ---------------------------------------------------------------------------
// output + telemetry
// ---------------------------------------------------------------------------

function progressOf(state: CheckState) {
  const flagged = (state.summaries ?? []).filter((s) => s.status !== 'held' && s.status !== 'error').length;
  return {
    phase: state.phase,
    asins: state.asins.length,
    summarized: state.summaries ? state.summaries.length : 0,
    flagged,
    shelf_calls_total: state.plan.length,
    shelf_calls_done: state.results.length,
    shelf_answers_spent: state.results.filter((r) => r.ok).length,
    shelf_calls_failed: state.results.filter((r) => !r.ok).length,
  };
}

function nextOf(state: CheckState): 'resume' | null {
  if (state.phase === 'done') return null;
  if (state.blocked && state.blocked.kind !== 'zip_unavailable') return null;
  return 'resume';
}

function emitState(state: CheckState, dir: string, json: boolean, extra: Record<string, unknown> = {}): void {
  const progress = progressOf(state);
  const next = nextOf(state);
  const counts = state.report ? reportCounts(JSON.parse(JSON.stringify(buildReport(state))) as CheckReport) : undefined;
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          status: 'ok',
          out_dir: dir,
          run_id: state.runId,
          merchant: { legacy_seller_id: state.merchant.legacySellerId, amazon_seller_id: state.merchant.amazonSellerId, name: state.merchant.name, marketplace: state.merchant.marketplace },
          progress,
          next,
          blocked: state.blocked,
          report: state.report ? { html: state.report.html, md: state.report.md, json: state.report.json, counts } : null,
          ...extra,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  const lines: string[] = [];
  lines.push(`Featured offer check for ${state.merchant.name ?? state.merchant.amazonSellerId} (${state.merchant.marketplace}): phase ${state.phase}.`);
  lines.push(`  ASINs ${progress.asins}, summarized ${progress.summarized}, flagged ${progress.flagged}; shelf calls ${progress.shelf_calls_done}/${progress.shelf_calls_total} (${progress.shelf_answers_spent} answers spent).`);
  if (state.blocked) lines.push(`  BLOCKED: ${state.blocked.friendly}${state.blocked.requestMore ? ` ${state.blocked.requestMore}` : ''}`);
  if (state.report) lines.push(`  Report: ${state.report.md} (markdown), ${state.report.html} (page).`);
  if (next) lines.push(`  Next: mixshift shelf featured-offer-check resume --out "${dir}"`);
  process.stdout.write(lines.join('\n') + '\n');
}

async function trackCheck(phase: string, state: CheckState, startedAt: number, dataDir: string | undefined, extra: Record<string, unknown> = {}): Promise<void> {
  const p = progressOf(state);
  await track(
    {
      event_name: EventName.ShelfFeaturedOfferCheck,
      outcome: state.blocked ? 'failed' : 'ok',
      duration_ms: Date.now() - startedAt,
      ...(state.blocked ? { error_class: state.blocked.kind } : {}),
      payload: {
        phase,
        asins: p.asins,
        flagged: p.flagged,
        shelf_calls_total: p.shelf_calls_total,
        shelf_calls_done: p.shelf_calls_done,
        shelf_answers_spent: p.shelf_answers_spent,
        include_held: state.includeHeld,
        marketplace: state.merchant.marketplace,
        ...extra,
      },
    },
    dataDir,
  );
}

function emitReportFailure(failure: ReportFailure, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ status: 'error', failure_kind: failure.kind, message: failure.friendly, detail: failure.message, http_status: failure.httpStatus }, null, 2) + '\n');
  } else {
    process.stderr.write(`\n✗ ${failure.friendly}\n`);
    if (failure.message && failure.message !== failure.friendly) process.stderr.write(`  ${failure.message}\n`);
  }
  process.exitCode = exitCodeForKind(failure.kind);
}

function emitError(err: unknown, json: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  if (json) process.stdout.write(JSON.stringify({ status: 'error', message }, null, 2) + '\n');
  else process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}

export type { ShelfFailure };
