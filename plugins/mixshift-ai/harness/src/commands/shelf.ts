/**
 * `mixshift shelf ...` — shelf data: what a shopper at a zip sees on Amazon
 * for an ASIN or a keyword, through the MixShift service (lib/shelf/client.ts).
 *
 * Command shape:
 *   shelf catalog                             every call, with a plain "what is this"
 *   shelf zips [--country us]                 the shopper locations (free)
 *   shelf usage                               this month's allowance (free)
 *   shelf buybox <asin> [--zip Z]             the Buy Box at a zip
 *   shelf offers <asin> [--zip Z]             every offer at a zip
 *   shelf search <query> [--surface desktop|mobile] [--page N] [--zip Z]
 *   shelf product <asin> [--zip Z]            the product page (beta)
 *   shelf seller <seller-id>                  who a seller is
 *   (data calls also take --country, --fresh, --origin, --json)
 *
 * Reads only; nothing here can change anything. Every data answer counts one
 * against the organization's monthly shelf allowance (`shelf usage` shows it).
 *
 * Exit / telemetry contract matches the amazon, ads and walmart commands:
 * handlers set process.exitCode and return; telemetry captures the call kind,
 * country, whether a zip was given, surface and page, fresh, duration and
 * outcome. It never carries the subject (an ASIN, a keyword or a seller id is
 * the user's own research) or the answer.
 */

import type { Command } from 'commander';
import {
  SHELF_COUNTRIES,
  SHELF_SURFACES,
  exitCodeForShelfKind,
  isShelfFailure,
  shelfBuybox,
  shelfOffers,
  shelfProduct,
  shelfSearch,
  shelfSeller,
  shelfUsage,
  shelfZips,
  type ShelfAnswer,
  type ShelfBuybox,
  type ShelfCountry,
  type ShelfFailure,
  type ShelfOffers,
  type ShelfOrigin,
  type ShelfProduct,
  type ShelfSearch,
  type ShelfSeller,
  type ShelfSurface,
  type ShelfUsage,
} from '../lib/shelf/client.js';
import { SHELF_CATALOG, renderShelfCatalogChat } from '../lib/shelf/catalog.js';
import { CONTRACT_WORD } from '../lib/amazon/reports.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

interface DataOptions {
  zip?: string;
  country?: string;
  fresh?: boolean;
  origin?: string;
  surface?: string;
  page?: string;
}

const ORIGINS = new Set(['on_demand', 'featured_offer_check', 'demo', 'subscription']);

export function registerShelfCommands(program: Command): void {
  const shelf = program
    .command('shelf')
    .description(
      'Shelf data: what a shopper at a zip sees on Amazon for an ASIN or a keyword (Buy Box, offers, ' +
        'search rank, product page, seller), through the MixShift service. Reads only; each data answer ' +
        "counts one against your organization's monthly shelf allowance.",
    );

  shelf
    .command('catalog')
    .description('Every shelf call, with a plain explanation of what it answers, what it takes and what it costs.')
    .action(async (_opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      if (root.json) writeJson({ status: 'ok', count: SHELF_CATALOG.length, catalog: SHELF_CATALOG });
      else process.stdout.write(renderShelfCatalogChat());
      await track({ event_name: EventName.ShelfCatalogListed, payload: { count: SHELF_CATALOG.length } }, root.dataDir);
    });

  shelf
    .command('zips')
    .description('The shopper locations (zip/postal codes) shelf data can be observed from. Free.')
    .option('--country <code>', 'marketplace country: us (default), ca, uk, de, fr, it, es, in')
    .action(async (opts: { country?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const country = parseCountry(opts.country);
      if (!country) return emitError(new Error(`--country must be one of ${SHELF_COUNTRIES.join(', ')}.`), !!root.json);
      const result = await shelfZips(country, { dataDirOverride: root.dataDir });
      if (isShelfFailure(result)) {
        await trackShelf(EventName.ShelfZipsListed, 'failed', startedAt, root.dataDir, failurePayload(result, { country }));
        return emitFailure(result, !!root.json);
      }
      await trackShelf(EventName.ShelfZipsListed, 'ok', startedAt, root.dataDir, { country, count: result.count });
      if (root.json) writeJson({ status: 'ok', ...result });
      else {
        process.stderr.write(`\n✓ ${result.count} shopper location(s) for ${result.country}\n\n`);
        process.stdout.write(result.zips.join(' ') + '\n');
      }
    });

  shelf
    .command('usage')
    .description("Your organization's shelf allowance for the current month. Free.")
    .action(async (_opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const result = await shelfUsage({ dataDirOverride: root.dataDir });
      if (isShelfFailure(result)) {
        await trackShelf(EventName.ShelfUsageRead, 'failed', startedAt, root.dataDir, failurePayload(result, {}));
        return emitFailure(result, !!root.json);
      }
      await trackShelf(EventName.ShelfUsageRead, 'ok', startedAt, root.dataDir, {
        allowance: result.allowance,
        used: result.used,
        source: result.source,
      });
      if (root.json) writeJson({ status: 'ok', ...result });
      else process.stdout.write(renderUsage(result) + '\n');
    });

  registerData(shelf, 'buybox', '<asin>', 'The Buy Box (featured offer) a shopper at a zip sees for an ASIN: price, seller, delivery promise.', true);
  registerData(shelf, 'offers', '<asin>', 'Every offer a shopper at a zip sees on an ASIN (the other-sellers list), with promise days per offer.', true);
  registerData(shelf, 'search', '<query>', 'The search results page for a keyword as a shopper at a zip sees it: organic and sponsored rank, badges, prices.', true);
  registerData(shelf, 'product', '<asin>', 'The product page for an ASIN as a shopper at a zip sees it: title, bullets, details, images, best-seller ranks (beta).', true);
  registerData(shelf, 'seller', '<seller-id>', 'Who a third-party seller is: storefront name, rating, business details. No zip.', false);
}

type DataKind = 'buybox' | 'offers' | 'search' | 'product' | 'seller';

function registerData(shelf: Command, kind: DataKind, arg: string, description: string, takesZip: boolean): void {
  const c = shelf.command(`${kind} ${arg}`).description(description + ' Counts one against the shelf allowance.');
  if (takesZip) c.option('--zip <zip>', 'shopper location from `shelf zips`; omit for the default location');
  c.option('--country <code>', 'marketplace country: us (default), ca, uk, de, fr, it, es, in');
  c.option('--fresh', 'observe the shelf right now instead of serving a recent observation (same cost)');
  c.option('--origin <origin>', 'which workflow is asking (attribution only): on_demand, featured_offer_check, demo, subscription');
  if (kind === 'search') {
    c.option('--surface <surface>', 'desktop (default, 60 positions a page) or mobile (15 a page)');
    c.option('--page <n>', 'results page, 1 (default) to 5');
  }
  c.action(async (subject: string, opts: DataOptions, cmd: Command) => {
    const root = cmd.optsWithGlobals<RootOptions>();
    const startedAt = Date.now();
    try {
      const country = parseCountry(opts.country);
      if (!country) return emitError(new Error(`--country must be one of ${SHELF_COUNTRIES.join(', ')}.`), !!root.json);
      if (opts.origin !== undefined && !ORIGINS.has(opts.origin)) {
        return emitError(new Error(`--origin must be one of ${[...ORIGINS].join(', ')}.`), !!root.json);
      }
      const origin = opts.origin as ShelfOrigin | undefined;
      const common = { country, fresh: !!opts.fresh, ...(origin ? { origin } : {}) };
      const zip = takesZip && opts.zip ? opts.zip.trim() : undefined;
      let surface: ShelfSurface | undefined;
      let page: number | undefined;
      if (kind === 'search') {
        if (opts.surface !== undefined) {
          if (!(SHELF_SURFACES as readonly string[]).includes(opts.surface)) {
            return emitError(new Error(`--surface must be ${SHELF_SURFACES.join(' or ')}.`), !!root.json);
          }
          surface = opts.surface as ShelfSurface;
        }
        if (opts.page !== undefined) {
          page = Number(opts.page);
          if (!Number.isInteger(page) || page < 1 || page > 5) return emitError(new Error('--page must be a whole number from 1 to 5.'), !!root.json);
        }
      }
      const telemetry = {
        kind: kind === 'search' ? `search_${surface ?? 'desktop'}` : kind,
        country,
        has_zip: !!zip,
        fresh: !!opts.fresh,
        ...(origin ? { origin } : {}),
        ...(kind === 'search' ? { page: page ?? 1 } : {}),
      };
      const clientOpts = { dataDirOverride: root.dataDir };
      const result =
        kind === 'buybox'
          ? await shelfBuybox({ asin: subject, zip, ...common }, clientOpts)
          : kind === 'offers'
            ? await shelfOffers({ asin: subject, zip, ...common }, clientOpts)
            : kind === 'search'
              ? await shelfSearch({ query: subject, surface, page, zip, ...common }, clientOpts)
              : kind === 'product'
                ? await shelfProduct({ asin: subject, zip, ...common }, clientOpts)
                : await shelfSeller({ sellerId: subject, ...common }, clientOpts);
      if (isShelfFailure(result)) {
        await trackShelf(EventName.ShelfCalled, 'failed', startedAt, root.dataDir, failurePayload(result, telemetry));
        return emitFailure(result, !!root.json);
      }
      await trackShelf(EventName.ShelfCalled, 'ok', startedAt, root.dataDir, {
        ...telemetry,
        observed_age_s: ageSeconds(result.observed_at, startedAt),
        ...(result.beta ? { beta: true } : {}),
        ...(kind === 'search' ? { positions: (result as ShelfAnswer<ShelfSearch>).data.products.length } : {}),
        ...(kind === 'offers' ? { offer_count: (result as ShelfAnswer<ShelfOffers>).data.offer_count } : {}),
      });
      if (root.json) {
        writeJson({ status: 'ok', ...result });
        return;
      }
      process.stderr.write(`\n✓ ${result.kind} ${result.subject}${result.zip ? ` at ${result.zip}` : ''} (${result.country}), observed ${result.observed_at}${result.beta ? ' [beta]' : ''}\n\n`);
      process.stdout.write(renderAnswer(kind, result) + '\n');
    } catch (err) {
      emitError(err, !!root.json);
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCountry(raw: string | undefined): ShelfCountry | null {
  if (raw === undefined || raw === '') return 'us';
  const v = raw.trim().toLowerCase();
  return (SHELF_COUNTRIES as readonly string[]).includes(v) ? (v as ShelfCountry) : null;
}

/** Seconds between the observation and the call, rounded; null when unparseable. Age is a number, never a date. */
function ageSeconds(observedAt: string, now: number): number | null {
  const t = Date.parse(observedAt);
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 1000)) : null;
}

function failurePayload(failure: ShelfFailure, base: Record<string, unknown>): Record<string, unknown> {
  return {
    ...base,
    kind_failed: failure.kind,
    ...(failure.httpStatus ? { http_status: failure.httpStatus } : {}),
    ...(failure.unrecognizedKind ? { unrecognized_kind: failure.unrecognizedKind } : {}),
    // Gateway contract (mx-ops#144): enums and a flag; never the friendly text.
    ...(failure.source !== undefined && CONTRACT_WORD.test(failure.source) ? { source: failure.source } : {}),
    ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}),
  };
}

async function trackShelf(eventName: string, outcome: 'ok' | 'failed', startedAt: number, dataDir: string | undefined, payload: Record<string, unknown>): Promise<void> {
  await track(
    {
      event_name: eventName,
      outcome,
      duration_ms: Date.now() - startedAt,
      ...(outcome === 'failed' && typeof payload.kind_failed === 'string' ? { error_class: payload.kind_failed } : {}),
      payload,
    },
    dataDir,
  );
}

function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function emitFailure(failure: ShelfFailure, json: boolean): void {
  if (json) {
    writeJson({
      status: 'error',
      failure_kind: failure.kind,
      message: failure.friendly,
      detail: failure.message,
      http_status: failure.httpStatus,
      period: failure.period,
      allowance: failure.allowance,
      used: failure.used,
      resets_at: failure.resetsAt,
      request_more: failure.requestMore,
      available_count: failure.availableCount,
      retry_after_ms: failure.retryAfterMs,
      required_scope: failure.requiredScope,
      unrecognized_kind: failure.unrecognizedKind,
      source: failure.source,
      retryable: failure.retryable,
      invalid_params: failure.invalidParams,
    });
  } else {
    process.stderr.write(`\n✗ ${failure.friendly}\n`);
    if (failure.message && failure.message !== failure.friendly) process.stderr.write(`  ${failure.message}\n`);
    if (failure.kind === 'shelf_allowance_exhausted') {
      if (failure.resetsAt) process.stderr.write(`  used ${failure.used ?? '?'} of ${failure.allowance ?? '?'} for ${failure.period ?? 'this month'}; resets ${failure.resetsAt}\n`);
      process.stderr.write('  To ask MixShift for more now: say "request more shelf requests" (the skill sends feedback with your organization and period).\n');
    }
    if (failure.retryable === false && failure.source === 'request') {
      process.stderr.write('  Not retryable as sent: change the request before calling again.\n');
    }
  }
  process.exitCode = exitCodeForShelfKind(failure.kind);
}

function emitError(err: unknown, json: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  if (json) writeJson({ status: 'error', message });
  else process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Rendering (chat markdown; --json carries the full envelope)
// ---------------------------------------------------------------------------

const money = (n: number | null | undefined): string => (typeof n === 'number' ? n.toFixed(2) : '-');
const days = (n: number | null | undefined): string => (typeof n === 'number' ? `${n} d` : '-');
const yes = (b: boolean | null | undefined): string => (b === true ? 'yes' : b === false ? 'no' : '-');
const cell = (s: string | null | undefined): string => (s ? s.replace(/\|/g, '/') : '-');

export function renderUsage(u: ShelfUsage): string {
  return [
    `**Shelf allowance for ${u.period}**`,
    '',
    `- used: ${u.used} of ${u.allowance} (${u.remaining} left)`,
    `- resets: ${u.resets_at}`,
    `- source: ${u.source === 'discovery_first_month' ? 'first-month discovery allowance' : u.source === 'discovery' ? 'monthly discovery allowance' : u.source === 'entitlement' ? 'your shelf package' : u.source}`,
    '',
    'Every data answer counts one; `shelf zips` and `shelf usage` are free. Unused requests do not roll over.',
  ].join('\n');
}

export function renderAnswer(kind: DataKind, a: ShelfAnswer<unknown>): string {
  switch (kind) {
    case 'buybox':
      return renderBuybox(a.data as unknown as ShelfBuybox);
    case 'offers':
      return renderOffers(a.data as unknown as ShelfOffers);
    case 'search':
      return renderSearch(a.data as unknown as ShelfSearch);
    case 'product':
      return renderProduct(a.data as unknown as ShelfProduct);
    case 'seller':
      return renderSeller(a.data as unknown as ShelfSeller);
    default:
      return JSON.stringify(a.data, null, 2);
  }
}

export function renderBuybox(b: ShelfBuybox): string {
  if (!b.in_stock && b.price === null) return `_(no Buy Box: the listing shows no featured offer at this location${b.delivery_to ? `, ${b.delivery_to}` : ''})_`;
  return [
    '| field | value |',
    '|---|---|',
    `| price | ${cell(b.currency)}${money(b.price)} |`,
    `| sold by | ${cell(b.sold_by)}${b.seller_id ? ` (${b.seller_id})` : ''} |`,
    `| ships from | ${cell(b.ships_from)} |`,
    `| Prime | ${yes(b.prime)} |`,
    `| in stock | ${yes(b.in_stock)}${typeof b.stock === 'number' ? ` (${b.stock})` : ''} |`,
    `| free delivery | ${cell(b.free_delivery)} (${days(b.promise_days_free)}) |`,
    `| fastest delivery | ${cell(b.fastest_delivery)} (${days(b.promise_days_fastest)}) |`,
    `| order within | ${cell(b.order_within)} |`,
    `| delivering to | ${cell(b.delivery_to)} |`,
  ].join('\n');
}

export function renderOffers(o: ShelfOffers): string {
  const L: string[] = [];
  if (o.product) {
    L.push(`**Featured offer:** ${cell(o.product.sold_by)} at ${cell(o.product.price)}${o.product.fba ? ', FBA' : ''}; fastest ${cell(o.product.fastest_delivery)} (${days(o.product.promise_days_fastest)})`);
    if (o.product.title) L.push(`_${o.product.title}_${typeof o.product.rating === 'number' ? ` (${o.product.rating} stars, ${o.product.reviews ?? '-'} reviews)` : ''}`);
    L.push('');
  }
  if (o.offers.length === 0) {
    L.push('_(no other offers)_');
    return L.join('\n');
  }
  L.push(`**${o.offer_count} offer(s)**`, '', '| # | price | sold by | seller id | FBA | condition | fastest delivery |', '|---|---|---|---|---|---|---|');
  o.offers.forEach((x, i) => {
    L.push(`| ${i + 1} | ${cell(x.price)} | ${cell(x.sold_by)} | ${cell(x.seller_id)} | ${yes(x.fba)} | ${cell(x.conditions)} | ${cell(x.fastest_delivery)} (${days(x.promise_days_fastest)}) |`);
  });
  return L.join('\n');
}

function badgeOf(p: { badge_text: string | null; is_amazon_choice: boolean | null; is_best_seller: boolean | null; is_overall_pick: boolean | null }): string {
  if (p.badge_text) return p.badge_text;
  if (p.is_amazon_choice) return "Amazon's Choice";
  if (p.is_best_seller) return 'Best Seller';
  if (p.is_overall_pick) return 'Overall Pick';
  return '-';
}

export function renderSearch(s: ShelfSearch): string {
  const L: string[] = [];
  L.push(`**${s.surface} page ${s.page}: ${s.products.length} positions, ${s.sponsored_count} sponsored${typeof s.total_results === 'number' ? `, ${s.total_results} results in all` : ''}${s.delivery_to ? `, delivering to ${s.delivery_to}` : ''}**`);
  if (s.banners.length > 0) {
    L.push('');
    L.push('Sponsored-brand banners: ' + s.banners.map((b) => `${cell(b.brand)} ("${cell(b.headline)}")`).join('; '));
  }
  L.push('', '| rank | asin | spons. | price | rating | reviews | bought/mo | badge | coupon | stock | title |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const p of s.products) {
    L.push(
      `| ${p.absolute_rank} | ${p.asin} | ${p.is_sponsored ? 'yes' : ''} | ${cell(p.price)} | ${p.rating ?? '-'} | ${p.reviews ?? '-'} | ${p.monthly_sales ?? '-'} | ${badgeOf(p)} | ${cell(p.coupon)} | ${cell(p.stock_level)} | ${cell(p.title ? p.title.slice(0, 60) : null)} |`,
    );
  }
  if (s.related_keywords.length > 0) L.push('', 'Related keywords: ' + s.related_keywords.join(', '));
  if (s.has_more) L.push('', `More positions: \`--page ${s.page + 1}\` (one answer per page).`);
  return L.join('\n');
}

export function renderProduct(p: ShelfProduct): string {
  const L: string[] = [];
  L.push(`**${cell(p.title)}**${p.landing_asin ? ` (${p.landing_asin})` : ''}`);
  L.push('');
  L.push(`- rating: ${p.rating ?? '-'} (${p.reviews ?? '-'} reviews); bought in past month: ${p.monthly_sales ?? '-'}${p.badge_text ? `; badge: ${p.badge_text}` : ''}`);
  if (p.bsr.length > 0) L.push(`- best-seller rank: ${p.bsr.map((b) => `#${b.rank} in ${b.category}`).join('; ')}`);
  if (p.buybox) L.push(`- Buy Box: ${cell(p.buybox.sold_by)} at ${cell(p.buybox.currency)}${money(p.buybox.price)}, in stock ${yes(p.buybox.in_stock)}, fastest ${cell(p.buybox.fastest_delivery)} (${days(p.buybox.promise_days_fastest)})`);
  L.push(`- images: ${p.media.images.length}${p.media.primary_image ? ` (primary ${p.media.primary_image})` : ''}; videos: ${p.media.videos.length}`);
  if (p.bullet_points.length > 0) {
    L.push('', '**Bullet points**');
    for (const b of p.bullet_points) L.push(`- ${b}`);
  }
  const details = Object.entries(p.details);
  if (details.length > 0) {
    L.push('', '**Details**', '', '| field | value |', '|---|---|');
    for (const [k, v] of details) L.push(`| ${cell(k)} | ${cell(v)} |`);
  }
  if (p.customer_say) L.push('', `**Customers say:** ${p.customer_say}`);
  L.push('', '_Beta: the product page is parsed from a changing layout; a field can be missing on some listings._');
  return L.join('\n');
}

export function renderSeller(s: ShelfSeller): string {
  const L: string[] = [];
  L.push(`**${cell(s.name)}**${typeof s.rating === 'number' ? ` (${s.rating} stars, ${s.rating_count ?? '-'} ratings)` : ''}`);
  if (s.description) L.push('', s.description);
  if (s.details.length > 0) {
    L.push('', '**Business details**');
    for (const d of s.details) L.push(`- ${d}`);
  }
  return L.join('\n');
}
