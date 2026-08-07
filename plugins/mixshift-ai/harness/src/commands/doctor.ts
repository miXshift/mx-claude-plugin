/**
 * `mixshift doctor` — one-shot environment diagnostic.
 *
 * Started life as a network-only preflight (the bare {"ok":false,
 * "error":"fetch failed"} sign-in failure whose real cause is a sandbox
 * egress proxy refusing our host). Extended into the single command support
 * points people at: it reports the running session's version alongside what
 * the host's own install record says is actually on disk (feedback
 * 36645/36672/36728 — this section used to call the running version "the
 * TRUE build" and tell people to trust it over the host's label, which is
 * backwards: the running process only knows what it loaded at launch, and an
 * update can land on disk without a currently-running session ever seeing
 * it), the detected channel, auth state, query-pack compatibility, telemetry
 * status, and the network preflight, plus the right "how to update" copy
 * when stale.
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
  compareVersions,
  type VersionCheckResult,
} from '../lib/version-check.js';
import {
  readInstallRecord,
  evaluateInstallSituation,
  renderSessionBehindInstall,
  type InstallSituation,
} from '../lib/install-record.js';
import { detectSurface, type Surface } from '../lib/telemetry/surface.js';
import { loadCredentials, getValidAccessToken } from '../lib/auth/credentials.js';
import type { Credentials } from '../lib/auth/schema.js';
import { getTelemetryStatus } from '../lib/telemetry/consent.js';
import { queueSizeBytes } from '../lib/telemetry/queue.js';
import { REGISTRATION_URL } from '../lib/onboarding.js';
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
    /** The TRUE running build — what this process actually loaded. */
    version: string;
    /** The host's on-disk install record's version, or null if unreadable
     *  on this surface (feedback 36645/36672/36728). */
    installed: string | null;
    /** True iff `installed` is readable and newer than `version` — the
     *  update already succeeded and this session just hasn't reloaded it.
     *  Computed locally; never depends on `latest`. */
    sessionBehindInstall: boolean;
    latest: string | null;
    /** Judged against `installed` when readable, else against `version`
     *  (see `staleBasis`). */
    stale: boolean;
    /** Which version `stale` was judged against. */
    staleBasis: 'installed' | 'current';
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
  /** Raw version-check result (current vs latest only), kept for the --json
   *  consumer's back-compat. The renderer's stale banner now reads `build`
   *  instead, since `build.stale`/`build.releaseUrl` are judged against the
   *  corrected basis (installed, when readable) rather than this raw value. */
  update: VersionCheckResult | null;
  /** Broken-environment summary: service reachable AND no query-pack skew. */
  ok: boolean;
}

/**
 * Assemble the `build` section of the report: the running session's version,
 * the host's install record (when readable), and the resulting staleness
 * judged against the right basis. Pure and exported so the comparison logic
 * (feedback 36645/36672/36728) is unit-testable without the network/auth
 * side effects the rest of `assembleFullReport` carries.
 */
export function buildDoctorBuildSection(opts: {
  version: string;
  installed: string | null;
  latest: string | null;
  fetched: boolean;
}): DoctorFullReport['build'] {
  const situation: InstallSituation = evaluateInstallSituation({
    current: opts.version,
    installed: opts.installed,
    latest: opts.latest,
  });
  return {
    version: opts.version,
    installed: opts.installed,
    sessionBehindInstall: situation.sessionBehindInstall,
    latest: opts.latest,
    stale: situation.isStale,
    staleBasis: situation.staleBasis,
    releaseUrl: situation.releaseUrl,
    checkedRemote: opts.fetched,
  };
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

  // Installed-vs-running (feedback 36645/36672/36728) — local, best-effort;
  // never breaks the diagnostic. readInstallRecord() itself never throws,
  // but keep the same defensive shape as the update check above.
  let installedVersion: string | null = null;
  try {
    const record = await readInstallRecord();
    installedVersion = record?.installedVersion ?? null;
  } catch {
    installedVersion = null;
  }
  const build = buildDoctorBuildSection({
    version,
    installed: installedVersion,
    latest: update?.latest ?? null,
    fetched: update?.fetched ?? false,
  });

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
    build,
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

/**
 * Render the `Build:` block of `mixshift doctor`'s terminal output. Pure and
 * exported (mirrors `buildDoctorBuildSection`'s data/render split) so this is
 * unit-testable off a constructed `build` value alone, without the
 * auth/network/telemetry fixture the rest of `DoctorFullReport` needs.
 *
 * FEEDBACK 36645/36672/36728: this section used to call `version` "the TRUE
 * running build — trust this over the host's plugin label." That claim is
 * exactly what this fix disproves: `version` is only what THIS PROCESS
 * loaded at launch, and a host installs updates independently of any
 * already-running session. `installed` (the host's own record) is what's
 * actually on disk right now; when the two disagree, name both rather than
 * asserting either one is "the truth."
 *
 * FIX: the `installed` line below does a REAL three-way comparison
 * (compareVersions against `version`), not just a check of
 * `sessionBehindInstall`. That flag is only true when installed is NEWER, so
 * branching on `installed === null` then `sessionBehindInstall` then an
 * unconditional `else` also caught installed being OLDER than this session
 * and mislabeled that "matches" too — printing two different version numbers
 * one line apart under a claim they agree.
 */
export function renderBuildSection(build: DoctorFullReport['build']): string[] {
  const out: string[] = [];
  out.push('Build:');
  out.push(`  version:   ${build.version}  (this session's running payload)`);
  const installedCmp =
    build.installed === null ? null : compareVersions(build.installed, build.version);
  if (build.installed === null) {
    out.push('  installed: (could not be verified on this surface)');
  } else if (installedCmp !== null && installedCmp > 0) {
    out.push(`  installed: ${build.installed}  (NEWER than this session)`);
  } else if (installedCmp !== null && installedCmp < 0) {
    out.push(
      `  installed: ${build.installed}  (OLDER than this session; the install record on disk hasn't caught up to what this session is running)`,
    );
  } else {
    out.push(`  installed: ${build.installed}  (matches this session)`);
  }
  if (build.latest === null) {
    out.push('  latest:    (could not check, offline or version check unavailable)');
  } else if (build.stale) {
    out.push(`  latest:    ${build.latest}  (UPDATE AVAILABLE, see below)`);
  } else {
    out.push(`  latest:    ${build.latest}  (up to date)`);
  }
  // `installed` OLDER than this session means the `latest` line above is
  // judged against a stale install record (staleBasis is always 'installed'
  // whenever installed is readable), not against what this session is
  // actually running — name that explicitly so the block as a whole doesn't
  // quietly describe a state the user isn't in.
  if (installedCmp !== null && installedCmp < 0 && build.latest !== null) {
    out.push(
      `  note:      the line above is judged against the OLDER install record (${build.installed}), not the ${build.version} this session is running.`,
    );
  }
  if (build.sessionBehindInstall) {
    out.push(
      renderSessionBehindInstall({
        installed: build.installed,
        current: build.version,
        installIsStale: build.stale,
      }),
    );
  }
  return out;
}

/**
 * Render the trailing "update available" banner off `build` alone, or ''
 * when not stale. Pure and exported so the F2 fix (the banner must render
 * whenever `build.stale`, independent of `sessionBehindInstall`) is
 * unit-testable without the full `DoctorFullReport` fixture.
 *
 * FIX: this used to also require `!build.sessionBehindInstall`, on the
 * theory that re-running doctor after relaunching would surface any
 * remaining installed-vs-latest gap normally, so showing both at once was
 * unnecessary. That assumed the two facts were mutually exclusive; they
 * aren't — current < installed < latest is a real, test-covered state.
 * Suppressing the banner there hid a real available update AND left the
 * "(see below)" text in `renderBuildSection`'s `latest` line pointing at
 * nothing. Render it whenever stale, regardless of `sessionBehindInstall`.
 */
export function renderBuildStaleBanner(build: DoctorFullReport['build']): string {
  if (!build.stale || !build.latest) return '';
  const basisVersion =
    build.staleBasis === 'installed' && build.installed !== null
      ? build.installed
      : build.version;
  return renderUpdateBanner(
    {
      current: basisVersion,
      latest: build.latest,
      isStale: true,
      releaseUrl: build.releaseUrl,
      fetched: build.checkedRemote,
    },
    'terminal',
  );
}

export function renderFull(r: DoctorFullReport): string {
  const out: string[] = [];
  out.push('mixshift doctor');
  out.push('');

  out.push(...renderBuildSection(r.build));
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
    out.push(
      `  No MixShift account yet? Create one first: ${REGISTRATION_URL}`,
    );
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

  // Channel-aware update guidance — see renderBuildStaleBanner for the F2
  // fix (renders whenever stale, independent of sessionBehindInstall).
  const staleBanner = renderBuildStaleBanner(r.build);
  if (staleBanner) {
    out.push(staleBanner);
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
