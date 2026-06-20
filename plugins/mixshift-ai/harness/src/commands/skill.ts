/**
 * `mixshift skill ...` — OCL (Objective Level Configuration) management
 * and the apply-gate.
 *
 * Subcommands:
 *   - `config <skill-id> --brand <slug>`     show/edit/reset per-brand OCL
 *   - `apply  <skill-id> --brand <slug>`     dry-run apply (writes applied.json)
 *
 * The `config` subcommand has three modes:
 *   1. Default (no extra flags): emit the confirmation card. In chat-mode
 *      output (default), prints text Claude reads aloud + offers as the
 *      next user prompt. In `--json` mode, emits structured payload Claude
 *      can parse to drive a richer chat UX.
 *   2. `--apply <decision-json>`: take a structured decision (action,
 *      edits, save) and persist if appropriate. Returns the effective
 *      config + did_persist boolean.
 *   3. `--reset`: wipe the skill's block (with confirmation in interactive
 *      mode; `--yes` for non-interactive).
 *
 * The confirm-on-run flow IS this command — every `mixshift skill run <id>`
 * delegates to it as a pre-step. We don't ship a separate `wizard` command
 * because there's no separate wizard concept anymore.
 */

import type { Command } from 'commander';
import { loadSkillManifest } from '../lib/prefetch/manifest.js';
import { extractCalibration } from '../lib/calibration/manifest-schema.js';
import {
  prepareConfirmation,
  applyConfirmation,
  selectCaptureCandidates,
  type ConfirmationDecision,
} from '../lib/calibration/confirm-flow.js';
import {
  renderConfirmationCard,
  renderCaptureCandidates,
  indexConfirmationEntries,
  joinCard,
  renderValidationIssues,
  renderPersistenceFooter,
} from '../lib/calibration/render-chat.js';
import { resetSkillConfig } from '../lib/calibration/brand-config.js';
import { readIndex } from '../lib/clients/index.js';
import { resolveBrandName } from '../lib/clients/resolve-brand.js';
import type { IndexBrand } from '../lib/clients/index-schema.js';
import { track, EventName } from '../lib/telemetry/index.js';
import { runAppliedPath } from '../lib/paths/resolve.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerSkillCommands(program: Command): void {
  const skill = program
    .command('skill')
    .description(
      'Per-skill OCL (Objective Level Configuration) management and ' +
        'the apply-gate. See `mixshift skill config --help` and ' +
        '`mixshift skill apply --help`.',
    );

  // ----------------------------------------------------------------------
  // `mixshift skill config <skill-id>`
  // ----------------------------------------------------------------------
  skill
    .command('config <skill-id>')
    .description(
      'Show or edit the per-brand calibration for one skill. Default ' +
        'prints the confirmation card. Pair with --apply to persist edits, ' +
        '--reset to wipe, or --json to emit a machine-readable payload.',
    )
    .requiredOption('--brand <slug>', 'brand slug from the registry')
    .option(
      '--apply <decision>',
      'apply a confirmation decision (JSON). Schema: ' +
        '{"action":"confirm"} | {"action":"edit","edits":{},"save":true} | ' +
        '{"action":"cancel"}',
    )
    .option('--reset', 'reset the per-brand block (wipes user values)', false)
    .option(
      '--yes',
      'skip the interactive confirmation for --reset',
      false,
    )
    .option(
      '--show',
      'read-only inspect — alias for the default action when no flags are passed',
      false,
    )
    .option(
      '--missing',
      'list the unset-but-valuable fields (the "improve this skill" surface) ' +
        'instead of the full confirmation card',
      false,
    )
    .action(
      async (
        skillId: string,
        opts: {
          brand: string;
          apply?: string;
          reset: boolean;
          yes: boolean;
          show: boolean;
          missing: boolean;
        },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          // Resolve brand once — used by every mode.
          const brandRow = await resolveBrandRow(opts.brand, root.dataDir);
          if (brandRow === null) {
            return emitError(
              root.json,
              `Brand "${opts.brand}" not found in the registry. Run \`node dist/cli.js brand list\` to see available brands. The resolver accepts slugs, display names, acronyms, and prefixes.`,
            );
          }

          // --reset path
          if (opts.reset) {
            return await runReset({
              skillId,
              brandSlug: brandRow.slug,
              brandName: brandRow.display_name,
              yes: opts.yes,
              json: root.json,
              dataDir: root.dataDir,
            });
          }

          // Common: load manifest + calibration
          const manifest = await loadSkillManifest(skillId);
          const calibration = extractCalibration(manifest);
          if (!calibration) {
            // Skill has no calibration block — nothing to configure.
            if (root.json) {
              process.stdout.write(
                JSON.stringify(
                  {
                    status: 'ok',
                    skill_id: skillId,
                    has_calibration: false,
                    message: 'Skill has no calibration manifest.',
                  },
                  null,
                  2,
                ) + '\n',
              );
              return;
            }
            process.stdout.write(
              `\n${manifest.display_name} has no calibration to configure. ` +
                `It runs with whatever the skill code defines internally.\n\n`,
            );
            return;
          }

          // --missing path: "improve this skill" read-only surface
          if (opts.missing) {
            return await runMissing({
              skillId,
              brandSlug: brandRow.slug,
              brandName: brandRow.display_name,
              manifestDisplayName: manifest.display_name,
              calibration,
              json: root.json,
              dataDir: root.dataDir,
            });
          }

          // --apply path (decision-driven, non-interactive)
          if (opts.apply) {
            return await runApplyDecision({
              skillId,
              brandSlug: brandRow.slug,
              brandName: brandRow.display_name,
              manifest,
              calibration,
              decisionJson: opts.apply,
              json: root.json,
              dataDir: root.dataDir,
            });
          }

          // Default / --show path: emit confirmation payload
          return await runShow({
            skillId,
            brandSlug: brandRow.slug,
            brandName: brandRow.display_name,
            manifestDisplayName: manifest.display_name,
            calibration,
            json: root.json,
            dataDir: root.dataDir,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return emitError(root.json, message);
        }
      },
    );

  // ----------------------------------------------------------------------
  // `mixshift skill apply <skill-id>` — apply-gate (dry-run for 0.5.0)
  // ----------------------------------------------------------------------
  skill
    .command('apply <skill-id>')
    .description(
      'Apply-gate: reconciles suggestions.json + overrides.json from a run ' +
        'and writes applied.json. In 0.5.0 this is dry-run only (status: ' +
        '"dry_run" per row). Real writes ship when the Amazon write MCP/API ' +
        'lands — same contract, status flips to "applied" | "failed".',
    )
    .requiredOption('--brand <slug>', 'brand slug from the registry')
    .requiredOption('--run <date>', 'run date directory under runs/<skill>/')
    .option(
      '--dry-run',
      'write applied.json with status="dry_run" (default for 0.5.0)',
      true,
    )
    .action(
      async (
        skillId: string,
        opts: { brand: string; run: string; dryRun: boolean },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          const brandRow = await resolveBrandRow(opts.brand, root.dataDir);
          if (brandRow === null) {
            return emitError(
              root.json,
              `Brand "${opts.brand}" not in the registry.`,
            );
          }

          await track(
            {
              event_name: EventName.SkillApplyAttempted,
              skill_id: skillId,
              payload: {
                brand_slug: brandRow.slug,
                run_date: opts.run,
                dry_run: opts.dryRun,
              },
            },
            root.dataDir,
          );

          const result = await applyDryRun({
            skillId,
            brandSlug: brandRow.slug,
            runDate: opts.run,
            dataDir: root.dataDir,
          });

          await track(
            {
              event_name: EventName.SkillApplied,
              skill_id: skillId,
              outcome: 'ok',
              row_count: result.row_count,
              payload: {
                brand_slug: brandRow.slug,
                run_date: opts.run,
                dry_run: opts.dryRun,
                rows_with_overrides: result.rows_with_overrides,
              },
            },
            root.dataDir,
          );

          if (root.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  status: 'ok',
                  applied_to: result.applied_path,
                  row_count: result.row_count,
                  rows_with_overrides: result.rows_with_overrides,
                  dry_run: opts.dryRun,
                },
                null,
                2,
              ) + '\n',
            );
            return;
          }
          process.stdout.write(
            `\n✓ Apply-gate (dry-run) wrote ${result.row_count} row(s) to\n` +
              `  ${result.applied_path}\n` +
              `  (${result.rows_with_overrides} had user overrides)\n` +
              `\nReal Amazon writes will land once the write MCP/API is wired. Same contract.\n\n`,
          );
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return emitError(root.json, message);
        }
      },
    );
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function runShow(args: {
  skillId: string;
  brandSlug: string;
  brandName: string;
  manifestDisplayName: string;
  calibration: NonNullable<ReturnType<typeof extractCalibration>>;
  json?: boolean;
  dataDir?: string;
}): Promise<void> {
  const payload = await prepareConfirmation({
    brandSlug: args.brandSlug,
    brandName: args.brandName,
    skillId: args.skillId,
    manifest: args.calibration,
    dataDirOverride: args.dataDir,
  });
  indexConfirmationEntries(payload);

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        { status: 'ok', confirmation: payload },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const card = renderConfirmationCard(payload, {
    skill_display_name: args.manifestDisplayName,
  });
  process.stdout.write('\n' + joinCard(card) + '\n\n');
  return;
}

async function runMissing(args: {
  skillId: string;
  brandSlug: string;
  brandName: string;
  manifestDisplayName: string;
  calibration: NonNullable<ReturnType<typeof extractCalibration>>;
  json?: boolean;
  dataDir?: string;
}): Promise<void> {
  const payload = await prepareConfirmation({
    brandSlug: args.brandSlug,
    brandName: args.brandName,
    skillId: args.skillId,
    manifest: args.calibration,
    dataDirOverride: args.dataDir,
  });
  const candidates = selectCaptureCandidates(payload);

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          status: 'ok',
          skill_id: args.skillId,
          brand_slug: args.brandSlug,
          candidate_count: candidates.length,
          candidates: candidates.map((c) => ({
            id: c.field.id,
            target: c.target,
            context_path: c.context_path ?? null,
            reason: c.reason,
            required: c.field.required,
          })),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const text = renderCaptureCandidates(candidates, {
    skillId: args.skillId,
    skillDisplayName: args.manifestDisplayName,
    brandName: args.brandName,
    brandSlug: args.brandSlug,
  });
  process.stdout.write('\n' + text + '\n\n');
}

async function runApplyDecision(args: {
  skillId: string;
  brandSlug: string;
  brandName: string;
  manifest: { display_name: string };
  calibration: NonNullable<ReturnType<typeof extractCalibration>>;
  decisionJson: string;
  json?: boolean;
  dataDir?: string;
}): Promise<void> {
  let decision: ConfirmationDecision;
  try {
    decision = JSON.parse(args.decisionJson) as ConfirmationDecision;
  } catch (err) {
    return emitError(
      args.json,
      `--apply must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const payload = await prepareConfirmation({
    brandSlug: args.brandSlug,
    brandName: args.brandName,
    skillId: args.skillId,
    manifest: args.calibration,
    dataDirOverride: args.dataDir,
  });
  const result = await applyConfirmation(payload, decision, {
    dataDirOverride: args.dataDir,
  });

  // Telemetry for the decision
  if (decision.action === 'confirm') {
    await track(
      {
        event_name: EventName.SkillCalibrationConfirmed,
        skill_id: args.skillId,
        outcome: result.status === 'ok' ? 'ok' : 'failed',
        payload: {
          brand_slug: args.brandSlug,
          had_edits: false,
        },
      },
      args.dataDir,
    );
  } else if (decision.action === 'edit') {
    await track(
      {
        event_name: EventName.SkillCalibrationEdited,
        skill_id: args.skillId,
        outcome: result.status === 'ok' ? 'ok' : 'failed',
        payload: {
          brand_slug: args.brandSlug,
          edit_count: Object.keys(decision.edits).length,
          persisted: result.did_persist,
        },
      },
      args.dataDir,
    );
  }

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          status: result.status,
          effective_config: result.effective_config,
          did_persist: result.did_persist,
          saved_to: result.saved_to,
          validation_issues: result.validation_issues,
          // Shared fields just captured (the "I learned X" surface) so the
          // JSON-driven caller (Claude in chat) can acknowledge them, matching
          // the human CLI footer (renderPersistenceFooter).
          captured: result.captured ?? [],
        },
        null,
        2,
      ) + '\n',
    );
    if (result.status === 'validation_failed') process.exitCode = 4;
    return;
  }

  if (result.status === 'validation_failed') {
    const fieldsById = new Map(payload.fields.map((e) => [e.field.id, e.field]));
    process.stderr.write('\n' + renderValidationIssues(result, fieldsById) + '\n\n');
    process.exitCode = 4;
    return;
  }
  if (result.status === 'cancelled') {
    process.stdout.write('\nCancelled. No changes saved.\n\n');
    return;
  }
  const footer = renderPersistenceFooter(
    result,
    args.brandName,
    args.manifest.display_name,
  );
  if (footer) process.stdout.write(`\n${footer}\n\n`);
  return;
}

async function runReset(args: {
  skillId: string;
  brandSlug: string;
  brandName: string;
  yes: boolean;
  json?: boolean;
  dataDir?: string;
}): Promise<void> {
  if (!args.yes && !args.json) {
    process.stdout.write(
      `\nThis will wipe ${args.brandName}'s calibration for ${args.skillId}.\n` +
        `Your tuned values will be lost. The next run will re-prompt as if first-time.\n` +
        `\nTo confirm, re-run with --yes:\n` +
        `  mixshift skill config ${args.skillId} --brand ${args.brandSlug} --reset --yes\n\n`,
    );
    process.exitCode = 1;
    return;
  }

  const result = await resetSkillConfig(
    args.skillId,
    args.brandSlug,
    args.dataDir,
  );

  await track(
    {
      event_name: EventName.SkillCalibrationReset,
      skill_id: args.skillId,
      outcome: 'ok',
      payload: { brand_slug: args.brandSlug, existed: result.existed },
    },
    args.dataDir,
  );

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        { status: 'ok', existed: result.existed, path: result.path },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  process.stdout.write(
    result.existed
      ? `\n✓ Reset ${args.brandName}'s ${args.skillId} calibration.\n\n`
      : `\n${args.brandName} had no calibration for ${args.skillId}. Nothing to reset.\n\n`,
  );
  return;
}

// ---------------------------------------------------------------------------
// Apply-gate (dry-run)
// ---------------------------------------------------------------------------

/**
 * Read `suggestions.json` + `overrides.json` from runs/<skill>/<date>/,
 * reconcile per-row (override wins when present), write applied.json with
 * status="dry_run" per row. The future write-MCP/API integration replaces
 * `status: "dry_run"` with the actual write result.
 */
async function applyDryRun(args: {
  skillId: string;
  brandSlug: string;
  runDate: string;
  dataDir?: string;
}): Promise<{
  applied_path: string;
  row_count: number;
  rows_with_overrides: number;
}> {
  const path = runAppliedPath(
    args.brandSlug,
    args.skillId,
    args.runDate,
    args.dataDir,
  );
  const runDir = dirname(path);

  const suggestions = await readJsonIfExists(`${runDir}/suggestions.json`);
  if (!suggestions) {
    throw new Error(
      `No suggestions.json found at ${runDir}. ` +
        `Apply-gate requires a completed skill run with structured output.`,
    );
  }
  const overrides = (await readJsonIfExists(`${runDir}/overrides.json`)) ?? {
    rows: [],
  };

  const suggestionRows = extractRows(suggestions);
  const overrideMap = new Map<string, Record<string, unknown>>();
  for (const r of extractRows(overrides)) {
    const id = stableRowId(r);
    if (id) overrideMap.set(id, r);
  }

  const appliedRows: Array<Record<string, unknown>> = [];
  let rowsWithOverrides = 0;
  for (const s of suggestionRows) {
    const id = stableRowId(s);
    const ov = id ? overrideMap.get(id) : undefined;
    if (ov) rowsWithOverrides += 1;
    appliedRows.push({
      row_id: id ?? null,
      suggested: s,
      override: ov ?? null,
      // Final values: override fields take precedence per-field.
      final: ov ? { ...s, ...ov } : s,
      // Apply contract: dry_run today, "applied" | "failed" when MCP lands.
      status: 'dry_run',
      applied_at: null,
      external_id: null,
      // User's reasoning note (if any) lifted to top for easy querying.
      reason_note:
        (ov && typeof ov.reason_note === 'string' && ov.reason_note) || null,
    });
  }

  const body = {
    schema_version: 1,
    skill_id: args.skillId,
    brand_slug: args.brandSlug,
    run_date: args.runDate,
    generated_at: new Date().toISOString(),
    dry_run: true,
    row_count: appliedRows.length,
    rows_with_overrides: rowsWithOverrides,
    rows: appliedRows,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(body, null, 2), 'utf-8');

  return {
    applied_path: path,
    row_count: appliedRows.length,
    rows_with_overrides: rowsWithOverrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied brand input (slug, display name, acronym, prefix)
 * against the registry using the same fuzzy resolver as `brand key add`.
 * Returns null + emits a helpful error message on no-match or ambiguous.
 */
async function resolveBrandRow(
  input: string,
  dataDir?: string,
): Promise<{ slug: string; display_name: string } | null> {
  const { index } = await readIndex(dataDir);
  // Exact slug match wins (lets scripts pass the canonical slug without
  // worrying about the fuzzy resolver getting clever).
  const exact = index.brands.find((b) => b.slug === input);
  if (exact) return { slug: exact.slug, display_name: exact.display_name };

  const resolved = resolveBrandName(input, index);
  if (resolved.status === 'found') {
    return {
      slug: resolved.brand.slug,
      display_name: resolved.brand.display_name,
    };
  }
  // Both 'ambiguous' and 'none' return null; the caller's emitError prints
  // a fixed message. For richer feedback, callers can use the lower-level
  // resolveBrandName directly — kept simple here since `mixshift skill
  // config` is typically invoked by Claude with a slug already in hand.
  if (resolved.status === 'ambiguous') {
    const candidates = resolved.candidates
      .slice(0, 5)
      .map((c: IndexBrand) => `  - ${c.display_name} (slug: ${c.slug})`)
      .join('\n');
    throw new Error(
      `Brand input "${input}" matches ${resolved.candidates.length} brands. Disambiguate by slug:\n${candidates}`,
    );
  }
  return null;
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'ENOENT'
    ) {
      return null;
    }
    throw err;
  }
}

function extractRows(obj: unknown): Array<Record<string, unknown>> {
  if (obj === null || typeof obj !== 'object') return [];
  const rows = (obj as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (r): r is Record<string, unknown> =>
      r !== null && typeof r === 'object' && !Array.isArray(r),
  );
}

/**
 * Stable row id across suggestions/overrides/applied. Convention: the
 * skill picks ONE identifier field — `row_id`, `campaign_id`, `keyword_id`,
 * `asin`, whichever is canonical — and uses it consistently. We look for
 * the common candidates in order.
 */
function stableRowId(row: Record<string, unknown>): string | null {
  for (const key of [
    'row_id',
    'campaign_id',
    'ad_group_id',
    'keyword_id',
    'target_id',
    'placement_id',
    'asin',
    'sku',
  ]) {
    const v = row[key];
    if (typeof v === 'string' || typeof v === 'number') return String(v);
  }
  return null;
}

function emitError(json: boolean | undefined, message: string): void {
  if (json) {
    process.stdout.write(
      JSON.stringify({ status: 'error', message }, null, 2) + '\n',
    );
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}
