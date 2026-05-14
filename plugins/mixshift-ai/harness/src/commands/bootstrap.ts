import type { Command } from 'commander';
import { notYetImplemented } from '../lib/stub.js';

export function registerBootstrapCommand(program: Command): void {
  program
    .command('bootstrap')
    .description('Create the initial context.yaml shell for a new brand')
    .requiredOption('--brand <slug>', 'brand slug (lowercase, hyphenated)')
    .requiredOption('--brand-name <name>', 'human-friendly display name')
    .option(
      '--seller-id <id>',
      'SellerID from the warehouse seller table (can repeat)',
      collect,
      [] as string[],
    )
    .option(
      '--account-type <type>',
      'SC or VC; matches each --seller-id positionally',
      collect,
      [] as string[],
    )
    .option('--date <yyyy-mm-dd>', 'cold-start data date', todayISO())
    .action(
      (opts: {
        brand: string;
        brandName: string;
        sellerId: string[];
        accountType: string[];
        date: string;
      }) => {
        notYetImplemented('bootstrap', opts);
      },
    );
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
