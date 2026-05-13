import type { Command } from 'commander';
import { notYetImplemented } from '../lib/stub.js';

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
    .description('Re-query the seller table and surface new brands')
    .action(() => {
      notYetImplemented('brand discover', {});
    });

  brand
    .command('validate <slug>')
    .description('Schema-check one brand context.yaml (post manual edit)')
    .action((slug: string) => {
      notYetImplemented('brand validate', { slug });
    });
}
