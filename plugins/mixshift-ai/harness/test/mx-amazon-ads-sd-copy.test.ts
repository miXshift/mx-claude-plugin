/**
 * Copy guard for the mx-amazon-ads skill's Sponsored Display and Creative
 * Assets text (mx-ops#284). The gateway catalog gained the SD creative reads
 * (sd.list_creatives, sd.preview_creative, sd.list_creative_moderations), the
 * SD creative writes (sd.create_creatives, sd.update_creatives) and a name
 * search over the Creative Asset Library (assets.search_by_name). Before this,
 * the skill still told the agent that no operation reads the asset library and
 * listed only four SD reads, so an agent would send a user to the Amazon
 * console for an asset id it could look up itself.
 *
 * The release-time drift gate (check-catalog-drift) proves every id named here
 * exists in the catalog; this test proves the skill names them at all and
 * that the stale sentence does not come back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'skills',
  'mx-amazon-ads',
);
const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
const manifest = readFileSync(join(SKILL_DIR, 'skill.manifest.yaml'), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ');

const SD_GET_READS = [
  'sd.list_campaigns',
  'sd.list_ad_groups',
  'sd.list_product_ads',
  'sd.list_targets',
  'sd.list_creatives',
  'sd.list_creative_moderations',
];

describe('mx-amazon-ads Sponsored Display and Creative Assets copy', () => {
  it('no longer says nothing reads the Creative Asset Library', () => {
    expect(flat(skill)).not.toMatch(/no cataloged operation that reads the Creative Asset Library/i);
    expect(flat(skill)).not.toMatch(/no way to look up a new one/i);
  });

  it('lists Creative Assets among the families and names both library reads', () => {
    expect(flat(skill)).toMatch(/Families:[^.]*Creative Assets/);
    for (const id of ['assets.search_by_name', 'assets.list_recent']) {
      expect(skill).toContain(`\`${id}\``);
      expect(manifest).toContain(id);
    }
  });

  it('lists the whole SD GET read surface in the skill and the manifest', () => {
    for (const id of SD_GET_READS) {
      expect(skill).toContain(`\`${id}\``);
      expect(manifest).toContain(id);
    }
    // The one SD read that is not a query-param GET is called out as such.
    expect(flat(skill)).toMatch(/`sd\.preview_creative` is the one SD read that is a \*\*POST with a body\*\*/);
  });

  it('names the SD creative writes with their 100-item cap and upper-case creativeType', () => {
    for (const id of ['sd.create_creatives', 'sd.update_creatives']) {
      expect(skill).toContain(`\`${id}\``);
      expect(manifest).toContain(id);
    }
    expect(flat(skill)).toMatch(/creative writes take at most 100/);
    expect(skill).toContain('"creativeType": "IMAGE"');
    expect(skill).toContain('"assetVersion": "version_v1"');
  });

  it('does not describe asset upload (that operation is not in the catalog yet)', () => {
    expect(skill).not.toContain('assets.upload_image');
    expect(manifest).not.toContain('assets.upload_image');
  });

  it('keeps the skill and manifest versions in step', () => {
    const skillVersion = skill.match(/^\s+version: "([^"]+)"/m)?.[1];
    const manifestVersion = manifest.match(/^version: "([^"]+)"/m)?.[1];
    expect(skillVersion).toBe('0.2.6');
    expect(manifestVersion).toBe(skillVersion);
  });
});
