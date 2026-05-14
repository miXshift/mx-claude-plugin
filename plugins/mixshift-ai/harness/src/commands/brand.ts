import type { Command } from 'commander';
import { notYetImplemented } from '../lib/stub.js';
import { validateBrandContext } from '../lib/context/load.js';
import { renderValidationResult } from './_render-validation.js';
import { discoverSellers } from '../lib/discovery/seller-query.js';
import { groupIntoBrands } from '../lib/discovery/brand-grouping.js';
import { renderDiscoveryTable } from './_render-discovery.js';
import { bootstrapBrand } from '../lib/clients/bootstrap.js';

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
    .description(
      'Bootstrap a brand context directory from warehouse data. ' +
        'Run /account-cold-start <slug> in Claude afterwards to complete AM intake.',
    )
    .option('--force', 'overwrite an existing brand directory', false)
    .option(
      '--include-inactive',
      'allow brands where both ads and retail access are lost',
      false,
    )
    .action(
      async (
        slug: string,
        opts: { force: boolean; includeInactive: boolean },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          // 1. Re-query discovery so we always work from current warehouse state.
          const sellers = await discoverSellers({
            dataDirOverride: root.dataDir,
            includeInactive: opts.includeInactive,
          });
          const suggestions = groupIntoBrands(sellers);
          const match = suggestions.find((s) => s.slug === slug);
          if (!match) {
            const close = suggestions
              .filter((s) => s.slug.startsWith(slug.slice(0, 3)))
              .slice(0, 5)
              .map((s) => `  - ${s.slug}  (${s.display_name})`)
              .join('\n');
            throw new Error(
              `No brand "${slug}" found in warehouse discovery.\n` +
                (close
                  ? `Close matches:\n${close}\n\n`
                  : '') +
                `Run \`mixshift brand discover\` to list all available brands.`,
            );
          }

          // 2. Bootstrap the directory.
          const result = await bootstrapBrand(match, {
            dataDirOverride: root.dataDir,
            force: opts.force,
          });

          // 3. Output
          if (root.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  status: 'ok',
                  slug: match.slug,
                  brand_dir: result.brand_dir,
                  context_path: result.context_path,
                  narrative_path: result.narrative_path,
                  written_files: result.written_files,
                  account_count: result.context.accounts.length,
                  next_step: `Run /account-cold-start ${match.slug} in Claude to complete AM intake.`,
                },
                null,
                2,
              ) + '\n',
            );
          } else {
            process.stderr.write(
              `\n✓ Bootstrapped "${match.slug}" (${match.display_name})\n` +
                `    accounts:  ${result.context.accounts.length}\n` +
                `    context:   ${result.context_path}\n` +
                `    narrative: ${result.narrative_path}\n` +
                `\nNext: run \`/account-cold-start ${match.slug}\` in Claude.\n` +
                `      The skill walks you through AM intake (positioning,\n` +
                `      goals, structural events) and fills in everything\n` +
                `      the bootstrap couldn't derive from the warehouse.\n`,
            );
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
      },
    );

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
