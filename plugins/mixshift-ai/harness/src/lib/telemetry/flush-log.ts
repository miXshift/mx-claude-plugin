/**
 * Diagnostic flush log — one line per CLI invocation showing what
 * happened when cli.ts's finally `maybeFlush()` ran.
 *
 * Lives at `~/.mixshift/telemetry/flush.log`. Tab-separated columns:
 *   <ISO timestamp>\t<status>\t<events_sent>\t<error>\n
 *
 * Statuses: `sent` | `no_events` | `no_endpoint` | `failed`.
 *
 * Useful for the "events ran but didn't reach Supabase" debugging
 * case — if the harness was invoked, this file gets a line. If the
 * file has no recent line, the harness wasn't invoked (or crashed
 * before the finally block ran).
 *
 * In Cowork's per-session sandboxes the log lives at
 * `/sessions/<session-id>/.mixshift/telemetry/flush.log`. Inspect via:
 *   cat ~/.mixshift/telemetry/flush.log | tail
 *   mixshift telemetry status      (last 5 lines appear in the output)
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { telemetryDir } from '../paths/resolve.js';
import type { FlushResult } from './client.js';

const LOG_FILENAME = 'flush.log';

export function flushLogPath(dataDirOverride?: string): string {
  return join(telemetryDir(dataDirOverride), LOG_FILENAME);
}

/**
 * Append a one-line entry describing the flush result. Best-effort —
 * any error is swallowed so diagnostic logging can never break the CLI.
 */
export async function appendFlushLog(
  result: FlushResult,
  dataDirOverride?: string,
): Promise<void> {
  try {
    const path = flushLogPath(dataDirOverride);
    await mkdir(dirname(path), { recursive: true });
    const errorField = result.error
      ? result.error.replace(/[\t\n\r]+/g, ' ').slice(0, 300)
      : '';
    const line = `${new Date().toISOString()}\t${result.status}\t${result.events_sent}\t${errorField}\n`;
    await appendFile(path, line, { encoding: 'utf-8' });
  } catch {
    // Diagnostic logging must never break the CLI.
  }
}

/**
 * Read the most recent N flush log lines. Returns oldest-first within the
 * tail window. Empty array if the file doesn't exist or is empty.
 *
 * Used by `mixshift telemetry status` to surface recent flush history
 * inline, making the "did my events flush?" question answerable in one
 * command.
 */
export async function tailFlushLog(
  lines: number = 5,
  dataDirOverride?: string,
): Promise<string[]> {
  try {
    const path = flushLogPath(dataDirOverride);
    const raw = await readFile(path, 'utf-8');
    const allLines = raw.split('\n').filter((l) => l.trim().length > 0);
    return allLines.slice(-lines);
  } catch {
    return [];
  }
}
