/**
 * `mixshift doctor` — one-shot environment diagnostic.
 *
 * Started life as a network-only preflight (the bare {"ok":false,
 * "error":"fetch failed"} sign-in failure whose real cause is a sandbox
 * egress proxy refusing our host). Extended into the single command support
 * points people at: it reports the TRUE runtime version (and whether it's
 * stale — the antidote to the Cowork version-label drift, where the host's
 * plugin label claims one version while the runtime is another), the detected
 * channel, auth state, query-pack compatibility, telemetry status, and the
 * network preflight, plus the right "how to update" copy when stale.
 *
 * Local sections (Build / Channel / Auth / Telemetry) always render. Network-
 * dependent sections (staleness, /health, named-pack) degrade gracefully when
 * offline. `--network-only` keeps the original preflight-only scope for any
 * script that depended on it.
 */

import type { Command } from 'commander';
import { runNetworkDoctor, type DoctorReport } from '../lib/net/doctor.js';
import { getPluginVersion } from '../lib/plugin-version.js';
import {
  checkForUpdate,
  renderUpdateBanner,
  type VersionCheckResult,
} from '../lib/version-check.js';
import { detectSurface, type Surface } from '../lib/telemetry/surface.js';
import { loadCredentials, getValidAccessToken } from '../lib/auth/credentials.js';
import type { Credentials } from '../lib/auth/schema.js';
import { getTelemetryStatus } from '../lib/telemetry/consent.js';
import { queueSizeBytes } from '../lib/telemetry/queue.js';
import {
  checkNamedPackCompat,
  type NamedPackResult,
} from '../lib/data/named-pack-check.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

interface DoctorCliOptions {
  apiBase?: string;
  timeoutMs?: string;
  networkOnly?: boolean;
}

type AuthKind = 'interactive' | 'service' | 'legacy_mysql' | 'none';

interface AuthSummary {
  signedIn: boolean;
  kind: AuthKind;
  email?: string;
  personLabel?: string;
  apiBase?: string;
  clientId?: string;
  label?: string;
  database?: string;
  accessExpiresAt?: string;
  accessExpired?: boolean;
  refreshExpiresAt?: string;
}

interface DoctorFullReport {
  build: {
    version: string;
    latest: string | null;
    stale: boolean;
    releaseUrl: string | null;
    checkedRemote: boolean;
  };
  channel: Surface;
  auth: AuthSummary;
  telemetry: {
    enabled: boolean;
    reason: string;
    optedOut: boolean;
    envOverride: boolean;
    configured: boolean;
    queuedBytes: number;
  };
  namedPack: NamedPackResult;
  network: DoctorReport;
  /** Raw version-check result, for the --json consumer + the stale banner. */
  update: VersionCheckResult | null;
  /** Broken-environment summary: service reachable AND no query-pack skew. */
  ok: boolean;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description(
      'One-shot environment diagnostic: runtime version (+ staleness), ' +
        'channel, auth state, query-pack compatibility, telemetry, and the ' +
        'network preflight (egress proxy + /health + allowlist remediation). ' +
        'Run this first when anything seems wrong. --network-only keeps the ' +
        'original preflight-only scope.',
    )
    .option(
      '--api-base <url>',
      'Service URL to probe. Defaults to your saved credentials, then ' +
        'https://mcp.mixshift.io.',
    )
    .option('--timeout-ms <ms>', 'Per-request timeout in milliseconds.', '10000')
    .option(
      '--network-only',
      'Only run the network preflight (original behavior).',
      false,
    )
    .action(async (opts: DoctorCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const parsed = Number.parseInt(opts.timeoutMs ?? '10000', 10);
      const timeoutMs =
        Number.isFinite(parsed) && parsed >= 1000 ? parsed : 10_000;

      // --network-only: preserve the original network-preflight scope + exit.
      if (opts.networkOnly) {
        const report = await runNetworkDoctor({
          apiBase: opts.apiBase,
          dataDirOverride: root.dataDir,
          timeoutMs,
        });
        if (root.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        } else {
          process.stdout.write(renderNetwork(report));
        }
        process.exitCode = report.ok ? 0 : 1;
        return;
      }

      const report = await assembleFullReport({
        apiBase: opts.apiBase,
        dataDirOverride: root.dataDir,
        timeoutMs,
      });

      if (root.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        process.stdout.write(renderFull(report));
      }
      // Exit reflects a broken ENVIRONMENT: service unreachable or a query-
      // pack skew. Not-signed-in is informational (people run doctor to debug
      // BEFORE signing in), so it does not flip the exit code.
      process.exitCode = report.ok ? 0 : 1;
    });
}

async function assembleFullReport(opts: {
  apiBase?: string;
  dataDirOverride?: string;
  timeoutMs: number;
}): Promise<DoctorFullReport> {
  const version = getPluginVersion();
  const channel = detectSurface();

  // Build / staleness — best-effort; never breaks the diagnostic.
  let update: VersionCheckResult | null = null;
  try {
    update = await checkForUpdate({ dataDirOverride: opts.dataDirOverride });
  } catch {
    update = null;
  }

  // Auth — local read of the credentials file.
  const auth = await summarizeAuth(opts.dataDirOverride);

  // Network /health — the original preflight.
  const network = await runNetworkDoctor({
    apiBase: opts.apiBase,
    dataDirOverride: opts.dataDirOverride,
    timeoutMs: opts.timeoutMs,
  });

  // Named-pack compat — only when we can actually reach + authenticate.
  let namedPack: NamedPackResult = {
    checked: false,
    ok: true,
    missing: [],
    total: 0,
    revisions: {},
    reason: auth.signedIn
      ? 'service not reachable'
      : 'not signed in (run `mixshift auth login`)',
  };
  if (auth.signedIn && network.health.reachable) {
    try {
      const token = await getValidAccessToken(opts.dataDirOverride);
      namedPack = await checkNamedPackCompat({
        apiBase: network.api_base,
        accessToken: token,
        timeoutMs: opts.timeoutMs,
      });
    } catch (err) {
      namedPack = {
        checked: false,
        ok: true,
        missing: [],
        total: 0,
        revisions: {},
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Telemetry — local state.
  const ts = await getTelemetryStatus(opts.dataDirOverride);
  const queuedBytes = await queueSizeBytes(opts.dataDirOverride).catch(() => 0);

  const ok = network.ok && namedPack.ok;

  return {
    build: {
      version,
      latest: update?.latest ?? null,
      stale: update?.isStale ?? false,
      releaseUrl: update?.releaseUrl ?? null,
      checkedRemote: update?.fetched ?? false,
    },
    channel,
    auth,
    telemetry: {
      enabled: ts.enabled,
      reason: ts.reason,
      optedOut: ts.opted_out,
      envOverride: ts.env_override,
      configured: ts.configured,
      queuedBytes,
    },
    namedPack,
    network,
    update,
    ok,
  };
}

async function summarizeAuth(dataDirOverride?: string): Promise<AuthSummary> {
  let credentials: Credentials | null = null;
  try {
    credentials = (await loadCredentials(dataDirOverride)).credentials;
  } catch {
    // A malformed creds file must not break a diagnostic; treat as signed-out.
    return { signedIn: false, kind: 'none' };
  }
  if (!credentials) return { signedIn: false, kind: 'none' };

  // datahub (human session) wins when both exist — the more specific intent.
  if (credentials.datahub) {
    const d = credentials.datahub;
    return {
      signedIn: true,
      kind: 'interactive',
      email: d.email,
      personLabel: d.person_label,
      apiBase: d.api_base,
      accessExpiresAt: d.expires_at,
      accessExpired: Date.parse(d.expires_at) <= Date.now(),
      refreshExpiresAt: d.refresh_expires_at,
    };
  }
  if (credentials.service) {
    return {
      signedIn: true,
      kind: 'service',
      apiBase: credentials.service.api_base,
      clientId: credentials.service.client_id,
      label: credentials.service.label,
    };
  }
  if (credentials.mysql) {
    return {
      signedIn: true,
      kind: 'legacy_mysql',
      database: credentials.mysql.database,
    };
  }
  return { signedIn: false, kind: 'none' };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderFull(r: DoctorFullReport): string {
  const out: string[] = [];
  out.push('mixshift doctor');
  out.push('');

  // Build — lead with version + staleness (the Cowork-drift answer).
  out.push('Build:');
  out.push(
    `  version: ${r.build.version}  (the TRUE running build — trust this over the host's plugin label)`,
  );
  if (r.build.latest === null) {
    out.push('  latest:  (could not check — offline or version check unavailable)');
  } else if (r.build.stale) {
    out.push(`  latest:  ${r.build.latest}  — UPDATE AVAILABLE (see below)`);
  } else {
    out.push(`  latest:  ${r.build.latest}  — up to date`);
  }
  out.push('');

  // Channel.
  out.push(`Channel: ${r.channel}`);
  if (r.channel === 'plugin_host_unknown') {
    out.push(
      "  (couldn't identify the host; telemetry tags this as plugin_host_unknown)",
    );
  }
  out.push('');

  // Auth.
  out.push('Auth:');
  if (!r.auth.signedIn) {
    out.push('  not signed in. Run `mixshift auth login`.');
  } else if (r.auth.kind === 'interactive') {
    out.push(
      `  signed in (interactive) as ${r.auth.personLabel ?? r.auth.email ?? '?'}`,
    );
    if (r.auth.email && r.auth.email !== r.auth.personLabel) {
      out.push(`    tenant login: ${r.auth.email}`);
    }
    out.push(`    service: ${r.auth.apiBase ?? '?'}`);
    if (r.auth.accessExpired) {
      out.push(
        '    access token: EXPIRED (auto-refreshes on next call; if that fails, run `mixshift auth login`)',
      );
    } else if (r.auth.accessExpiresAt) {
      out.push(`    access token valid until ${r.auth.accessExpiresAt}`);
    }
  } else if (r.auth.kind === 'service') {
    out.push(
      `  signed in (service credential) ${r.auth.label ?? r.auth.clientId ?? ''}`.trimEnd(),
    );
    out.push(`    service: ${r.auth.apiBase ?? '?'}`);
  } else if (r.auth.kind === 'legacy_mysql') {
    out.push('  signed in (legacy raw-MySQL credential)');
  }
  out.push('');

  // Query pack (service compatibility).
  out.push('Query pack (service compatibility):');
  if (r.namedPack.checked) {
    if (r.namedPack.ok) {
      out.push(
        `  OK — all ${r.namedPack.total} named queries resolve against the deployed pack.`,
      );
    } else {
      out.push(
        `  MISMATCH — ${r.namedPack.missing.length}/${r.namedPack.total} named queries are NOT deployed: ${r.namedPack.missing.join(', ')}.`,
      );
      out.push(
        '    This build is ahead of the service (or the service is mid-deploy);',
      );
      out.push('    affected skills will hit `unknown_query` until it catches up.');
    }
  } else {
    out.push(`  not checked (${r.namedPack.reason ?? 'unavailable'}).`);
  }
  out.push('');

  // Telemetry.
  out.push('Telemetry:');
  out.push(`  ${r.telemetry.enabled ? 'on' : 'off'} (${r.telemetry.reason})`);
  if (r.telemetry.queuedBytes > 0) {
    out.push(
      `    ${r.telemetry.queuedBytes} bytes queued; flushes on the next command.`,
    );
  }
  out.push('');

  // Network — the original preflight section.
  out.push(renderNetwork(r.network));

  // Channel-aware update guidance — only when stale.
  if (r.update && r.update.isStale) {
    out.push(renderUpdateBanner(r.update, 'terminal'));
  }

  return out.join('\n').replace(/\n+$/, '\n');
}

function renderNetwork(r: DoctorReport): string {
  const out: string[] = [];
  out.push('Network:');
  out.push('');

  out.push('  Egress proxy:');
  if (r.proxy.honored) {
    out.push(`    https_proxy: ${r.proxy.https_proxy ?? '(unset)'}`);
    out.push(`    http_proxy:  ${r.proxy.http_proxy ?? '(unset)'}`);
    if (r.proxy.all_proxy) {
      out.push(
        `    all_proxy:   ${r.proxy.all_proxy} (SOCKS; not used, undici routes via the HTTP proxy)`,
      );
    }
    out.push('    status: detected. Global fetch is routed through it.');
  } else {
    out.push(
      '    none detected. Direct connections (normal terminal / unrestricted environment).',
    );
  }
  out.push('');

  out.push(`  Service: ${r.api_base}`);
  if (r.health.reachable) {
    out.push(
      `    reachable (HTTP ${r.health.status}, ${r.health.duration_ms}ms). You are good to go.`,
    );
  } else {
    out.push(`    NOT reachable (${r.health.duration_ms}ms).`);
    if (r.health.error) out.push(`    ${r.health.error}`);
  }
  out.push('');

  if (!r.ok && r.remediation) {
    out.push('  How to fix:');
    for (const line of r.remediation.split('\n')) out.push(`    ${line}`);
    out.push('');
    out.push('  Required domains:');
    for (const e of r.allowlist.required) {
      out.push(`    ${e.domain}`);
      out.push(`      ${e.why}`);
    }
    out.push('');
    out.push('  Optional (safe to omit):');
    for (const e of r.allowlist.optional) {
      out.push(`    ${e.domain}`);
      out.push(`      ${e.why}`);
    }
    out.push('');
  }

  return out.join('\n');
}
