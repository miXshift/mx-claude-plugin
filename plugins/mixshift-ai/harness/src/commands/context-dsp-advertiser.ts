/**
 * `mixshift context dsp-advertiser <show|assign|unassign>` (mx-ops#205).
 *
 * The MixShift service files a DSP change on a brand only when exactly one
 * brand's context.yaml declares the advertiser as a quoted digit string.
 *   show   asks the service which brand (if any) declares an advertiser.
 *   assign declares it on ONE brand the user named, through the normal
 *          context push, and reads the answer back. Dry run by default.
 * Nothing here guesses: `assign` never runs without --brand, refuses when
 * another brand already declares the advertiser, and refuses when the lookup
 * cannot prove the write is unambiguous. Both commands print one compact JSON
 * object (last stdout line) under --json and exit 0 for every non-error answer.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { createContextSyncClient } from '../lib/context-sync/client.js';
import type { ContextSyncClient } from '../lib/context-sync/client.js';
import { computeStatus, pull, push, type EngineOptions } from '../lib/context-sync/engine.js';
import { isSafeBrandSlug, localPathForKey } from '../lib/context-sync/local.js';
import {
  describeAccounts,
  isValidDspAdvertiserId,
  planDspAssignment,
  planDspUnassignment,
  type AccountChoice,
} from '../lib/context-sync/dsp-advertiser.js';
import type { DspAdvertiserLookupResult } from '../lib/context-sync/types.js';
import { loadCredentials } from '../lib/auth/credentials.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

type ResolveBrands = (
  brandOpt: string | undefined,
  root: RootOptions,
) => Promise<{ brands: string[]; engineOptions: EngineOptions } | null>;

export type AssignRefusalReason =
  | 'invalid_id'
  | 'invalid_brand'
  | 'declared_by_other_brand'
  | 'lookup_unavailable'
  | 'context_not_current'
  | 'context_has_unpublished_changes'
  | 'unattended_credential'
  | 'no_context_file'
  | 'unreadable_yaml'
  | 'no_accounts'
  | 'unexpected_change'
  | 'existing_context_invalid'
  | 'expect_without_commit'
  | 'plan_changed'
  | 'account_not_found'
  | 'flow_style_account'
  | 'existing_value_invalid'
  | 'result_not_recognized'
  | 'result_invalid';

function emit(root: RootOptions, obj: Record<string, unknown>, human: string[]): void {
  if (root.json) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } else {
    process.stdout.write(human.join('\n') + '\n');
  }
}

function fail(root: RootOptions, kind: string, message: string, extra: Record<string, unknown> = {}): void {
  if (root.json) {
    process.stdout.write(JSON.stringify({ status: 'error', kind, message, ...extra }) + '\n');
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}

function lookupFailureMessage(r: Extract<DspAdvertiserLookupResult, { ok: false }>): string {
  return r.kind === 'unsupported'
    ? 'This MixShift service does not support the DSP advertiser lookup yet. Try again after the service is updated.'
    : r.friendly;
}

async function lookup(
  client: ContextSyncClient,
  advertiserId: string,
): Promise<DspAdvertiserLookupResult> {
  if (!client.lookupDspAdvertiser) {
    return {
      ok: false,
      kind: 'unsupported',
      message: 'lookup not available',
      friendly: 'This MixShift service does not support the DSP advertiser lookup yet.',
    };
  }
  return client.lookupDspAdvertiser(advertiserId);
}

export function registerDspAdvertiserCommands(
  context: Command,
  deps: { resolveBrandsAndManifest: ResolveBrands },
): void {
  const group = context
    .command('dsp-advertiser')
    .description(
      'Which brand a DSP advertiser belongs to. The MixShift service files a DSP change ' +
        "on a brand's change log only when exactly one brand declares the advertiser.",
    );

  // ---- show ---------------------------------------------------------------
  group
    .command('show')
    .description(
      'Report which brand declares a DSP advertiser: unassigned (none), assigned (one brand), ' +
        'or conflict (several). Exit 0 for all three.',
    )
    .argument('<advertiser_id>', 'the DSP advertiser id (digits)')
    .action(async (advertiserId: string, _opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const t0 = Date.now();
      if (!isValidDspAdvertiserId(advertiserId)) {
        fail(root, 'invalid_id', 'The DSP advertiser id must be digits only (up to 64).');
        return;
      }
      try {
        const client = createContextSyncClient({ dataDirOverride: root.dataDir });
        const r = await lookup(client, advertiserId);
        if (!r.ok) {
          await track(
            {
              event_name: EventName.ContextDspAdvertiserShown,
              outcome: 'failed',
              duration_ms: Date.now() - t0,
              payload: { failure_kind: r.kind },
            },
            root.dataDir,
          );
          fail(root, r.kind, lookupFailureMessage(r));
          return;
        }
        const state = r.brands.length === 0 ? 'unassigned' : r.brands.length === 1 ? 'assigned' : 'conflict';
        await track(
          {
            event_name: EventName.ContextDspAdvertiserShown,
            outcome: 'ok',
            duration_ms: Date.now() - t0,
            payload: { state, brand_count: r.brands.length },
          },
          root.dataDir,
        );
        const human =
          state === 'unassigned'
            ? [`unassigned: no brand declares DSP advertiser ${advertiserId}. Its changes stay unassigned.`]
            : state === 'assigned'
              ? [`assigned: DSP advertiser ${advertiserId} belongs to brand ${r.brands[0]}.`]
              : [
                  `conflict: DSP advertiser ${advertiserId} is declared by several brands: ${r.brands.join(', ')}.`,
                  'Its changes stay unassigned until only one brand declares it. Ask the user which brand keeps it.',
                ];
        emit(
          root,
          {
            status: 'ok',
            advertiser_id: advertiserId,
            state,
            brand: state === 'assigned' ? r.brands[0] : null,
            brands: r.brands,
          },
          human,
        );
      } catch (err) {
        fail(root, 'unknown', err instanceof Error ? err.message : String(err));
      }
    });

  // ---- assign / unassign --------------------------------------------------
  group
    .command('assign')
    .description(
      'Declare a DSP advertiser on one brand the user named, so its DSP changes show on that ' +
        "brand's change log. Dry run by default; --commit writes the brand context, publishes " +
        'only context.yaml, and reads the answer back. Refuses when another brand already ' +
        'declares the advertiser.',
    )
    .argument('<advertiser_id>', 'the DSP advertiser id (digits)')
    .requiredOption('--brand <slug>', 'the brand the USER named for this advertiser')
    .option('--account <seller_id>', "which of the brand's accounts (seller id) when it has several")
    .option('--commit', 'write the declaration and publish it (default: dry run)', false)
    .option('--expect <plan_hash>', 'with --commit: refuse unless the plan still hashes to this (from the dry run)')
    .action(
      async (
        advertiserId: string,
        opts: { brand: string; account?: string; commit?: boolean; expect?: string },
        cmd: Command,
      ) => runWrite('assign', advertiserId, opts, cmd, deps),
    );

  group
    .command('unassign')
    .description(
      'Remove a DSP advertiser from one brand the user named: the way out of a conflict or a ' +
        'wrong pick. Dry run by default; --commit writes, publishes only context.yaml, and ' +
        'reads the answer back. A brand that does not declare it is a no-op.',
    )
    .argument('<advertiser_id>', 'the DSP advertiser id (digits)')
    .requiredOption('--brand <slug>', 'the brand the USER named')
    .option('--commit', 'remove the declaration and publish it (default: dry run)', false)
    .option('--expect <plan_hash>', 'with --commit: refuse unless the plan still hashes to this (from the dry run)')
    .action(async (advertiserId: string, opts: { brand: string; commit?: boolean; expect?: string }, cmd: Command) =>
      runWrite('unassign', advertiserId, opts, cmd, deps),
    );
}

/** A service credential is for unattended runs: it must never write a declaration. */
async function serviceCredentialActive(dataDir: string | undefined): Promise<boolean> {
  try {
    const { credentials } = await loadCredentials(dataDir);
    return !credentials?.datahub && Boolean(credentials?.service);
  } catch {
    return false;
  }
}

async function runWrite(
  op: 'assign' | 'unassign',
  advertiserId: string,
  opts: { brand: string; account?: string; commit?: boolean; expect?: string },
  cmd: Command,
  deps: { resolveBrandsAndManifest: ResolveBrands },
): Promise<void> {
  const root = cmd.optsWithGlobals<RootOptions>();
  const t0 = Date.now();
  const commit = opts.commit === true;
  const brand = opts.brand;
  const assigning = op === 'assign';

  const finish = async (
    result: string,
    outcome: 'ok' | 'failed',
    payload: Record<string, unknown> = {},
  ): Promise<void> => {
    await track(
      {
        event_name: EventName.ContextDspAdvertiserAssigned,
        outcome,
        duration_ms: Date.now() - t0,
        payload: { op, result, commit, ...payload },
      },
      root.dataDir,
    );
  };
  const refuse = async (
    reason: AssignRefusalReason,
    message: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    await finish('refused', 'failed', { reason });
    if (root.json) {
      process.stdout.write(
        JSON.stringify({
          status: 'refused',
          reason,
          op,
          advertiser_id: advertiserId,
          brand,
          commit,
          message,
          ...extra,
        }) + '\n',
      );
    } else {
      process.stderr.write(`refused: ${message}\n`);
    }
    process.exitCode = 1;
  };
  const noop = async (result: 'already_assigned' | 'not_declared', message: string): Promise<void> => {
    await finish(result, 'ok');
    emit(
      root,
      { status: 'ok', result, op, advertiser_id: advertiserId, brand, commit, message },
      [`${result}: ${message}`],
    );
  };

  try {
    if (!isValidDspAdvertiserId(advertiserId)) {
      await refuse('invalid_id', 'The DSP advertiser id must be digits only (up to 64).');
      return;
    }
    if (!isSafeBrandSlug(brand)) {
      await refuse('invalid_brand', `"${brand}" is not a valid brand slug.`);
      return;
    }
    if (opts.expect !== undefined && !commit) {
      await refuse(
        'expect_without_commit',
        '--expect only applies together with --commit (it pins the change to the dry run the user saw).',
      );
      return;
    }
    if (commit && (await serviceCredentialActive(root.dataDir))) {
      await refuse(
        'unattended_credential',
        'This session is signed in with a service credential (for unattended runs), which must ' +
          'not change which brand owns a DSP advertiser. Sign in as a person (`mixshift auth login`) ' +
          'and run it again. A dry run is still allowed.',
      );
      return;
    }

    // 1. Look first: never write a change we cannot prove is unambiguous.
    const client = createContextSyncClient({ dataDirOverride: root.dataDir });
    const found = await lookup(client, advertiserId);
    if (!found.ok) {
      await refuse(
        'lookup_unavailable',
        `${lookupFailureMessage(found)} Nothing was written: without the lookup there is no ` +
          'way to prove this change would not leave the advertiser ambiguous.',
        { lookup_kind: found.kind },
      );
      return;
    }
    if (assigning) {
      const others = found.brands.filter((b) => b !== brand);
      if (others.length > 0) {
        await refuse(
          'declared_by_other_brand',
          `DSP advertiser ${advertiserId} is already declared by ${others.join(', ')}. ` +
            'Nothing was written: a second declaration would make it ambiguous and its changes ' +
            'would stay unassigned. The user must decide which brand keeps it (`unassign` removes ' +
            'it from the one that does not own it; a retired brand still counts).',
          { declared_by: found.brands },
        );
        return;
      }
      if (found.brands.includes(brand)) {
        await noop('already_assigned', `DSP advertiser ${advertiserId} is already declared by ${brand}. Nothing to do.`);
        return;
      }
    } else if (!found.brands.includes(brand)) {
      await noop('not_declared', `Brand ${brand} does not declare DSP advertiser ${advertiserId}. Nothing to do.`);
      return;
    }

    // 2. Make sure the brand's context is current locally (server updates only).
    const setup = await deps.resolveBrandsAndManifest(brand, root);
    if (!setup) {
      // The error is already printed and exit code set: the brand is unknown or
      // the service could not be reached to check it.
      await finish('refused', 'failed', { reason: 'brand_check_failed' });
      return;
    }
    const pulled = await pull(brand, setup.engineOptions);
    if (!pulled.ok) {
      await refuse('context_not_current', `Could not bring ${brand}'s context up to date: ${pulled.message}`);
      return;
    }
    const bad = pulled.reports.find(
      (r) => r.key === 'context' && (r.action === 'conflict' || r.action === 'error'),
    );
    if (bad) {
      await refuse(
        'context_not_current',
        `${brand}'s context.yaml is not in step with the shared copy (${bad.action}${bad.detail ? `: ${bad.detail}` : ''}). ` +
          'Resolve that first (`mixshift context status`); nothing was written.',
      );
      return;
    }

    // Fresh manifest from here on: the one the command fetched predates the pull.
    const engineOptions: EngineOptions = { ...setup.engineOptions };
    delete engineOptions.manifest;

    // 3. context.yaml must match the shared copy, so the dry-run diff is exactly
    //    what gets published.
    const status = await computeStatus(brand, engineOptions);
    if (!status.ok) {
      await refuse('context_not_current', `Could not compare ${brand}'s context with the shared copy: ${status.message}`);
      return;
    }
    const verdict = status.docs.find((d) => d.key === 'context')?.verdict;
    if (verdict === 'local-ahead' || verdict === 'local-only') {
      await refuse(
        'context_has_unpublished_changes',
        `${brand}'s context.yaml has changes on this computer that are not published yet. Ask the ` +
          'user to review them and publish (`mixshift context push --brand ' + brand + '`) or discard ' +
          'them first, so this change publishes only what was shown. Nothing was written.',
      );
      return;
    }
    if (verdict !== undefined && verdict !== 'in-sync') {
      await refuse(
        'context_not_current',
        `${brand}'s context.yaml is not in step with the shared copy (${verdict}). Run ` +
          '`mixshift context status` and resolve it first; nothing was written.',
      );
      return;
    }

    const path = localPathForKey(brand, 'context', root.dataDir);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      await refuse(
        'no_context_file',
        `${brand} has no context.yaml on this computer. Set the brand up first (the mx-brand-context skill).`,
      );
      return;
    }

    // 4. Plan the edit and prove it the way the service will read it.
    const plan = assigning
      ? planDspAssignment(content, advertiserId, opts.account)
      : planDspUnassignment(content, advertiserId);
    if (!plan.ok) {
      await refuse(plan.reason, plan.message, plan.accounts ? { accounts: plan.accounts } : {});
      return;
    }
    const planHash = createHash('sha256').update(plan.content).digest('hex').slice(0, 12);
    if (commit && opts.expect !== undefined && opts.expect !== planHash) {
      await refuse(
        'plan_changed',
        'The planned change is no longer the one the user saw (the file or the shared copy changed ' +
          'since the dry run). Nothing was written. Run the dry run again, show it, and confirm again.',
        { plan_hash: planHash },
      );
      return;
    }
    const accountSummary = plan.account ? describeAccounts([plan.account]).trim().replace(/^- /, '') : '';
    const verb = assigning ? 'declare' : 'remove';
    const changeLines = [
      ...plan.removed_lines.map((l) => `- ${l}`),
      ...plan.added_lines.map((l) => `+ ${l}`),
    ];

    if (!commit) {
      await finish('dry_run', 'ok', { edit: plan.edit });
      emit(
        root,
        {
          status: 'ok',
          result: 'dry_run',
          op,
          advertiser_id: advertiserId,
          brand,
          account: plan.account,
          edit: plan.edit,
          commit: false,
          removed_lines: plan.removed_lines,
          added_lines: plan.added_lines,
          plan_hash: planHash,
          message:
            'Dry run: pulled any server updates to this brand\'s context and wrote nothing else. ' +
            'Re-run with --commit once the user confirms.',
        },
        [
          `Dry run: ${verb} DSP advertiser ${advertiserId} on brand ${brand}${accountSummary ? `, account ${accountSummary}` : ''}.`,
          plan.changed ? 'The context.yaml line(s) that would change:' : 'No line would change; a commit would only read back.',
          ...changeLines,
          "Pulled any server updates to this brand's context and wrote nothing else. Re-run with --commit once the user confirms.",
        ],
      );
      return;
    }

    // 5. Commit: write, publish only context.yaml, read back.
    if (plan.changed) await writeFile(path, plan.content, 'utf8');
    const pushed = await push(brand, { ...engineOptions, onlyKeys: ['context'] });
    const ctxReport = pushed.ok ? pushed.reports.find((r) => r.key === 'context') : undefined;
    const okActions = new Set(['pushed', 'created', 'noop', 'up-to-date']);
    const pushProblem = !pushed.ok
      ? pushed.message
      : !ctxReport
        ? 'context.yaml was not published'
        : okActions.has(ctxReport.action)
          ? ''
          : `${ctxReport.action}${ctxReport.detail ? ` (${ctxReport.detail})` : ''}`;
    if (pushProblem) {
      let rolledBack = false;
      if (plan.changed) {
        try {
          if ((await readFile(path, 'utf8')) === plan.content) {
            await writeFile(path, content, 'utf8');
            rolledBack = true;
          }
        } catch {
          // leave the file as is; the message below says so
        }
      }
      await finish('push_failed', 'failed', { rolled_back: rolledBack });
      const message =
        `context.yaml may not have been published: ${pushProblem}. Check with \`mixshift context status\`. ` +
        (rolledBack
          ? 'The local file was put back as it was. Run the command again: it re-pulls and re-checks first.'
          : plan.changed
            ? 'The local file still holds the edit (it changed while publishing). Run `mixshift context status` to see where it stands.'
            : 'Run `mixshift context status` to see where it stands.');
      if (root.json) {
        process.stdout.write(
          JSON.stringify({
            status: 'error',
            kind: 'push_failed',
            result: 'push_failed',
            op,
            advertiser_id: advertiserId,
            brand,
            commit: true,
            rolled_back: rolledBack,
            message,
          }) + '\n',
        );
      } else {
        process.stderr.write(`error: ${message}\n`);
      }
      process.exitCode = 1;
      return;
    }

    const back = await lookup(createContextSyncClient({ dataDirOverride: root.dataDir }), advertiserId);
    let verified: boolean | null = null;
    let readbackBrands: string[] | null = null;
    let note: string;
    if (!back.ok) {
      note = `Published, but the read-back lookup failed (${back.kind}), so it is not confirmed how the service now resolves the advertiser.`;
    } else {
      readbackBrands = back.brands;
      if (assigning) {
        verified = back.brands.length === 1 && back.brands[0] === brand;
        note = verified
          ? `Confirmed: the service now resolves DSP advertiser ${advertiserId} to ${brand} only.`
          : back.brands.includes(brand)
            ? `Published, but ${back.brands.join(' and ')} now both declare DSP advertiser ${advertiserId} (another brand claimed it at the same moment). It now resolves to no brand and its changes stay unassigned. Ask the user which brand owns it, then run unassign on the other one.`
            : `Published, but the service does not resolve DSP advertiser ${advertiserId} to ${brand} yet (it resolves to ${back.brands.length === 0 ? 'no brand' : back.brands.join(', ')}). Its changes stay unassigned until that is fixed.`;
      } else {
        verified = !back.brands.includes(brand);
        note = verified
          ? `Confirmed: ${brand} no longer declares DSP advertiser ${advertiserId}. It now resolves to ${back.brands.length === 0 ? 'no brand' : back.brands.join(', ')}.`
          : `Published, but the service still shows ${brand} declaring DSP advertiser ${advertiserId}.`;
      }
    }
    const ok = back.ok ? verified === true : true;
    await finish('committed', ok ? 'ok' : 'failed', { edit: plan.edit, verified });
    emit(
      root,
      {
        status: ok ? 'ok' : 'error',
        result: 'committed',
        op,
        advertiser_id: advertiserId,
        brand,
        account: plan.account,
        edit: plan.edit,
        commit: true,
        removed_lines: plan.removed_lines,
        added_lines: plan.added_lines,
        plan_hash: planHash,
        pushed: true,
        verified,
        readback_brands: readbackBrands,
        message: note,
      },
      [`${assigning ? 'Declared' : 'Removed'} DSP advertiser ${advertiserId} ${assigning ? 'on' : 'from'} brand ${brand}${accountSummary ? `, account ${accountSummary}` : ''}.`, note],
    );
    if (!ok) process.exitCode = 1;
  } catch (err) {
    fail(root, 'unknown', err instanceof Error ? err.message : String(err));
  }
}

export type { AccountChoice };
