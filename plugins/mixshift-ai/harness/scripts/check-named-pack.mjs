// Release gate: every catalog query marked `dispatch: named` must resolve
// against the DEPLOYED query pack on the auth service. Catches plugin /
// service version skew at release time instead of as a user's
// `unknown_query` failure mid-skill.
//
// Run via: npx tsx scripts/check-named-pack.mjs
// Release CI sets MIXSHIFT_PACK_CHECK_API_BASE and reads the public,
// tenant-free `/.well-known/mixshift-query-pack` manifest. Local runs fall
// back to the signed-in datahub api_base and, while an older gateway deploy is
// still live, its authenticated `/api/named-query/ids` endpoint.
//
// Exits 1 on any named id missing from the deployed pack, or if the
// deployed manifest can't be fetched (fail closed: don't ship a flip you
// couldn't verify).
//
// Set MIXSHIFT_SKIP_PACK_CHECK=1 to bypass loudly for local/offline use only
// (e.g. no network, or working on an unrelated change) — never pass silently,
// and never set it as a repository or organization Actions variable: a
// skipped gate still renders as a green check, so a standing skip in CI
// config would hide real plugin/pack skew instead of catching it.

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
const { checkNamedPackCompat } = await import('../src/lib/data/named-pack-check.ts');

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

// 2. Resolve the deployment to verify. CI supplies only a public API base.
//    Local runs may use a signed-in session for the temporary legacy fallback.
let creds;
try {
  const raw = readFileSync(join(resolveDataDir(), 'auth', 'credentials'), 'utf-8');
  creds = JSON.parse(raw).datahub;
} catch {
  creds = undefined;
}
const apiBase = process.env.MIXSHIFT_PACK_CHECK_API_BASE ?? creds?.api_base;
if (!apiBase) {
  console.error(
    'check-named-pack: no deployment configured. Set MIXSHIFT_PACK_CHECK_API_BASE ' +
      'or run `mixshift auth login` for a local check.',
  );
  process.exit(1);
}

// 3. Public manifest first; authenticated endpoint only as a 404 fallback.
const result = await checkNamedPackCompat({
  apiBase,
  accessToken: creds?.access_token,
});
if (!result.checked) {
  console.error(`check-named-pack: ${result.reason ?? 'deployment could not be verified'}.`);
  process.exit(1);
}

for (const id of namedIds) {
  const missing = result.missing.includes(id);
  console.log(
    `${missing ? 'MISS' : 'OK  '} ${id.padEnd(20)} ` +
      `${missing ? 'NOT DEPLOYED' : `rev=${result.revisions[id] ?? '?'}`}`,
  );
}

if (!result.ok) {
  console.error(
    `\n${result.missing.length} dispatch:named id(s) are NOT in the deployed pack: ` +
      `${result.missing.join(', ')}.\n` +
      'Deploy the mx-legacy-auth query pack entries BEFORE releasing this catalog flip, ' +
      'or users hit unknown_query. (Append-only ids; ship service first, plugin flip second.)',
  );
  process.exit(1);
}

console.log(`\nAll ${result.total} dispatch:named id(s) resolve against the deployed pack.`);
