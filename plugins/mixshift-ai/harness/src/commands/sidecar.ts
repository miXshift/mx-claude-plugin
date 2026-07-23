/**
 * `mixshift sidecar write --input-file <path>`
 *
 * Reads a skill-produced JSON file and writes a validated run sidecar
 * under `~/.mixshift/clients/<brand>/runs/<skill>/<date>-<run-id>.json`.
 *
 * Why a JSON input file instead of CLI flags?
 *   Sidecars have ~12 top-level fields including a nested context
 *   snapshot and metric map. Flattening that into flags would be
 *   user-hostile and brittle. The skill writes a JSON to a tmp file
 *   (often the same `data.json` directory) and points us at it.
 *
 */

import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { writeSidecar, type SidecarWriteInput } from '../lib/sidecar/write.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

interface SidecarWriteCmdOptions {
  inputFile: string;
  runId?: string;
}

export function registerSidecarCommands(program: Command): void {
  const sidecar = program
    .command('sidecar')
    .description('Write run sidecars after skill execution.');

  sidecar
    .command('write')
    .description(
      'Write a run sidecar from a skill-produced JSON input. The input ' +
        'file must match the schema in shared/run-sidecar.schema.yaml.',
    )
    .requiredOption(
      '--input-file <path>',
      'path to JSON file with sidecar fields (see docs / schema)',
    )
    .option(
      '--run-id <hex>',
      'override the generated 6-char hex run_id (for deterministic tests)',
    )
    .action(async (opts: SidecarWriteCmdOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      try {
        const raw = await readFile(opts.inputFile, 'utf-8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Failed to parse ${opts.inputFile} as JSON: ${message}`,
          );
        }
        if (typeof parsed !== 'object' || parsed === null) {
          throw new Error(
            `${opts.inputFile} must contain a JSON object at the top level.`,
          );
        }
        const input: SidecarWriteInput = {
          ...(parsed as SidecarWriteInput),
          dataDirOverride: root.dataDir,
          ...(opts.runId ? { run_id: opts.runId } : {}),
        };
        const result = await writeSidecar(input);
        if (root.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        } else {
          process.stdout.write(
            `\n✓ Sidecar written.\n` +
              `  - skill:     ${result.skill}\n` +
              `  - brand:     ${result.brand_slug}\n` +
              `  - data_date: ${result.data_date}\n` +
              `  - run_id:    ${result.run_id}\n` +
              `  - path:      ${result.sidecar_path}\n\n`,
          );
        }
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (root.json) {
          process.stdout.write(
            JSON.stringify({ status: 'error', message }, null, 2) + '\n',
          );
        } else {
          process.stderr.write(`error: ${message}\n`);
        }
        process.exitCode = 1;
        return;
      }
    });

}
