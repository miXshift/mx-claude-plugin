/**
 * The shelf-data catalog: every shelf call the plugin can make, with a plain
 * "what is this" for people meeting shelf data for the first time. Rendered by
 * `mixshift shelf catalog` and read by the mx-amazon-shelf skill (and its demo)
 * so discovery lives in one place.
 *
 * Wording rules: nothing here names the data provider (it is "shelf data" from
 * a licensed third-party provider, on MixShift's own key); every entry says
 * whether it counts against the organization's monthly shelf allowance.
 */

export interface ShelfCatalogEntry {
  /** `mixshift shelf <id>` */
  id: 'buybox' | 'offers' | 'search' | 'product' | 'seller' | 'zips' | 'usage';
  /** The service tool this is the CLI form of. */
  tool: string;
  /** One line: what the call answers. */
  what: string;
  /** Plain explanation for someone new to shelf data. */
  explain: string;
  /** What to pass. */
  inputs: string;
  /** The fields worth reading first. */
  returns: string;
  /** Whether an answer counts against the monthly allowance. */
  cost: 'counts 1' | 'free';
  /** A question a user asks that this call answers. */
  say: string;
  /** A runnable example. */
  example: string;
}

export const SHELF_CATALOG: readonly ShelfCatalogEntry[] = [
  {
    id: 'buybox',
    tool: 'shelf_get_buybox',
    what: 'The Buy Box (featured offer) a shopper at a zip sees for an ASIN right now.',
    explain:
      'The Buy Box is the offer Amazon puts behind the Add to Cart button. It can differ by where the shopper is: a seller ' +
      'with a faster delivery promise to that zip can win there and lose elsewhere. This shows who won it at one zip, at ' +
      'what price, shipped from where, Prime or not, how much stock, and the delivery promise as text and as days.',
    inputs: 'an ASIN; optional --zip (a shopper location from `shelf zips`), --country (us default), --fresh',
    returns: 'price, sold_by, seller_id, ships_from, prime, in_stock, stock, free_delivery, fastest_delivery, promise_days_free, promise_days_fastest, observed_at',
    cost: 'counts 1',
    say: 'who has the Buy Box for B0055QS6AK in Dallas?',
    example: 'mixshift shelf buybox B0055QS6AK --zip 75201 --json',
  },
  {
    id: 'offers',
    tool: 'shelf_get_offers',
    what: 'Every offer a shopper at a zip sees on an ASIN: the "other sellers" list.',
    explain:
      'One listing can carry many sellers. This is the whole list as the shopper sees it: each seller\'s price, whether Amazon ' +
      'ships it (FBA) or the seller does, the condition, and each seller\'s delivery promise. It is how you see a price war, ' +
      'a reseller undercutting MAP, or an unauthorized seller on your listing, and the seller ids to look up with `shelf seller`.',
    inputs: 'an ASIN; optional --zip, --country, --fresh',
    returns: 'product (the featured offer with title, rating, reviews), offers[] (price_num, sold_by, seller_id, fba, conditions, promise days), offer_count',
    cost: 'counts 1',
    say: 'list every seller on B0055QS6AK and their prices',
    example: 'mixshift shelf offers B0055QS6AK --zip 10001 --json',
  },
  {
    id: 'search',
    tool: 'shelf_search',
    what: 'The Amazon search results page for a keyword as a shopper at a zip sees it: organic and sponsored rank.',
    explain:
      'Type a keyword into Amazon and this is the page that comes back, position by position: which ASINs rank where, ' +
      'which are sponsored, prices, ratings, review counts, "bought in past month", badges (Amazon\'s Choice, Best Seller, ' +
      'Overall Pick), coupons, stock warnings and delivery promises, plus the sponsored-brand banners at the top. Desktop ' +
      'shows 60 positions a page, mobile 15 (and no review counts). Each page is one answer; absolute_rank counts across pages.',
    inputs: 'a keyword; optional --surface desktop|mobile, --page 1..5, --zip, --country, --fresh',
    returns: 'products[] (asin, rank, absolute_rank, is_sponsored, price_num, rating, reviews, monthly_sales, badges, coupon, stock_level), banners[], sponsored_count, total_results, related_keywords',
    cost: 'counts 1',
    say: 'where do we rank for "backpacking meals" in New York?',
    example: 'mixshift shelf search "backpacking meals" --zip 10001 --json',
  },
  {
    id: 'product',
    tool: 'shelf_get_product',
    what: 'The product page for an ASIN as a shopper at a zip sees it (beta).',
    explain:
      'The listing itself, parsed: title, bullet points, the product details table, images, best-seller ranks by category, ' +
      'rating and review count, "bought in past month", the badge, the Buy Box block, and Amazon\'s "customers say" summary. ' +
      'Use it to check what the page shows today, or to compare a competitor\'s page with yours. Beta: the page layout ' +
      'changes, so a field can be missing on some listings; the answer says beta: true.',
    inputs: 'an ASIN; optional --zip, --country, --fresh',
    returns: 'title, bullet_points[], details{}, media, bsr[], rating, reviews, monthly_sales, badge_text, buybox, customer_say',
    cost: 'counts 1',
    say: 'what does the product page for B07BDBDT21 show right now?',
    example: 'mixshift shelf product B07BDBDT21 --json',
  },
  {
    id: 'seller',
    tool: 'shelf_get_seller',
    what: 'Who a third-party seller is: the storefront details behind a seller id.',
    explain:
      'An offer carries a seller id. This looks the seller up: storefront name, rating and count, the storefront text, and the ' +
      'business name and address Amazon shows for the seller where it shows them. It is the "who is this reseller" step after ' +
      '`shelf offers`. Amazon\'s own retail offers have no seller id and no storefront to look up.',
    inputs: 'a seller id (from a buybox, offers or search answer); optional --country, --fresh',
    returns: 'name, rating, rating_count, description, details[] (business name and address lines), logo_url',
    cost: 'counts 1',
    say: 'who is seller A1EXAMPLESELLER?',
    example: 'mixshift shelf seller A1EXAMPLESELLER --json',
  },
  {
    id: 'zips',
    tool: 'shelf_list_zips',
    what: 'The shopper locations (zip or postal codes) shelf data can be observed from, per country.',
    explain:
      'Shelf answers are taken as a shopper at a location. The locations are a fixed list per country (about 300 US zips ' +
      'covering the metros, 20 to 30 elsewhere); a zip off the list is refused before anything is spent. Pick the zips ' +
      'that matter to you, for example the eight big metros, or the zip Amazon reports as a segment\'s sample location.',
    inputs: 'optional --country (us, ca, uk, de, fr, it, es, in)',
    returns: 'count, zips[]',
    cost: 'free',
    say: 'which zips can shelf data observe from?',
    example: 'mixshift shelf zips --country us --json',
  },
  {
    id: 'usage',
    tool: 'shelf_get_usage',
    what: "Your organization's shelf allowance for this month: allowance, used, remaining, reset date.",
    explain:
      'Every shelf answer counts one, whether MixShift observed the shelf for it or already had a recent observation; the ' +
      'zip list and this read are free. Unused requests do not roll over. The first month carries a larger discovery ' +
      'allowance; after that a monthly one, and more can be tracked on request.',
    inputs: 'none',
    returns: 'period, allowance, used, remaining, resets_at',
    cost: 'free',
    say: 'how many shelf requests do we have left this month?',
    example: 'mixshift shelf usage --json',
  },
];

/** Chat markdown for `mixshift shelf catalog`. */
export function renderShelfCatalogChat(entries: readonly ShelfCatalogEntry[] = SHELF_CATALOG): string {
  const L: string[] = [];
  L.push('**Shelf data: what a shopper sees on Amazon, by location**');
  L.push('');
  L.push(
    'Public shelf observations from a licensed third-party provider on MixShift\'s own key: nothing here uses your Amazon ' +
      'credentials or touches your account data. Every data answer carries `observed_at` (when the shelf looked like this) ' +
      'and counts one against your organization\'s monthly shelf allowance; `--fresh` asks for the shelf as of now at the same cost.',
  );
  L.push('');
  for (const e of entries) {
    L.push(`### ${e.id} (${e.cost})`);
    L.push(e.what);
    L.push('');
    L.push(e.explain);
    L.push('');
    L.push(`- inputs: ${e.inputs}`);
    L.push(`- returns: ${e.returns}`);
    L.push(`- say: "${e.say}"`);
    L.push(`- example: \`${e.example}\``);
    L.push('');
  }
  L.push('Say "demo Amazon shelf" to see these on your own ASIN and keyword.');
  L.push('');
  return L.join('\n');
}
