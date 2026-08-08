#!/usr/bin/env node
// announce-release.mjs — emit a `release.published` event so it fans out to the
// MixShift releases Discord channel.
//
// This is the release-time counterpart of the in-plugin `mixshift whatsnew`
// command and the hosted /releases page: it inserts one `release.published`
// event into the telemetry `events` table, which the `events_to_discord_fanout`
// trigger forwards to the `fanout-discord` Edge Function, which posts a release
// embed to the channel behind the RELEASES_DISCORD_WEBHOOK_URL secret.
// Routing and the event-type allowlist are configured server-side.
//
// Run this AFTER a release is merged + the CHANGELOG has the new top entry:
//   node scripts/announce-release.mjs              # announce the top CHANGELOG entry
//   node scripts/announce-release.mjs --dry-run    # print the payload, send nothing
//   node scripts/announce-release.mjs --version 0.5.41 --url https://mixshift.ai/releases
//
// Standalone: only Node builtins + global fetch. Reads the telemetry endpoint +
// anon key from the shipped .mixshift-defaults.yaml (env vars override, same as
// the harness). The anon key is INSERT-only on events via RLS, safe to embed.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const CHANGELOG = join(REPO_ROOT, 'CHANGELOG.md');
const DEFAULTS = join(__dirname, '..', '..', '.mixshift-defaults.yaml');
const RELEASE_SENTINEL_INSTALL_ID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_URL = 'https://mixshift.ai/releases';

function parseArgs(argv) {
  const args = { dryRun: false, version: undefined, url: DEFAULT_URL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--url') args.url = argv[++i];
    else throw new Error(`Unknown arg: ${a}`);
  }
  return args;
}

// Parse the CHANGELOG into [{ version, notes }] (newest first). Mirrors
// harness/src/lib/changelog.ts parseChangelog so whatsnew, /releases, and this
// emitter all read the same file the same way.
function parseChangelog(md) {
  const entries = [];
  let current = null;
  const flush = () => {
    if (current) entries.push({ version: current.version, notes: current.body.join('\n').trim() });
  };
  for (const line of md.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      const heading = (m[1] ?? '').trim();
      current = { version: heading.replace(/^\[/, '').split(/[\s\]]/)[0] ?? heading, body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return entries;
}

// Pull telemetry.endpoint + telemetry.apikey from the defaults YAML without a
// YAML dependency (the file ships simple scalars). Env vars win, like the harness.
function readTelemetryConfig(yamlText) {
  const endpoint =
    process.env.MIXSHIFT_TELEMETRY_ENDPOINT ||
    (yamlText.match(/^\s*endpoint:\s*(\S+)\s*$/m)?.[1]);
  const apikey =
    process.env.MIXSHIFT_TELEMETRY_APIKEY ||
    (yamlText.match(/^\s*apikey:\s*(\S+)\s*$/m)?.[1]);
  return { endpoint, apikey };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const md = await readFile(CHANGELOG, 'utf-8');
  const entries = parseChangelog(md);
  if (entries.length === 0) throw new Error(`No version entries found in ${CHANGELOG}`);

  const entry = args.version
    ? entries.find((e) => e.version === args.version)
    : entries[0];
  if (!entry) throw new Error(`Version ${args.version} not found in the CHANGELOG`);

  const record = {
    event_name: 'release.published',
    install_id: RELEASE_SENTINEL_INSTALL_ID,
    plugin_version: entry.version,
    payload: {
      version: entry.version,
      title: `mixshift-ai v${entry.version}`,
      summary: entry.notes,
      url: args.url,
    },
  };

  if (args.dryRun) {
    console.log('[dry-run] would POST release.published:\n');
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  const yamlText = await readFile(DEFAULTS, 'utf-8').catch(() => '');
  const { endpoint, apikey } = readTelemetryConfig(yamlText);
  if (!endpoint || !apikey) {
    throw new Error(
      'No telemetry endpoint/apikey resolved (set MIXSHIFT_TELEMETRY_ENDPOINT + ' +
        'MIXSHIFT_TELEMETRY_APIKEY, or run from a checkout with .mixshift-defaults.yaml).',
    );
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey,
      Authorization: `Bearer ${apikey}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify([record]),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '<unreadable>');
    throw new Error(`events insert failed: HTTP ${resp.status} ${body.slice(0, 300)}`);
  }
  console.log(`✓ Announced mixshift-ai v${entry.version} (release.published → Discord fan-out).`);
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
