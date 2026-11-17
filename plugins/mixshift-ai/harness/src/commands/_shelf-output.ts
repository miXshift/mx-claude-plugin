/**
 * Output and telemetry helpers shared by the `mixshift shelf ...` commands
 * (shelf.ts and shelf-tracking.ts): the --json writer, the typed-failure
 * printer with its exit code, and the telemetry shape (kind, outcome and
 * counts; never a subject or an answer).
 */

import { CONTRACT_WORD } from '../lib/amazon/reports.js';
import { exitCodeForShelfKind, type ShelfFailure } from '../lib/shelf/client.js';
import { track } from '../lib/telemetry/index.js';

export function failurePayload(failure: ShelfFailure, base: Record<string, unknown>): Record<string, unknown> {
  return {
    ...base,
    kind_failed: failure.kind,
    ...(failure.httpStatus ? { http_status: failure.httpStatus } : {}),
    ...(failure.unrecognizedKind ? { unrecognized_kind: failure.unrecognizedKind } : {}),
    // The service's error contract: enums and a flag; never the friendly text.
    ...(failure.source !== undefined && CONTRACT_WORD.test(failure.source) ? { source: failure.source } : {}),
    ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}),
    ...(failure.reason !== undefined && CONTRACT_WORD.test(failure.reason) ? { reason: failure.reason } : {}),
  };
}

export async function trackShelf(
  eventName: string,
  outcome: 'ok' | 'failed',
  startedAt: number,
  dataDir: string | undefined,
  payload: Record<string, unknown>,
): Promise<void> {
  await track(
    {
      event_name: eventName,
      outcome,
      duration_ms: Date.now() - startedAt,
      ...(outcome === 'failed' && typeof payload.kind_failed === 'string' ? { error_class: payload.kind_failed } : {}),
      payload,
    },
    dataDir,
  );
}

export function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

export function emitFailure(failure: ShelfFailure, json: boolean): void {
  if (json) {
    writeJson({
      status: 'error',
      failure_kind: failure.kind,
      message: failure.friendly,
      detail: failure.message,
      http_status: failure.httpStatus,
      period: failure.period,
      allowance: failure.allowance,
      used: failure.used,
      resets_at: failure.resetsAt,
      request_more: failure.requestMore,
      reason: failure.reason,
      projected_calls_per_month: failure.projectedCallsPerMonth,
      calls_per_day: failure.callsPerDay,
      max_calls_per_day_per_set: failure.maxCallsPerDayPerSet,
      available_count: failure.availableCount,
      unavailable: failure.unavailableZips,
      retry_after_ms: failure.retryAfterMs,
      required_scope: failure.requiredScope,
      unrecognized_kind: failure.unrecognizedKind,
      source: failure.source,
      retryable: failure.retryable,
      invalid_params: failure.invalidParams,
    });
  } else {
    process.stderr.write(`\n✗ ${failure.friendly}\n`);
    if (failure.message && failure.message !== failure.friendly) process.stderr.write(`  ${failure.message}\n`);
    if (failure.projectedCallsPerMonth !== undefined) {
      process.stderr.write(`  projected monthly use: ${failure.projectedCallsPerMonth} shelf requests; allowance: ${failure.allowance ?? '?'} a month\n`);
    }
    if (failure.callsPerDay !== undefined || failure.maxCallsPerDayPerSet !== undefined) {
      process.stderr.write(
        `  calls a day for this set: ${failure.callsPerDay ?? '?'}; the most one set may make: ${failure.maxCallsPerDayPerSet ?? '?'} ` +
          '(keywords x zips x views x pages). Trim it, or split it into more sets.\n',
      );
    }
    if (failure.unavailableZips) {
      process.stderr.write(`  not available: ${failure.unavailableZips.join(', ')} (\`mixshift shelf zips\` lists the ones that are)\n`);
    }
    if (failure.kind === 'shelf_allowance_exhausted') {
      if (failure.resetsAt) process.stderr.write(`  used ${failure.used ?? '?'} of ${failure.allowance ?? '?'} for ${failure.period ?? 'this month'}; resets ${failure.resetsAt}\n`);
      process.stderr.write('  To ask MixShift for more now: say "request more shelf requests" (the skill sends feedback with your organization and period).\n');
    }
    if (failure.kind === 'tracking_over_allowance') {
      process.stderr.write(
        '  To make room: `mixshift shelf tracking remove <set> --keyword "<keyword>"` or `mixshift shelf tracking pause <set>`; ' +
          'for a larger allowance, say "request more shelf requests".\n',
      );
    }
    if (failure.kind === 'forbidden' && failure.reason === 'identity_not_verified') {
      process.stderr.write(
        '  Sign in to MixShift as yourself, with your own Google or Microsoft work account (`mixshift auth login`), not a shared ' +
          'team login, then run it again.\n',
      );
    } else if (failure.kind === 'forbidden') {
      process.stderr.write(
        '  Ask an owner, admin or manager in your organization to make this change, or say "track these keywords" to ask MixShift. ' +
          "Only a person's sign-in can change tracking: a machine credential, such as one a scheduled task uses, never can.\n",
      );
    }
    if (failure.kind === 'tracking_unavailable') {
      process.stderr.write(
        '  Meanwhile, to have MixShift track keywords for you, say "track these keywords" (the skill sends the request as feedback); ' +
          '`mixshift shelf rank-history` keeps answering for what is already tracked.\n',
      );
    }
    if (failure.kind === 'not_tracked') {
      process.stderr.write(
        '  To track it: an owner, admin or manager can add the keyword to a set that already lists that zip and view ' +
          '(`mixshift shelf tracking list` shows them) with `mixshift shelf tracking add <set> --keyword "<keyword>"`, or create a set ' +
          'for it; anyone can say "track these keywords" to ask MixShift.\n',
      );
    }
    if (failure.retryable === false && failure.source === 'request') {
      process.stderr.write('  Not retryable as sent: change the request before calling again.\n');
    }
  }
  process.exitCode = exitCodeForShelfKind(failure.kind);
}

export function emitError(err: unknown, json: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  if (json) writeJson({ status: 'error', message });
  else process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}
