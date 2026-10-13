import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { findSkillsDir, renderDemoSectionChat } from './help.js';
import {
  loadDemos,
  renderDemoListChat,
  renderDemoOpenerChat,
  renderNoDemoChat,
  resolveDemoSkill,
  type DemoEntry,
} from '../lib/demos.js';
import { skillDemoSchema } from '../lib/prefetch/manifest.js';

// Demos are a standard every skill can adopt (shared/skill-runtime-contract.md
// "Demos"). The manifest block is what `mixshift demo` and the guide read; the
// SKILL.md `## Demo` section is what the agent follows. These tests hold the
// two together for EVERY skill that declares a demo, so the second skill to add
// one gets the same checks without touching this file.

const frontmatter = (md: string): Record<string, unknown> => {
  const m = md.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n/);
  return m ? (parseYaml(m[1]) as Record<string, unknown>) : {};
};

/** The `## Demo` section of a SKILL.md, up to the next `## ` heading. */
const demoSection = (md: string): string | null => {
  const text = md.replace(/\r\n/g, '\n');
  const start = text.search(/^## Demo\b/m);
  if (start < 0) return null;
  const rest = text.slice(start + 1);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
};

describe('skill demos: the standard, checked for every skill that declares one', () => {
  const savedRoot = process.env.CLAUDE_PLUGIN_ROOT;
  let skillsDir: string;
  let demos: DemoEntry[];

  beforeAll(async () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    skillsDir = (await findSkillsDir()) as string;
    demos = await loadDemos(skillsDir);
  });

  afterAll(() => {
    if (savedRoot !== undefined) process.env.CLAUDE_PLUGIN_ROOT = savedRoot;
  });

  it('finds the Walmart ads demo (the first one)', () => {
    const w = demos.find((d) => d.skillId === 'mx-walmart-ads');
    expect(w).toBeDefined();
    expect(w!.say).toBe('demo Walmart ads');
    expect(w!.title).toBe('Walmart ads');
    expect(w!.changes).toBe('preview');
  });

  it('every demo has a SKILL.md "## Demo" section whose steps match the manifest, in order', async () => {
    for (const d of demos) {
      const md = await fs.readFile(join(skillsDir, d.skillId, 'SKILL.md'), 'utf-8');
      const section = demoSection(md);
      expect(section, `${d.skillId}: no "## Demo" section`).not.toBeNull();
      const titles = [...section!.matchAll(/^### Step (\d+): (.+)$/gm)].map((m) => [Number(m[1]), m[2].trim()]);
      expect(titles, d.skillId).toEqual(d.steps.map((s, i) => [i + 1, s]));
      expect(section, d.skillId).toContain(`mixshift demo ${d.skillId}\n`);
      expect(section, d.skillId).toContain(`mixshift demo ${d.skillId} --finished --steps-shown`);
      expect(section, d.skillId).toMatch(/^### Close$/m);
    }
  });

  it('every demo can be found by its phrase: trigger phrases in both files, "demo" in the description', async () => {
    for (const d of demos) {
      const manifest = parseYaml(
        await fs.readFile(join(skillsDir, d.skillId, 'skill.manifest.yaml'), 'utf-8'),
      ) as { trigger_phrases?: string[] };
      const fm = frontmatter(await fs.readFile(join(skillsDir, d.skillId, 'SKILL.md'), 'utf-8'));
      const phrase = d.say.toLowerCase();
      expect(manifest.trigger_phrases ?? [], d.skillId).toContain(phrase);
      expect((fm.trigger_phrases as string[] | undefined) ?? [], d.skillId).toContain(phrase);
      expect(String(fm.description ?? ''), d.skillId).toMatch(/\bdemo\b/);
    }
  });

  it('mx-help catches a demo request that names no skill', async () => {
    const fm = frontmatter(await fs.readFile(join(skillsDir, 'mx-help', 'SKILL.md'), 'utf-8'));
    expect(fm.trigger_phrases).toEqual(expect.arrayContaining(['demo', 'give me a demo', 'show me around']));
  });
});

describe('demo manifest block', () => {
  const ok = {
    say: 'demo Example',
    summary: 'One line.',
    minutes: 5,
    steps: ['One', 'Two', 'Three'],
    changes: 'preview',
  };

  it('accepts a well-formed block', () => {
    expect(skillDemoSchema.safeParse(ok).success).toBe(true);
  });

  it('requires the phrase to start with "demo "', () => {
    expect(skillDemoSchema.safeParse({ ...ok, say: 'tour Example' }).success).toBe(false);
  });

  it('holds a demo to 3 to 8 steps', () => {
    expect(skillDemoSchema.safeParse({ ...ok, steps: ['One', 'Two'] }).success).toBe(false);
    expect(skillDemoSchema.safeParse({ ...ok, steps: Array(9).fill('x') }).success).toBe(false);
  });

  it('has no "commit" setting: a demo never commits on a live account', () => {
    expect(skillDemoSchema.safeParse({ ...ok, changes: 'commit' }).success).toBe(false);
  });
});

describe('demo resolution and rendering', () => {
  const walmart: DemoEntry = {
    skillId: 'mx-walmart-ads',
    title: 'Walmart ads',
    say: 'demo Walmart ads',
    summary: 'Advertisers, campaigns, last 30 days, one change previewed.',
    minutes: 5,
    steps: ['Your Walmart advertisers', 'Campaigns and their status', 'One change, shown as a preview'],
    changes: 'preview',
    needs: 'a Walmart advertiser connected to your MixShift account',
  };
  const ids = ['mx-walmart-ads', 'mx-amazon-ads', 'mx-help'];

  it('resolves the skill id, the id without mx-, the demo name and the spoken phrase', () => {
    for (const q of ['mx-walmart-ads', 'walmart-ads', 'Walmart ads', 'demo walmart ads', 'WALMART_ADS']) {
      expect(resolveDemoSkill(q, [walmart], ids), q).toBe('mx-walmart-ads');
    }
  });

  it('resolves a real skill without a demo (so the reply can say "no demo yet") and nothing else', () => {
    expect(resolveDemoSkill('amazon ads', [walmart], ids)).toBe('mx-amazon-ads');
    expect(resolveDemoSkill('nonsense', [walmart], ids)).toBeNull();
    expect(resolveDemoSkill('  ', [walmart], ids)).toBeNull();
  });

  it('the opener numbers the steps and says what changes and what it needs', () => {
    const text = renderDemoOpenerChat(walmart);
    expect(text).toContain('**Demo: Walmart ads** (about 5 minutes, on your own account)');
    expect(text).toContain('1. Your Walmart advertisers\n2. Campaigns and their status\n3. One change, shown as a preview');
    expect(text).toContain('shown as a preview and is not sent');
    expect(text).toContain('Needs: a Walmart advertiser connected to your MixShift account.');
    expect(text).not.toContain('—');
  });

  it('a read-only demo says nothing changes', () => {
    expect(renderDemoOpenerChat({ ...walmart, changes: 'none', needs: undefined })).toContain(
      'This demo only reads: nothing on your account changes.',
    );
  });

  it('lists demos by their phrase, and says so when there are none', () => {
    expect(renderDemoListChat([walmart])).toContain('- **"demo Walmart ads"** (about 5 min):');
    expect(renderDemoListChat([])).toContain('No skill has a demo yet.');
    expect(renderNoDemoChat('mx-amazon-ads', [walmart])).toContain('**mx-amazon-ads** does not have a demo yet.');
  });

  it('the guide shows a "See it in action" section only when a demo exists', () => {
    expect(renderDemoSectionChat([])).toEqual([]);
    expect(renderDemoSectionChat([walmart]).join('\n')).toContain('### See it in action');
  });
});
