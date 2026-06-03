/**
 * `mixshift brand config <slug>` — confirm-on-edit flow for brand-level
 * context.yaml fields.
 *
 * Mirrors `mixshift skill config <id>` but pointed at brand context
 * instead of per-skill OCL. Same three modes:
 *   - default (show): emit the confirmation card (chat or JSON)
 *   - `--apply <decision-json>`: persist user edits
 *   - `--show` (alias for default)
 *
 * There is no `--reset` for brand config — context.yaml is populated by
 * cold-start, not seeded from anywhere else. To clear a field, the user
 * edits it to empty (where the schema allows) or re-runs cold-start.
 *
 * The chat-style rendering is duplicated from the OCL card on purpose:
 * the two surfaces will diverge as we add brand-specific affordances
 * (forecast scorecards, category share inputs, hero SKU tables). Sharing
 * a renderer now would force premature abstraction.
 */

import type { Command } from 'commander';
import { readIndex } from '../lib/clients/index.js';
import { resolveBrandName } from '../lib/clients/resolve-brand.js';
import {
  prepareBrandConfigEdit,
  applyBrandConfigEdit,
  type BrandConfigPayload,
  type BrandConfigDecision,
  type BrandContextFieldState,
} from '../lib/context-editor/flow.js';
import {
  type CalibrationField,
  formatFieldValue,
} from '../lib/calibration/manifest-schema.js';
import { track } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerBrandConfigCommand(brandCmd: Command): void {
  brandCmd
    .command('config <slug>')
    .description(
      'Edit brand-level context fields (ACoS/TACoS targets, attribution ' +
        'window, goals). Shows the confirmation card by default. Pair ' +
        'with --apply <decision-json> to persist edits.',
    )
    .option(
      '--apply <decision>',
      'apply a decision (JSON). Schema: {"action":"confirm"} | ' +
        '{"action":"edit","edits":{...}} | {"action":"cancel"}',
    )
    .option(
      '--show',
      'read-only inspect — alias for the default action when no flags pass',
      false,
    )
    .action(
      async (
        slug: string,
        opts: { apply?: string; show: boolean },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          const brandRow = await resolveBrandRow(slug, root.dataDir);
          if (brandRow === null) {
            return emitError(
              root.json,
              `Brand "${slug}" not found in the registry. Run ` +
                '`node dist/cli.js brand list` to see available brands.',
            );
          }

          // --apply path
          if (opts.apply) {
            return await runApplyDecision({
              brandSlug: brandRow.slug,
              brandName: brandRow.display_name,
              decisionJson: opts.apply,
              json: root.json,
              dataDir: root.dataDir,
            });
          }

          // Default / --show: prepare + render
          return await runShow({
            brandSlug: brandRow.slug,
            brandName: brandRow.display_name,
            json: root.json,
            dataDir: root.dataDir,
          });
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
  brandSlug: string;
  brandName: string;
  json?: boolean;
  dataDir?: string;
}): Promise<void> {
  const payload = await prepareBrandConfigEdit({
    brandSlug: args.brandSlug,
    brandName: args.brandName,
    dataDirOverride: args.dataDir,
  });
  indexFields(payload);

  await track(
    {
      event_name: 'brand_config.viewed',
      payload: {
        brand_slug: args.brandSlug,
        context_missing: payload.context_missing,
      },
    },
    args.dataDir,
  );

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ status: 'ok', config: payload }, null, 2) + '\n',
    );
    return;
  }

  if (payload.context_missing) {
    process.stdout.write(
      `\nNo brand context yet for ${args.brandName}.\n\n` +
        `Run /mx-account-cold-start ${args.brandSlug} in chat to capture ` +
        `the brand's positioning, targets, and structural events.\n\n`,
    );
    return;
  }

  process.stdout.write('\n' + renderBrandConfigCard(payload) + '\n\n');
}

async function runApplyDecision(args: {
  brandSlug: string;
  brandName: string;
  decisionJson: string;
  json?: boolean;
  dataDir?: string;
}): Promise<void> {
  let decision: BrandConfigDecision;
  try {
    decision = JSON.parse(args.decisionJson) as BrandConfigDecision;
  } catch (err) {
    return emitError(
      args.json,
      `--apply must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const payload = await prepareBrandConfigEdit({
    brandSlug: args.brandSlug,
    brandName: args.brandName,
    dataDirOverride: args.dataDir,
  });
  const result = await applyBrandConfigEdit(payload, decision, {
    dataDirOverride: args.dataDir,
  });

  if (decision.action === 'edit') {
    await track(
      {
        event_name: 'brand_config.edited',
        outcome: result.status === 'ok' ? 'ok' : 'failed',
        payload: {
          brand_slug: args.brandSlug,
          edit_count: Object.keys(decision.edits).length,
          changed_count: result.changed_field_count,
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
          did_write: result.did_write,
          changed_field_count: result.changed_field_count,
          written_to: result.written_to,
          validation_issues: result.validation_issues,
        },
        null,
        2,
      ) + '\n',
    );
    if (result.status === 'validation_failed') process.exitCode = 4;
    if (result.status === 'context_missing') process.exitCode = 5;
    return;
  }

  switch (result.status) {
    case 'context_missing':
      process.stderr.write(
        `\nNo brand context yet for ${args.brandName}. Run /mx-account-cold-start ` +
          `${args.brandSlug} first.\n\n`,
      );
      process.exitCode = 5;
      return;
    case 'cancelled':
      process.stdout.write('\nCancelled. No changes saved.\n\n');
      return;
    case 'validation_failed':
      process.stderr.write('\nCould not save — please fix:\n');
      for (const issue of result.validation_issues) {
        process.stderr.write(`  - ${issue.field}: ${issue.message}\n`);
      }
      process.stderr.write('\n');
      process.exitCode = 4;
      return;
    case 'ok':
      if (result.did_write) {
        process.stdout.write(
          `\n✓ Saved ${result.changed_field_count} brand config edit(s) for ${args.brandName}.\n\n`,
        );
      } else {
        process.stdout.write(`\nNo changes.\n\n`);
      }
      return;
  }
}

// ---------------------------------------------------------------------------
// Rendering (small + brand-config-specific — see top-of-file comment)
// ---------------------------------------------------------------------------

function renderBrandConfigCard(payload: BrandConfigPayload): string {
  const lines: string[] = [];
  lines.push(`Brand config — ${payload.brand_name}`);
  lines.push('');
  for (const f of payload.fields) {
    lines.push(renderFieldLine(f));
    const hint = renderSourceHint(f);
    if (hint) lines.push(`${''.padStart(28)}${hint}`);
  }
  lines.push('');
  if (payload.blocking.has_missing_required) {
    lines.push(`Missing required: ${payload.blocking.missing_keys.join(', ')}`);
    lines.push('');
    lines.push(
      `Some required fields are unset. Choose a number above to set, or "cancel".`,
    );
  } else {
    lines.push(
      `Confirm or edit?  [Enter to keep / number to edit / "cancel"]`,
    );
  }
  return lines.join('\n');
}

function renderFieldLine(state: BrandContextFieldState): string {
  const idx = (state as BrandContextFieldState & { _idx?: number })._idx ?? 0;
  const num = idx.toString().padStart(2, ' ');
  const label = humanLabel(state.field).padEnd(24);
  return `  ${num}. ${label}  ${state.display}`;
}

function renderSourceHint(state: BrandContextFieldState): string | null {
  switch (state.source) {
    case 'stored':
      return null;
    case 'default':
      return `(default — set explicitly if this isn't right)`;
    case 'missing':
      return state.field.required
        ? `(required — must be set)`
        : `(not set — optional)`;
  }
}

function humanLabel(field: CalibrationField): string {
  if (field.label) return field.label;
  return field.id
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

function indexFields(payload: BrandConfigPayload): void {
  payload.fields.forEach((f, i) => {
    (f as BrandContextFieldState & { _idx: number })._idx = i + 1;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveBrandRow(
  input: string,
  dataDir?: string,
): Promise<{ slug: string; display_name: string } | null> {
  const { index } = await readIndex(dataDir);
  const exact = index.brands.find((b) => b.slug === input);
  if (exact) return { slug: exact.slug, display_name: exact.display_name };
  const resolved = resolveBrandName(input, index);
  if (resolved.status === 'found') {
    return {
      slug: resolved.brand.slug,
      display_name: resolved.brand.display_name,
    };
  }
  if (resolved.status === 'ambiguous') {
    const candidates = resolved.candidates
      .slice(0, 5)
      .map((c) => `  - ${c.display_name} (slug: ${c.slug})`)
      .join('\n');
    throw new Error(
      `Brand input "${input}" matches ${resolved.candidates.length} brands. Disambiguate by slug:\n${candidates}`,
    );
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

// Silence "imported but not used" while the formatter helper is reserved
// for a future enrich step that includes the field value-with-units in
// the brand_config.viewed telemetry payload.
void formatFieldValue;
