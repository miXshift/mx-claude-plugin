import type { Command } from 'commander';
import { notYetImplemented } from '../lib/stub.js';

export function registerProfileCommands(program: Command): void {
  const profile = program
    .command('profile')
    .description('Read and write ~/.mixshift/profile.yaml');

  profile
    .command('show')
    .description('Print the current user profile')
    .action(() => {
      notYetImplemented('profile show', {});
    });

  profile
    .command('set <key> <value>')
    .description('Set a profile field (dot.path syntax for nested keys)')
    .action((key: string, value: string) => {
      notYetImplemented('profile set', { key, value });
    });
}
