import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { catalogSkillIds, collectUncatalogued, findSkillsDir } from './help.js';

// The guide's CATALOG is hand-written, so it drifts from the shipped skills in
// both directions. A shipped skill with no row still renders, but only under
// "More" at the bottom of the guide (mx-max-forecast sat there after 0.8.17
// while the README, the manifest and the site all listed it). A row whose
// skill was renamed or removed keeps telling users to start something that no
// longer exists. Both directions are checked against the real skills/ dir.
describe('mixshift guide catalog', () => {
  const savedRoot = process.env.CLAUDE_PLUGIN_ROOT;

  beforeAll(() => {
    // Resolve skills/ from the source layout, not from an installed plugin.
    delete process.env.CLAUDE_PLUGIN_ROOT;
  });

  afterAll(() => {
    if (savedRoot !== undefined) process.env.CLAUDE_PLUGIN_ROOT = savedRoot;
  });

  it('finds the shipped skills directory from the source layout', async () => {
    const dir = await findSkillsDir();
    expect(dir).not.toBeNull();
    await expect(fs.access(join(dir as string, 'mx-help', 'SKILL.md'))).resolves.toBeUndefined();
  });

  it('gives every shipped skill a row', async () => {
    expect(await collectUncatalogued()).toEqual([]);
  });

  it('names only skills that ship', async () => {
    const dir = (await findSkillsDir()) as string;
    const missing: string[] = [];
    for (const id of catalogSkillIds()) {
      try {
        await fs.access(join(dir, id, 'SKILL.md'));
      } catch {
        missing.push(id);
      }
    }
    expect(missing).toEqual([]);
  });
});
