/**
 * Copy guard for mx-ops#320: in Cowork, Claude told a user the MixShift
 * plugin / CLI / connector was not installed when it was. Cowork runs no
 * plugin session hook (so `mixshift` is off PATH and `$MIXSHIFT_CLI` is
 * empty) and every fresh sandbox starts signed out (so the first command
 * answers `not_authenticated` / "No credentials found"). The skills now say:
 *   1. the CLI is missing only after the resolver scan ran to the end and
 *      printed no path (a timed-out scan has not finished);
 *   2. `not_authenticated` means sign in (mx-auth-login Path A), never
 *      "not installed";
 *   3. Cowork with a Bash tool is never Path D (the connector / paste-token
 *      route), in mx-auth-login Step 0 and Path D;
 *   4. mx-welcome sign-in step 2 points at the resolver scan, not only at
 *      `$MIXSHIFT_CLI`;
 * and the FAQ answers the symptom.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = resolve(HERE, '..', '..', 'skills');
const REPO = resolve(HERE, '..', '..', '..', '..');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const read = (p: string) => readFileSync(p, 'utf8');
const skill = (id: string) => read(join(SKILLS, id, 'SKILL.md'));

const skillIds = readdirSync(SKILLS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
  .map((e) => e.name)
  .sort();

const SCAN_TO_END = /only after (?:the|that) (?:resolver )?scan has run to the end/;

function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  expect(i, `missing anchor: ${start}`).toBeGreaterThan(-1);
  const j = text.indexOf(end, i + start.length);
  return flat(text.slice(i, j === -1 ? undefined : j));
}

describe('mx-ops#320: every skill says "not installed" only after the scan', () => {
  it('finds the skills', () => {
    expect(skillIds.length).toBeGreaterThan(30);
  });

  it.each(skillIds)('%s: scan must run to the end before "could not be found"', (id) => {
    expect(flat(skill(id))).toMatch(SCAN_TO_END);
  });

  it.each(skillIds)('%s: not_authenticated routes to sign-in', (id) => {
    const s = flat(skill(id));
    expect(s).toContain('not_authenticated');
    expect(s).toContain('mx-auth-login');
  });

  it.each(skillIds)('%s: no unconditional "never report it as not installed"', (id) => {
    expect(flat(skill(id))).not.toContain('which the scan locates; never report it as not installed');
  });

  it('the shared invocation note sends not_authenticated to Path A and names the connector', () => {
    const s = flat(skill('mx-amazon-ads'));
    expect(s).toMatch(
      /A `not_authenticated` error, or "No credentials found", means the CLI ran and the user is not signed in \(normal in every fresh Cowork sandbox\): that is a sign-in, so use the `mx-auth-login` skill \(Path A, device-init\), and never report the plugin, its CLI or the connector as not installed\./,
    );
  });
});

describe('mx-ops#320: mx-welcome sign-in step 2', () => {
  const w = skill('mx-welcome');
  const step2 = between(w, '2. **Initialize the sign-in flow.**', '3. **Prep the user');

  it('falls back to the resolver scan, not only $MIXSHIFT_CLI', () => {
    expect(step2).toContain('node "$MIXSHIFT_CLI"');
    expect(step2).toMatch(/resolve it again with the scan in "Fallback if the CLI fails"/);
    expect(w).toContain('### Fallback if the CLI fails');
  });

  it('says off PATH is not "not installed" and the scan must run to the end', () => {
    expect(step2).toMatch(/Being off PATH is not "not installed"/);
    expect(step2).toMatch(SCAN_TO_END);
  });

  it('treats No credentials found / not_authenticated as what this step fixes', () => {
    expect(step2).toMatch(/"No credentials found" or `not_authenticated`/);
    expect(step2).toMatch(/never report it as the plugin or connector not being installed/);
  });

  it('the Output handling fallback waits for a finished scan', () => {
    expect(flat(w)).toMatch(
      /Only if that scan has run to the end and printed no path \(a scan that timed out or was stopped has not finished, so run it again first\)/,
    );
  });
});

describe('mx-ops#320: mx-auth-login Step 0 and Path D keep Cowork with Bash off Path D', () => {
  const a = skill('mx-auth-login');
  const step0 = between(a, '## Step 0', '## How to frame this');
  const pathD = between(a, '## Path D', '## No MixShift account yet');

  it('routes not_authenticated / No credentials found to Path A', () => {
    expect(step0).toMatch(
      /\| A MixShift command returned `not_authenticated`, "No credentials found", or "Run `mixshift auth login`" \| \*\*Path A\*\*/,
    );
  });

  it('Path D row is no-Bash only and excludes Cowork', () => {
    expect(step0).toMatch(
      /\| claude\.ai web, or any surface with no Bash tool at all \| \*\*Path D\*\* \(direct mode, paste token\)\. Never for Cowork: Cowork has a Bash tool \|/,
    );
    expect(step0).not.toContain('| claude.ai web / no Bash tool available |');
  });

  it('Step 0 says Cowork with Bash is never Path D and resolves the CLI first', () => {
    expect(step0).toMatch(/\*\*Cowork with a Bash tool is never Path D\.\*\*/);
    expect(step0).toMatch(/Do not send a Cowork user to the remote MCP connector/);
    expect(step0).toMatch(SCAN_TO_END);
  });

  it('Path D itself repeats the guard', () => {
    expect(pathD).toMatch(/Use this path only on a surface with no Bash tool at all\./);
    expect(pathD).toMatch(/\*\*Cowork with a Bash tool is never Path D\*\*/);
  });

  it('keeps the skill and manifest versions in step', () => {
    const v = a.match(/^\s+version: "([^"]+)"/m)?.[1];
    const m = read(join(SKILLS, 'mx-auth-login', 'skill.manifest.yaml')).match(/^version: "([^"]+)"/m)?.[1];
    expect(v).toBe('0.2.5');
    expect(m).toBe(v);
  });
});

describe('mx-ops#320: mx-welcome version', () => {
  it('keeps the skill and manifest versions in step', () => {
    const v = skill('mx-welcome').match(/^\s+version: "([^"]+)"/m)?.[1];
    const m = read(join(SKILLS, 'mx-welcome', 'skill.manifest.yaml')).match(/^version: "([^"]+)"/m)?.[1];
    expect(v).toBe('0.1.3');
    expect(m).toBe(v);
  });
});

describe('mx-ops#320: docs answer the symptom', () => {
  it('FAQ has the Cowork "not installed" entry with the sign-in workaround', () => {
    const faq = read(join(REPO, 'docs', 'faq.md'));
    const entry = between(
      faq,
      '### Claude says MixShift (the plugin, its CLI or the connector) is not installed in Cowork, but it is',
      '\n### ',
    );
    expect(entry).toMatch(/`mixshift` is not on PATH/);
    expect(entry).toMatch(/"No credentials found" \(`not_authenticated`\)/);
    expect(entry).toMatch(/say \*\*"sign in to MixShift"\*\*/);
    expect(entry).toMatch(/You do not need to add the remote MCP connector in Cowork/);
  });

  it('Cowork personal install troubleshooting links the FAQ entry', () => {
    const doc = read(join(REPO, 'docs', 'install', 'cowork-personal.md'));
    expect(doc).toContain(
      '../faq.md#claude-says-mixshift-the-plugin-its-cli-or-the-connector-is-not-installed-in-cowork-but-it-is',
    );
  });
});
