/**
 * `mixshift doctor` — network preflight diagnostics.
 *
 * Exists because the single most confusing failure for a new Cowork /
 * Claude Code user is a bare `{"ok":false,"error":"fetch failed"}` during
 * sign-in, whose real cause is the sandbox egress proxy refusing our host.
 * `doctor` detects the proxy, probes /health through it, and prints the
 * exact allowlist remediation so the user (or their admin) can act without
 * guessing. The chat skill points here when sign-in fails.
 */

import type { Command } from 'commander';
import { runNetworkDoctor, type DoctorReport } from '../lib/net/doctor.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

interface DoctorCliOptions {
  apiBase?: string;
  timeoutMs?: string;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description(
      'Network preflight. Detects a sandbox egress proxy, probes the ' +
        'MixShift service /health endpoint through it, and prints the exact ' +
        'allowlist remediation when the host is blocked (the common Cowork ' +
        '/ Claude Code "fetch failed" cause).',
    )
    .option(
      '--api-base <url>',
      'Service URL to probe. Defaults to your saved credentials, then ' +
        'https://mcp.mixshift.io.',
    )
    .option('--timeout-ms <ms>', 'Health-check timeout in milliseconds.', '10000')
    .action(async (opts: DoctorCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const parsed = Number.parseInt(opts.timeoutMs ?? '10000', 10);
      const timeoutMs =
        Number.isFinite(parsed) && parsed >= 1000 ? parsed : 10_000;

      const report = await runNetworkDoctor({
        apiBase: opts.apiBase,
        dataDirOverride: root.dataDir,
        timeoutMs,
      });

      if (root.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      } else {
        process.stdout.write(renderReport(report));
      }
      // Non-zero exit when the service is unreachable so scripts / the chat
      // skill can branch on it.
      process.exitCode = report.ok ? 0 : 1;
    });
}

function renderReport(r: DoctorReport): string {
  const out: string[] = [];
  out.push('mixshift doctor: network preflight');
  out.push('');

  out.push('Egress proxy:');
  if (r.proxy.honored) {
    out.push(`  https_proxy: ${r.proxy.https_proxy ?? '(unset)'}`);
    out.push(`  http_proxy:  ${r.proxy.http_proxy ?? '(unset)'}`);
    if (r.proxy.all_proxy) {
      out.push(
        `  all_proxy:   ${r.proxy.all_proxy} (SOCKS; not used, undici routes via the HTTP proxy)`,
      );
    }
    out.push('  status: detected. Global fetch is routed through it.');
  } else {
    out.push(
      '  none detected. Direct connections (normal terminal / unrestricted environment).',
    );
  }
  out.push('');

  out.push(`Service: ${r.api_base}`);
  if (r.health.reachable) {
    out.push(
      `  reachable (HTTP ${r.health.status}, ${r.health.duration_ms}ms). You are good to go.`,
    );
  } else {
    out.push(`  NOT reachable (${r.health.duration_ms}ms).`);
    if (r.health.error) out.push(`  ${r.health.error}`);
  }
  out.push('');

  if (!r.ok && r.remediation) {
    out.push('How to fix:');
    for (const line of r.remediation.split('\n')) out.push(`  ${line}`);
    out.push('');
    out.push('Required domains:');
    for (const e of r.allowlist.required) {
      out.push(`  ${e.domain}`);
      out.push(`    ${e.why}`);
    }
    out.push('');
    out.push('Optional (safe to omit):');
    for (const e of r.allowlist.optional) {
      out.push(`  ${e.domain}`);
      out.push(`    ${e.why}`);
    }
    out.push('');
  }

  return out.join('\n') + '\n';
}
