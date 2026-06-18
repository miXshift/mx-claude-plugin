/**
 * `mixshift brand migrate-config <slug>` — one-time context -> OCL migration.
 *
 * Completes the Brand Context separation: copies the genuinely single-skill
 * scalar knobs out of context.yaml into the owning skill's OCL
 * (config.yaml::<skill_id>), so the value's canonical home is the skill block.
 * Idempotent + sovereign (never overwrites a value the AM already set);
 * extras round-trip; percent units normalize (context whole -> OCL [0,1]).
 * SHARED (2+ skill) and non-scalar brand-context fields stay in context.yaml.
 *
 * See lib/migrations/config-migrations.ts for the registry + the rationale on
 * why the migration set is narrow.
 */

import type { Command } from 'commander';
import { migrateBrandConfig } from '../lib/migrations/config-migrations.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerBrandMigrateConfigCommand(brand: Command): void {
  brand
    .command('migrate-config <slug>')
    .description(
      "One-time migration of single-skill scalar knobs from context.yaml into " +
        "the owning skill's OCL (config.yaml::<skill>). Idempotent + sovereign " +
        '(never overwrites a value you set); shared/structured brand-context ' +
        'fields stay in context.yaml.',
    )
    .action(async (slug: string, _opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const result = await migrateBrandConfig(slug, root.dataDir);

      if (root.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }

      const lines = [`\nConfig migration for ${slug}:`];
      if (result.moved.length === 0) {
        lines.push(
          '  Nothing migrated (already done, or no migratable field set in context).',
        );
      } else {
        for (const m of result.moved) {
          lines.push(`  -> ${m.skill_id}.${m.field} = ${String(m.value)}  (from context)`);
        }
      }
      if (result.skipped.length > 0) {
        const reasons = [...new Set(result.skipped.map((s) => s.reason))];
        lines.push(`  (${result.skipped.length} skipped: ${reasons.join('; ')})`);
      }
      if (result.wrote_skills.length > 0) {
        lines.push(
          `\nWrote ${result.wrote_skills.length} skill block(s): ${result.wrote_skills.join(', ')}.`,
        );
      }
      process.stdout.write(lines.join('\n') + '\n');
    });
}
