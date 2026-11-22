/**
 * `mixshift ads upload-image`: the plugin's way to add a PNG or JPEG to a
 * profile's Creative Asset Library (assets.upload_image), so a plugin user
 * does not need the MixShift connector for it.
 *
 * adsAssetUpload and track are mocked; the pins are:
 *   - the preview sends the image fields and NO dryRun (the service default,
 *     TRUE, is the safety contract), with the sub type upper-cased;
 *   - the commit sends only the selector, dryRun:false, previewId and the hash;
 *   - flag mistakes are refused before anything is sent;
 *   - telemetry never carries the link, the asset name or the tags;
 *   - a lost answer on a commit says "do not commit again".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';

import { registerAdsCommands, uploadImageFlagProblem, renderUploadPreview } from './ads.js';
import { adsAssetUpload, buildAssetUploadBody } from '../lib/amazon/ads-call.js';
import { track } from '../lib/telemetry/index.js';
import { redactArgs } from '../lib/telemetry/redact.js';

vi.mock('../lib/amazon/ads-call.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/amazon/ads-call.js')>();
  return { ...actual, adsAssetUpload: vi.fn() };
});

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return { ...actual, track: vi.fn(async () => {}) };
});

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'emit machine-readable JSON to stdout', false)
    .option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR');
  registerAdsCommands(program);
  return program;
}

async function runUpload(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', 'ads', 'upload-image', ...args]);
}

const URL = 'https://cdn.example.com/brand/logo-final.png?X-Amz-Signature=abc123';
const PREVIEW_ID = '0b5f1c2e-1111-4222-8333-944455556666';
const HASH = 'a'.repeat(64);

const PREVIEW_RESULT = {
  ok: true as const,
  operation: 'assets.upload_image',
  dryRun: true,
  profileId: 'p1',
  legacySellerId: 574,
  marketplaceId: 'ATVPDKIKX0DER',
  result: {
    ok: true,
    operation: 'assets.upload_image',
    dryRun: true,
    profileId: 'p1',
    previewId: PREVIEW_ID,
    previewHash: HASH,
    expiresAt: '2026-11-22T18:00:00.000Z',
    detected: { format: 'png', contentType: 'image/png', bytes: 204800, width: 600, height: 100, sha256: 'b'.repeat(64) },
    wouldRegister: { name: 'Acme logo', assetType: 'IMAGE', assetSubType: 'LOGO', asins: null, tags: null, brandEntityId: null },
    duplicateNames: { checked: true, matched: 0, coverage: 'partial', note: '' },
    note: '',
  },
};

const COMMIT_RESULT = {
  ok: true as const,
  operation: 'assets.upload_image',
  dryRun: false,
  profileId: 'p1',
  legacySellerId: 574,
  marketplaceId: 'ATVPDKIKX0DER',
  result: {
    ok: true,
    operation: 'assets.upload_image',
    dryRun: false,
    previewId: PREVIEW_ID,
    auditId: 'audit_1',
    assetId: 'amzn1.assetlibrary.asset1.abc',
    versionId: 'version_v1',
    failedSpecChecks: [],
    note: '',
  },
};

let exitCodeBefore: typeof process.exitCode;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  vi.clearAllMocks();
  exitCodeBefore = process.exitCode;
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array): boolean => {
    stdout.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array): boolean => {
    stderr.push(String(s));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = exitCodeBefore;
});

describe('ads upload-image: preview', () => {
  it('sends the image fields, upper-cases the sub type, and never sets dryRun', async () => {
    vi.mocked(adsAssetUpload).mockResolvedValue(PREVIEW_RESULT);
    await runUpload(
      '--legacy-seller-id', '574',
      '--source-url', ` ${URL} `,
      '--name', 'Acme logo',
      '--sub-type', 'logo',
      '--asin', 'B000000001',
      '--asin', 'B000000002',
      '--tag', 'holiday',
    );
    expect(process.exitCode ?? 0).toBe(0);
    expect(adsAssetUpload).toHaveBeenCalledTimes(1);
    const [input] = vi.mocked(adsAssetUpload).mock.calls[0]!;
    expect(input).toEqual({
      legacySellerId: '574',
      sourceUrl: URL,
      name: 'Acme logo',
      assetSubType: 'LOGO',
      asins: ['B000000001', 'B000000002'],
      tags: ['holiday'],
    });
    expect(input).not.toHaveProperty('dryRun');
    const err = stderr.join('');
    expect(err).toContain('PREVIEW assets.upload_image');
    expect(err).toContain(`--commit --preview-id ${PREVIEW_ID} --approved-hash ${HASH}`);
  });

  it('refuses a preview without --source-url, --name or --sub-type, sending nothing', async () => {
    await runUpload('--profile-id', 'p1', '--name', 'Acme logo');
    expect(adsAssetUpload).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('--source-url, --sub-type');
  });

  it('refuses a link that is not https', async () => {
    await runUpload('--profile-id', 'p1', '--source-url', 'http://x.example/a.png', '--name', 'n', '--sub-type', 'LOGO');
    expect(adsAssetUpload).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('https://');
  });

  it('refuses --preview-id or --approved-hash without --commit', async () => {
    await runUpload('--profile-id', 'p1', '--source-url', URL, '--name', 'n', '--sub-type', 'LOGO', '--preview-id', PREVIEW_ID);
    expect(adsAssetUpload).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('only apply with --commit');
  });
});

describe('ads upload-image: commit', () => {
  it('sends only the selector, dryRun:false, previewId and approvedPreviewHash', async () => {
    vi.mocked(adsAssetUpload).mockResolvedValue(COMMIT_RESULT);
    await runUpload('--profile-id', 'p1', '--commit', '--preview-id', PREVIEW_ID, '--approved-hash', HASH);
    expect(process.exitCode ?? 0).toBe(0);
    const [input] = vi.mocked(adsAssetUpload).mock.calls[0]!;
    expect(input).toEqual({
      profileId: 'p1',
      dryRun: false,
      previewId: PREVIEW_ID,
      approvedPreviewHash: HASH,
    });
    expect(stderr.join('')).toContain('UPLOADED');
    expect(stdout.join('')).toContain('amzn1.assetlibrary.asset1.abc');
  });

  it('refuses a commit without the preview id and hash', async () => {
    await runUpload('--profile-id', 'p1', '--commit', '--preview-id', PREVIEW_ID);
    expect(adsAssetUpload).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('--approved-hash');
  });

  it('refuses preview fields on a commit (the commit uploads what the preview checked)', async () => {
    await runUpload('--profile-id', 'p1', '--commit', '--preview-id', PREVIEW_ID, '--approved-hash', HASH, '--name', 'other');
    expect(adsAssetUpload).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('--name belongs on the preview');
  });

  it('a lost answer on a commit says not to commit again', async () => {
    vi.mocked(adsAssetUpload).mockResolvedValue({
      ok: false,
      kind: 'host_unreachable',
      friendly: 'No answer came back.',
      requestOutcome: 'unknown',
    });
    await buildProgram().parseAsync([
      'node', 'mixshift', '--json', 'ads', 'upload-image',
      '--profile-id', 'p1', '--commit', '--preview-id', PREVIEW_ID, '--approved-hash', HASH,
    ]);
    const out = JSON.parse(stdout.join(''));
    expect(out.status).toBe('error');
    expect(out.next_step).toContain('Do NOT commit again');
  });
});

describe('ads upload-image: telemetry', () => {
  it('never carries the link, the asset name or the tags', async () => {
    vi.mocked(adsAssetUpload).mockResolvedValue(PREVIEW_RESULT);
    await runUpload('--profile-id', 'p1', '--source-url', URL, '--name', 'Acme logo', '--sub-type', 'LOGO', '--tag', 'holiday');
    vi.mocked(adsAssetUpload).mockResolvedValue({ ok: false, kind: 'invalid_request', friendly: 'Refused.' });
    await runUpload('--profile-id', 'p1', '--source-url', URL, '--name', 'Acme logo', '--sub-type', 'LOGO', '--tag', 'holiday');
    expect(track).toHaveBeenCalledTimes(2);
    for (const [event] of vi.mocked(track).mock.calls) {
      const s = JSON.stringify(event);
      expect(s).toContain('assets.upload_image');
      expect(s).not.toContain('cdn.example.com');
      expect(s).not.toContain('Acme logo');
      expect(s).not.toContain('holiday');
    }
  });

  it('the captured command line drops the link, the name and the tags, in both flag forms', () => {
    expect(
      redactArgs([
        'ads', 'upload-image', '--profile-id', 'p1', '--source-url', URL, '--name', 'Acme logo',
        '--sub-type', 'LOGO', '--tag', 'holiday', `--name=Acme logo 2`, `--source-url=${URL}`,
      ]),
    ).toEqual([
      'ads', 'upload-image', '--profile-id', 'p1', '--source-url', '<redacted>', '--name', '<redacted>',
      '--sub-type', 'LOGO', '--tag', '<redacted>', '--name=<redacted>', '--source-url=<redacted>',
    ]);
    // Another ads command keeps its --name as before.
    expect(redactArgs(['ads', 'call', 'x', '--name', 'keep'])).toEqual(['ads', 'call', 'x', '--name', 'keep']);
  });
});

describe('buildAssetUploadBody and renderUploadPreview', () => {
  it('sends only the fields that were set', () => {
    expect(buildAssetUploadBody({ legacySellerId: '574', sourceUrl: URL, name: 'n', assetSubType: 'LOGO' })).toEqual({
      legacySellerId: 574,
      sourceUrl: URL,
      name: 'n',
      assetSubType: 'LOGO',
    });
    expect(buildAssetUploadBody({ profileId: 'p1', dryRun: false, previewId: PREVIEW_ID, approvedPreviewHash: HASH })).toEqual({
      profileId: 'p1',
      dryRun: false,
      previewId: PREVIEW_ID,
      approvedPreviewHash: HASH,
    });
  });

  it('the preview summary names similar assets when there are some', () => {
    const text = renderUploadPreview('p1', {
      ...PREVIEW_RESULT.result,
      duplicateNames: { checked: true, matched: 2, coverage: 'complete', note: '' },
    });
    expect(text).toContain('2 asset(s) in the library already have a similar name');
    expect(text).toContain('600x100, 200 KB');
  });

  it('flag checks: a valid preview and a valid commit pass', () => {
    expect(uploadImageFlagProblem({ sourceUrl: URL, name: 'n', subType: 'LOGO', asin: [], tag: [] })).toBeNull();
    expect(
      uploadImageFlagProblem({ commit: true, previewId: PREVIEW_ID, approvedHash: HASH, asin: [], tag: [] }),
    ).toBeNull();
  });
});

describe('ads upload-image: redaction of mistyped lines (argv is captured before parsing)', () => {
  const SIGNED =
    'https://bucket.s3.amazonaws.com/logo.png?X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=deadbeef';
  const cases: string[][] = [
    ['ads', 'upload-imgae', '--source-url', SIGNED],
    ['ads', 'upload-image', '--url', SIGNED],
    ['ads', 'upload-image', '--source', SIGNED],
    ['ads', 'upload-image', '--name', 'Logo', SIGNED],
    ['upload-image', '--source-url', SIGNED],
    ['ads', 'upload-image', '--url=' + SIGNED],
    ['ads', 'upload-image', '--url', 'https://cdn.example.com/plain-logo.png'],
    ['ads', 'image-upload', '--url', 'https://cdn.example.com/plain-logo.png'],
  ];
  for (const argv of cases) {
    it('drops the link from ' + argv.slice(0, 3).join(' '), () => {
      const out = redactArgs(argv).join(' ');
      expect(out).not.toContain('amazonaws.com');
      expect(out).not.toContain('cdn.example.com');
      expect(out).toContain('<redacted>');
    });
  }

  it('drops a signed link and a --source-url value on any command line', () => {
    expect(redactArgs(['ads', 'call', 'x', '--note', SIGNED])).toEqual(['ads', 'call', 'x', '--note', '<redacted>']);
    expect(redactArgs(['doctor', '--source-url', 'https://cdn.example.com/a.png'])).toEqual([
      'doctor',
      '--source-url',
      '<redacted>',
    ]);
    // An unrelated line that merely mentions uploading keeps its values.
    expect(redactArgs(['ads', 'call', 'x', '--note', 'upload later', '--name', 'keep'])).toEqual([
      'ads',
      'call',
      'x',
      '--note',
      'upload later',
      '--name',
      'keep',
    ]);
    // forecast budget keeps its own rule even with an upload-ish word on the line.
    expect(
      redactArgs(['forecast', 'budget', 'set', '--note', '--set', '2026-01=5000', '--x', 'upload-image']),
    ).toEqual(['forecast', 'budget', 'set', '--note', '--set', '2026-01=<redacted>', '--x', 'upload-image']);
    // A plain link with no query string on another command stays.
    expect(redactArgs(['ads', 'call', 'x', '--note', 'https://example.com/a'])).toEqual([
      'ads',
      'call',
      'x',
      '--note',
      'https://example.com/a',
    ]);
  });
});

describe('renderUploadPreview: everything the commit will register', () => {
  it('names the ASINs, tags, brand entity, download host and similar names', () => {
    const text = renderUploadPreview('p1', {
      ...PREVIEW_RESULT.result,
      source: { url: URL, finalUrl: 'https://img.example.net/final.png', redirects: 1 },
      wouldRegister: {
        name: 'Acme logo',
        assetType: 'IMAGE',
        assetSubType: 'LOGO',
        asins: ['B000000001'],
        tags: ['holiday'],
        brandEntityId: 'ENTITY1',
      },
      duplicateNames: {
        checked: true,
        matched: 1,
        coverage: 'complete',
        matches: [{ assetId: 'a1', name: 'Acme logo v1', assetType: 'IMAGE' }],
        note: '',
      },
    });
    expect(text).toContain('downloaded from img.example.net after 1 redirect(s)');
    expect(text).toContain('ASINs: B000000001');
    expect(text).toContain('tags: holiday');
    expect(text).toContain('brand entity id: ENTITY1');
    expect(text).toContain('"Acme logo v1"');
  });

  it('does not claim absence the search could not prove', () => {
    const text = renderUploadPreview('p1', PREVIEW_RESULT.result);
    expect(text).toContain(
      'no similar name found in the part of the library that was searched (coverage: partial)',
    );
    expect(text).not.toContain('no asset in the library has a similar name');
  });
});
