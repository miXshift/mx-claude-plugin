/**
 * mixshift — internal CLI for the mixshift-ai plugin.
 *
 * Not user-facing. Claude invokes this via the Bash tool during skill
 * execution. End users interact through slash commands and natural language.
 *
 * Architecture: see docs/productization/HARNESS-REWRITE.md
 */

import { Command } from 'commander';
import { registerProfileCommands } from './commands/profile.js';
import { registerBrandCommands } from './commands/brand.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerBootstrapCommand } from './commands/bootstrap.js';
import { registerValidateCommand } from './commands/validate.js';
import { registerPrefetchCommand } from './commands/prefetch.js';
import { registerRenderCommand } from './commands/render.js';
import { registerSidecarCommands } from './commands/sidecar.js';
import { registerUiCommand } from './commands/ui.js';
import { registerDataCommands } from './commands/data.js';
import { registerFeedbackCommand } from './commands/feedback.js';

const program = new Command();

program
  .name('mixshift')
  .description(
    'Internal harness for the mixshift-ai plugin.\n' +
      'Invoked by Claude during skill execution. Not user-facing.',
  )
  .version('0.0.1')
  .option('--json', 'emit machine-readable JSON to stdout', false)
  .option('--verbose', 'verbose logging to stderr', false)
  .option(
    '--data-dir <path>',
    'override MIXSHIFT_DATA_DIR (default: ~/.mixshift)',
  )
  .option(
    '--surface <surface>',
    'force surface detection: claude_code | cowork | chat',
  );

// Register all command groups. Each module is responsible for its own
// subcommands and option parsing — cli.ts stays a registry.
registerProfileCommands(program);
registerAuthCommands(program);
registerBrandCommands(program);
registerBootstrapCommand(program);
registerValidateCommand(program);
registerPrefetchCommand(program);
registerRenderCommand(program);
registerSidecarCommands(program);
registerUiCommand(program);
registerDataCommands(program);
registerFeedbackCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
});
