/**
 * Command-level tests for `mixshift brand config <slug> --apply`.
 *
 * WHY THIS FILE EXISTS. The unit tests in lib/context-editor/flow.test.ts drive
 * applyBrandConfigEdit directly, and they all passed while the actual CLI still
 * crashed. The reason: applyBrandConfigEdit returned a clean validation_failed,
 * and then this command's own unguarded `Object.keys(decision.edits).length`
 * (computed for the edit_count telemetry field) threw the very TypeError the
 * validation was added to replace, BEFORE the validation_failed JSON reached
 * stdout. The user got a generic exit 1 instead of the itemized exit 4.
 *
 * A guard is only real at the layer the user actually touches, so these tests
 * exercise the registered command end to end and assert on the emitted JSON and
 * the exit code, not on a library return value.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerBrandConfigCommand } from './brand-config.js';

// Telemetry is fire-and-forget; stub it so tests never touch the network.
vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return { ...actual, track: vi.fn().mockResolvedValue(undefined) };
});

// The write path publishes to the org store on success. Stub the sync seam so
// these tests stay local and offline.
vi.mock('../lib/context-sync/push-after-write.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../lib/context-sync/push-after-write.js')>();
  return { ...actual, pushAfterWrite: vi.fn().mockResolvedValue(undefined) };
});

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_CLIENTS = join(HERE, '..', '..', 'testdata', 'clients');
const BRAND = 'goldenbrand-sc-acos';

let dataDir: string;
let stdout: string;
let priorExitCode: typeof process.exitCode;
let writeSpy: ReturnType<typeof vi.spyOn>;

async function runApply(decisionJson: string): Promise<void> {
  const program = new Command();
  program.exitOverride();
  // The command reads these via cmd.optsWithGlobals<RootOptions>(), so they are
  // declared on the ROOT in the real CLI. Mirror that here or commander rejects
  // them as unknown and the action never runs.
  program.option('--json', 'emit JSON', false);
  program.option('--data-dir <dir>', 'data dir override');
  const brandCmd = program.command('brand');
  registerBrandConfigCommand(brandCmd);
  try {
    await program.parseAsync(
      ['brand', 'config', BRAND, '--apply', decisionJson, '--json', '--data-dir', dataDir],
      { from: 'user' },
    );
  } catch {
    // commander's exitOverride throws on a non-zero exit; the assertions below
    // read the captured exit code and stdout instead.
  }
}

function emitted(): Record<string, unknown> {
  const start = stdout.indexOf('{');
  expect(start, `no JSON in stdout: ${stdout}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

describe('brand config --apply (command level)', () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'mx-brandcfg-'));
    await cp(FIXTURE_CLIENTS, join(dataDir, 'clients'), { recursive: true });
    stdout = '';
    // The command signals failure with `process.exitCode = N`, not process.exit(),
    // so read the property rather than spying on a call that never happens.
    priorExitCode = process.exitCode;
    process.exitCode = undefined;
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
  });

  afterEach(async () => {
    writeSpy.mockRestore();
    // Never leave a non-zero code behind: vitest would exit non-zero itself.
    process.exitCode = priorExitCode;
    await rm(dataDir, { recursive: true, force: true });
  });

  it.each([
    ['edits missing entirely', '{"action":"edit"}'],
    ['edits null', '{"action":"edit","edits":null}'],
    ['edits a number', '{"action":"edit","edits":42}'],
    ['edits an array', '{"action":"edit","edits":[{"acos_target_pct":"32"}]}'],
  ])('reports %s as a named validation failure, not a raw crash', async (_label, json) => {
    await runApply(json);
    const out = emitted();
    // The regression this file exists for: a raw TypeError used to escape here
    // as {"status":"error","message":"Cannot convert undefined or null to object"}.
    expect(out.status).toBe('validation_failed');
    expect(JSON.stringify(out)).not.toContain('Cannot convert undefined or null to object');
    expect(out.did_write).toBe(false);
    const issues = out.validation_issues as Array<{ field: string; message: string }>;
    expect(issues[0]?.field).toBe('edits');
    expect(process.exitCode).toBe(4);
  });

  it('rejects an unknown action without writing or publishing', async () => {
    const contextPath = join(dataDir, 'clients', BRAND, 'context.yaml');
    const before = await readFile(contextPath, 'utf-8');

    await runApply('{"action":"edt","edits":{"acos_target_pct":32}}');

    const out = emitted();
    expect(out.status).toBe('validation_failed');
    expect(out.did_write).toBe(false);
    const issues = out.validation_issues as Array<{ field: string; message: string }>;
    expect(issues[0]?.field).toBe('action');
    expect(process.exitCode).toBe(4);
    // Byte-identical on disk: nothing was written, so nothing could have been
    // published to the shared org store.
    expect(await readFile(contextPath, 'utf-8')).toBe(before);
  });

  it('still applies a well-formed edit', async () => {
    await runApply('{"action":"edit","edits":{"acos_target_pct":32}}');
    const out = emitted();
    expect(out.status).toBe('ok');
    expect(out.did_write).toBe(true);
    const raw = await readFile(join(dataDir, 'clients', BRAND, 'context.yaml'), 'utf-8');
    expect(raw).toMatch(/acos_target_pct: 32\b/);
  });

  it('treats an empty edits object as a valid no-op', async () => {
    // Guards the opposite failure: a container check tightened far enough to
    // reject a legitimately empty request.
    await runApply('{"action":"edit","edits":{}}');
    const out = emitted();
    expect(out.status).toBe('ok');
    expect(out.changed_field_count).toBe(0);
  });
});
