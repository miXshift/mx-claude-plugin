/**
 * Copy guard for the mx-amazon-ads skill's Sponsored Display and Creative
 * Assets text (mx-ops#284). The gateway catalog gained the SD creative reads
 * (sd.list_creatives, sd.preview_creative, sd.list_creative_moderations), the
 * SD creative writes (sd.create_creatives, sd.update_creatives) and a name
 * search over the Creative Asset Library (assets.search_by_name). Before this,
 * the skill still told the agent that no operation reads the asset library and
 * listed only four SD reads, so an agent would send a user to the Amazon
 * console for an asset id it could look up itself. Slice 3 (mx-gateway#526)
 * added image upload by https link as its own service, not a catalog entry;
 * the skill describes it without claiming it as an operation.
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

  // assets.upload_image (mx-gateway#526, mx-ops#284 slice 3) is its own service,
  // reached through the MCP tool amazon_ads_asset_upload or POST
  // /api/amazon/ads/assets/upload. It is NOT a catalog operation, so
  // `mixshift ads call` cannot run it and the plugin CLI has no command for it.
  describe('asset upload by https link (assets.upload_image)', () => {
    it('describes the upload in the skill and the manifest', () => {
      for (const text of [skill, manifest]) {
        expect(text).toContain('assets.upload_image');
        expect(text).toContain('amazon_ads_asset_upload');
        expect(text).toContain('/api/amazon/ads/assets/upload');
        expect(flat(text)).toMatch(/NOT (an operation of the catalog|a catalog operation)/i);
      }
    });

    it('states the write contract: dry run, user go, previewId + approvedPreviewHash, 30 minutes', () => {
      const s = flat(skill);
      expect(s).toMatch(/Dry run first; it is the default/);
      expect(s).toMatch(/explicit go/);
      expect(skill).toContain('`approvedPreviewHash`');
      expect(skill).toContain('`previewId`');
      expect(s).toMatch(/within 30 minutes/);
      expect(s).toMatch(/cannot delete it/);
      expect(s).toMatch(/Images only\.\*\* A new video still goes in through the Amazon Ads console/);
      for (const sub of ['LOGO', 'PRODUCT_IMAGE', 'LIFESTYLE_IMAGE', 'OTHER_IMAGE', 'AUTHOR_IMAGE']) {
        expect(skill).toContain(`\`${sub}\``);
        expect(manifest).toContain(sub);
      }
      for (const kind of ['asset_upload_not_enabled', 'asset_upload_disabled']) {
        expect(skill).toContain(`\`${kind}\``);
      }
    });

    it('never claims it as a catalog operation (release drift gate stays green)', () => {
      // check-catalog-drift treats a backticked id, or an id after "ads call",
      // as a capability claim; the assets namespace is in the catalog, so either
      // form would fail the release gate for an op the catalog does not have.
      for (const text of [skill, manifest]) {
        expect(text).not.toContain('`assets.upload_image`');
        expect(text).not.toMatch(/(?:ads|spapi|amazon)\s+call\s+(?:--operation\s+)?assets\.upload_image/);
        expect(text).not.toMatch(/--operation[=\s]+assets\.upload_image/);
        expect(text).not.toMatch(/^\s*-\s*mixshift[^\n]*assets\.upload_image/m);
      }
    });
  });

  it('keeps the skill and manifest versions in step', () => {
    const skillVersion = skill.match(/^\s+version: "([^"]+)"/m)?.[1];
    const manifestVersion = manifest.match(/^version: "([^"]+)"/m)?.[1];
    expect(skillVersion).toBe('0.2.7');
    expect(manifestVersion).toBe(skillVersion);
  });
});
