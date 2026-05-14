import type { Command } from 'commander';
import { notYetImplemented } from '../lib/stub.js';

export function registerSidecarCommands(program: Command): void {
  const sidecar = program
    .command('sidecar')
    .description('Run sidecar write + drift comparison');

  sidecar
    .command('write')
    .description('Write a run sidecar after a skill completes')
    .requiredOption('--brand <slug>', 'brand slug')
    .requiredOption('--skill <skill-id>', 'skill identifier')
    .requiredOption(
      '--headline-json <path>',
      'path to the headline JSON the skill produced',
    )
    .action(
      (opts: { brand: string; skill: string; headlineJson: string }) => {
        notYetImplemented('sidecar write', opts);
      },
    );

  sidecar
    .command('compare')
    .description('Drift check this run against the prior run sidecar')
    .requiredOption('--brand <slug>', 'brand slug')
    .requiredOption('--skill <skill-id>', 'skill identifier')
    .action((opts: { brand: string; skill: string }) => {
      notYetImplemented('sidecar compare', opts);
    });
}
