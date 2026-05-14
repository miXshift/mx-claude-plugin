/**
 * The orchestration logic for `mixshift auth setup`.
 *
 * Split from the command file so it can be unit-tested with fake
 * collaborators (no real MySQL, no real fetch). The command file
 * (commands/auth.ts) wires this to interactive prompts; tests wire it
 * to scripted inputs.
 */

import { randomUUID } from 'node:crypto';
import { platform, release } from 'node:os';
import type { PluginDefaults } from '../defaults/schema.js';
import { loadProfile } from '../profile/load.js';
import { saveProfile } from '../profile/save.js';
import { profileSchema } from '../profile/schema.js';
import { saveCredentials, loadOrInit } from './credentials.js';
import type { MysqlCreds } from './schema.js';
import {
  testConnection as defaultTestConnection,
  type TestResult,
  type FailureKind,
} from './test-connection.js';
import { fetchPublicIp as defaultFetchPublicIp } from './public-ip.js';
import { postWebhook as defaultPostWebhook } from '../webhook/discord.js';
import type { PostResult, WebhookRequest } from '../webhook/types.js';

export interface SetupInputs {
  email: string;
  mysql: MysqlCreds;
  /** Allow the IP whitelist request to be sent automatically if MySQL refuses the host. */
  auto_request_whitelist: boolean;
  /** Skip the connection test entirely (CI / dry-run). */
  skip_connection_test: boolean;
}

export interface SetupResultOk {
  status: 'ok';
  profile_path: string;
  credentials_path: string;
  connection_tested: boolean;
}

export interface SetupResultPending {
  status: 'pending_whitelist';
  profile_path: string;
  credentials_path: string;
  failure_kind: FailureKind;
  whitelist_request_sent: boolean;
  whitelist_request_error?: string;
  public_ip?: string;
}

export interface SetupResultFailure {
  status: 'failed';
  profile_path?: string;
  credentials_path?: string;
  failure_kind: FailureKind;
  message: string;
}

export type SetupResult = SetupResultOk | SetupResultPending | SetupResultFailure;

export interface SetupContext {
  defaults: PluginDefaults;
  plugin_version: string;
  data_dir_override?: string;
}

/**
 * Injectable collaborators. Tests pass fakes; production uses the real
 * implementations imported in this module.
 */
export interface SetupDeps {
  testConnection: (creds: MysqlCreds) => Promise<TestResult>;
  fetchPublicIp: (endpoint: string) => Promise<string | null>;
  postWebhook: (url: string, request: WebhookRequest) => Promise<PostResult>;
}

const defaultDeps: SetupDeps = {
  testConnection: defaultTestConnection,
  fetchPublicIp: defaultFetchPublicIp,
  postWebhook: defaultPostWebhook,
};

/**
 * Run the auth setup orchestration. Returns a structured result describing
 * what happened so the command (or test) can render it appropriately.
 */
export async function runAuthSetup(
  inputs: SetupInputs,
  ctx: SetupContext,
  deps: SetupDeps = defaultDeps,
): Promise<SetupResult> {
  // 1. Persist credentials first so any subsequent test failures don't
  //    force the user to re-enter passwords.
  const credsObj = await loadOrInit(ctx.data_dir_override);
  credsObj.mysql = inputs.mysql;
  const { path: credentials_path } = await saveCredentials(
    credsObj,
    ctx.data_dir_override,
  );

  // 2. Update the user profile with email + (generate if needed) telemetry user_id.
  const { profile } = await loadProfile(ctx.data_dir_override);
  const merged: Record<string, unknown> = JSON.parse(JSON.stringify(profile));
  merged.user = { email: inputs.email };
  const tele = (merged.telemetry ?? {}) as Record<string, unknown>;
  tele.user_id = tele.user_id ?? randomUUID();
  merged.telemetry = tele;
  const parsed = profileSchema.parse(merged);
  const { path: profile_path } = await saveProfile(parsed, ctx.data_dir_override);

  // 3. Optional connection test.
  if (inputs.skip_connection_test) {
    return {
      status: 'ok',
      profile_path,
      credentials_path,
      connection_tested: false,
    };
  }

  const result = await deps.testConnection(inputs.mysql);
  if (result.ok) {
    return {
      status: 'ok',
      profile_path,
      credentials_path,
      connection_tested: true,
    };
  }

  // 4. Classified failure handling.
  if (result.kind === 'ip_not_allowed') {
    if (!inputs.auto_request_whitelist) {
      return {
        status: 'failed',
        profile_path,
        credentials_path,
        failure_kind: 'ip_not_allowed',
        message:
          'Connection refused: your IP is not whitelisted. Re-run with --request-whitelist to send a request.',
      };
    }
    return await sendWhitelistRequest({
      email: inputs.email,
      ctx,
      profile_path,
      credentials_path,
      deps,
    });
  }

  return {
    status: 'failed',
    profile_path,
    credentials_path,
    failure_kind: result.kind,
    message: friendlyFailureMessage(result),
  };
}

async function sendWhitelistRequest(args: {
  email: string;
  ctx: SetupContext;
  profile_path: string;
  credentials_path: string;
  deps: SetupDeps;
}): Promise<SetupResultPending> {
  const publicIp = await args.deps.fetchPublicIp(
    args.ctx.defaults.auth.public_ip_lookup_url,
  );

  let webhookResult: PostResult;
  if (!publicIp) {
    webhookResult = {
      ok: false,
      error:
        'Could not determine your public IP automatically. ' +
        'Visit https://api.ipify.org and email the result to your MixShift contact.',
    };
  } else {
    webhookResult = await args.deps.postWebhook(
      args.ctx.defaults.auth.ip_whitelist_webhook,
      {
        kind: 'ip_whitelist_request',
        user_email: args.email,
        public_ip: publicIp,
        plugin_version: args.ctx.plugin_version,
        os: `${platform()} ${release()}`,
      },
    );
  }

  return {
    status: 'pending_whitelist',
    profile_path: args.profile_path,
    credentials_path: args.credentials_path,
    failure_kind: 'ip_not_allowed',
    whitelist_request_sent: webhookResult.ok,
    whitelist_request_error: webhookResult.error,
    public_ip: publicIp ?? undefined,
  };
}

function friendlyFailureMessage(result: TestResult & { ok: false }): string {
  switch (result.kind) {
    case 'access_denied':
      return 'MySQL rejected the username or password. Double-check both and re-run `mixshift auth setup`.';
    case 'unknown_database':
      return `MySQL accepted the credentials but the database does not exist or this user has no access to it. Verify the database name.`;
    case 'timeout':
      return 'Connection timed out. The host may be unreachable, or your network is blocking outbound MySQL traffic.';
    case 'host_unreachable':
      return 'Could not reach the MySQL host. Check the hostname and your network connection.';
    case 'unknown':
    default:
      return `Connection failed: ${result.message}`;
  }
}
