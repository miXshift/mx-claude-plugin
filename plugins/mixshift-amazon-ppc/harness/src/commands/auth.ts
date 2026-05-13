import type { Command } from 'commander';
import { notYetImplemented } from '../lib/stub.js';

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command('auth')
    .description('User authentication setup (MySQL creds, IP whitelist)');

  auth
    .command('setup')
    .description('Walk through interactive auth onboarding (one-time per user)')
    .option('--non-interactive', 'fail if input is required (for CI)', false)
    .action((opts: { nonInteractive: boolean }) => {
      notYetImplemented('auth setup', opts);
    });
}
