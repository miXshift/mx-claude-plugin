import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { input, password, confirm } from '@inquirer/prompts';
import { loadPluginDefaults } from '../lib/defaults/load.js';
import { runAuthSetup, type SetupInputs, type SetupResult } from '../lib/auth/setup-flow.js';
import { mysqlCredsSchema } from '../lib/auth/schema.js';
import { formatZodError } from '../lib/profile/format-error.js';
import type { PluginDefaults } from '../lib/defaults/schema.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

interface SetupOptions {
  nonInteractive: boolean;
  fromFile?: string;
  skipConnectionTest: boolean;
  requestWhitelist: boolean;
  host?: string;
  port?: string;
  database?: string;
}

const PLUGIN_VERSION = '0.0.1';

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command('auth')
    .description('User authentication setup (MySQL creds, IP whitelist)');

  auth
    .command('setup')
    .description('Walk through interactive auth onboarding (one-time per user)')
    .option('--non-interactive', 'fail if input is required (for CI)', false)
    .option(
      '--from-file <path>',
      'read inputs from a YAML / JSON file instead of prompting',
    )
    .option(
      '--skip-connection-test',
      'save credentials without verifying they work (CI / dry-run)',
      false,
    )
    .option(
      '--request-whitelist',
      'automatically POST to the IP whitelist webhook if the connection test ' +
        'fails with "host not allowed"',
      false,
    )
    .option(
      '--host <host>',
      'MySQL host override (default: db.mydashapplications.studio from plugin defaults)',
    )
    .option('--port <port>', 'MySQL port override (default: 3306)')
    .option(
      '--database <name>',
      'MySQL database/schema override (default: dashamazon)',
    )
    .action(async (opts: SetupOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      try {
        const defaults = await loadPluginDefaults();
        const inputs = await gatherInputs(opts, defaults);
        const result = await runAuthSetup(inputs, {
          defaults,
          plugin_version: PLUGIN_VERSION,
          data_dir_override: root.dataDir,
        });
        renderResult(result, !!root.json);
        process.exit(exitCodeFor(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (root.json) {
          process.stdout.write(
            JSON.stringify({ status: 'error', message }, null, 2) + '\n',
          );
        } else {
          process.stderr.write(`error: ${message}\n`);
        }
        process.exit(1);
      }
    });
}

async function gatherInputs(
  opts: SetupOptions,
  defaults: PluginDefaults,
): Promise<SetupInputs> {
  if (opts.fromFile) {
    return loadInputsFromFile(opts.fromFile, opts);
  }
  if (opts.nonInteractive) {
    throw new Error(
      '--non-interactive requires --from-file <path> with inputs filled in.',
    );
  }
  return promptInputs(opts, defaults);
}

async function loadInputsFromFile(
  path: string,
  opts: SetupOptions,
): Promise<SetupInputs> {
  const raw = await readFile(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = path.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${path}: ${message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path} must be an object with email + mysql fields.`);
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.email !== 'string') {
    throw new Error(`${path} is missing a top-level "email" string.`);
  }

  const mysqlParse = mysqlCredsSchema.safeParse(obj.mysql);
  if (!mysqlParse.success) {
    throw new Error(
      formatZodError(mysqlParse.error, `MySQL credentials in ${path} are invalid`),
    );
  }

  return {
    email: obj.email,
    mysql: mysqlParse.data,
    auto_request_whitelist: opts.requestWhitelist,
    skip_connection_test: opts.skipConnectionTest,
  };
}

async function promptInputs(
  opts: SetupOptions,
  defaults: PluginDefaults,
): Promise<SetupInputs> {
  const cr = defaults.auth.credential_retrieval;
  const dbDefaults = defaults.auth.mysql;

  // Credential-retrieval instructions — show before any prompts so the
  // user knows where to find the values they're about to enter.
  process.stderr.write(
    '\n# MixShift plugin auth setup\n' +
      '# One-time step. You can re-run later if anything changes.\n' +
      '\n' +
      '# To connect, you need your MySQL credentials from MixShift:\n' +
      `#   1. Open  ${cr.url_default}\n` +
      `#      (or your tenant: ${cr.url_tenant_pattern})\n` +
      (cr.master_password
        ? `#   2. Enter the master password when prompted:\n` +
          `#        ${cr.master_password}\n`
        : '#   2. Sign in if prompted.\n') +
      `#   3. Copy HostName, Username, Port, Schema, and Password from the page.\n` +
      '\n' +
      (cr.notes ? `# ${cr.notes.replace(/\n/g, '\n# ')}\n\n` : '\n'),
  );

  const email = await input({
    message: 'Your email (for telemetry + IP whitelist requests):',
    required: true,
  });

  // Ask username first so we can default the database to match (most
  // accounts have username == schema). Sam's `dash` account is the
  // outlier — he edits the database default.
  const user = await input({ message: 'MySQL Username:', required: true });
  const passwd = await password({ message: 'MySQL Password:', mask: '*' });

  const host = await input({
    message: 'MySQL HostName:',
    default: opts.host ?? dbDefaults.host,
    required: true,
  });

  const portStr = await input({
    message: 'MySQL Port:',
    default: String(opts.port ?? dbDefaults.port),
    required: true,
  });
  const port = Number.parseInt(portStr, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Port must be an integer in 1..65535, got "${portStr}".`);
  }

  const database = await input({
    message: 'MySQL Schema (database name):',
    // Default to the username (typical case); falls back to plugin
    // default only if user gave an empty username (which would have
    // failed the required check above, so this is defensive).
    default: opts.database ?? user ?? dbDefaults.database,
    required: true,
  });

  const requestWhitelist =
    opts.requestWhitelist ||
    (await confirm({
      message:
        '\nIf the connection test fails because your IP is not whitelisted, ' +
        'send a whitelist request to MixShift automatically?',
      default: true,
    }));

  return {
    email,
    mysql: { host, port, user, password: passwd, database },
    auto_request_whitelist: requestWhitelist,
    skip_connection_test: opts.skipConnectionTest,
  };
}

function renderResult(result: SetupResult, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  switch (result.status) {
    case 'ok':
      process.stderr.write(
        '\n✓ Auth setup complete.\n' +
          `  - profile:     ${result.profile_path}\n` +
          `  - credentials: ${result.credentials_path}\n` +
          `  - connection:  ${result.connection_tested ? 'verified' : 'not tested (--skip-connection-test)'}\n`,
      );
      return;

    case 'pending_whitelist':
      process.stderr.write(
        '\n• Connection refused: your IP is not whitelisted on the warehouse.\n' +
          `  - profile:     ${result.profile_path}\n` +
          `  - credentials: ${result.credentials_path}\n` +
          `  - public IP:   ${result.public_ip ?? '(could not detect)'}\n`,
      );
      if (result.whitelist_request_sent) {
        process.stderr.write(
          '\n  ✓ Whitelist request sent to MixShift ops.\n' +
            '    You will hear back via email (typically within a few hours)\n' +
            '    once your IP is granted access. Re-run any skill afterwards.\n',
        );
      } else {
        process.stderr.write(
          '\n  ✗ Whitelist request was NOT sent automatically.\n' +
            `    Reason: ${result.whitelist_request_error ?? 'unknown'}\n` +
            '    Email your MixShift contact with your public IP to request access.\n',
        );
      }
      return;

    case 'failed':
      process.stderr.write(`\n✗ Auth setup failed: ${result.message}\n`);
      return;
  }
}

function exitCodeFor(result: SetupResult): number {
  switch (result.status) {
    case 'ok':
      return 0;
    case 'pending_whitelist':
      // Distinct exit code so scripts can recognize "creds saved, waiting on
      // human action" vs. "completed" or "failed."
      return 3;
    case 'failed':
      return 1;
  }
}
