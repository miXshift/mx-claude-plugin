import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  corpusKey,
  hashContent,
  isSafeCorpusName,
  listLocalBrands,
  localPathForKey,
  readLocalDocs,
} from './local.js';
import { brandDir, corporaDir } from '../paths/resolve.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `mxtest-ctxsync-local-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

/** Seed one brand dir with all five doc kinds + local-only noise. */
async function seedBrand(slug: string): Promise<void> {
  const dir = brandDir(slug, testDir);
  await mkdir(join(dir, 'corpora'), { recursive: true });
  await mkdir(join(dir, 'runs', 'mx-daily-health-check', '2026-07-01'), {
    recursive: true,
  });

  await writeFile(join(dir, 'context.yaml'), 'brand_slug: acme\n', 'utf8');
  await writeFile(join(dir, 'narrative.md'), '# Acme\n\nStory.\n', 'utf8');
  await writeFile(join(dir, 'brand-brain.yaml'), 'facts: []\n', 'utf8');
  await writeFile(join(dir, 'config.yaml'), 'skills: {}\n', 'utf8');
  await writeFile(join(dir, 'corpora', 'tone.md'), 'Friendly.\n', 'utf8');
  await writeFile(join(dir, 'corpora', 'competitors.csv'), 'name\nRival\n', 'utf8');

  // Local-only files that must NOT be enumerated:
  await writeFile(join(dir, '.brain-status.json'), '{}', 'utf8');
  await writeFile(join(dir, '.pending-discoveries.json'), '{}', 'utf8');
  await writeFile(join(dir, '.context-sync-state.json'), '{}', 'utf8');
  await writeFile(join(dir, 'brand-context.html'), '<html></html>', 'utf8');
  await writeFile(
    join(dir, 'runs', 'mx-daily-health-check', '2026-07-01', 'ocl.yaml'),
    'x: 1\n',
    'utf8',
  );
  await writeFile(join(dir, 'corpora', '.DS_Store'), 'junk', 'utf8');
  // Directories inside corpora are not corpus docs:
  await mkdir(join(dir, 'corpora', 'nested'), { recursive: true });
  await writeFile(join(dir, 'corpora', 'nested', 'deep.md'), 'no\n', 'utf8');
}

describe('isSafeCorpusName', () => {
  it('accepts ordinary portable filenames', () => {
    for (const name of [
      'tone.md',
      'competitors.csv',
      'a',
      'A-b_c.1.MD',
      'x'.repeat(128),
      'v1.2.3-notes.txt',
    ]) {
      expect(isSafeCorpusName(name), name).toBe(true);
    }
  });

  it('rejects traversal, separators, streams, dot-names, and oversized names', () => {
    for (const name of [
      '../x', // traversal
      '..', // bare traversal
      'a/b', // path separator
      'a\\b', // Windows path separator
      'a:b', // NTFS alternate data stream
      '.hidden', // dot-file (local-only namespace)
      '', // empty
      'x'.repeat(129), // over length cap
      'a b.md', // space (outside the server sanitizer set)
      'café.md', // non-ASCII (outside the server sanitizer set)
      'a..b', // '..' substring
    ]) {
      expect(isSafeCorpusName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe('hashContent', () => {
  it('is sha256 hex lowercase over utf8 bytes (the wire algorithm)', () => {
    const content = 'brand_slug: acme\nnote: café ✓\n';
    const expected = createHash('sha256').update(content, 'utf8').digest('hex');
    expect(hashContent(content)).toBe(expected);
    expect(hashContent(content)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('listLocalBrands', () => {
  it('returns [] when the clients dir does not exist', async () => {
    expect(await listLocalBrands(testDir)).toEqual([]);
  });

  it('lists directories only, sorted', async () => {
    await mkdir(join(testDir, 'clients', 'zeta'), { recursive: true });
    await mkdir(join(testDir, 'clients', 'acme'), { recursive: true });
    await writeFile(join(testDir, 'clients', 'index.yaml'), 'brands: []\n', 'utf8');
    expect(await listLocalBrands(testDir)).toEqual(['acme', 'zeta']);
  });
});

describe('readLocalDocs', () => {
  it('enumerates all five doc kinds with keys, types, and hashes', async () => {
    await seedBrand('acme');
    const docs = await readLocalDocs('acme', testDir);

    expect(docs.map((d) => d.key)).toEqual([
      'context',
      'narrative',
      'brain',
      'config',
      'corpus/competitors.csv',
      'corpus/tone.md',
    ]);

    const context = docs.find((d) => d.key === 'context')!;
    expect(context.docType).toBe('context');
    expect(context.corpusName).toBeUndefined();
    expect(context.content).toBe('brand_slug: acme\n');
    expect(context.hash).toBe(hashContent('brand_slug: acme\n'));

    const tone = docs.find((d) => d.key === 'corpus/tone.md')!;
    expect(tone.docType).toBe('corpus');
    expect(tone.corpusName).toBe('tone.md');
    expect(tone.path).toBe(join(corporaDir('acme', testDir), 'tone.md'));
  });

  it('excludes dot-files, runs/, rendered HTML, and nested corpora entries', async () => {
    await seedBrand('acme');
    const docs = await readLocalDocs('acme', testDir);
    const keys = docs.map((d) => d.key);
    expect(keys).not.toContain('corpus/.DS_Store');
    expect(keys.some((k) => k.includes('brain-status'))).toBe(false);
    expect(keys.some((k) => k.includes('html'))).toBe(false);
    expect(keys.some((k) => k.includes('runs'))).toBe(false);
    expect(keys.some((k) => k.includes('nested'))).toBe(false);
    expect(keys.some((k) => k.includes('deep'))).toBe(false);
  });

  it('returns only the docs that exist (partial brand dir)', async () => {
    const dir = brandDir('sparse', testDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'context.yaml'), 'a: 1\n', 'utf8');
    const docs = await readLocalDocs('sparse', testDir);
    expect(docs.map((d) => d.key)).toEqual(['context']);
  });

  it('returns [] for a brand dir that does not exist', async () => {
    expect(await readLocalDocs('ghost', testDir)).toEqual([]);
  });

  it('skips leftover atomic-write tmp files (dot-prefixed) in corpora/', async () => {
    // A crashed pull may leave `.<name>.tmp.<pid>.<ts>` behind; it must
    // never be enumerated (a non-dot leftover would be PUSHED org-wide).
    const dir = brandDir('acme', testDir);
    await mkdir(join(dir, 'corpora'), { recursive: true });
    await writeFile(join(dir, 'corpora', 'foo.csv'), 'a,b\n', 'utf8');
    await writeFile(join(dir, 'corpora', '.foo.csv.tmp.123.456'), 'partial', 'utf8');
    const docs = await readLocalDocs('acme', testDir);
    expect(docs.map((d) => d.key)).toEqual(['corpus/foo.csv']);
  });

  it('reads content verbatim (no YAML re-serialization)', async () => {
    const dir = brandDir('verbatim', testDir);
    await mkdir(dir, { recursive: true });
    const funky = '# AM comment\nbrand_slug:   "acme"   # trailing\n\n\n';
    await writeFile(join(dir, 'context.yaml'), funky, 'utf8');
    const docs = await readLocalDocs('verbatim', testDir);
    expect(docs[0]!.content).toBe(funky);
  });
});

describe('localPathForKey', () => {
  it('round-trips every enumerated doc back to its own path', async () => {
    await seedBrand('acme');
    const docs = await readLocalDocs('acme', testDir);
    for (const doc of docs) {
      expect(localPathForKey('acme', doc.key, testDir)).toBe(doc.path);
    }
  });

  it('maps corpus keys into corpora/', () => {
    expect(localPathForKey('acme', corpusKey('faq.md'), testDir)).toBe(
      join(corporaDir('acme', testDir), 'faq.md'),
    );
  });

  it('throws on unsafe corpus keys instead of resolving outside corpora/ (last-ditch traversal defense)', () => {
    for (const name of ['../x', '..\\..\\evil', 'a:b', '.hidden', '']) {
      expect(() => localPathForKey('acme', corpusKey(name), testDir)).toThrow(/unsafe corpus name/);
    }
  });
});
