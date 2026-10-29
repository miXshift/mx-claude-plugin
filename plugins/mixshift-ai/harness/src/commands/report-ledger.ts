import type { Command } from 'commander';
import { isSafeBrandSlug } from '../lib/context-sync/local.js';
import { createRunLedgerClient, type RunLedgerClient } from '../lib/run-ledger/client.js';
import { SKILL_LEDGERS } from '../lib/run-ledger/local.js';
import {
  ledgerStatus,
  pullLedger,
  pushLedger,
  type PullState,
  type PushState,
  type SyncResult,
} from '../lib/run-ledger/sync.js';
import { track } from '../lib/telemetry/index.js';
import { EventName } from '../lib/telemetry/events.js';

/**
 * `mixshift report ledger pull|push|status`: sync a skill's run ledger with the
 * MixShift service, the single source of truth (mx-ops#202). The local folder under
 * ~/.mixshift/clients/<brand>/runs/ is a cache. Run state is not brand context, so
 * this is its own command and its own service route, never `mixshift context`.
 *
 * Exit codes: 0 = the skill can proceed (read `state` for the nuance, including
 * `absent` and `gateway_unavailable`); 1 = refused or failed, nothing overwritten
 * (diverged, server_missing, local_corrupt, other_account, conflict, pull_first,
 * error); 2 = bad arguments.
 */

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

interface LedgerOptions {
  brand: string;
  skill: string;
  force?: boolean;
  prune?: boolean;
}

const DEFAULT_SKILL = 'mx-max-report';
/** The service's brand slug rule (the brand context service uses the same one). */
const SERVICE_BRAND_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const PULL_PROCEED: ReadonlySet<PullState> = new Set(['pulled', 'up_to_date', 'migrated', 'absent', 'gateway_unavailable']);
const PUSH_PROCEED: ReadonlySet<PushState> = new Set(['pushed', 'up_to_date', 'gateway_unavailable']);

/** Test seam: the client the commands use. */
let clientFactory: (dataDir?: string) => RunLedgerClient = (dataDir) =>
  createRunLedgerClient({ dataDirOverride: dataDir });
export function setRunLedgerClientFactoryForTests(f: ((dataDir?: string) => RunLedgerClient) | null): void {
  clientFactory = f ?? ((dataDir) => createRunLedgerClient({ dataDirOverride: dataDir }));
}

/** Validate --brand and --skill; null (after printing why) when either is unusable. */
export function checkLedgerArgs(opts: { brand?: string; skill?: string }): string | null {
  const brand = opts.brand ?? '';
  if (!SERVICE_BRAND_SLUG_RE.test(brand) || !isSafeBrandSlug(brand)) {
    return (
      `--brand must be a brand slug (lowercase letters, digits and hyphens, as \`mixshift brand list\` shows it); got ${JSON.stringify(brand)}.`
    );
  }
  const skill = opts.skill ?? DEFAULT_SKILL;
  if (!SKILL_LEDGERS[skill]) {
    return `--skill must be one of: ${Object.keys(SKILL_LEDGERS).join(', ')}; got ${JSON.stringify(skill)}.`;
  }
  return null;
}

function printResult(result: SyncResult<string>, json: boolean, proceed: boolean): void {
  if (json) {
    // `ok` is false for every refusal, so a reader keying on it never mistakes
    // `diverged` or `error` for success. `state` carries the detail.
    console.log(JSON.stringify({ ok: proceed, ...result }, null, 2));
    return;
  }
  console.log(`[${result.state}] ${result.message}`);
  console.log(`  local ledger: ${result.local_dir} (${result.local_files} files)`);
  if (result.revision !== null) console.log(`  service revision: ${result.revision}`);
  for (const c of result.changes) console.log(`  ${c.change}: ${c.path}`);
  for (const p of result.local_edits) console.log(`  newer here (push to save): ${p}`);
  for (const p of result.diverged) console.log(`  changed on both sides: ${p}`);
  for (const p of result.corrupt) console.log(`  does not parse: ${p}`);
  for (const p of result.missing_locally ?? []) console.log(`  missing here, kept on the service (push --prune deletes): ${p}`);
  for (const s of result.skipped) console.log(`  not synced (${s.reason}): ${s.path}`);
  if (result.kept_aside) console.log(`  your local copies were kept in: ${result.kept_aside}`);
}

async function emit(
  action: 'pull' | 'push' | 'status',
  result: { state: string; changes?: unknown[]; local_files: number; failure?: { kind: string } },
  skill: string,
  ok: boolean,
  t0: number,
  dataDir: string | undefined,
): Promise<void> {
  await track(
    {
      event_name: EventName.ReportLedgerSynced,
      skill_id: skill,
      outcome: ok ? 'ok' : 'failed',
      duration_ms: Date.now() - t0,
      ...(result.failure ? { error_class: result.failure.kind } : {}),
      payload: {
        action,
        state: result.state,
        files_changed: result.changes?.length ?? 0,
        local_files: result.local_files,
        ...(result.failure ? { failure_kind: result.failure.kind } : {}),
      },
    },
    dataDir,
  );
}

function badArgs(message: string, json: boolean): void {
  if (json) console.log(JSON.stringify({ ok: false, state: 'error', error_class: 'bad_params', message }, null, 2));
  else console.error(message);
  process.exitCode = 2;
}

/**
 * A local file-system failure mid-sync (a locked file, a full disk) is an `error`
 * state with exit 1, in the same envelope as every other outcome. Pull writes its
 * sync point only after every file landed, so a failed pull is retried from the old one.
 */
async function guarded(json: boolean, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) console.log(JSON.stringify({ ok: false, state: 'error', error_class: 'local_io', message }, null, 2));
    else console.error(message);
    process.exitCode = 1;
  }
}

export function registerReportLedgerCommands(report: Command): void {
  const ledger = report
    .command('ledger')
    .description(
      "Sync a skill's run ledger (Report Max: the brand's hub URLs, commitments, claims register, watch items, " +
        'restatement baseline and period fragments) with the MixShift service, which holds the one true copy. ' +
        'The folder under ~/.mixshift/clients/<brand>/runs/ is a cache, so a fresh cloud session finds last ' +
        "period's ledger with one pull.",
    );

  const brandOpt = '--brand <slug>';
  const brandHelp = 'brand slug, as `mixshift brand list` shows it';
  const skillOpt = '--skill <skill_id>';
  const skillHelp = `the skill whose ledger to sync (${Object.keys(SKILL_LEDGERS).join(', ')})`;

  ledger
    .command('pull')
    .description(
      'Bring the service ledger into the local cache. When the service has none but this computer does, ' +
        'uploads the local ledger once as the first service copy, then proceeds. Never overwrites a file ' +
        'that changed on both sides (state diverged) unless --force, which keeps your local copies aside. ' +
        'States: pulled, up_to_date, migrated, absent, gateway_unavailable (exit 0); diverged, server_missing, ' +
        'local_corrupt, other_account, error (exit 1).',
    )
    .requiredOption(brandOpt, brandHelp)
    .option(skillOpt, skillHelp, DEFAULT_SKILL)
    .option('--force', 'on diverged files, take the service version (local copies kept aside)', false)
    .action(async (opts: LedgerOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const bad = checkLedgerArgs(opts);
      if (bad) return badArgs(bad, !!root.json);
      await guarded(!!root.json, async () => {
        const t0 = Date.now();
        const result = await pullLedger({
          brand: opts.brand,
          skill: opts.skill,
          client: clientFactory(root.dataDir),
          dataDirOverride: root.dataDir,
          force: !!opts.force,
        });
        const proceed = PULL_PROCEED.has(result.state);
        await emit('pull', result, opts.skill, proceed, t0, root.dataDir);
        printResult(result, !!root.json, proceed);
        process.exitCode = proceed ? 0 : 1;
      });
    });

  ledger
    .command('push')
    .description(
      'Save the local ledger to the service, carrying only the files changed since the last pull and the ' +
        'revision they were read at. A service copy that moved since then is refused (state conflict): pull, ' +
        'reconcile, push again. A file deleted locally stays on the service unless --prune. ' +
        'States: pushed, up_to_date, gateway_unavailable (exit 0); conflict, pull_first, local_corrupt, ' +
        'other_account, error (exit 1).',
    )
    .requiredOption(brandOpt, brandHelp)
    .option(skillOpt, skillHelp, DEFAULT_SKILL)
    .option('--prune', 'also delete on the service the files deleted locally since the last sync', false)
    .action(async (opts: LedgerOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const bad = checkLedgerArgs(opts);
      if (bad) return badArgs(bad, !!root.json);
      await guarded(!!root.json, async () => {
        const t0 = Date.now();
        const result = await pushLedger({
          brand: opts.brand,
          skill: opts.skill,
          client: clientFactory(root.dataDir),
          dataDirOverride: root.dataDir,
          prune: !!opts.prune,
        });
        const proceed = PUSH_PROCEED.has(result.state);
        await emit('push', result, opts.skill, proceed, t0, root.dataDir);
        printResult(result, !!root.json, proceed);
        process.exitCode = proceed ? 0 : 1;
      });
    });

  ledger
    .command('status')
    .description('Compare the local cache with the service ledger without changing either.')
    .requiredOption(brandOpt, brandHelp)
    .option(skillOpt, skillHelp, DEFAULT_SKILL)
    .action(async (opts: LedgerOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const bad = checkLedgerArgs(opts);
      if (bad) return badArgs(bad, !!root.json);
      await guarded(!!root.json, async () => {
        const t0 = Date.now();
        const status = await ledgerStatus({
          brand: opts.brand,
          skill: opts.skill,
          client: clientFactory(root.dataDir),
          dataDirOverride: root.dataDir,
        });
        await emit(
          'status',
          { state: status.service.available ? 'ok' : 'gateway_unavailable', local_files: status.local_files },
          opts.skill,
          true,
          t0,
          root.dataDir,
        );
        if (root.json) {
          console.log(JSON.stringify({ ok: true, ...status }, null, 2));
          return;
        }
        console.log(`local ledger: ${status.local_dir} (${status.local_files} files)`);
        console.log(`last synced revision: ${status.synced_revision ?? 'never'}`);
        if (status.other_account) console.log('synced under a different MixShift sign-in');
        console.log(
          status.service.available
            ? `service: revision ${status.service.revision ?? 'none (no ledger yet)'}, ${status.service.file_count} files`
            : `service: not available (${status.service.reason})`,
        );
        for (const p of status.local_edits) console.log(`  changed here since the last sync: ${p}`);
        for (const s of status.skipped) console.log(`  not synced (${s.reason}): ${s.path}`);
      });
    });
}
