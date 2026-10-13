/**
 * `mixshift demo [skill]` — guided skill demos.
 *
 * The user never types this. They say "demo Walmart ads" (or "give me a
 * demo", "show me around", ...) and the skill, or mx-help for a demo with no
 * skill named, runs it:
 *
 *   demo                       list every skill that has a demo
 *   demo <skill>               the opener for that skill's demo (the agent
 *                              shows it verbatim, then runs the steps in the
 *                              skill's SKILL.md `## Demo` section)
 *   demo <skill> --finished    record how far the demo got (telemetry only)
 *
 * Demos are declared by skills (a `demo:` block in skill.manifest.yaml), so
 * this command holds no list of its own: see lib/demos.ts. Like `guide`, the
 * harness owns the opener wording so every demo starts the same way.
 *
 * Telemetry: demo.listed (count), demo.requested (skill id, whether it has a
 * demo; a request for a skill WITHOUT one tells us which demo to build next),
 * demo.finished (skill id, steps shown of steps total). Skill ids and counts
 * only, never account data.
 */

import type { Command } from 'commander';
import { promises as fs } from 'node:fs';
import { track, EventName } from '../lib/telemetry/index.js';
import {
  loadDemos,
  renderDemoListChat,
  renderDemoOpenerChat,
  renderNoDemoChat,
  resolveDemoSkill,
  type DemoEntry,
} from '../lib/demos.js';
import { findSkillsDir } from './help.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

interface DemoOptions {
  finished?: boolean;
  stepsShown?: string;
}

export function registerDemoCommand(program: Command): void {
  program
    .command('demo')
    .argument('[skill]', 'skill id (e.g. mx-walmart-ads) or its demo name (e.g. "walmart ads")')
    .description(
      'Guided skill demos. With no skill: list every skill that has a demo. With a skill: ' +
        'print the opener the agent shows before walking the steps in that skill\'s ' +
        'SKILL.md "## Demo" section. Output is chat markdown; --json for the structured form.',
    )
    .option('--finished', 'record that the demo ended (telemetry only)')
    .option('--steps-shown <n>', 'with --finished: how many steps the user saw')
    .action(async (skill: string | undefined, opts: DemoOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const skillsDir = await findSkillsDir();
      const demos = await loadDemos(skillsDir);

      if (!skill) {
        await listDemos(demos, root);
        return;
      }

      const skillIds = await listSkillIds(skillsDir);
      const skillId = resolveDemoSkill(skill, demos, skillIds);
      if (!skillId) {
        fail(root, `No skill matches "${skill}".`, demos);
        return;
      }
      const demo = demos.find((d) => d.skillId === skillId);

      if (opts.finished) {
        await finishDemo(skillId, demo, opts.stepsShown, root);
        return;
      }

      if (root.json) {
        out({ status: 'ok', skill_id: skillId, available: !!demo, demo: demo ?? null, demos: demo ? undefined : demos.map(brief) });
      } else {
        process.stdout.write(demo ? renderDemoOpenerChat(demo) : renderNoDemoChat(skillId, demos));
      }
      await track(
        {
          event_name: EventName.DemoRequested,
          payload: { skill_id: skillId, available: !!demo, steps_total: demo?.steps.length ?? 0 },
        },
        root.dataDir,
      );
    });
}

async function listDemos(demos: DemoEntry[], root: RootOptions): Promise<void> {
  if (root.json) out({ status: 'ok', count: demos.length, demos: demos.map(brief) });
  else process.stdout.write(renderDemoListChat(demos));
  await track({ event_name: EventName.DemoListed, payload: { count: demos.length } }, root.dataDir);
}

async function finishDemo(
  skillId: string,
  demo: DemoEntry | undefined,
  stepsShownRaw: string | undefined,
  root: RootOptions,
): Promise<void> {
  const total = demo?.steps.length ?? 0;
  const n = stepsShownRaw === undefined ? NaN : Number(stepsShownRaw);
  const stepsShown = Number.isInteger(n) && n >= 0 ? Math.min(n, total) : null;
  await track(
    {
      event_name: EventName.DemoFinished,
      payload: { skill_id: skillId, steps_shown: stepsShown, steps_total: total },
    },
    root.dataDir,
  );
  if (root.json) out({ status: 'ok', skill_id: skillId, steps_shown: stepsShown, steps_total: total });
  else process.stdout.write(`Recorded: ${skillId} demo finished.\n`);
}

function brief(d: DemoEntry) {
  return { skill_id: d.skillId, say: d.say, summary: d.summary, minutes: d.minutes };
}

async function listSkillIds(skillsDir: string | null): Promise<string[]> {
  if (!skillsDir) return [];
  try {
    return (await fs.readdir(skillsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith('mx-'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function fail(root: RootOptions, message: string, demos: DemoEntry[]): void {
  if (root.json) out({ status: 'error', failure_kind: 'not_found', message, demos: demos.map(brief) });
  else process.stdout.write(`${message}\n\n${renderDemoListChat(demos)}`);
  process.exitCode = 1;
}

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
