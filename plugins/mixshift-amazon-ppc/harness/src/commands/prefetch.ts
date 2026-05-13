import type { Command } from 'commander';
import { notYetImplemented } from '../lib/stub.js';

export function registerPrefetchCommand(program: Command): void {
  program
    .command('prefetch')
    .description('Run SQL batches for a skill and write the data artifact')
    .requiredOption('--brand <slug>', 'brand slug')
    .requiredOption('--skill <skill-id>', 'skill identifier from manifest')
    .option('--date <yyyy-mm-dd>', 'data date', todayISO())
    .action((opts: { brand: string; skill: string; date: string }) => {
      notYetImplemented('prefetch', opts);
    });
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
