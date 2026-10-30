/**
 * `mixshift context dsp-advertiser <show|assign>` (mx-ops#205).
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

import { readFile, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { createContextSyncClient } from '../lib/context-sync/client.js';
import type { ContextSyncClient } from '../lib/context-sync/client.js';
import { pull, push, type EngineOptions } from '../lib/context-sync/engine.js';
import { isSafeBrandSlug, localPathForKey } from '../lib/context-sync/local.js';
import {
  describeAccounts,
  isValidDspAdvertiserId,
  planDspAssignment,
  type AccountChoice,
} from '../lib/context-sync/dsp-advertiser.js';
import type { DspAdvertiserLookupResult } from '../lib/context-sync/types.js';
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
  | 'brand_not_found'
  | 'context_not_current'
  | 'no_context_file'
  | 'unreadable_yaml'
  | 'no_accounts'
  | 'account_required'
  | 'account_not_found'
  | 'existing_value_invalid'
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

  // ---- assign -------------------------------------------------------------
  group
    .command('assign')
    .description(
      'Declare a DSP advertiser on one brand the user named, so its DSP changes show on that ' +
        "brand's change log. Dry run by default; --commit writes the brand context, pushes it, " +
        'and reads the answer back. Refuses when another brand already declares the advertiser.',
    )
    .argument('<advertiser_id>', 'the DSP advertiser id (digits)')
    .requiredOption('--brand <slug>', 'the brand the USER named for this advertiser')
    .option('--account <seller_id>', "which of the brand's accounts (seller id) when it has several")
    .option('--commit', 'write the declaration and push it (default: dry run)', false)
    .action(
      async (
        advertiserId: string,
        opts: { brand: string; account?: string; commit?: boolean },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        const t0 = Date.now();
        const commit = opts.commit === true;
        const brand = opts.brand;

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
              payload: { result, commit, ...payload },
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

        try {
          if (!isValidDspAdvertiserId(advertiserId)) {
            await refuse('invalid_id', 'The DSP advertiser id must be digits only (up to 64).');
            return;
          }
          if (!isSafeBrandSlug(brand)) {
            await refuse('invalid_brand', `"${brand}" is not a valid brand slug.`);
            return;
          }

          // 1. Look first: never write a declaration we cannot prove is unambiguous.
          const client = createContextSyncClient({ dataDirOverride: root.dataDir });
          const found = await lookup(client, advertiserId);
          if (!found.ok) {
            await refuse(
              'lookup_unavailable',
              `${lookupFailureMessage(found)} Nothing was written: without the lookup there is no ` +
                'way to prove this declaration would not make the advertiser ambiguous.',
              { lookup_kind: found.kind },
            );
            return;
          }
          const others = found.brands.filter((b) => b !== brand);
          if (others.length > 0) {
            await refuse(
              'declared_by_other_brand',
              `DSP advertiser ${advertiserId} is already declared by ${others.join(', ')}. ` +
                'Nothing was written: a second declaration would make it ambiguous and its changes ' +
                'would stay unassigned. The user must decide which brand keeps it.',
              { declared_by: found.brands },
            );
            return;
          }
          if (found.brands.includes(brand)) {
            await finish('already_assigned', 'ok');
            emit(
              root,
              {
                status: 'ok',
                result: 'already_assigned',
                advertiser_id: advertiserId,
                brand,
                commit,
                message: `DSP advertiser ${advertiserId} is already declared by ${brand}. Nothing to do.`,
              },
              [`already_assigned: DSP advertiser ${advertiserId} is already declared by ${brand}. Nothing to do.`],
            );
            return;
          }

          // 2. Make sure the brand's context is current locally.
          const setup = await deps.resolveBrandsAndManifest(brand, root);
          if (!setup) {
            // resolveBrandsAndManifest already printed the error and set exit 1.
            await finish('refused', 'failed', { reason: 'brand_not_found' });
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

          // 3. Plan the edit.
          const plan = planDspAssignment(content, advertiserId, opts.account);
          if (!plan.ok) {
            await refuse(plan.reason, plan.message, plan.accounts ? { accounts: plan.accounts } : {});
            return;
          }

          const accountSummary = describeAccounts([plan.account]).trim().replace(/^- /, '');
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
                advertiser_id: advertiserId,
                brand,
                account: plan.account,
                edit: plan.edit,
                commit: false,
                removed_lines: plan.removed_lines,
                added_lines: plan.added_lines,
                message: 'Dry run: nothing was written. Re-run with --commit once the user confirms.',
              },
              [
                `Dry run: declare DSP advertiser ${advertiserId} on brand ${brand}, account ${accountSummary}.`,
                plan.changed ? 'The context.yaml line(s) that would change:' : 'The file already declares it; a commit would only push.',
                ...changeLines,
                'Nothing was written. Re-run with --commit once the user confirms.',
              ],
            );
            return;
          }

          // 4. Commit: write, push that one brand, read back.
          if (plan.changed) await writeFile(path, plan.content, 'utf8');
          const pushed = await push(brand, setup.engineOptions);
          const pushProblem = !pushed.ok
            ? pushed.message
            : pushed.reports
                .filter((r) => r.action === 'conflict' || r.action === 'error')
                .map((r) => `${r.key}: ${r.action}${r.detail ? ` (${r.detail})` : ''}`)
                .join('; ');
          if (pushProblem) {
            await finish('push_failed', 'failed');
            const message =
              `The declaration was written to ${brand}'s local context.yaml but the push did not go through: ${pushProblem}. ` +
              'It is not shared yet and the service does not know about it. Run `mixshift context status`, ' +
              'resolve any conflict, then run `mixshift context push --brand ' + brand + '`.';
            if (root.json) {
              process.stdout.write(
                JSON.stringify({
                  status: 'error',
                  kind: 'push_failed',
                  result: 'push_failed',
                  advertiser_id: advertiserId,
                  brand,
                  commit: true,
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
          let readbackNote: string;
          if (!back.ok) {
            readbackNote = `Pushed, but the read-back lookup failed (${back.kind}), so it is not confirmed that the service resolves the advertiser to ${brand}.`;
          } else {
            readbackBrands = back.brands;
            verified = back.brands.length === 1 && back.brands[0] === brand;
            readbackNote = verified
              ? `Confirmed: the service now resolves DSP advertiser ${advertiserId} to ${brand} only.`
              : `Pushed, but the service resolves DSP advertiser ${advertiserId} to ${back.brands.length === 0 ? 'no brand yet' : back.brands.join(', ')}, not ${brand} alone. Its changes stay unassigned until that is fixed.`;
          }
          const ok = back.ok ? verified === true : true;
          await finish('committed', ok ? 'ok' : 'failed', { edit: plan.edit, verified });
          emit(
            root,
            {
              status: ok ? 'ok' : 'error',
              result: 'committed',
              advertiser_id: advertiserId,
              brand,
              account: plan.account,
              edit: plan.edit,
              commit: true,
              pushed: true,
              verified,
              readback_brands: readbackBrands,
              message: readbackNote,
            },
            [`Declared DSP advertiser ${advertiserId} on brand ${brand}, account ${accountSummary}.`, readbackNote],
          );
          if (!ok) process.exitCode = 1;
        } catch (err) {
          fail(root, 'unknown', err instanceof Error ? err.message : String(err));
        }
      },
    );
}

export type { AccountChoice };
