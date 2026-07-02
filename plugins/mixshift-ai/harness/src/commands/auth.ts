import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { input, password, confirm } from '@inquirer/prompts';
import { loadPluginDefaults } from '../lib/defaults/load.js';
import { runAuthSetup, type SetupInputs, type SetupResult } from '../lib/auth/setup-flow.js';
import { mysqlCredsSchema } from '../lib/auth/schema.js';
import {
  runAuthLogin,
  initDeviceFlow,
  pollDeviceFlow,
  type AuthLoginResult,
} from '../lib/auth/login-flow.js';
import { formatZodError } from '../lib/profile/format-error.js';
import type { PluginDefaults } from '../lib/defaults/schema.js';
import { serviceCredsSchema } from '../lib/auth/schema.js';
import { saveService, getValidAccessToken } from '../lib/auth/credentials.js';
import { exchangeSetupCode } from '../lib/auth/setup-code.js';
import { track, EventName } from '../lib/telemetry/index.js';
import { getPluginVersion } from '../lib/plugin-version.js';
import {
  runDiscoveryAndPersist,
  countByActivity,
} from '../lib/clients/index.js';
import { networkErrorMessage } from '../lib/net/classify.js';
import { resolveApiBaseHost } from '../lib/net/api-base.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

interface SetupOptions {
  nonInteractive: boolean;
  fromFile?: string;
  passwordFile?: string;
  skipConnectionTest: boolean;
  requestWhitelist: boolean;
  host?: string;
  port?: string;
  database?: string;
}

interface LoginOptions {
  personLabel?: string;
  deviceLabel?: string;
  clientId?: string;
  apiBase?: string;
  mode?: string;
  noFallback?: boolean;
}

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command('auth')
    .description(
      'Authenticate against the MixShift warehouse. Two flows: ' +
        '`login` (recommended) for the token-based mx-legacy-auth path, ' +
        'or `setup` for the legacy raw-MySQL path.',
    );

  registerLoginSubcommand(auth);
  registerDeviceInitSubcommand(auth);
  registerDevicePollSubcommand(auth);
  registerServiceSetupSubcommand(auth);

  auth
    .command('setup')
    .description('Walk through interactive auth onboarding (one-time per user)')
    .option('--non-interactive', 'fail if input is required (for CI)', false)
    .option(
      '--from-file <path>',
      'read inputs from a YAML / JSON file instead of prompting',
    )
    .option(
      '--password-file <path>',
      'read MySQL password from this file (overrides any password in ' +
        '--from-file YAML). Use when you want to keep the password out of ' +
        'chat history / bash command previews — the password is read from ' +
        'disk and never echoed.',
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
      const startedAt = Date.now();
      await track({ event_name: EventName.AuthStarted }, root.dataDir);
      try {
        const defaults = await loadPluginDefaults();
        const inputs = await gatherInputs(opts, defaults);
        const result = await runAuthSetup(inputs, {
          defaults,
          plugin_version: getPluginVersion(),
          data_dir_override: root.dataDir,
        });
        renderResult(result, !!root.json);

        // Telemetry: capture the outcome class. Email goes into the event
        // so the server-side join can link install_id → MixShift user.
        const duration = Date.now() - startedAt;
        await track(
          {
            event_name: EventName.AuthConnectionTested,
            outcome:
              result.status === 'ok'
                ? 'ok'
                : result.status === 'pending_whitelist'
                  ? 'deferred'
                  : 'failed',
            duration_ms: duration,
            email: inputs.email,
            payload: {
              status: result.status,
              connection_tested:
                'connection_tested' in result ? result.connection_tested : false,
              whitelist_request_sent:
                'whitelist_request_sent' in result
                  ? result.whitelist_request_sent
                  : undefined,
              public_ip: 'public_ip' in result ? result.public_ip : undefined,
            },
          },
          root.dataDir,
        );
        if (result.status === 'ok') {
          await track(
            { event_name: EventName.AuthCompleted, email: inputs.email },
            root.dataDir,
          );
          // Link install_id ↔ email server-side.
          await track(
            {
              event_name: EventName.UserIdentified,
              email: inputs.email,
            },
            root.dataDir,
          );
          // Post-auth discovery: populate ~/.mixshift/clients/index.yaml so
          // every subsequent skill has the brand list pre-cached. Best-effort
          // — discovery failure does NOT fail auth (creds are saved, user
          // can manually run `mixshift brand discover` later). The non-JSON
          // success message gets a brand-count line appended downstream.
          try {
            const { index } = await runDiscoveryAndPersist({
              dataDirOverride: root.dataDir,
            });
            const counts = countByActivity(index);
            await track(
              {
                event_name: EventName.BrandDiscovered,
                outcome: 'ok',
                email: inputs.email,
                payload: {
                  trigger: 'post_auth',
                  total: counts.total,
                  active: counts.active,
                  dormant: counts.dormant,
                  cold_started: counts.cold_started,
                },
              },
              root.dataDir,
            );
            // Non-JSON: append a brand-count line to the success message.
            // Also nudge toward curating key brands when the count is large
            // — agency managers with 200+ accounts don't want portfolio
            // skills running against all of them.
            if (!root.json) {
              process.stdout.write(
                `\nBrand registry populated at ~/.mixshift/clients/index.yaml:\n` +
                  `  - ${counts.active} active brand(s), ${counts.dormant} dormant, ${counts.cold_started} set up\n` +
                  (counts.active === 0
                    ? `\nNo active brands found. This means you have not yet activated\n` +
                      `data in MixShift for your brands. Head to the Account Manager view:\n` +
                      `  https://dash.mydashapplications.com/account-manager\n` +
                      `\nOnboarding help doc:\n` +
                      `  https://know.mixshift.io/en/articles/9584082-getting-started-with-mixshift\n`
                    : counts.active > 5
                      ? `\nWith ${counts.active} active brand(s), you probably focus on a smaller set day-to-day.\n` +
                        `Mark them as "key" so portfolio skills default to those instead of all ${counts.active}:\n` +
                        `  mixshift brand key add <name-or-slug>   (accepts display names, acronyms, slugs)\n` +
                        `Or in chat: "I manage <brand1>, <brand2>, <brand3>, ..."\n`
                      : ''),
              );
            }
          } catch (err) {
            const message =
              err instanceof Error ? err.message : String(err);
            await track(
              {
                event_name: EventName.BrandDiscovered,
                outcome: 'failed',
                email: inputs.email,
                error_class: 'post_auth_discovery_threw',
                payload: {
                  trigger: 'post_auth',
                  message: message.slice(0, 500),
                },
              },
              root.dataDir,
            );
            // Surface the warning without failing the auth flow.
            if (!root.json) {
              process.stdout.write(
                `\n⚠ Auth succeeded but post-auth brand discovery failed:\n` +
                  `    ${message}\n` +
                  `  Run \`mixshift brand discover\` manually once the issue clears.\n`,
              );
            }
          }
        } else if (result.status === 'pending_whitelist') {
          // This event is in the Supabase fan-out allowlist — emitting it
          // posts the request to the MixShift ops Discord channel. The
          // public_ip in the payload is rendered into the Discord embed
          // so the operator can whitelist it without a follow-up email.
          await track(
            {
              event_name: EventName.IpWhitelistRequested,
              email: inputs.email,
              payload: {
                public_ip: result.public_ip,
                whitelist_request_sent: result.whitelist_request_sent,
              },
            },
            root.dataDir,
          );
        }
        process.exitCode = exitCodeFor(result);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await track(
          {
            event_name: EventName.AuthFailed,
            outcome: 'failed',
            error_class: 'setup_threw',
            payload: { message: message.slice(0, 500) },
          },
          root.dataDir,
        );
        if (root.json) {
          process.stdout.write(
            JSON.stringify({ status: 'error', message }, null, 2) + '\n',
          );
        } else {
          process.stderr.write(`error: ${message}\n`);
        }
        process.exitCode = 1;
        return;
      }
    });
}

function registerLoginSubcommand(auth: Command): void {
  auth
    .command('login')
    .description(
      'Sign in to the MixShift warehouse via the mx-legacy-auth MCP ' +
        'service. Opens a browser (PKCE) or falls back to a device-code ' +
        'flow when no browser is available. Recommended over `auth setup` ' +
        'for new installs — no IP whitelist, no raw MySQL credentials.',
    )
    .option(
      '--person-label <email>',
      'Your work email — attributes this session to you in the admin ' +
        'view. Required because one tenant credential is shared across ' +
        'many employees; person_label lets admins see who did what.',
    )
    .option(
      '--device-label <label>',
      'Friendly device name shown on the login confirmation page ' +
        '(default: this machine\'s hostname).',
    )
    .option(
      '--client-id <slug>',
      'Override the surface-attribution client_id. Defaults to ' +
        '`mx-claude-plugin` (or MIXSHIFT_PLUGIN_CLIENT_ID env var). ' +
        'Use `mx-claude-plugin-dev` for plugin development.',
    )
    .option(
      '--api-base <url>',
      'Override the auth service URL (default: https://mcp.mixshift.io). ' +
        'Used for local mx-legacy-auth development.',
    )
    .option(
      '--mode <flow>',
      'Login flow: `pkce` (browser callback), `device` (device-code ' +
        'paste-URL), or `auto` (PKCE first, fall back to device on ' +
        'browser-open failure).',
      'auto',
    )
    .option(
      '--no-fallback',
      'Auto-mode debug: surface PKCE failure directly instead of ' +
        'falling back to device-code. Use when debugging PKCE locally.',
      false,
    )
    .action(async (opts: LoginOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      await track({ event_name: EventName.AuthStarted }, root.dataDir);

      try {
        const personLabel =
          opts.personLabel ??
          (await promptPersonLabel());

        const mode = parseLoginMode(opts.mode);
        const result = await runAuthLogin({
          personLabel,
          deviceLabel: opts.deviceLabel,
          clientId: opts.clientId,
          apiBase: opts.apiBase,
          mode,
          noFallback: opts.noFallback ?? false,
          dataDirOverride: root.dataDir,
        });

        renderLoginResult(result, !!root.json);

        // UserIdentified is emitted inside runAuthLogin (lib/auth/login-flow.ts)
        // alongside AuthLoginCompleted, so both the PKCE path and the chat
        // device-code path (auth device-init + device-poll) get it for free.
        return;
      } catch (err) {
        const message = networkErrorMessage(
          err,
          resolveApiBaseHost(opts.apiBase),
        );
        await track(
          {
            event_name: EventName.AuthFailed,
            outcome: 'failed',
            error_class: 'login_threw',
            duration_ms: Date.now() - startedAt,
            payload: { message: message.slice(0, 500) },
          },
          root.dataDir,
        );
        if (root.json) {
          process.stdout.write(
            JSON.stringify({ status: 'error', message }, null, 2) + '\n',
          );
        } else {
          process.stderr.write(`error: ${message}\n`);
        }
        process.exitCode = 1;
        return;
      }
    });
}

/**
 * Prompt for person_label when not supplied via flag. TTY-required.
 * Chat-driven invocations should pass --person-label so we don't reach
 * this path (Bash tool can't satisfy interactive prompts).
 */
async function promptPersonLabel(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Missing --person-label and stdin is not a TTY. Pass ' +
        '--person-label <your.email@domain.com> on the command line. ' +
        '(The chat skill provides this automatically; you only need ' +
        'to pass it when running `mixshift auth login` directly in a ' +
        'non-interactive context.)',
    );
  }
  return input({
    message:
      'Your work email (for per-employee session attribution; not auth):',
    required: true,
    validate: (v: string) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
        ? true
        : 'Use email format (e.g. alice@marpartners.com)',
  });
}

function parseLoginMode(raw: string | undefined): 'pkce' | 'device' | 'auto' {
  const v = (raw ?? 'auto').toLowerCase();
  if (v === 'pkce' || v === 'device' || v === 'auto') return v;
  throw new Error(
    `--mode must be one of: pkce, device, auto (got "${raw}").`,
  );
}

function renderLoginResult(result: AuthLoginResult, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  process.stdout.write(
    `\n✓ Signed in via ${result.mode === 'pkce' ? 'browser (PKCE)' : 'device-code'}.\n` +
      `  - tenant:        ${result.email}\n` +
      `  - actor:         ${result.personLabel}\n` +
      `  - api_base:      ${result.apiBase}\n` +
      `  - client_id:     ${result.clientId}\n` +
      `  - duration:      ${(result.durationMs / 1000).toFixed(1)}s\n` +
      `\nTry: \`mixshift data query --sql "SELECT 1"\` to verify ` +
      `warehouse access.\n`,
  );
}

// ---------------------------------------------------------------------------
// Two-phase device-code subcommands (for chat-skill orchestration).
//
// `mixshift auth login` blocks the CLI for up to 10 minutes waiting for the
// browser callback. That doesn't fit chat hosts (Cowork, claude.ai) where
// the Bash tool ceiling is ~45 seconds. These two short-lived commands let
// the chat skill orchestrate the wait across multiple Bash invocations:
//
//   `auth device-init` → POST /auth/device/init, prints {device_code,
//     login_url, ...} JSON, exits immediately. The skill shows login_url
//     to the user and waits for them to confirm in chat.
//
//   `auth device-poll <device_code>` → polls /auth/device/poll for up to
//     --max-wait-ms (default 30s). Prints {state: pending|approved|expired}
//     JSON. On approved, saves the datahub creds + fires post-login
//     discovery + emits AuthLoginCompleted, identical side effects to
//     `auth login`. If still pending, the skill re-calls with the same
//     device_code.
//
// The output is always JSON (`--json` flag is implicit) — these are
// machine-friendly primitives designed for skill orchestration, not
// direct human use. Humans should keep using `mixshift auth login`.
// ---------------------------------------------------------------------------

interface ServiceSetupOptions {
  apiBase?: string;
  setupCode?: string;
  clientId?: string;
  clientSecretFile?: string;
  label?: string;
  skipVerify?: boolean;
}

/**
 * `mixshift auth service-setup` — configure an admin-issued machine
 * credential (OAuth client_credentials) for unattended runs: Cowork
 * scheduled tasks, cloud automations, CI.
 *
 * Preferred path: `--setup-code SVC-XXXX-XXXX`. The admin mints a one-time
 * code at {api_base}/admin; the exchange creates the credential server-side
 * and delivers the secret straight into credentials.json. Nobody handles
 * the secret, and the code in argv is fine by design (single-use, 10-min
 * TTL, burned by the exchange).
 *
 * Raw path (CI / secret managers): --client-id plus the secret via
 * --client-secret-file or the MIXSHIFT_CLIENT_SECRET env var. The raw
 * secret is NEVER taken as a CLI argument.
 */
function registerServiceSetupSubcommand(auth: Command): void {
  auth
    .command('service-setup')
    .description(
      'Configure a service credential for unattended runs (scheduled ' +
        'tasks, cloud automations, CI). Preferred: --setup-code from your ' +
        'tenant admin (one-time, no secret handling). Raw path: --client-id ' +
        'plus --client-secret-file or MIXSHIFT_CLIENT_SECRET, never argv.',
    )
    .option('--api-base <url>', 'mx-legacy-auth service URL.', 'https://mcp.mixshift.io')
    .option(
      '--setup-code <code>',
      'One-time setup code (SVC-XXXX-XXXX) minted by your admin at /admin.',
    )
    .option('--client-id <id>', 'Service client id (svc_...). Raw path only.')
    .option(
      '--client-secret-file <path>',
      'File containing the client secret (whitespace-trimmed). Raw path only.',
    )
    .option('--label <label>', 'Informational label, e.g. svc:my-cron (for telemetry).')
    .option('--skip-verify', 'Save without minting a test token.', false)
    .action(async (opts: ServiceSetupOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      try {
        const apiBase = opts.apiBase ?? 'https://mcp.mixshift.io';
        let clientId: string;
        let secret: string;
        let label = opts.label;
        let via: 'setup_code' | 'secret_file' | 'env';

        if (opts.setupCode) {
          // Preferred: burn the one-time code; the credential is created at
          // exchange time and the secret goes straight to disk below.
          const exchanged = await exchangeSetupCode(apiBase, opts.setupCode);
          clientId = exchanged.client_id;
          secret = exchanged.client_secret;
          label = label ?? exchanged.label;
          via = 'setup_code';
        } else {
          if (!opts.clientId) {
            throw new Error(
              'Pass --setup-code SVC-XXXX-XXXX (preferred, from your admin) ' +
                'or --client-id svc_... with the secret via file/env.',
            );
          }
          clientId = opts.clientId;
          secret = process.env.MIXSHIFT_CLIENT_SECRET ?? '';
          via = secret ? 'env' : 'secret_file';
          if (opts.clientSecretFile) {
            secret = (await readFile(opts.clientSecretFile, 'utf-8')).trim();
            via = 'secret_file';
          }
          if (!secret) {
            throw new Error(
              'No client secret supplied. Pass --client-secret-file <path> or ' +
                'set the MIXSHIFT_CLIENT_SECRET env var.',
            );
          }
        }

        const service = serviceCredsSchema.parse({
          api_base: apiBase,
          client_id: clientId,
          client_secret: secret,
          ...(label ? { label } : {}),
        });
        const { path } = await saveService(service, root.dataDir);

        let verified = false;
        if (!opts.skipVerify) {
          // Proves the credential mints before we call it configured. Throws
          // with an actionable message on 401 (revoked/rotated) or network.
          await getValidAccessToken(root.dataDir, true);
          verified = true;
        }

        // Tracked AFTER the service block is on disk, so when this is the
        // first-ever command in a fresh data dir (the scheduled-task case),
        // the synthetic plugin.installed event riding alongside attributes
        // to the svc: label instead of landing as an anonymous install.
        await track(
          {
            event_name: EventName.AuthServiceSetupCompleted,
            outcome: verified ? 'ok' : 'skipped',
            payload: {
              label: service.label ?? service.client_id,
              verified,
              via,
            },
          },
          root.dataDir,
        );

        if (root.json) {
          process.stdout.write(
            JSON.stringify(
              { status: 'ok', path, client_id: service.client_id, label: service.label, verified, via },
              null,
              2,
            ) + '\n',
          );
        } else {
          process.stderr.write(
            `\n✓ Service credential saved to ${path}\n` +
              (verified
                ? '✓ Verified: minted a test access token via /oauth/token\n'
                : '• Skipped verification (--skip-verify)\n') +
              `\nUnattended runs now authenticate as ${service.label ?? service.client_id}.\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (root.json) {
          process.stdout.write(
            JSON.stringify({ status: 'error', message }, null, 2) + '\n',
          );
        } else {
          process.stderr.write(`error: ${message}\n`);
        }
        process.exitCode = 1;
      }
    });
}

interface DeviceInitCliOptions {
  personLabel?: string;
  deviceLabel?: string;
  clientId?: string;
  apiBase?: string;
}

function registerDeviceInitSubcommand(auth: Command): void {
  auth
    .command('device-init')
    .description(
      'Initialize a device-code sign-in flow. Returns {device_code, ' +
        'login_url, expires_at} as JSON and exits immediately. The chat ' +
        'skill orchestrates the wait via `auth device-poll`. Humans ' +
        'should use `auth login` instead.',
    )
    .option(
      '--person-label <email>',
      'Self-attested per-employee actor email (required).',
    )
    .option('--device-label <label>', 'Device hostname-style label.')
    .option('--client-id <slug>', 'Surface-attribution client_id.')
    .option('--api-base <url>', 'mx-legacy-auth service URL.')
    .action(async (opts: DeviceInitCliOptions, _cmd: Command) => {
      try {
        if (!opts.personLabel) {
          throw new Error(
            '--person-label is required for device-init. ' +
              'Pass --person-label <your.email@domain.com>.',
          );
        }
        const result = await initDeviceFlow({
          personLabel: opts.personLabel,
          deviceLabel: opts.deviceLabel,
          clientId: opts.clientId,
          apiBase: opts.apiBase,
        });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      } catch (err) {
        const message = networkErrorMessage(
          err,
          resolveApiBaseHost(opts.apiBase),
        );
        process.stdout.write(
          JSON.stringify({ ok: false, error: message }, null, 2) + '\n',
        );
        process.exitCode = 1;
        return;
      }
    });
}

interface DevicePollCliOptions {
  personLabel?: string;
  deviceLabel?: string;
  clientId?: string;
  apiBase?: string;
  maxWaitMs?: string;
}

function registerDevicePollSubcommand(auth: Command): void {
  auth
    .command('device-poll <deviceCode>')
    .description(
      'Poll a device-code sign-in flow for up to --max-wait-ms (default ' +
        '30s). Returns {state, result?} as JSON. On approved, persists ' +
        'tokens + runs post-login discovery. Used by the chat skill ' +
        'after the user completes sign-in in their browser.',
    )
    .option(
      '--person-label <email>',
      'Self-attested per-employee actor email (must match device-init).',
    )
    .option('--device-label <label>', 'Device label (match device-init).')
    .option('--client-id <slug>', 'client_id (match device-init).')
    .option('--api-base <url>', 'mx-legacy-auth service URL.')
    .option(
      '--max-wait-ms <ms>',
      'Maximum wall-clock time to keep polling before returning pending.',
      '30000',
    )
    .action(
      async (
        deviceCode: string,
        opts: DevicePollCliOptions,
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          if (!opts.personLabel) {
            throw new Error(
              '--person-label is required for device-poll. ' +
                'Pass the same value used in device-init.',
            );
          }
          const maxWaitMs = Number.parseInt(opts.maxWaitMs ?? '30000', 10);
          if (!Number.isFinite(maxWaitMs) || maxWaitMs < 1_000) {
            throw new Error(
              `--max-wait-ms must be an integer >= 1000 (got "${opts.maxWaitMs}").`,
            );
          }
          const result = await pollDeviceFlow({
            deviceCode,
            personLabel: opts.personLabel,
            deviceLabel: opts.deviceLabel,
            clientId: opts.clientId,
            apiBase: opts.apiBase,
            maxWaitMs,
            dataDirOverride: root.dataDir,
          });
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        } catch (err) {
          const message = networkErrorMessage(
            err,
            resolveApiBaseHost(opts.apiBase),
          );
          process.stdout.write(
            JSON.stringify({ ok: false, error: message }, null, 2) + '\n',
          );
          process.exitCode = 1;
          return;
        }
      },
    );
}

async function gatherInputs(
  opts: SetupOptions,
  defaults: PluginDefaults,
): Promise<SetupInputs> {
  if (opts.fromFile) {
    const inputs = await loadInputsFromFile(opts.fromFile, opts);
    if (opts.passwordFile) {
      // Read password from a separate file so it doesn't appear in the
      // --from-file YAML (which gets shown in bash command previews and
      // chat history).
      //
      // Normalize aggressively because text editors do annoying things:
      //   - Notepad always appends CRLF on save (no way to disable)
      //   - Users pressing Enter after typing the password add another CRLF
      //   - VS Code / Sublime may prepend a UTF-8 BOM (0xEF 0xBB 0xBF)
      //   - Some editors append trailing newlines on every save
      //
      // What we DON'T strip: leading whitespace inside the password (rare
      // but legitimate) or anything mid-string. Just leading BOM + all
      // trailing CR/LF.
      let passwordRaw = await readFile(opts.passwordFile, 'utf-8');
      // Strip UTF-8 BOM if present
      passwordRaw = passwordRaw.replace(/^﻿/, '');
      // Strip ALL trailing CR/LF chars (not just one — Notepad+Enter gives \r\n\r\n)
      const password = passwordRaw.replace(/[\r\n]+$/, '');
      if (password.length === 0) {
        throw new Error(
          `--password-file ${opts.passwordFile} is empty (after stripping ` +
            `BOM and trailing newlines). The file should contain just your ` +
            `MySQL password text — no quotes / labels.`,
        );
      }
      inputs.mysql = { ...inputs.mysql, password };
    }
    return inputs;
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

  // When --password-file is provided, the password in YAML can be an empty
  // placeholder string (the file value will override it). Inject "" if the
  // YAML omits the field entirely so schema parsing succeeds.
  const mysqlInput = (obj.mysql ?? {}) as Record<string, unknown>;
  if (opts.passwordFile && mysqlInput.password === undefined) {
    mysqlInput.password = '';
  }

  const mysqlParse = mysqlCredsSchema.safeParse(mysqlInput);
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
  // Interactive prompts require a TTY. Claude Code's Bash tool doesn't
  // pass one through, so we'd fail with "User force closed the prompt"
  // a few prompts in. Detect early and give a clear error pointing at
  // the right path (chat surface should use mx-auth-login skill instead).
  if (!process.stdin.isTTY) {
    throw new Error(
      'Interactive prompts require a TTY (a real terminal). It looks like ' +
        'stdin isn\'t a terminal here — common when running through the ' +
        'Claude Code Bash tool.\n\n' +
        'Three options:\n' +
        '  1. Recommended: in Claude chat, say "sign in to mixshift" — ' +
        'the mx-auth-login skill drives the token-based browser flow (no ' +
        'TTY prompts needed, no raw MySQL credentials).\n' +
        '  2. Run "mixshift auth login" in your own terminal — same ' +
        'browser flow as the chat skill.\n' +
        '  3. (Legacy) Run "mixshift auth setup" in your own terminal ' +
        '(Git Bash, PowerShell, etc.) where TTY prompts work.\n\n' +
        'For scripted / CI use, pass --from-file <path> with a YAML/JSON ' +
        'file containing email + mysql fields.',
    );
  }

  const cr = defaults.auth.credential_retrieval;
  const dbDefaults = defaults.auth.mysql;

  // Credential-retrieval instructions — show before any prompts so the
  // user knows where to find the values they're about to enter.
  // Written to stdout (not stderr) so it doesn't render as an error in
  // tools that style stderr red (like the Claude Code Bash tool output).
  process.stdout.write(
    '\n# MixShift plugin auth setup\n' +
      '# One-time step. You can re-run later if anything changes.\n' +
      '\n' +
      '# To connect, you need your MySQL credentials from MixShift:\n' +
      `#   1. Open  ${cr.url_default}\n` +
      `#      (or your tenant: ${cr.url_tenant_pattern})\n` +
      '#   2. Sign in if prompted.\n' +
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

  // Success and info messages go to stdout so they don't render as errors
  // in tools that style stderr red. Only actual failures stay on stderr.
  switch (result.status) {
    case 'ok':
      process.stdout.write(
        '\n✓ Auth setup complete.\n' +
          `  - profile:     ${result.profile_path}\n` +
          `  - credentials: ${result.credentials_path}\n` +
          `  - connection:  ${result.connection_tested ? 'verified' : 'not tested (--skip-connection-test)'}\n`,
      );
      return;

    case 'pending_whitelist':
      process.stdout.write(
        '\n• Connection refused: your IP is not whitelisted on the warehouse.\n' +
          `  - profile:     ${result.profile_path}\n` +
          `  - credentials: ${result.credentials_path}\n` +
          `  - public IP:   ${result.public_ip ?? '(could not detect)'}\n`,
      );
      if (result.whitelist_request_sent) {
        process.stdout.write(
          '\n  ✓ Whitelist request sent to MixShift ops.\n' +
            '    You will hear back via email (typically within a few hours)\n' +
            '    once your IP is granted access. Re-run any skill afterwards.\n',
        );
      } else {
        process.stdout.write(
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
