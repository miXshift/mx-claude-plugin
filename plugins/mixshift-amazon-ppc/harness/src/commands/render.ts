import type { Command } from 'commander';
import { notYetImplemented } from '../lib/stub.js';

export function registerRenderCommand(program: Command): void {
  program
    .command('render')
    .description('Render skill output via the configured adapter')
    .requiredOption('--brand <slug>', 'brand slug')
    .requiredOption('--skill <skill-id>', 'skill identifier from manifest')
    .requiredOption(
      '--sidecar-path <path>',
      'path to the structured sidecar JSON the skill produced',
    )
    .option(
      '--adapter <name>',
      'override profile default: local-html | inline-markdown | google-doc | csv | terminal',
    )
    .option('--date <yyyy-mm-dd>', 'data date', todayISO())
    .action(
      (opts: {
        brand: string;
        skill: string;
        sidecarPath: string;
        adapter?: string;
        date: string;
      }) => {
        notYetImplemented('render', opts);
      },
    );
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
