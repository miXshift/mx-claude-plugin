import type { Command } from 'commander';
import { stringify as stringifyYaml } from 'yaml';
import { loadProfile } from '../lib/profile/load.js';
import { saveProfile } from '../lib/profile/save.js';
import { profileSchema } from '../lib/profile/schema.js';
import { formatZodError } from '../lib/profile/format-error.js';
import { coerceValue, setNested } from '../lib/utils/set-nested.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerProfileCommands(program: Command): void {
  const profile = program
    .command('profile')
    .description('Read and write ~/.mixshift/profile.yaml');

  profile
    .command('show')
    .description('Print the current user profile')
    .action(async (_opts, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      try {
        const { profile: data, source, path } = await loadProfile(root.dataDir);

        if (root.json) {
          process.stdout.write(
            JSON.stringify({ source, path, profile: data }, null, 2) + '\n',
          );
        } else {
          if (source === 'default') {
            process.stderr.write(
              `# No profile file at ${path} yet — showing defaults.\n` +
                `# Run \`mixshift auth setup\` to populate, or \`mixshift profile set <key> <value>\` to persist.\n\n`,
            );
          } else {
            process.stderr.write(`# Loaded from ${path}\n\n`);
          }
          process.stdout.write(stringifyYaml(data, { lineWidth: 0 }));
        }
        process.exit(0);
      } catch (err) {
        emitError(err, root.json);
      }
    });

  profile
    .command('set <key> <value>')
    .description(
      'Set a profile field. Use dot.path syntax for nested keys (e.g. ' +
        '`output.default_by_surface.cowork inline-markdown`). String values pass ' +
        'through; "true"/"false"/numbers/null are JSON-coerced.',
    )
    .action(async (key: string, rawValue: string, _opts, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      try {
        const { profile: existing } = await loadProfile(root.dataDir);
        const coerced = coerceValue(rawValue);

        // Mutate a shallow clone so we don't disturb the validated object's identity
        const next: Record<string, unknown> = JSON.parse(JSON.stringify(existing));
        setNested(next, key, coerced);

        const parsed = profileSchema.safeParse(next);
        if (!parsed.success) {
          throw new Error(formatZodError(parsed.error));
        }
        const { path } = await saveProfile(parsed.data, root.dataDir);

        if (root.json) {
          process.stdout.write(
            JSON.stringify({ status: 'ok', path, key, value: coerced }, null, 2) + '\n',
          );
        } else {
          process.stderr.write(`# Wrote ${key} = ${JSON.stringify(coerced)} to ${path}\n`);
        }
        process.exit(0);
      } catch (err) {
        emitError(err, root.json);
      }
    });
}

function emitError(err: unknown, json: boolean | undefined): never {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    process.stdout.write(
      JSON.stringify({ status: 'error', message }, null, 2) + '\n',
    );
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exit(1);
}
