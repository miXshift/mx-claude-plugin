#!/usr/bin/env node
/**
 * package-zip.mjs
 *
 * Builds the two org-distribution release zips that the GitHub "Upload plugin"
 * console and the private-mirror path consume:
 *
 *   dist-zip/mixshift-ai-plugin-<version>.zip
 *     Single-plugin layout. The plugin's own contents sit at the zip ROOT
 *     (.claude-plugin/plugin.json, hooks/, harness/bin/, harness/dist/,
 *     skills/, ...), so the admin console sees a plugin folder directly.
 *     NOTE: no top-level bin/ — the claude.ai validator rejects it; PATH
 *     registration happens via the SessionStart hook instead.
 *
 *   dist-zip/mixshift-ai-marketplace-<version>.zip
 *     Marketplace layout: .claude-plugin/marketplace.json at the root plus the
 *     plugin under plugins/mixshift-ai/, mirroring the repo, for consoles that
 *     ingest a marketplace.
 *
 * Both carry LICENSE + NOTICE at the zip root.
 *
 * CRITICAL — every file byte comes from the committed git BLOB (git cat-file),
 * never the working tree. On Windows `core.autocrlf=true` inflates the checked
 * out dist/cli.js with CRLF, which would (a) break the bin/mixshift bundle
 * integrity preflight (it compares against build-meta output_bytes, an LF count)
 * and (b) make the zip non-reproducible across platforms. The blob is the LF
 * bytes esbuild actually emitted. This is why the GitHub runner (ubuntu) and a
 * Windows dev box produce byte-identical zips.
 *
 * Standalone: Node builtins plus the `yaml` package (already a harness runtime
 * dependency; used to parse SKILL.md frontmatter for the admin-console rules).
 * No zip dependency — the zip writer below is a minimal DEFLATE +
 * central-directory implementation on top of zlib.
 *
 * Usage:  node scripts/package-zip.mjs            (from harness/, or anywhere)
 *         npm run package-zip
 */

import { deflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// git helpers — everything sources from the committed tree at HEAD.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

// Repo root, so the script (and its git pathspecs) work from any cwd. Every
// later git call is pinned to this directory so pathspecs and ls-files output
// are repo-relative regardless of where the script was invoked from.
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', cwd: REPO_ROOT, ...opts });
}

/** Raw bytes of a committed blob at HEAD (LF-exact, no autocrlf filtering). */
function blob(pathInRepo) {
  return execFileSync('git', ['cat-file', 'blob', `HEAD:${pathInRepo}`], {
    cwd: REPO_ROOT,
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Byte size of a committed blob at HEAD. */
function blobSize(pathInRepo) {
  return parseInt(git(['cat-file', '-s', `HEAD:${pathInRepo}`]).trim(), 10);
}

/** Tracked files under a repo-relative directory. */
function lsFiles(pathInRepo) {
  return git(['ls-files', pathInRepo])
    .split(/\r?\n/)
    .filter(Boolean);
}

function fail(msg) {
  console.error(`✗ package-zip: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer (store nothing; DEFLATE everything via zlib.deflateRawSync)
// ---------------------------------------------------------------------------

// CRC-32 (IEEE 802.3), standard table implementation. zlib.crc32 only exists on
// Node >= 22.2; the harness targets >= 20, so compute it ourselves.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed DOS timestamp (2020-01-01 00:00:00) for reproducible archives.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

/**
 * Build a zip Buffer from entries [{ name, data, mode }].
 * name uses forward slashes; no wrapper top-level folder is added.
 */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const compressed = deflateRawSync(entry.data, { level: 9 });
    // If deflate somehow expands tiny inputs, store raw instead (method 0).
    const useStore = compressed.length >= entry.data.length;
    const method = useStore ? 0 : 8;
    const body = useStore ? entry.data : compressed;

    // Local file header
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18); // compressed size
    lfh.writeUInt32LE(entry.data.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra len

    chunks.push(lfh, nameBuf, body);

    // Central directory record for this entry
    const cdh = Buffer.alloc(46);
    const mode = entry.mode ?? 0o644;
    const externalAttrs = ((0o100000 | mode) << 16) >>> 0; // unix regular file
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE((3 << 8) | 20, 4); // version made by: unix, 2.0
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0, 8); // flags
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(DOS_TIME, 12);
    cdh.writeUInt16LE(DOS_DATE, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(entry.data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra len
    cdh.writeUInt16LE(0, 32); // comment len
    cdh.writeUInt16LE(0, 34); // disk number
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(externalAttrs, 38);
    cdh.writeUInt32LE(offset, 42); // local header offset

    central.push(Buffer.concat([cdh, nameBuf]));

    offset += lfh.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk w/ central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ---------------------------------------------------------------------------
// Version consistency
// ---------------------------------------------------------------------------

// Read the manifests from the committed HEAD blobs, same as every packaged
// byte: reading the working tree here would let an uncommitted version bump
// name the zip one version while the packaged manifests inside carry another.
const pluginJson = JSON.parse(
  blob('plugins/mixshift-ai/.claude-plugin/plugin.json').toString('utf8')
);
const marketplaceJson = JSON.parse(blob('.claude-plugin/marketplace.json').toString('utf8'));
const version = pluginJson.version;
const mpEntry =
  (marketplaceJson.plugins ?? []).find((p) => p.name === pluginJson.name) ??
  marketplaceJson.plugins?.[0];
const mpVersion = mpEntry?.version;

if (!version) fail('plugin.json has no version.');
if (version !== mpVersion) {
  fail(
    `version drift: plugin.json = "${version}" but marketplace.json = "${mpVersion}". ` +
      'Sync them (CONTRIBUTING.md) before packaging.',
  );
}

// ---------------------------------------------------------------------------
// Build-meta / cli.js integrity (committed blob bytes)
// ---------------------------------------------------------------------------

const CLI_REPO_PATH = 'plugins/mixshift-ai/harness/dist/cli.js';
const META_REPO_PATH = 'plugins/mixshift-ai/harness/dist/build-meta.json';

let buildMeta;
try {
  buildMeta = JSON.parse(blob(META_REPO_PATH).toString('utf8'));
} catch (err) {
  fail(`cannot read committed ${META_REPO_PATH} (build + commit dist first): ${err.message}`);
}
const expectedBytes = buildMeta.output_bytes;
if (!Number.isFinite(expectedBytes)) fail('build-meta.json has no numeric output_bytes.');

const cliBlobSize = blobSize(CLI_REPO_PATH);
if (cliBlobSize !== expectedBytes) {
  fail(
    `dist/cli.js committed blob is ${cliBlobSize} bytes but build-meta output_bytes is ` +
      `${expectedBytes}. Rebuild (npm run build) and commit dist/ so they agree.`,
  );
}

// ---------------------------------------------------------------------------
// Collect the INCLUDE file set from the committed tree.
// ---------------------------------------------------------------------------

const PLUGIN_PREFIX = 'plugins/mixshift-ai/';
const EXACT = new Set([
  '.claude-plugin/plugin.json',
  '.mcp.json',
  '.mixshift-defaults.yaml',
  'harness/dist/cli.js',
  'harness/dist/build-meta.json',
  'harness/package.json',
]);
const PREFIXES = ['harness/bin/', 'hooks/', 'harness/assets/', 'shared/', 'skills/'];
const EXEC_RELS = new Set(['harness/bin/mixshift', 'harness/dist/cli.js']);

function isIncluded(rel) {
  if (EXACT.has(rel)) return true;
  return PREFIXES.some((p) => rel.startsWith(p));
}

const pluginRels = lsFiles('plugins/mixshift-ai')
  .map((p) => p.slice(PLUGIN_PREFIX.length))
  .filter(isIncluded)
  .sort();

if (!pluginRels.includes('.claude-plugin/plugin.json')) fail('plugin.json not found in tracked set.');
if (!pluginRels.includes('harness/package.json')) {
  fail('harness/package.json missing — required so the CLI runs as ESM (avoids MODULE_TYPELESS warning).');
}
if (!pluginRels.includes('harness/dist/cli.js')) fail('harness/dist/cli.js not found in tracked set.');
if (pluginRels.some((rel) => rel.startsWith('bin/'))) {
  fail('top-level bin/ made it into the payload set — the claude.ai validator rejects it.');
}
if (!pluginRels.includes('hooks/hooks.json')) {
  fail('hooks/hooks.json not found in tracked set — the PATH-registration hook must ship.');
}
try {
  const h = JSON.parse(blob(PLUGIN_PREFIX + 'hooks/hooks.json').toString('utf8'));
  const ss = h?.hooks?.SessionStart;
  if (!Array.isArray(ss) || ss.length === 0 || !ss.some((m) => (m?.hooks ?? []).some((x) => x?.type === 'command'))) {
    fail('hooks/hooks.json malformed: expected hooks.SessionStart[].hooks[] with a command entry.');
  }
} catch (err) {
  fail(`hooks/hooks.json is not valid JSON: ${err.message}`);
}

// Cache each plugin blob once; reused across both layouts.
const pluginBlobs = new Map();
for (const rel of pluginRels) pluginBlobs.set(rel, blob(PLUGIN_PREFIX + rel));

const licenseBuf = blob('LICENSE');
const noticeBuf = blob('NOTICE');
const marketplaceBuf = blob('.claude-plugin/marketplace.json');

// ---------------------------------------------------------------------------
// Claude admin-console upload rules. Source: the console's EXACT rejection
// strings from a live claude.ai org admin-console upload (discovered
// 2026-07-13):
//   "Plugin validation failed: Plugin description must be at most 500 characters."
//   "Skill 'skills/mx-brand-context': SKILL.md description cannot contain XML tags"
// Enforced on the PACKAGED bytes so a zip that would bounce off the console
// can never ship. Same rules gate PRs in check-docs.mjs. Skill description
// LENGTH is deliberately unchecked — the console only enforces length on the
// plugin description, and shortening skill descriptions degrades triggering.
// ---------------------------------------------------------------------------

const CONSOLE_DESC_MAX = 500;
const XML_TAG = /<[^>]+>/;

function assertConsoleDescription(label, desc) {
  if (typeof desc !== 'string' || desc.trim() === '') fail(`${label} is missing or empty.`);
  if (desc.length > CONSOLE_DESC_MAX) {
    fail(
      `${label} is ${desc.length} chars; the Claude admin console rejects plugin ` +
        `descriptions over ${CONSOLE_DESC_MAX}.`,
    );
  }
  const tag = desc.match(XML_TAG);
  if (tag) {
    fail(
      `${label} contains an XML-like tag (${tag[0]}); the Claude admin console rejects it. ` +
        'Use [placeholder] instead of <placeholder>.',
    );
  }
}

const packagedPluginJson = JSON.parse(pluginBlobs.get('.claude-plugin/plugin.json').toString('utf8'));
assertConsoleDescription('plugin.json description', packagedPluginJson.description);

const packagedMarketplace = JSON.parse(marketplaceBuf.toString('utf8'));
for (const [i, p] of (packagedMarketplace.plugins ?? []).entries()) {
  assertConsoleDescription(`marketplace.json plugins[${i}] ("${p.name}") description`, p.description);
}

for (const rel of pluginRels) {
  const m = rel.match(/^skills\/([^/]+)\/SKILL\.md$/);
  if (!m) continue;
  const raw = pluginBlobs.get(rel).toString('utf8');
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) fail(`${rel} has no frontmatter block.`);
  let fm;
  try {
    fm = parseYaml(fmMatch[1]) ?? {};
  } catch (err) {
    fail(`${rel} frontmatter does not parse as YAML: ${err.message}`);
  }
  const desc = fm.description;
  if (typeof desc !== 'string' || desc.trim() === '') fail(`${rel} frontmatter has no description.`);
  const tag = desc.match(XML_TAG);
  if (tag) {
    fail(
      `${rel} frontmatter description contains an XML-like tag (${tag[0]}); the Claude ` +
        'admin console rejects it ("SKILL.md description cannot contain XML tags"). ' +
        'Use [placeholder] instead of <placeholder>.',
    );
  }
}

function modeFor(rel) {
  return EXEC_RELS.has(rel) ? 0o755 : 0o644;
}

// Layout A — single plugin at zip root.
const entriesA = [
  ...pluginRels.map((rel) => ({ name: rel, data: pluginBlobs.get(rel), mode: modeFor(rel) })),
  { name: 'LICENSE', data: licenseBuf, mode: 0o644 },
  { name: 'NOTICE', data: noticeBuf, mode: 0o644 },
];

// Layout B — marketplace layout mirroring the repo.
const entriesB = [
  { name: '.claude-plugin/marketplace.json', data: marketplaceBuf, mode: 0o644 },
  ...pluginRels.map((rel) => ({ name: PLUGIN_PREFIX + rel, data: pluginBlobs.get(rel), mode: modeFor(rel) })),
  { name: 'LICENSE', data: licenseBuf, mode: 0o644 },
  { name: 'NOTICE', data: noticeBuf, mode: 0o644 },
];

// ---------------------------------------------------------------------------
// Post-build assertions on the entry set (fail loudly on any violation).
// ---------------------------------------------------------------------------

function assertLayout(entries, { mustContain, cliEntryName, label }) {
  const names = entries.map((e) => e.name);

  // (1) cli.js uncompressed size === build-meta output_bytes
  const cli = entries.find((e) => e.name === cliEntryName);
  if (!cli) fail(`[${label}] missing cli.js entry ${cliEntryName}.`);
  if (cli.data.length !== expectedBytes) {
    fail(
      `[${label}] cli.js entry is ${cli.data.length} bytes but build-meta output_bytes is ` +
        `${expectedBytes}.`,
    );
  }

  // (2) max folder depth <= 8 (directory components before the filename)
  for (const name of names) {
    const depth = name.split('/').length - 1;
    if (depth > 8) fail(`[${label}] entry exceeds depth 8 (${depth}): ${name}`);
  }

  // (3) required manifest present
  if (!names.includes(mustContain)) fail(`[${label}] zip is missing ${mustContain}.`);

  // (4) no excluded path leaked. The directory patterns are anchored to the
  // HARNESS root on purpose: they guard the maintainer dirs (harness/src,
  // harness/test, harness/testdata, harness/scripts), which never ship. A
  // skill may legitimately ship its own scripts/ (mx-monthly-report-max did
  // in 0.8.12, and its SKILL.md told the user to run it; the battery moved
  // server-side in 0.8.13 so no skill ships one today, but the anchoring
  // stays); an unanchored pattern rejected the 0.8.12 tag over exactly that
  // file.
  const leak = names.find(
    (n) =>
      /(^|\/)harness\/(src|test|testdata|scripts)\//.test(n) ||
      n.endsWith('.map') ||
      n.endsWith('package-lock.json') ||
      n.endsWith('tsconfig.json') ||
      n.endsWith('vitest.config.ts'),
  );
  if (leak) fail(`[${label}] excluded path leaked into zip: ${leak}`);

  return names;
}

const namesA = assertLayout(entriesA, {
  mustContain: '.claude-plugin/plugin.json',
  cliEntryName: 'harness/dist/cli.js',
  label: 'plugin',
});
const namesB = assertLayout(entriesB, {
  mustContain: '.claude-plugin/marketplace.json',
  cliEntryName: 'plugins/mixshift-ai/harness/dist/cli.js',
  label: 'marketplace',
});

// ---------------------------------------------------------------------------
// Write the zips.
// ---------------------------------------------------------------------------

const outDir = join(REPO_ROOT, 'dist-zip');
mkdirSync(outDir, { recursive: true });

const zipA = buildZip(entriesA);
const zipB = buildZip(entriesB);
const pathA = join(outDir, `mixshift-ai-plugin-${version}.zip`);
const pathB = join(outDir, `mixshift-ai-marketplace-${version}.zip`);
writeFileSync(pathA, zipA);
writeFileSync(pathB, zipB);

function maxDepth(names) {
  return Math.max(...names.map((n) => n.split('/').length - 1));
}

console.log(`✓ package-zip: mixshift-ai v${version}`);
console.log(`  cli.js: ${expectedBytes} bytes (blob == build-meta output_bytes)`);
console.log(
  `  plugin      → ${pathA}\n` +
    `                ${entriesA.length} entries, max depth ${maxDepth(namesA)}, ${zipA.length} bytes`,
);
console.log(
  `  marketplace → ${pathB}\n` +
    `                ${entriesB.length} entries, max depth ${maxDepth(namesB)}, ${zipB.length} bytes`,
);
