/**
 * `mixshift doctor` core: a one-call network preflight.
 *
 * Does by hand what a stuck Cowork / Claude Code user would otherwise have
 * to reason out: detects whether a sandbox egress proxy is active, probes
 * the MixShift service `/health` endpoint through it, and classifies any
 * failure into an actionable allowlist remediation.
 *
 * The function is fetch-injectable (`fetchImpl`) so it is unit-testable
 * without real network access, mirroring lib/amazon/reports.ts.
 */

import { loadCredentials } from '../auth/credentials.js';
import { DEFAULT_API_BASE, resolveApiBaseHost } from './api-base.js';
import { networkErrorMessage } from './classify.js';

export interface AllowlistEntry {
  domain: string;
  why: string;
}

/** Domains that must be reachable for the plugin to function. Surfaced in
 *  the doctor output AND mirrored in the install docs. Keep in sync. */
export const REQUIRED_ALLOWLIST: AllowlistEntry[] = [
  {
    domain: 'mcp.mixshift.io',
    why: 'Auth, device flow, all warehouse queries, report start/poll, and feedback. Nothing works without it.',
  },
  {
    domain: '*.amazonaws.com',
    why: 'Amazon SP-API report downloads. The service returns presigned S3 URLs the client fetches directly, so report pulls need S3 egress.',
  },
];

/** Non-blocking domains. Safe to omit; listed so admins can allow them
 *  preemptively if they want version checks / telemetry to work. */
export const OPTIONAL_ALLOWLIST: AllowlistEntry[] = [
  {
    domain: 'github.com, raw.githubusercontent.com',
    why: 'Plugin version check only.',
  },
  {
    domain: 'telemetry endpoint',
    why: 'Best-effort anonymized usage events. MIXSHIFT_TELEMETRY=0 disables it entirely.',
  },
];

export interface DoctorProxyInfo {
  https_proxy: string | null;
  http_proxy: string | null;
  all_proxy: string | null;
  /** True when an HTTP(S) proxy is configured, i.e. we install undici's
   *  EnvHttpProxyAgent at startup and route global fetch through it. */
  honored: boolean;
}

export interface DoctorHealth {
  reachable: boolean;
  status: number | null;
  duration_ms: number;
  /** Classified failure message when not reachable; null on success. */
  error: string | null;
}

export interface DoctorReport {
  ok: boolean;
  api_base: string;
  host: string;
  proxy: DoctorProxyInfo;
  health: DoctorHealth;
  /** Allowlist remediation text when ok === false; null otherwise. */
  remediation: string | null;
  allowlist: {
    required: AllowlistEntry[];
    optional: AllowlistEntry[];
  };
}

export interface RunNetworkDoctorOptions {
  /** Override the probed service URL. Defaults to saved credentials, then
   *  DEFAULT_API_BASE. */
  apiBase?: string;
  dataDirOverride?: string;
  timeoutMs?: number;
  /** Injected for testing. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;

export async function runNetworkDoctor(
  opts: RunNetworkDoctorOptions = {},
): Promise<DoctorReport> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;

  const apiBase = await resolveApiBase(opts.apiBase, opts.dataDirOverride);
  const host = resolveApiBaseHost(apiBase);
  const proxy = readProxyInfo();

  const startedAt = Date.now();
  let reachable = false;
  let status: number | null = null;
  let error: string | null = null;

  try {
    const res = await doFetch(`${apiBase}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    reachable = res.ok;
    if (!res.ok) {
      error = `${host} responded with HTTP ${res.status} on /health.`;
    }
  } catch (err) {
    reachable = false;
    error = networkErrorMessage(err, host);
  }

  const ok = reachable;

  return {
    ok,
    api_base: apiBase,
    host,
    proxy,
    health: {
      reachable,
      status,
      duration_ms: Date.now() - startedAt,
      error,
    },
    remediation: ok ? null : buildRemediation(host, proxy),
    allowlist: {
      required: REQUIRED_ALLOWLIST,
      optional: OPTIONAL_ALLOWLIST,
    },
  };
}

async function resolveApiBase(
  override: string | undefined,
  dataDirOverride: string | undefined,
): Promise<string> {
  if (override) return override;
  try {
    const { credentials } = await loadCredentials(dataDirOverride);
    if (credentials?.datahub?.api_base) return credentials.datahub.api_base;
    if (credentials?.service?.api_base) return credentials.service.api_base;
  } catch {
    // Unreadable / malformed credentials should never break a diagnostic.
  }
  return DEFAULT_API_BASE;
}

function readProxyInfo(): DoctorProxyInfo {
  const https = process.env.https_proxy || process.env.HTTPS_PROXY || null;
  const http = process.env.http_proxy || process.env.HTTP_PROXY || null;
  const all = process.env.all_proxy || process.env.ALL_PROXY || null;
  return {
    https_proxy: https,
    http_proxy: http,
    all_proxy: all,
    honored: Boolean(https || http),
  };
}

function buildRemediation(host: string, proxy: DoctorProxyInfo): string {
  const inSandbox = Boolean(
    proxy.https_proxy || proxy.http_proxy || proxy.all_proxy,
  );
  const lines: string[] = [];
  lines.push(
    inSandbox
      ? `${host} is not reachable from this sandbox. An egress proxy is ` +
          `active and ${host} is almost certainly not on its allowlist.`
      : `${host} is not reachable from here.`,
  );
  lines.push(
    'Claude Cowork (Team/Enterprise): an org admin must add the domains ' +
      'below under Organization settings > Capabilities > Code execution, ' +
      'then start a NEW conversation (network settings apply at session ' +
      'creation, so an existing chat will not pick up the change).',
  );
  lines.push(
    'Standalone Claude Code: add them in ~/.claude/settings.json under ' +
      'sandbox.network.allowedDomains (unless managed settings set ' +
      'allowManagedDomainsOnly: true).',
  );
  return lines.join('\n');
}
