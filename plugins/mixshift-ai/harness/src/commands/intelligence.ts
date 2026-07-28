/**
 * `mixshift intelligence ...` — MixShift Intelligence service consumption.
 *
 * MixShift Intelligence runs a catalog of server-side insight computations
 * ("insights" — e.g. Ops Bridge) against a merchant's data and hands back a
 * structured JSON envelope: narrative-ready numbers, deltas, and named
 * limitations. This command family is a thin, read-only client over that
 * catalog — it never computes anything itself, and it never touches the
 * warehouse directly (that's `mixshift data`). Closed beta.
 *
 * Command shape:
 *   intelligence catalog                          browse the insight catalog
 *   intelligence run <id> [--params-file f | --params json] [--async]
 *   intelligence poll <runId>                     lightweight status check
 *   intelligence get <runId>                      fetch a finished async run
 *   intelligence runs                             local ledger (recovery)
 *
 * Two-tier output: a finished insight envelope can run tens of KB (the
 * monthly bundle, INS-MONTHLY-01, is roughly 40-120KB). `run` (sync) and
 * `get` NEVER dump that inline unless --json is passed explicitly — the
 * default is a compact headline plus the full envelope written to an
 * artifact file (--out, or a default path; see
 * lib/paths/resolve.ts#intelligenceOutputPath).
 *
 * Exit / telemetry contract matches the other Amazon-adjacent surfaces:
 * handlers set process.exitCode and return (see the header contract in
 * cli.ts); telemetry captures insight id + run id + duration + outcome +
 * cache hit/miss + limitation COUNT only — never the insight payload itself
 * (customer performance numbers, not telemetry).
 */

import type { Command } from 'commander';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve as resolvePath, dirname } from 'node:path';
import {
  catalog,
  run as runInsight,
  pollRun,
  getRunResult,
  isAccepted,
  isIntelligenceFailure,
  exitCodeForKind,
  type InsightEntry,
  type InsightResult,
  type IntelligenceFailure,
  type IntelligenceFailureKind,
  type IntelligenceRunParams,
} from '../lib/intelligence/client.js';
import {
  recordIntelligenceRun,
  updateIntelligenceRunStatus,
  listIntelligenceRuns,
} from '../lib/intelligence/ledger.js';
import { extractRunHeadline, renderHeadline } from '../lib/intelligence/headline.js';
import { intelligenceOutputPath } from '../lib/paths/resolve.js';
import { isSafeBrandSlug } from '../lib/context-sync/local.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerIntelligenceCommands(program: Command): void {
  const intelligence = program
    .command('intelligence')
    .description(
      'MixShift Intelligence: read finished insight envelopes (Ops Bridge and ' +
        'friends) from the MixShift Intelligence service. Closed beta.',
    );

  registerCatalogCommand(intelligence);
  registerRunCommand(intelligence);
  registerPollCommand(intelligence);
  registerGetCommand(intelligence);
  registerRunsCommand(intelligence);
}

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

function registerCatalogCommand(intelligence: Command): void {
  intelligence
    .command('catalog')
    .description('List the insight catalog: id, version, revision, purpose, status.')
    .action(async (_opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const result = await catalog({ dataDirOverride: root.dataDir });
        if (isIntelligenceFailure(result)) {
          await trackFailure('catalog', undefined, result, startedAt, root.dataDir);
          return emitFailure(result, !!root.json);
        }
        await track(
          {
            event_name: EventName.IntelligenceCatalogListed,
            outcome: 'ok',
            duration_ms: Date.now() - startedAt,
            payload: { count: result.entries.length },
          },
          root.dataDir,
        );
        if (root.json) {
          writeJson({ ok: true, entries: result.entries });
        } else {
          process.stdout.write(`\n✓ ${result.entries.length} insight(s)\n\n`);
          process.stdout.write(renderCatalog(result.entries) + '\n');
        }
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// run <id>
// ---------------------------------------------------------------------------

interface RunCliOptions {
  paramsFile?: string;
  params?: string;
  async?: boolean;
  out?: string;
}

function registerRunCommand(intelligence: Command): void {
  intelligence
    .command('run <id>')
    .description(
      'Run one insight (sync by default; --async for large accounts). Params are ' +
        'a single JSON object, server-validated: run `intelligence catalog` for ids.',
    )
    .option('--params-file <path>', 'JSON params from a file. Mutually exclusive with --params.')
    .option('--params <json>', 'inline JSON params (small payloads; prefer --params-file).')
    .option(
      '--async',
      'start the run asynchronously; returns a runId to poll instead of computing inline.',
    )
    .option('--out <path>', 'write the full result JSON here instead of the default artifact path.')
    .action(async (id: string, opts: RunCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const params = await loadParams(opts.paramsFile, opts.params);
        if (opts.async) params.async = true;

        const result = await runInsight({ id, params }, { dataDirOverride: root.dataDir });
        if (isIntelligenceFailure(result)) {
          await trackFailure('run', id, result, startedAt, root.dataDir);
          return emitFailure(result, !!root.json);
        }

        if (isAccepted(result)) {
          await recordIntelligenceRun(
            {
              run_id: result.runId,
              insight_id: id,
              status: result.status,
              ...merchantEcho(params),
            },
            root.dataDir,
          );
          await track(
            {
              event_name: EventName.IntelligenceRunStarted,
              outcome: 'ok',
              duration_ms: Date.now() - startedAt,
              payload: {
                insight_id: id,
                mode: 'async',
                run_id: result.runId,
                status: result.status,
              },
            },
            root.dataDir,
          );
          if (root.json) {
            writeJson(result);
          } else {
            process.stdout.write(
              `\nrunId: ${result.runId}\nstatus: ${result.status}\n\n` +
                `Poll with: mixshift intelligence poll ${result.runId}\n` +
                `Get result: mixshift intelligence get ${result.runId}\n` +
                `Handle saved to intelligence-runs.json; any later call can list it: ` +
                `mixshift intelligence runs\n`,
            );
          }
          return;
        }

        // Sync success — two-tier output: headline inline, full envelope to a file.
        await emitInsightResult(id, result, opts.out, startedAt, root, brandSlugFromParams(params));
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// poll <runId>
// ---------------------------------------------------------------------------

function registerPollCommand(intelligence: Command): void {
  intelligence
    .command('poll <runId>')
    .description('Lightweight status check for an async run (never fetches the payload).')
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const result = await pollRun(runId, { dataDirOverride: root.dataDir });
        if (isIntelligenceFailure(result)) {
          if (result.kind !== 'not_ready') {
            await updateIntelligenceRunStatus(runId, result.kind, root.dataDir);
          }
          await trackFailure('poll', undefined, result, startedAt, root.dataDir, runId);
          return emitFailure(result, !!root.json);
        }
        await updateIntelligenceRunStatus(runId, result.status, root.dataDir);
        await track(
          {
            event_name: EventName.IntelligenceRunPolled,
            outcome: 'ok',
            duration_ms: Date.now() - startedAt,
            payload: { run_id: runId, status: result.status, ready: result.ready },
          },
          root.dataDir,
        );
        if (root.json) {
          writeJson(result);
        } else {
          process.stdout.write(
            `${result.ready ? '✓ done' : '… still running'}  status=${result.status}\n` +
              (result.ready
                ? `Fetch it with: mixshift intelligence get ${runId}\n`
                : `Poll again shortly: mixshift intelligence poll ${runId}\n`),
          );
        }
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// get <runId>
// ---------------------------------------------------------------------------

function registerGetCommand(intelligence: Command): void {
  intelligence
    .command('get <runId>')
    .description('Fetch a finished async run (call after `poll` reports ready).')
    .option('--out <path>', 'write the full result JSON here instead of the default artifact path.')
    .action(async (runId: string, opts: { out?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const result = await getRunResult(runId, { dataDirOverride: root.dataDir });
        if (isIntelligenceFailure(result)) {
          if (result.kind !== 'not_ready') {
            await updateIntelligenceRunStatus(runId, result.kind, root.dataDir);
          }
          await trackFailure('get', undefined, result, startedAt, root.dataDir, runId);
          return emitFailure(result, !!root.json);
        }
        await updateIntelligenceRunStatus(runId, 'DONE', root.dataDir);
        const headlineForId = extractRunHeadline(result);
        const brandSlug = await brandForRunId(runId, root.dataDir);
        await emitInsightResult(
          headlineForId.insightId ?? 'insight',
          result,
          opts.out,
          startedAt,
          root,
          brandSlug,
          runId,
        );
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// runs — list locally recorded async run handles
// ---------------------------------------------------------------------------

function registerRunsCommand(intelligence: Command): void {
  intelligence
    .command('runs')
    .description(
      'List async Intelligence runs recorded on this machine (newest first). ' +
        'Recovery surface: a run started in one shell call can be polled from any later call.',
    )
    .option('--limit <n>', 'max handles to show (default 10).')
    .action(async (opts: { limit?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      try {
        const { runs, path } = await listIntelligenceRuns(root.dataDir);
        const limit = Math.max(1, Math.min(Number(opts.limit) || 10, 50));
        const shown = runs.slice(0, limit);
        if (root.json) {
          writeJson({ ok: true, runs: shown, total_recorded: runs.length, ledger_path: path });
          return;
        }
        if (shown.length === 0) {
          process.stdout.write(
            `No recorded Intelligence runs (ledger: ${path}).\n` +
              'Async submits record here automatically: mixshift intelligence run <id> --async ...\n',
          );
          return;
        }
        for (const r of shown) {
          process.stdout.write(
            `${r.run_id}  ${r.insight_id}  status=${r.status}` +
              `${r.brand ? `  brand=${r.brand}` : ''}${r.seller_id ? `  seller=${r.seller_id}` : ''}` +
              `  submitted=${r.submitted_at}\n`,
          );
        }
        process.stdout.write(
          `\nResume with: mixshift intelligence poll <runId>  |  get <runId>\n` +
            `Statuses are last-seen on THIS machine; poll refreshes from the server.\n`,
        );
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadParams(
  file: string | undefined,
  inline: string | undefined,
): Promise<IntelligenceRunParams> {
  if (file && inline) {
    throw new Error('Pass --params-file or --params, not both.');
  }
  let raw: string;
  if (file) {
    raw = await readFile(file, 'utf8');
  } else if (inline) {
    raw = inline;
  } else {
    throw new Error(
      'No params supplied. Pass --params \'{"merchant": {...}, "period": {...}}\' ' +
        'or --params-file <path>.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Params must be valid JSON: ${message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'Params must be a JSON object (e.g. {"merchant": {...}, "period": {...}}).',
    );
  }
  return parsed as IntelligenceRunParams;
}

/** Best-effort echo of params.merchant for the local ledger + brand-scoped
 *  artifact paths. Never throws on an unexpected shape.
 *
 *  SECURITY: `brand` is caller-supplied and ultimately reaches
 *  intelligenceOutputPath -> brandDir -> path.join(clientsDir, brand) — a
 *  value like '../../evil' or 'a/b' must never be treated as a real brand
 *  slug. isSafeBrandSlug (the same guard lib/context-sync/local.ts uses for
 *  brand slugs crossing the same trust boundary) rejects anything that
 *  isn't. An unsafe brand is dropped, not errored: the run still completes,
 *  just against the flat (no-brand) artifact path — see brandDir in
 *  lib/paths/resolve.ts for the second, unconditional layer of defense. */
function merchantEcho(params: IntelligenceRunParams): { brand?: string; seller_id?: string } {
  const merchant = params.merchant;
  if (typeof merchant !== 'object' || merchant === null || Array.isArray(merchant)) return {};
  const m = merchant as Record<string, unknown>;
  const out: { brand?: string; seller_id?: string } = {};
  if (typeof m.brand === 'string' && m.brand.trim() && isSafeBrandSlug(m.brand.trim())) {
    out.brand = m.brand.trim();
  }
  if (typeof m.sellerId === 'string' && m.sellerId.trim()) out.seller_id = m.sellerId.trim();
  return out;
}

function brandSlugFromParams(params: IntelligenceRunParams): string | undefined {
  return merchantEcho(params).brand;
}

/** Look up the brand this runId was submitted under, from the local ledger,
 *  so `get` can land its artifact next to where `run --async` would have.
 *  Best-effort: an unrecorded/expired handle just falls back to the flat
 *  (no-brand) artifact path.
 *
 *  SECURITY: re-validates the stored brand with isSafeBrandSlug rather than
 *  trusting the ledger file verbatim — defense in depth against a
 *  hand-edited, pre-fix, or otherwise corrupt ledger entry carrying an
 *  unsafe value (see merchantEcho, which is what should have kept it out in
 *  the first place). */
async function brandForRunId(runId: string, dataDir: string | undefined): Promise<string | undefined> {
  try {
    const { runs } = await listIntelligenceRuns(dataDir);
    const brand = runs.find((r) => r.run_id === runId)?.brand;
    return brand && isSafeBrandSlug(brand) ? brand : undefined;
  } catch {
    return undefined;
  }
}

/** Two-tier output shared by `run` (sync) and `get`: always write the full
 *  envelope to an artifact file, and print either a compact headline (human
 *  mode) or the full JSON (--json) — never the full payload inline in human
 *  mode, however large the envelope is.
 *
 *  `runIdForTracking` does double duty: besides tagging the telemetry event,
 *  when present (the `get` path always has one) it also seeds
 *  intelligenceOutputPath's filename nonce, so the artifact for this run
 *  never collides with another run's (see resolve.ts for why timestamp
 *  alone isn't enough). */
async function emitInsightResult(
  id: string,
  result: InsightResult,
  outOverride: string | undefined,
  startedAt: number,
  root: RootOptions,
  brandSlug: string | undefined,
  runIdForTracking?: string,
): Promise<void> {
  const headline = extractRunHeadline(result);
  const artifactPath = outOverride
    ? resolvePath(outOverride)
    : intelligenceOutputPath(
        sanitizeForFilename(id),
        fsSafeTimestamp(),
        brandSlug,
        root.dataDir,
        runIdForTracking,
      );

  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, JSON.stringify(result, null, 2), 'utf8');

  await track(
    {
      event_name: EventName.IntelligenceRunRetrieved,
      outcome: 'ok',
      duration_ms: Date.now() - startedAt,
      payload: {
        insight_id: headline.insightId ?? id,
        cache: headline.cache,
        limitation_count: headline.limitationCount,
        ...(runIdForTracking ? { run_id: runIdForTracking } : {}),
      },
    },
    root.dataDir,
  );

  if (root.json) {
    writeJson({ ...result, artifact_path: artifactPath });
    return;
  }
  process.stdout.write('\n' + renderHeadline(headline) + '\n');
  process.stdout.write(`\nFull result: ${artifactPath}\n`);
}

/** Reduce an id/runId to filename-safe characters so the artifact path can
 *  never escape the output dir even if the caller/server value is unusual.
 *  Mirrors commands/amazon.ts's sanitizeForFilename. */
function sanitizeForFilename(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return cleaned || 'insight';
}

/** ISO timestamp with colons/periods stripped so the filename is valid on
 *  Windows (":' is a reserved path character there). */
function fsSafeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function hintForKind(kind: IntelligenceFailureKind): string | undefined {
  switch (kind) {
    case 'not_enrolled':
      return 'MixShift Intelligence is in closed beta. Contact MixShift ops to get this account enrolled.';
    case 'account_too_large_use_async':
      return 'Retry the same command with --async, then poll the returned runId (mixshift intelligence poll <runId>).';
    case 'busy':
      return 'The Intelligence engine is busy. Wait a moment and retry.';
    case 'not_ready':
      return 'This run has not finished yet. Poll again shortly: mixshift intelligence poll <runId>.';
    case 'run_not_found':
      return 'Check `mixshift intelligence runs` for recent handles on this machine.';
    default:
      return undefined;
  }
}

async function trackFailure(
  op: 'catalog' | 'run' | 'poll' | 'get',
  insightId: string | undefined,
  failure: IntelligenceFailure,
  startedAt: number,
  dataDir: string | undefined,
  runId?: string,
): Promise<void> {
  await track(
    {
      event_name: EventName.IntelligenceRunFailed,
      outcome: 'failed',
      duration_ms: Date.now() - startedAt,
      error_class: failure.kind,
      payload: {
        op,
        ...(insightId ? { insight_id: insightId } : {}),
        ...(runId ? { run_id: runId } : {}),
        failure_kind: failure.kind,
        ...(failure.httpStatus ? { http_status: failure.httpStatus } : {}),
      },
    },
    dataDir,
  );
}

function emitFailure(failure: IntelligenceFailure, json: boolean): void {
  const hint = hintForKind(failure.kind);
  if (json) {
    writeJson({
      ok: false,
      kind: failure.kind,
      message: failure.friendly,
      detail: failure.message,
      http_status: failure.httpStatus,
      ...(hint ? { hint } : {}),
    });
  } else {
    process.stderr.write(`\n✗ (${failure.kind}) ${failure.friendly}\n`);
    if (failure.message) process.stderr.write(`  detail: ${failure.message}\n`);
    if (hint) process.stderr.write(`  hint: ${hint}\n`);
  }
  process.exitCode = exitCodeForKind(failure.kind);
}

function emitError(err: unknown, json: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    writeJson({ ok: false, kind: 'unknown', message });
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}

function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function renderCatalog(entries: InsightEntry[]): string {
  if (entries.length === 0) {
    return '_(no insights in the catalog yet)_';
  }
  return entries
    .map((e) => `- **${e.id}** v${e.version} (rev ${e.revision}, status: ${e.status})\n  ${e.purpose}`)
    .join('\n');
}
