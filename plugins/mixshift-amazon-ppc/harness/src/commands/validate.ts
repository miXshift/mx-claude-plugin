import type { Command } from 'commander';
import { validateBrandContext } from '../lib/context/load.js';
import { renderValidationResult } from './_render-validation.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate a brand context.yaml against the schema')
    .requiredOption('--brand <slug>', 'brand slug')
    .option('--strict', 'fail on warnings, not just errors', false)
    .action(async (opts: { brand: string; strict: boolean }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const result = await validateBrandContext(opts.brand, root.dataDir);
      renderValidationResult(opts.brand, result, !!root.json);
      process.exit(result.ok ? 0 : 1);
    });
}
