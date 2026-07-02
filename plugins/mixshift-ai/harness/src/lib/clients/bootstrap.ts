/**
 * Bootstrap a brand-context directory from a BrandSuggestion.
 *
 * What this does:
 *   - Takes a discovered brand (one BrandSuggestion = one Name +
 *     N account rows)
 *   - Builds a schema-valid context.yaml skeleton from the warehouse
 *     data we already have (SellerIDs, account types, marketplaces,
 *     ACOS target if populated)
 *   - Writes context.yaml, narrative.md, README.md, and an empty
 *     corpora/ directory under ~/.mixshift/clients/<slug>/
 *
 * What this does NOT do:
 *   - AM intake (positioning, goals, structural events, brand
 *     intelligence) — that's the `mx-brand-context` skill's job,
 *     and it runs in Claude after this bootstrap completes
 *   - Any warehouse mutation — read-only against `seller`
 *   - HTML rendering — also the skill's job
 *
 * The output of this function is enough to satisfy contextSchema. The
 * skill picks up from there.
 */

import { mkdir, rename, writeFile, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { contextSchema, type BrandContext } from '../context/schema.js';
import { formatZodError } from '../profile/format-error.js';
import { brandDir, contextPath, narrativePath } from '../paths/resolve.js';
import type { BrandSuggestion } from '../discovery/brand-grouping.js';
import type { SellerRow } from '../discovery/seller-query.js';

export interface BootstrapOptions {
  /** Override data dir (mostly tests). */
  dataDirOverride?: string;
  /** Overwrite an existing brand directory. Default false (errors). */
  force?: boolean;
  /** ISO date for last_updated. Default: today. */
  asOfDate?: string;
}

export interface BootstrapResult {
  brand_dir: string;
  context_path: string;
  narrative_path: string;
  context: BrandContext;
  written_files: string[];
}

export async function bootstrapBrand(
  suggestion: BrandSuggestion,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const dir = brandDir(suggestion.slug, options.dataDirOverride);
  const ctxPath = contextPath(suggestion.slug, options.dataDirOverride);
  const narrPath = narrativePath(suggestion.slug, options.dataDirOverride);

  // 1. Keep only account rows the context schema can represent. SC/VC
  //    only: DSP seats have no seller catalog and aren't cold-startable
  //    yet (the context schema's account_type enum is SC|VC; DSP
  //    analytical support is future work), and 'unknown' can't be
  //    classified at all.
  const validAccounts = suggestion.accounts.filter(
    (a) => a.account_type === 'SC' || a.account_type === 'VC',
  );
  if (validAccounts.length === 0) {
    throw new Error(
      `Cannot bootstrap "${suggestion.slug}": none of the ${suggestion.accounts.length} accounts ` +
        `are SC or VC (DSP-only and unclassified brands can't be set up yet). ` +
        `If the MerchantType looks wrong, fix the warehouse seller table and ` +
        `re-run \`mixshift brand discover\`.`,
    );
  }

  // 2. Check for existing directory unless --force
  if (!options.force) {
    try {
      await access(dir);
      throw new Error(
        `Brand directory already exists at ${dir}.\n` +
          `Either pick a different slug, delete the existing directory, or pass --force to overwrite.`,
      );
    } catch (err) {
      if (!isFileNotFoundError(err)) throw err;
      // ENOENT: good, directory doesn't exist yet
    }
  }

  // 3. Build and validate the context.yaml shape
  const context = buildContext(suggestion, validAccounts, options.asOfDate);
  const parsed = contextSchema.safeParse(context);
  if (!parsed.success) {
    // This would mean a bug in our bootstrap mapping — surface it loudly
    throw new Error(
      `Bootstrap produced an invalid context.yaml for "${suggestion.slug}". ` +
        `This is a bug in the harness; please report it.\n` +
        formatZodError(parsed.error),
    );
  }

  // 4. Write files (atomic per-file via tmp + rename)
  await mkdir(dir, { recursive: true });
  await mkdir(`${dir}/corpora`, { recursive: true });
  const yaml = stringifyYaml(parsed.data, { lineWidth: 0, indent: 2 });
  await writeAtomic(ctxPath, yaml);
  await writeAtomic(narrPath, narrativeTemplate(suggestion));
  const readmePath = `${dir}/README.md`;
  await writeAtomic(readmePath, readmeTemplate(suggestion));

  return {
    brand_dir: dir,
    context_path: ctxPath,
    narrative_path: narrPath,
    context: parsed.data,
    written_files: [ctxPath, narrPath, readmePath, `${dir}/corpora/`],
  };
}

// -----------------------------------------------------------------------
// Context shape construction
// -----------------------------------------------------------------------

function buildContext(
  suggestion: BrandSuggestion,
  accounts: SellerRow[],
  asOfDate?: string,
): unknown {
  const sorted = sortAccountsForPrimary(accounts);
  const primaryAccount = sorted[0]!;

  // primaryAccount.account_type is 'SC' or 'VC' (we already filtered 'unknown')
  const primaryType = primaryAccount.account_type as 'SC' | 'VC';

  // ACOS target: use any non-null acos_target from accounts, else default 20
  const acosFromWarehouse = accounts
    .map((a) => a.acos_target)
    .find((v): v is number => typeof v === 'number' && v > 0);
  const acosTargetPct = acosFromWarehouse ?? 20.0;

  return {
    schema_version: 1,
    brand_slug: suggestion.slug,
    brand_name: suggestion.display_name,
    last_updated: asOfDate ?? todayISO(),
    accounts: sorted.map((a, i) => buildAccountEntry(a, i === 0)),
    sources: sourcesFor(primaryType),
    management: {
      primary_metric: 'ACOS',
      acos_target_pct: acosTargetPct,
      attribution_window_days: 14,
    },
  };
}

function buildAccountEntry(row: SellerRow, isPrimary: boolean): unknown {
  // Note: account_type is narrowed to 'SC' | 'VC' by the filter in bootstrapBrand.
  const account_type = row.account_type as 'SC' | 'VC';
  return {
    seller_id: row.seller_id,
    seller_name: row.seller_name,
    account_type,
    status: row.is_active ? 'active' : 'inactive',
    role: isPrimary ? 'primary' : 'secondary',
    ...(row.amazon_seller_id ? { amazon_seller_id: row.amazon_seller_id } : {}),
    ...(row.marketplace ? { marketplace: row.marketplace } : {}),
    merchant_type: account_type === 'SC' ? 'seller' : 'vendor',
    ...(row.merchant_alias ? { merchant_alias: row.merchant_alias } : {}),
    ...(row.region ? { region: row.region } : {}),
    ads_active: row.ads_active,
    retail_active: row.retail_active,
  };
}

function sourcesFor(primaryType: 'SC' | 'VC'): Record<string, string> {
  if (primaryType === 'SC') {
    return {
      ad_metrics: 'campaignmetric',
      ops_revenue: 'business_reports_dpst_date',
      ops_revenue_field: 'SalesAmount',
      ops_units_field: 'UnitsOrdered',
      ops_date_field: 'DateTime',
    };
  }
  return {
    ad_metrics: 'campaignmetric',
    ops_revenue: 'vendor_sales_manufacturing_asin',
    ops_revenue_field: 'OrderedRevenueAmount',
    ops_units_field: 'OrderedUnits',
    ops_date_field: 'DateTime',
  };
}

/**
 * Sort accounts so the most-likely "primary" comes first. Used to assign
 * role: primary to one account, role: secondary to the rest. The AM can
 * override during cold-start if needed.
 *
 * Order of preference:
 *   1. SC before VC (SC is the more common headline account)
 *   2. Both ads+retail active before partial-access accounts
 *   3. US marketplace before non-US
 *   4. Alphabetical by marketplace for stable output
 */
export function sortAccountsForPrimary(accounts: SellerRow[]): SellerRow[] {
  return [...accounts].sort((a, b) => {
    if (a.account_type !== b.account_type) {
      if (a.account_type === 'SC') return -1;
      if (b.account_type === 'SC') return 1;
    }
    const aFull = a.ads_active && a.retail_active;
    const bFull = b.ads_active && b.retail_active;
    if (aFull !== bFull) return aFull ? -1 : 1;
    const aUs = (a.marketplace ?? '').toLowerCase().includes('united states');
    const bUs = (b.marketplace ?? '').toLowerCase().includes('united states');
    if (aUs !== bUs) return aUs ? -1 : 1;
    return (a.marketplace ?? '').localeCompare(b.marketplace ?? '');
  });
}

// -----------------------------------------------------------------------
// Templates
// -----------------------------------------------------------------------

function narrativeTemplate(suggestion: BrandSuggestion): string {
  return `# ${suggestion.display_name}

*Generated by \`mixshift brand add ${suggestion.slug}\` on ${todayISO()}.*
*Run \`/mx-brand-context ${suggestion.slug}\` in Claude to complete AM intake (positioning, goals, structural events).*

---

## Brand Identity

_To be populated by AM intake._

## Current Quarter Context

_To be populated by AM intake._

## Historical Notes

_To be populated by AM intake._
`;
}

function readmeTemplate(suggestion: BrandSuggestion): string {
  return `# ${suggestion.display_name} brand context

Generated by \`mixshift brand add ${suggestion.slug}\`.

| File | Purpose |
|---|---|
| \`context.yaml\` | Mechanical truth: SellerIDs, account types, sources, management thresholds. Schema-validated. |
| \`narrative.md\` | Prose context: positioning, history, interpretation rules. Filled by the brand-context skill. |
| \`corpora/\` | Lists referenced by skills (manual-targeting ASINs, conquest sets, etc.). Empty at bootstrap. |
| \`runs/\` | Per-skill run sidecars accumulate here over time. Created by the runner; do not edit. |

**Next step:** run \`/mx-brand-context ${suggestion.slug}\` in Claude. The skill walks you through AM intake and fills in everything the bootstrap couldn't derive from the warehouse.
`;
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, content, { encoding: 'utf-8' });
  await rename(tmpPath, path);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
