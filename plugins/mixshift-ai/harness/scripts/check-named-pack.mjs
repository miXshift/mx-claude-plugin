// Release gate: every catalog query marked `dispatch: named` must resolve
// against the DEPLOYED query pack on the auth service. Catches plugin /
// service version skew at release time instead of as a user's
// `unknown_query` failure mid-skill.
//
// Run via: npx tsx scripts/check-named-pack.mjs
// Uses this machine's signed-in datahub credentials (run `mixshift auth
// login` first). Set MIXSHIFT_SKIP_PACK_CHECK=1 to bypass loudly (e.g. a
// CI box with no warehouse credentials) — never pass silently.
//
// Exits 1 on any named id missing from the deployed pack, or if the
// deployed manifest can't be fetched (fail closed: don't ship a flip you
// couldn't verify).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.MIXSHIFT_PLUGIN_ROOT = join(__dirname, '..', '..');

if (process.env.MIXSHIFT_SKIP_PACK_CHECK === '1') {
  console.log('check-named-pack: SKIPPED (MIXSHIFT_SKIP_PACK_CHECK=1).');
  process.exit(0);
}

const { loadCatalog } = await import('../src/lib/prefetch/sql-library.ts');
const { resolveDataDir } = await import('../src/lib/paths/resolve.ts');

// 1. Catalog ids that depend on the deployed pack.
const catalog = await loadCatalog();
const namedIds = catalog.queries
  .filter((q) => q.dispatch === 'named')
  .map((q) => q.id)
  .sort();

if (namedIds.length === 0) {
  console.log('check-named-pack: no dispatch:named queries in the catalog. Nothing to verify.');
  process.exit(0);
}

// 2. This machine's datahub session (api_base + bearer).
let creds;
try {
  const raw = readFileSync(join(resolveDataDir(), 'auth', 'credentials'), 'utf-8');
  creds = JSON.parse(raw).datahub;
} catch {
  creds = undefined;
}
if (!creds?.api_base || !creds?.access_token) {
  console.error(
    'check-named-pack: no datahub session found. Run `mixshift auth login` first, ' +
      'or set MIXSHIFT_SKIP_PACK_CHECK=1 to bypass (CI without warehouse creds).',
  );
  process.exit(1);
}

// 3. Deployed pack manifest.
let manifest;
try {
  const res = await fetch(`${creds.api_base}/api/named-query/ids`, {
    headers: { Authorization: `Bearer ${creds.access_token}` },
  });
  if (res.status === 401) {
    console.error('check-named-pack: session expired (401). Run `mixshift auth login` and retry.');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`check-named-pack: GET /api/named-query/ids returned ${res.status}.`);
    process.exit(1);
  }
  manifest = await res.json();
} catch (err) {
  console.error(`check-named-pack: could not reach ${creds.api_base}: ${err.message ?? err}`);
  process.exit(1);
}

const deployed = new Set(manifest.ids ?? []);
const revisions = manifest.revisions ?? {};
const missing = namedIds.filter((id) => !deployed.has(id));

for (const id of namedIds) {
  const ok = deployed.has(id);
  console.log(`${ok ? 'OK  ' : 'MISS'} ${id.padEnd(20)} ${ok ? `rev=${revisions[id] ?? '?'}` : 'NOT DEPLOYED'}`);
}

if (missing.length > 0) {
  console.error(
    `\n${missing.length} dispatch:named id(s) are NOT in the deployed pack: ${missing.join(', ')}.\n` +
      'Deploy the mx-legacy-auth query pack entries BEFORE releasing this catalog flip, ' +
      'or users hit unknown_query. (Append-only ids; ship service first, plugin flip second.)',
  );
  process.exit(1);
}

console.log(`\nAll ${namedIds.length} dispatch:named id(s) resolve against the deployed pack.`);
