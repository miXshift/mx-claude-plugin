/**
 * Skill demos: the shared index behind `mixshift demo` and the guide's
 * "See it in action" section.
 *
 * A demo is declared by a skill, not registered here: a `demo:` block in its
 * skill.manifest.yaml (schema: lib/prefetch/manifest.ts `skillDemoSchema`)
 * plus a `## Demo` section in its SKILL.md holding the step-by-step script.
 * This module only reads the manifests, so a skill that adds a demo appears
 * in every listing with no code change. Contract and entry points:
 * shared/skill-runtime-contract.md ("Demos").
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { skillManifestSchema, type SkillDemo } from './prefetch/manifest.js';

export interface DemoEntry extends SkillDemo {
  /** Skill directory id, e.g. `mx-walmart-ads`. */
  skillId: string;
  /** `say` without the leading "demo ", e.g. "Walmart ads". */
  title: string;
}

/**
 * Every skill under `skillsDir` whose manifest declares a demo, sorted by
 * skill id. A manifest that does not parse is skipped here (validate-manifests
 * fails CI on it), so one bad skill never hides the others' demos.
 */
export async function loadDemos(skillsDir: string | null): Promise<DemoEntry[]> {
  if (!skillsDir) return [];
  let entries: string[];
  try {
    entries = (await fs.readdir(skillsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith('mx-'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const demos: DemoEntry[] = [];
  for (const skillId of entries) {
    let raw: string;
    try {
      raw = await fs.readFile(join(skillsDir, skillId, 'skill.manifest.yaml'), 'utf-8');
    } catch {
      continue;
    }
    const parsed = skillManifestSchema.safeParse(parseYaml(raw));
    if (!parsed.success || !parsed.data.demo) continue;
    const demo = parsed.data.demo;
    demos.push({ ...demo, skillId, title: demo.say.replace(/^demo\s+/, '') });
  }
  return demos;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, '-');

/**
 * Resolve what the agent passed (`mx-walmart-ads`, `walmart-ads`,
 * "Walmart ads", "demo walmart ads") to a skill id. Returns the id even when
 * that skill has no demo, so the caller can say "no demo yet" for a real
 * skill; null when nothing matches.
 */
export function resolveDemoSkill(
  input: string,
  demos: DemoEntry[],
  skillIds: string[],
): string | null {
  const q = norm(input).replace(/^demo-/, '');
  if (!q) return null;
  for (const d of demos) {
    if (q === d.skillId || `mx-${q}` === d.skillId || q === norm(d.title)) return d.skillId;
  }
  for (const id of skillIds) {
    if (q === id || `mx-${q}` === id) return id;
  }
  return null;
}

/** The opener the agent shows verbatim before step 1 (chat markdown). */
export function renderDemoOpenerChat(d: DemoEntry): string {
  const L: string[] = [];
  L.push(`**Demo: ${d.title}** (about ${d.minutes} minutes, on your own account)`);
  L.push('');
  L.push(d.summary);
  L.push('');
  L.push("What you'll see:");
  d.steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push('');
  L.push(
    d.changes === 'preview'
      ? 'Nothing on your account changes: any change is shown as a preview and is not sent.'
      : 'This demo only reads: nothing on your account changes.',
  );
  if (d.needs) L.push(`Needs: ${d.needs}.`);
  L.push('Say "skip" to move on, "stop" to end, or ask about anything along the way.');
  L.push('');
  return L.join('\n');
}

/** The demo list for "give me a demo" with no skill named (chat markdown). */
export function renderDemoListChat(demos: DemoEntry[]): string {
  const L: string[] = [];
  L.push('**Demos: see a skill in action on your own account**');
  L.push('');
  if (demos.length === 0) {
    L.push('No skill has a demo yet. Say **"help"** to see everything the plugin can do.');
  } else {
    for (const d of demos) L.push(`- **"${d.say}"** (about ${d.minutes} min): ${d.summary}`);
    L.push('');
    L.push('Say one to start. More skills get demos over time; say **"help"** for everything the plugin can do.');
  }
  L.push('');
  return L.join('\n');
}

/** A real skill without a demo yet (chat markdown). */
export function renderNoDemoChat(skillId: string, demos: DemoEntry[]): string {
  const L: string[] = [];
  L.push(`**${skillId}** does not have a demo yet.`);
  if (demos.length > 0) {
    L.push('');
    L.push('Demos you can run now:');
    for (const d of demos) L.push(`- **"${d.say}"**: ${d.summary}`);
  }
  L.push('');
  return L.join('\n');
}
