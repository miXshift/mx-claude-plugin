/**
 * Lint for the mx-dayparting skill: the install-time description rules, the telemetry block, that every
 * `mixshift dayparting` command the skill (and its manifest) names is a real command with real flags,
 * and that the skill keeps saying nothing is applied in this release.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { registerDaypartingCommands } from '../src/commands/dayparting.js';
import { skillManifestSchema } from '../src/lib/prefetch/manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(here, '..', '..', 'skills', 'mx-dayparting');
const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
const manifestRaw = readFileSync(join(skillDir, 'skill.manifest.yaml'), 'utf-8');

const frontmatter = parseYaml(skill.split(/^---\s*$/m)[1]!) as { name: string; description: string; trigger_phrases: string[]; metadata: { version: string } };

function commandTree(): Command {
  const program = new Command();
  registerDaypartingCommands(program);
  return program.commands.find((c) => c.name() === 'dayparting')!;
}

describe('mx-dayparting skill', () => {
  it('has the house frontmatter and a description inside the install limits', () => {
    expect(frontmatter.name).toBe('mx-dayparting');
    const description = frontmatter.description.replace(/\s+/g, ' ').trim();
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).not.toMatch(/<[^>]+>/);
    expect(frontmatter.trigger_phrases.length).toBeGreaterThan(3);
  });

  it('has a manifest that validates and agrees with the skill', () => {
    const m = skillManifestSchema.parse(parseYaml(manifestRaw));
    expect(m.skill_id).toBe('mx-dayparting');
    expect(m.version).toBe(frontmatter.metadata.version);
    expect(m.side_effect_policy).toBe('recommendation_only');
    expect(m.trigger_phrases).toEqual(frontmatter.trigger_phrases);
  });

  it('carries the required telemetry block', () => {
    expect(skill).toMatch(/##\s*Telemetry\s*\(required/);
    expect(skill).toContain('mixshift telemetry emit skill.invoked --skill mx-dayparting');
    expect(skill).toContain('mixshift telemetry emit skill.completed --skill mx-dayparting --outcome');
  });

  it('names only commands and flags that exist', () => {
    const dayparting = commandTree();
    const known = new Map(dayparting.commands.map((c) => [c.name(), new Set(c.options.map((o) => o.long))]));
    expect([...known.keys()].sort()).toEqual(['diagnose', 'hours']);
    const text = skill + '\n' + manifestRaw;
    const lines = text.split('\n').filter((l) => /mixshift dayparting (diagnose|hours)/.test(l));
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) {
      const sub = /mixshift dayparting (diagnose|hours)/.exec(line)![1]!;
      const flags = [...line.matchAll(/(--[a-z][a-z-]*)/g)].map((m) => m[1]!);
      for (const flag of flags.filter((f) => f !== '--json')) expect(known.get(sub)!.has(flag), `${sub} has no ${flag}`).toBe(true);
    }
  });

  it('states the rules and that nothing is applied in this release', () => {
    expect(skill).toMatch(/only diagnoses/i);
    expect(skill).toMatch(/later release/i);
    expect(skill).toMatch(/Matured data only/);
    expect(skill).toMatch(/8 weeks/);
    expect(skill).toMatch(/Event days are left out/);
    expect(skill).toMatch(/target ACOS/);
    expect(skill).not.toMatch(/--commit/);
  });

  it('carries no real ids, customer names or internal addresses', () => {
    for (const text of [skill, manifestRaw]) {
      expect(text).not.toMatch(/\b\d{9,}\b/);
      expect(text).not.toMatch(/railway\.app|supabase\.co|internal|mx-ops|mx-brain/i);
    }
  });
});
