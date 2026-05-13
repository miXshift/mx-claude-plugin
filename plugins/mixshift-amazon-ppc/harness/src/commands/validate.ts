import type { Command } from 'commander';
import { notYetImplemented } from '../lib/stub.js';

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate a brand context.yaml against the schema')
    .requiredOption('--brand <slug>', 'brand slug')
    .option('--strict', 'fail on warnings, not just errors', false)
    .action((opts: { brand: string; strict: boolean }) => {
      notYetImplemented('validate', opts);
    });
}
