import type { Command } from 'commander';
import { notYetImplemented } from '../lib/stub.js';
import { validateBrandContext } from '../lib/context/load.js';
import { renderValidationResult } from './_render-validation.js';
import { discoverSellers } from '../lib/discovery/seller-query.js';
import { groupIntoBrands } from '../lib/discovery/brand-grouping.js';
import { renderDiscoveryTable } from './_render-discovery.js';
import { bootstrapBrand } from '../lib/clients/bootstrap.js';
import {
  readIndex,
  filterIndex,
  isStale,
  runDiscoveryAndPersist,
  countByActivity,
  markBrandColdStarted,
} from '../lib/clients/index.js';
import { track, EventName } from '../lib/telemetry/index.js';

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
    .description(
      'List brands from the local registry (~/.mixshift/clients/index.yaml). ' +
        'Default hides dormant brands; use --all to see everything or ' +
        '--only-inactive to see just dormants.',
    )
    .option('--all', 'include dormant brands (no active ads or retail access)', false)
    .option('--only-inactive', 'show ONLY dormant brands', false)
    .option('--refresh', 'force a fresh discovery query before listing', false)
    .action(
      async (
        opts: { all: boolean; onlyInactive: boolean; refresh: boolean },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          // Load index, refresh if stale or explicitly requested
          let { index, source } = await readIndex(root.dataDir);
          const needsRefresh =
            opts.refresh || source === 'empty' || isStale(index);
          if (needsRefresh) {
            const result = await runDiscoveryAndPersist({
              dataDirOverride: root.dataDir,
            });
            index = result.index;
            const counts = countByActivity(index);
            await track(
              {
                event_name: EventName.BrandDiscovered,
                outcome: 'ok',
                payload: {
                  trigger: opts.refresh ? 'manual_refresh' : 'ttl_refresh',
                  total: counts.total,
                  active: counts.active,
                  dormant: counts.dormant,
                  cold_started: counts.cold_started,
                },
              },
              root.dataDir,
            );
          }

          const mode = opts.onlyInactive
            ? 'dormant'
            : opts.all
              ? 'all'
              : 'active';
          const brands = filterIndex(index, mode);
          const counts = countByActivity(index);

          if (root.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  status: 'ok',
                  mode,
                  discovered_at: index.discovered_at,
                  counts,
                  brands,
                },
                null,
                2,
              ) + '\n',
            );
            return;
          }

          // Empty-active edge case: surface the activation handoff so
          // the user knows what to do instead of staring at an empty
          // table.
          if (mode === 'active' && counts.active === 0 && counts.total === 0) {
            process.stdout.write(
              '\nNo brands found in your MixShift warehouse.\n' +
                '\n' +
                'This means you have not yet activated data in MixShift for\n' +
                'your brands. Head to the Account Manager view to begin:\n' +
                '  https://dash.mydashapplications.com/account-manager\n' +
                '\n' +
                'Onboarding help doc:\n' +
                '  https://know.mixshift.io/en/articles/9584082-getting-started-with-mixshift\n' +
                '\n',
            );
            return;
          }
          if (mode === 'active' && counts.active === 0 && counts.dormant > 0) {
            process.stdout.write(
              `\nNo ACTIVE brands found (${counts.dormant} dormant — say "show all brands" or run "mixshift brand list --all").\n` +
                '\n' +
                'This typically means MixShift ops has not activated ads + retail\n' +
                'on any of your seller accounts yet. Head to the Account Manager view:\n' +
                '  https://dash.mydashapplications.com/account-manager\n' +
                '\n' +
                'Onboarding help doc:\n' +
                '  https://know.mixshift.io/en/articles/9584082-getting-started-with-mixshift\n' +
                '\n',
            );
            return;
          }

          // Normal rendering path — reuse the existing discovery table
          // by mapping IndexBrand back into the BrandSuggestion shape
          // the renderer expects. (Lightweight adapter; the renderer
          // doesn't care about the cold_started / is_dormant fields.)
          const renderable = brands.map((b) => ({
            slug: b.slug,
            display_name: b.display_name,
            ads_active: b.ads_active,
            retail_active: b.retail_active,
            accounts: b.accounts.map((a) => ({
              seller_id: a.seller_id,
              seller_name: a.seller_name,
              amazon_seller_id: null,
              merchant_alias: a.merchant_alias,
              account_type: a.account_type,
              marketplace: a.marketplace,
              region: a.region,
              agency_name: null,
              acos_target: null,
              ads_active: a.ads_active,
              retail_active: a.retail_active,
              is_active: a.is_active,
              has_mws: a.is_mws_user,
              created_at: null,
              updated_at: null,
            })),
          }));
          process.stderr.write(renderDiscoveryTable(renderable) + '\n');

          // Footer with counts + dormancy hint
          const footerLines: string[] = [];
          footerLines.push(
            `Mode: ${mode}.  Total: ${counts.total} (${counts.active} active, ${counts.dormant} dormant, ${counts.cold_started} cold-started).`,
          );
          footerLines.push(`Discovered: ${index.discovered_at}`);
          if (mode === 'active' && counts.dormant > 0) {
            footerLines.push(
              `${counts.dormant} dormant brand(s) hidden. Use --all or --only-inactive to see them.`,
            );
          }
          process.stderr.write('\n' + footerLines.join('\n') + '\n\n');
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (root.json) {
            process.stdout.write(
              JSON.stringify({ status: 'error', message }, null, 2) + '\n',
            );
          } else {
            process.stderr.write(`error: ${message}\n`);
          }
          process.exitCode = 1;
          return;
        }
      },
    );

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

          await track(
            {
              event_name: EventName.BrandAdded,
              outcome: 'ok',
              payload: {
                slug: match.slug,
                account_count: result.context.accounts.length,
                account_types: result.context.accounts.map((a) => a.account_type),
              },
            },
            root.dataDir,
          );

          // Flip the cold_started flag in the registry so subsequent
          // `brand list` / chat reads can see this brand is onboarded.
          // Best-effort — never fails the bootstrap.
          try {
            await markBrandColdStarted(match.slug, root.dataDir);
          } catch {
            // Index might not exist yet (user ran `brand add` before
            // `brand discover`) — that's fine, next discovery will pick
            // up the cold-started state from the on-disk folder.
          }

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
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (root.json) {
            process.stdout.write(
              JSON.stringify({ status: 'error', message }, null, 2) + '\n',
            );
          } else {
            process.stderr.write(`error: ${message}\n`);
          }
          process.exitCode = 1;
          return;
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
    .description(
      'Query the seller table, persist to ~/.mixshift/clients/index.yaml, ' +
        'and surface the brands you have access to. By default hides ' +
        'dormant brands from the printed table; use --include-inactive to ' +
        'see them. The registry on disk always captures every brand.',
    )
    .option(
      '--include-inactive',
      'include dormant brands (no active ads or retail) in the printed table',
      false,
    )
    .action(async (opts: { includeInactive: boolean }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      try {
        const { index } = await runDiscoveryAndPersist({
          dataDirOverride: root.dataDir,
        });
        const counts = countByActivity(index);

        await track(
          {
            event_name: EventName.BrandDiscovered,
            outcome: 'ok',
            payload: {
              trigger: 'manual_discover',
              total: counts.total,
              active: counts.active,
              dormant: counts.dormant,
              cold_started: counts.cold_started,
              include_inactive_display: opts.includeInactive,
            },
          },
          root.dataDir,
        );

        const displayBrands = opts.includeInactive
          ? filterIndex(index, 'all')
          : filterIndex(index, 'active');

        if (root.json) {
          process.stdout.write(
            JSON.stringify(
              {
                status: 'ok',
                discovered_at: index.discovered_at,
                counts,
                brands: displayBrands,
              },
              null,
              2,
            ) + '\n',
          );
          return;
        }

        // Empty-active handoff (matches `brand list` behavior).
        if (counts.active === 0 && counts.total === 0) {
          process.stdout.write(
            '\nNo brands found in your MixShift warehouse.\n' +
              '\n' +
              'This means you have not yet activated data in MixShift for\n' +
              'your brands. Head to the Account Manager view to begin:\n' +
              '  https://dash.mydashapplications.com/account-manager\n' +
              '\n' +
              'Onboarding help doc:\n' +
              '  https://know.mixshift.io/en/articles/9584082-getting-started-with-mixshift\n' +
              '\n',
          );
          return;
        }

        // Adapter back to BrandSuggestion shape for the existing renderer
        const renderable = displayBrands.map((b) => ({
          slug: b.slug,
          display_name: b.display_name,
          ads_active: b.ads_active,
          retail_active: b.retail_active,
          accounts: b.accounts.map((a) => ({
            seller_id: a.seller_id,
            seller_name: a.seller_name,
            amazon_seller_id: null,
            merchant_alias: a.merchant_alias,
            account_type: a.account_type,
            marketplace: a.marketplace,
            region: a.region,
            agency_name: null,
            acos_target: null,
            ads_active: a.ads_active,
            retail_active: a.retail_active,
            is_active: a.is_active,
            has_mws: a.is_mws_user,
            created_at: null,
            updated_at: null,
          })),
        }));
        process.stderr.write(renderDiscoveryTable(renderable) + '\n');

        const footer = [
          `Total: ${counts.total} (${counts.active} active, ${counts.dormant} dormant, ${counts.cold_started} cold-started).`,
          `Persisted to ${index.brands.length === 0 ? '(empty)' : '~/.mixshift/clients/index.yaml'}.`,
        ];
        if (!opts.includeInactive && counts.dormant > 0) {
          footer.push(
            `${counts.dormant} dormant brand(s) hidden. Use --include-inactive or "mixshift brand list --all" to see them.`,
          );
        }
        process.stderr.write('\n' + footer.join('\n') + '\n\n');
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (root.json) {
          process.stdout.write(
            JSON.stringify({ status: 'error', message }, null, 2) + '\n',
          );
        } else {
          process.stderr.write(`error: ${message}\n`);
        }
        process.exitCode = 1;
        return;
      }
    });

  brand
    .command('validate <slug>')
    .description('Schema-check one brand context.yaml (post manual edit)')
    .action(async (slug: string, _opts, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const result = await validateBrandContext(slug, root.dataDir);
      renderValidationResult(slug, result, !!root.json);
      process.exitCode = result.ok ? 0 : 1;
      return;
    });
}
