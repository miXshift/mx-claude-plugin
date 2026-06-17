/**
 * `mixshift guide` — the navigation + discovery hub.
 *
 * The help analogue of `mixshift welcome`: welcome onboards a first-run user
 * (sign in, try one thing); the guide answers "what can this do / where do I
 * find X / how do I fix Y" at ANY time. Like welcome, the harness owns the
 * wording (`--format chat`) so every install renders the same map and the
 * mx-help SKILL.md stays a thin wrapper.
 *
 * Named `guide`, not `help`, on purpose: commander reserves `help` for its
 * auto-generated command listing. The user never types either — they say
 * "help" in chat, the mx-help skill runs `mixshift guide --format chat`.
 *
 * The capability catalog below is EDITORIAL (hand-written "say this to start"
 * copy, NOT the verbose triggering descriptions from each SKILL.md — those are
 * tuned for matching, not for reading). To stay honest as skills are added,
 * the command also enumerates the skills/ directory at runtime and appends any
 * skill not in the catalog under "More", so a newly-shipped skill is never
 * silently invisible here.
 */

import type { Command } from 'commander';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCredentials } from '../lib/auth/credentials.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

interface HubSkill {
  /** Skill directory id (must match skills/<id>/). */
  id: string;
  /** What the user can say in chat to start it. */
  say: string;
  /** One short outcome phrase. */
  what: string;
}

interface HubGroup {
  title: string;
  skills: HubSkill[];
}

/**
 * Outcome-grouped catalog. Order = scan order. Keep `say` phrasings close to
 * the trigger phrases the target skills actually match on, and keep `what`
 * under ~8 words so the chat render stays scannable.
 */
const CATALOG: HubGroup[] = [
  {
    title: 'Get set up & signed in',
    skills: [
      { id: 'mx-welcome', say: 'welcome', what: 'first-run orientation and sign-in' },
      { id: 'mx-auth-login', say: 'sign me in', what: 'sign in, or switch MixShift accounts' },
      { id: 'mx-auth-service-setup', say: 'set up an unattended credential', what: 'a service credential for scheduled or CI runs' },
      { id: 'mx-account-cold-start', say: 'cold start <brand>', what: 'onboard a brand so the analytical skills know it' },
    ],
  },
  {
    title: 'Explore data & pull reports',
    skills: [
      { id: 'mx-data-explore', say: 'explore my data', what: 'query, sample, and export the warehouse to CSV' },
      { id: 'mx-report-pull', say: 'pull a Brand Analytics report', what: 'fetch SP-API reports on demand, any window' },
      { id: 'mx-amazon-retail', say: 'look up this ASIN', what: 'live catalog, inventory, orders, pricing lookups' },
    ],
  },
  {
    title: 'Daily & weekly account health',
    skills: [
      { id: 'mx-portfolio-quick-scan', say: 'run a portfolio quick scan', what: 'one green/yellow/red card per brand' },
      { id: 'mx-daily-health-check', say: 'run a daily health check on <brand>', what: 'what needs attention today' },
      { id: 'mx-runaway-spend-check', say: 'check for runaway spend on <brand>', what: 'acute keyword overspend' },
      { id: 'mx-keyword-bid-health', say: 'run a bid health review on <brand>', what: 'weekly bid pullbacks and scale-ups' },
    ],
  },
  {
    title: 'Search terms, negatives & harvesting',
    skills: [
      { id: 'mx-search-term-negation', say: 'run search term negation on <brand>', what: 'find irrelevant traffic to negate' },
      { id: 'mx-search-term-harvest', say: 'harvest converting search terms', what: 'promote winners to explicit targeting' },
      { id: 'mx-phrase-negative-discovery', say: 'find phrase negative candidates', what: 'n-gram zero-conversion spend' },
      { id: 'mx-asin-target-negation', say: 'run ASIN target negation', what: 'PDP-overlap review of ASIN targets' },
      { id: 'mx-ppc-relevance-check', say: 'check search term relevance', what: 'semantic relevance verdicts' },
      { id: 'mx-search-term-data-pull', say: 'pull search term data', what: 'the raw extract the analyses run on (building block)' },
    ],
  },
  {
    title: 'Live Amazon surfaces',
    skills: [
      { id: 'mx-amazon-ads', say: 'show my campaigns', what: 'read live Ads state, or make audited changes' },
      { id: 'mx-amazon-amc', say: 'run an AMC query', what: 'Marketing Cloud SQL analytics' },
      { id: 'mx-amazon-dsp', say: 'pull a DSP report', what: 'Demand-Side Platform reporting' },
    ],
  },
  {
    title: 'Reporting & analysis',
    skills: [
      { id: 'mx-monthly-report', say: 'write the monthly report for <brand>', what: 'MoM and YoY performance narrative' },
      { id: 'mx-competitive-analysis', say: 'run a competitive analysis', what: 'SWOT, feature, and pricing comparison' },
    ],
  },
  {
    title: 'Help, feedback & contributing',
    skills: [
      { id: 'mx-help', say: 'help', what: 'this map; ask what anything does' },
      { id: 'mx-feedback', say: 'send feedback', what: 'bugs, requests, comments straight to us' },
      { id: 'mx-share-skill', say: 'I built a skill', what: 'share a skill you made for the library' },
    ],
  },
];

export function registerHelpCommand(program: Command): void {
  program
    .command('guide')
    .description(
      'Render the navigation + discovery hub: what the plugin can do, how to ' +
        'fix things, where the docs are, how to give feedback or share a skill. ' +
        'The mx-help skill surfaces `guide --format chat` verbatim. Named ' +
        '`guide` because commander reserves `help`.',
    )
    .option(
      '--format <type>',
      'output format: `terminal` (ASCII, default) | `chat` (markdown for ' +
        'Claude/Cowork to surface verbatim in chat).',
      'terminal',
    )
    .action(async (opts: { format?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const format = opts.format === 'chat' ? 'chat' : 'terminal';

      // Auth state — best-effort. The guide is useful signed out (it tells you
      // how to sign in), so a missing/malformed credentials file just renders
      // the signed-out variant rather than erroring.
      let authReady = false;
      let who: string | null = null;
      try {
        const { credentials } = await loadCredentials(root.dataDir);
        authReady =
          !!credentials?.datahub || !!credentials?.service || !!credentials?.mysql;
        if (credentials?.datahub) {
          who = credentials.datahub.person_label ?? credentials.datahub.email ?? null;
        } else if (credentials?.service) {
          who = credentials.service.label ?? null;
        }
      } catch {
        // ignore — render signed-out
      }

      const uncatalogued = await collectUncatalogued();

      if (root.json) {
        process.stdout.write(
          JSON.stringify(
            {
              status: 'ok',
              auth_ready: authReady,
              groups: CATALOG.map((g) => ({
                title: g.title,
                skills: g.skills.map((s) => s.id),
              })),
              uncatalogued,
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }

      const rendered =
        format === 'chat'
          ? renderHelpChat({ authReady, who, uncatalogued })
          : renderHelpTerminal({ authReady, who, uncatalogued });
      process.stdout.write(rendered);

      await track(
        {
          event_name: EventName.HelpViewed,
          payload: {
            format,
            auth_ready: authReady,
            uncatalogued_count: uncatalogued.length,
          },
        },
        root.dataDir,
      );
    });
}

/**
 * Skills present on disk that the editorial catalog doesn't mention. Drift
 * guard: a new skill that nobody added to CATALOG still shows up (under
 * "More") instead of being silently absent. Best-effort — if we can't locate
 * the skills dir (e.g. a unit test with no plugin layout), return [].
 */
async function collectUncatalogued(): Promise<string[]> {
  const known = new Set(CATALOG.flatMap((g) => g.skills.map((s) => s.id)));
  const skillsDir = await findSkillsDir();
  if (!skillsDir) return [];
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    return entries
      .filter(
        (e) => e.isDirectory() && e.name.startsWith('mx-') && !known.has(e.name),
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Locate the plugin's skills/ directory. Prefers CLAUDE_PLUGIN_ROOT (set in
 * the plugin runtime — the case that matters); otherwise walks up from this
 * module looking for a skills/ dir, which handles both the bundled layout
 * (harness/dist/cli.js) and the dev layout (harness/src/commands/help.ts).
 */
async function findSkillsDir(): Promise<string | null> {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    return join(process.env.CLAUDE_PLUGIN_ROOT, 'skills');
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const candidate = join(dir, 'skills');
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function renderHelpChat(args: {
  authReady: boolean;
  who: string | null;
  uncatalogued: string[];
}): string {
  const { authReady, who, uncatalogued } = args;
  const L: string[] = [];

  L.push('**MixShift plugin: what you can do here**');
  L.push('');
  L.push(
    'Tell me what you are trying to get done and I will take you there. Or pick from the map below (say any line in **bold**).',
  );
  L.push('');

  if (authReady) {
    L.push(
      `You are signed in${who ? ` as ${who}` : ''}. Everything below is ready to use.`,
    );
  } else {
    L.push(
      'You are not signed in yet. Start by saying **"sign me in"**, then anything below works.',
    );
  }
  L.push('');

  for (const group of CATALOG) {
    L.push(`### ${group.title}`);
    for (const s of group.skills) {
      L.push(`- **"${s.say}"**: ${s.what}`);
    }
    L.push('');
  }

  if (uncatalogued.length > 0) {
    L.push('### More');
    for (const id of uncatalogued) {
      L.push(`- \`${id}\` (say *"help with ${id}"* and I will explain it)`);
    }
    L.push('');
  }

  L.push('### Stuck, or something is broken?');
  L.push(
    '- Say **"run a diagnostic"** for a health check (version, sign-in, connectivity, query-pack status) with the exact fix for anything wrong.',
  );
  L.push(
    '- Most common fix: not signed in. Say **"sign me in"**. If the plugin is out of date, the diagnostic shows how to update.',
  );
  L.push('');

  L.push('### Tell us things, or share what you built');
  L.push('- Feedback, bugs, requests: say **"send feedback"**. We read every one.');
  L.push(
    '- Built your own skill with the plugin? Say **"I built a skill"** and we will fold it into the library.',
  );
  L.push('');

  L.push('### Docs');
  L.push(
    '- Getting started: https://know.mixshift.io/en/articles/9584082-getting-started-with-mixshift',
  );
  L.push(
    '- What we collect (privacy): https://github.com/miXshift/mx-claude-plugin/blob/main/docs/privacy.md',
  );
  L.push('');

  L.push('What do you want to do?');
  L.push('');

  return L.join('\n');
}

function renderHelpTerminal(args: {
  authReady: boolean;
  who: string | null;
  uncatalogued: string[];
}): string {
  const { authReady, who, uncatalogued } = args;
  const L: string[] = [];
  L.push('');
  L.push('MixShift plugin: what you can do here');
  L.push('='.repeat(60));
  L.push('');
  L.push(
    authReady
      ? `Signed in${who ? ` as ${who}` : ''}. Everything below is ready.`
      : 'Not signed in yet. Run `mixshift auth login` first.',
  );
  L.push('');
  for (const group of CATALOG) {
    L.push(`${group.title}`);
    for (const s of group.skills) {
      L.push(`  say "${s.say}"`);
      L.push(`      ${s.what}`);
    }
    L.push('');
  }
  if (uncatalogued.length > 0) {
    L.push('More skills:');
    for (const id of uncatalogued) L.push(`  ${id}`);
    L.push('');
  }
  L.push('Stuck or broken?   run `mixshift doctor`');
  L.push('Feedback / bugs:   say "send feedback"  (or `mixshift feedback "..."`)');
  L.push('Share a skill:     say "I built a skill"  (or `mixshift share-skill <path>`)');
  L.push(
    'Docs:              https://know.mixshift.io/en/articles/9584082-getting-started-with-mixshift',
  );
  L.push('');
  return L.join('\n');
}
