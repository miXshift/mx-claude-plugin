import type { Command } from 'commander';
import { notYetImplemented } from '../lib/stub.js';
import { validateBrandContext } from '../lib/context/load.js';
import { renderValidationResult } from './_render-validation.js';
import { discoverSellers } from '../lib/discovery/seller-query.js';
import { groupIntoBrands } from '../lib/discovery/brand-grouping.js';
import { renderDiscoveryTable } from './_render-discovery.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerBrandCommands(program: Command): void {
  const brand = program
    .command('brand')
    .description('Brand portfolio management (list, add, edit, archive)');

  brand
    .command('list')
    .description('Show the portfolio table (mirrors index.yaml)')
    .action(() => {
      notYetImplemented('brand list', {});
    });

  brand
    .command('add <slug>')
    .description('Trigger account-cold-start for a new brand')
    .option('--from-file <path>', 'bulk-import config file (YAML list)')
    .action((slug: string, opts: { fromFile?: string }) => {
      notYetImplemented('brand add', { slug, ...opts });
    });

  brand
    .command('status <slug>')
    .description('Show full context + freshness + recent runs for one brand')
    .action((slug: string) => {
      notYetImplemented('brand status', { slug });
    });

  brand
    .command('update <slug>')
    .description('Conversational-edit entry point for one brand')
    .action((slug: string) => {
      notYetImplemented('brand update', { slug });
    });

  brand
    .command('refresh <slug>')
    .description('Re-run cold-start for an existing brand (structure change)')
    .action((slug: string) => {
      notYetImplemented('brand refresh', { slug });
    });

  brand
    .command('archive <slug>')
    .description('Move brand to archived state (data preserved)')
    .action((slug: string) => {
      notYetImplemented('brand archive', { slug });
    });

  brand
    .command('rename <old> <new>')
    .description('Rename a brand slug (folder move + index patch)')
    .action((oldSlug: string, newSlug: string) => {
      notYetImplemented('brand rename', { old: oldSlug, new: newSlug });
    });

  brand
    .command('discover')
    .description('Query the seller table and surface all brands you have access to')
    .option(
      '--include-inactive',
      'include brands where both ads and retail access are lost',
      false,
    )
    .action(async (opts: { includeInactive: boolean }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      try {
        const sellers = await discoverSellers({
          dataDirOverride: root.dataDir,
          includeInactive: opts.includeInactive,
        });
        const suggestions = groupIntoBrands(sellers);

        if (root.json) {
          process.stdout.write(
            JSON.stringify(
              {
                status: 'ok',
                seller_count: sellers.length,
                brand_count: suggestions.length,
                brands: suggestions.map((s) => ({
                  slug: s.slug,
                  display_name: s.display_name,
                  ads_active: s.ads_active,
                  retail_active: s.retail_active,
                  accounts: s.accounts.map((a) => ({
                    seller_id: a.seller_id,
                    seller_name: a.seller_name,
                    merchant_alias: a.merchant_alias,
                    account_type: a.account_type,
                    marketplace: a.marketplace,
                    ads_active: a.ads_active,
                    retail_active: a.retail_active,
                  })),
                })),
              },
              null,
              2,
            ) + '\n',
          );
        } else {
          process.stderr.write(renderDiscoveryTable(suggestions) + '\n');
        }
        process.exit(0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (root.json) {
          process.stdout.write(
            JSON.stringify({ status: 'error', message }, null, 2) + '\n',
          );
        } else {
          process.stderr.write(`error: ${message}\n`);
        }
        process.exit(1);
      }
    });

  brand
    .command('validate <slug>')
    .description('Schema-check one brand context.yaml (post manual edit)')
    .action(async (slug: string, _opts, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const result = await validateBrandContext(slug, root.dataDir);
      renderValidationResult(slug, result, !!root.json);
      process.exit(result.ok ? 0 : 1);
    });
}
