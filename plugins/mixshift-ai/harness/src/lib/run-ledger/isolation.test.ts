import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { readLocalDocs } from '../context-sync/local.js';
import { ledgerDir, statePath } from './local.js';

/**
 * Run state is NOT brand context (mx-ops#202). The run ledger never rides context
 * sync (the four brand docs plus corpora/), and the ledger code never talks to the
 * brand context service. Both directions are held here.
 */

const here = dirname(fileURLToPath(import.meta.url));
let dataDir: string;

beforeEach(async () => {
  dataDir = join(tmpdir(), `mxtest-runledger-iso-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(dataDir, { recursive: true });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function sources(dir: string): Promise<Array<{ name: string; text: string }>> {
  const out: Array<{ name: string; text: string }> = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      out.push({ name: e.name, text: await readFile(join(dir, e.name), 'utf8') });
    }
  }
  return out;
}

describe('the run ledger stays out of brand context', () => {
  it('context sync enumerates the four brand docs and corpora only, never the ledger or its state', async () => {
    const brand = 'acme-goods';
    const brandRoot = join(dataDir, 'clients', brand);
    await mkdir(join(brandRoot, 'corpora'), { recursive: true });
    await writeFile(join(brandRoot, 'context.yaml'), 'brand: acme-goods\n');
    await writeFile(join(brandRoot, 'corpora', 'notes.md'), 'notes');
    const ledger = ledgerDir(brand, 'mx-max-report', dataDir);
    await mkdir(join(ledger, 'fragments'), { recursive: true });
    await writeFile(join(ledger, 'publish-registry.json'), '{"client_hub_url":"https://example.test/hub"}');
    await writeFile(join(ledger, 'fragments', '2026-09-client.html'), '<section/>');
    await writeFile(statePath(brand, dataDir), '{}');

    const docs = await readLocalDocs(brand, dataDir);
    expect(docs.map((d) => d.key).sort()).toEqual(['context', 'corpus/notes.md']);
    for (const d of docs) {
      expect(d.path).not.toContain('runs');
      expect(d.content).not.toContain('example.test/hub');
    }
  });

  it('the context sync code never mentions the run ledger', async () => {
    for (const f of await sources(join(here, '..', 'context-sync'))) {
      expect(f.text, f.name).not.toMatch(/run-ledger|runLedger|RunLedger/);
    }
  });

  it('the run ledger code never calls the brand context service', async () => {
    for (const f of await sources(here)) {
      expect(f.text, f.name).not.toMatch(/\/api\/context|createContextSyncClient/);
    }
  });
});
