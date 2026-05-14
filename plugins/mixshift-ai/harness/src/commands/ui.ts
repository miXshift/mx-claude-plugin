import type { Command } from 'commander';
import { notYetImplemented } from '../lib/stub.js';

export function registerUiCommand(program: Command): void {
  program
    .command('ui')
    .description(
      'Launch the local web UI for brand management (Claude Code only).\n' +
        'Cowork users should use conversational editing via /mixshift-brand-update.',
    )
    .option('--port <port>', 'local port to bind', '8080')
    .option(
      '--password <password>',
      'one-time password (stored in profile.ui_password)',
    )
    .action((opts: { port: string; password?: string }) => {
      notYetImplemented('ui', opts);
    });
}
