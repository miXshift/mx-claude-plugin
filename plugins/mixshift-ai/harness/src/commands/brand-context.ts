/**
 * `mixshift brand context resolve <slug>` — the read side of the Brand
 * Context accessor seam (lib/brain/read.ts).
 *
 * Resolves every registered brand-level field across the tiers in one pass
 * (Tier 3 context.yaml wins, Tier 2 brand-brain.yaml pre-fills) and emits
 * { field: { value, source, fetched_at } | null }. Analytical skills call
 * this ONCE at Step 0 instead of N ad-hoc context reads, then label each
 * value ✓ (you confirmed it) / ⊙ (pre-filled from the brain) / gap (null →
 * use the skill default). The brand-level counterpart to `mixshift skill
 * config` (the per-skill OCL read).
 */

import type { Command } from 'commander';
import {
  resolveBrandFields,
  resolveProductAcosTargets,
  BRAND_FIELD_KEYS,
  isPlaceholderDefault,
  PLACEHOLDER_NOTE,
  type ResolvedField,
} from '../lib/brain/read.js';
import { noticeIfRetired } from '../lib/context-sync/lifecycle-notice.js';
import type { ProductAcosTargets } from '../lib/context/product-targets.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerBrandContextCommands(brand: Command): void {
  const context = brand
    .command('context')
    .description(
      'Resolved brand context — the brand-level fields skills read, each ' +
        'tagged with its source (Tier-3 context.yaml = you confirmed it, ' +
        'Tier-2 brain = auto pre-filled) so output can show confidence.',
    );

  context
    .command('resolve <slug>')
    .description(
      'Resolve every brand-level field across the tiers in one pass. --json ' +
        'emits { field: { value, source, fetched_at, account_wide? } | null }; ' +
        'a null field means neither tier has it (use the skill default); ' +
        'account_wide is present and true only for a bound sub-brand whose ' +
        'pre-filled value describes the whole seller account, not this brand.',
    )
    .action(async (slug: string, _opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      // Explicit slug: a retired brand still resolves (and is fetched if this
      // machine has no copy yet). Brand retire only skips IMPLICIT bulk work.
      const fields = await resolveBrandFields(slug, root.dataDir, { explicit: true });
      // Product-level ACoS targets (mx-ops#291), beside fields.acos_target_pct.
      // Omitted entirely when the brand sets none, so such a brand's output is
      // byte-identical to before.
      const productTargets = await resolveProductAcosTargets(slug, root.dataDir);
      // Retired brand: one stderr line (who, when, how to undo). stdout below
      // is untouched, so the --json document stays byte-identical. Fails
      // open: an unknown lifecycle prints nothing.
      await noticeIfRetired(slug, { dataDirOverride: root.dataDir });

      if (root.json) {
        process.stdout.write(
          JSON.stringify(
            productTargets ? { slug, fields, product_acos_targets: productTargets } : { slug, fields },
            null,
            2,
          ) + '\n',
        );
        return;
      }

      const lines = [`\nResolved brand context for ${slug}:`];
      let confirmed = 0;
      let prefilled = 0;
      let gaps = 0;
      for (const key of BRAND_FIELD_KEYS) {
        const r: ResolvedField<unknown> | null = fields[key];
        if (r == null) {
          gaps++;
          lines.push(`  ◯ ${key}: (not set — skill default)`);
        } else if (isPlaceholderDefault(fields, key)) {
          // In context.yaml, but only the bootstrap placeholder: never "you
          // confirmed". --json is unchanged; consumers read acos_target_source.
          prefilled++;
          lines.push(`  ⊙ ${key}: ${formatValue(r.value)} (${PLACEHOLDER_NOTE})`);
        } else if (r.source === 'context') {
          confirmed++;
          lines.push(`  ✓ ${key}: ${formatValue(r.value)} (you confirmed)`);
        } else {
          prefilled++;
          lines.push(
            `  ⊙ ${key}: ${formatValue(r.value)} (pre-filled` +
              (r.fetched_at ? `, ${r.fetched_at}` : '') +
              (r.account_wide ? ', ACCOUNT-WIDE, not this sub-brand\'s own' : '') +
              ')',
          );
        }
      }
      if (productTargets) lines.push(...formatProductTargets(productTargets));
      lines.push(
        `\n${confirmed} confirmed · ${prefilled} pre-filled · ${gaps} not set` +
          ` — set any with \`mixshift brand config ${slug}\`, or run a skill that captures it.`,
      );
      process.stdout.write(lines.join('\n') + '\n');
    });
}

/** The product-target lines of the text output (only when the brand sets any). */
export function formatProductTargets(t: ProductAcosTargets): string[] {
  const asins = Object.keys(t.by_asin).length;
  const skus = Object.keys(t.by_sku).length;
  const out = [
    `  ✓ product_acos_targets: ${asins} per-ASIN, ${skus} per-SKU ` +
      `(you confirmed; from ${t.source_paths.join(', ')}). ` +
      'Skills use these per product and acos_target_pct everywhere else.',
  ];
  if (t.skipped.length > 0) {
    out.push(
      `    ${t.skipped.length} entr${t.skipped.length === 1 ? 'y' : 'ies'} could not be read and use the brand target: ` +
        t.skipped
          .slice(0, 5)
          .map((s) => `${s.id} (${s.reason})`)
          .join('; ') +
        (t.skipped.length > 5 ? `; and ${t.skipped.length - 5} more` : ''),
    );
  }
  return out;
}

function formatValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`;
  if (v !== null && typeof v === 'object') return '{…}';
  return String(v);
}
