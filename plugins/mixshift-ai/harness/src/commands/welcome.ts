import type { Command } from 'commander';
import { loadPluginDefaults } from '../lib/defaults/load.js';
import { loadProfile } from '../lib/profile/load.js';
import { loadCredentials } from '../lib/auth/credentials.js';
import { readIndex, countByActivity } from '../lib/clients/index.js';
import { loadKeyBrands } from '../lib/clients/key-brands.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerWelcomeCommand(program: Command): void {
  program
    .command('welcome')
    .description(
      'Show the first-run welcome and quick-start (URL to retrieve your ' +
        'credentials, what commands to run, where to get help).',
    )
    .option(
      '--format <type>',
      'output format: `terminal` (ASCII for shell, default) | `chat` ' +
        '(markdown for Claude/Cowork to surface verbatim in chat). The ' +
        'welcome SKILL.md uses --format chat so every install renders the ' +
        'same text without depending on Claude\'s paraphrase quality.',
      'terminal',
    )
    .action(async (opts: { format?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const defaults = await loadPluginDefaults();
      const { profile, source: profileSource } = await loadProfile(root.dataDir);
      const { credentials } = await loadCredentials(root.dataDir);

      const cr = defaults.auth.credential_retrieval;
      const authReady = !!credentials?.mysql;
      const profileReady = profileSource === 'file' && !!profile.user?.email;

      if (root.json) {
        process.stdout.write(
          JSON.stringify(
            {
              status: 'ok',
              auth_ready: authReady,
              profile_ready: profileReady,
              credential_retrieval: {
                url_default: cr.url_default,
                url_tenant_pattern: cr.url_tenant_pattern,
                master_password: cr.master_password,
              },
              next_step: authReady ? 'mixshift brand discover' : 'mixshift auth setup',
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }

      // Welcome is informational, not an error — route to stdout so it
      // doesn't render red in tools that style stderr as error.
      const format = opts.format === 'chat' ? 'chat' : 'terminal';

      // Brand counts feed the chat-format "already set up" branch so the
      // user sees "you have N active brands" right away. Best-effort: if
      // the index hasn't been populated yet (fresh install) or read fails,
      // fall through to the no-counts code path.
      let brandCounts: {
        total: number;
        active: number;
        dormant: number;
        cold_started: number;
        key: number;
      } | null = null;
      if (authReady) {
        try {
          const idxResult = await readIndex(root.dataDir);
          if (idxResult.source === 'file') {
            const base = countByActivity(idxResult.index);
            const keys = await loadKeyBrands(root.dataDir);
            brandCounts = { ...base, key: keys.length };
          }
        } catch {
          // Malformed registry — treat as if there's no index.
        }
      }

      const rendered =
        format === 'chat'
          ? renderWelcomeChat({ authReady, profileReady, cr, brandCounts })
          : renderWelcome({ authReady, profileReady, cr });
      process.stdout.write(rendered);
      await track(
        {
          event_name: EventName.WelcomeViewed,
          payload: {
            auth_ready: authReady,
            profile_ready: profileReady,
            format,
          },
        },
        root.dataDir,
      );
      // No explicit flush needed — cli.ts's finally block drains the
      // queue before process.exit. `welcome` is the canonical one-shot
      // first-run command (Cowork chat fires it, then the user moves to
      // auth setup), so the wrapper's flush is the only thing standing
      // between the `consent.acknowledged` + `welcome.viewed` events
      // and the Supabase write.
    });
}

function renderWelcome(args: {
  authReady: boolean;
  profileReady: boolean;
  cr: {
    url_default: string;
    url_tenant_pattern: string;
    master_password: string;
    notes: string;
  };
}): string {
  const { authReady, profileReady, cr } = args;
  const lines: string[] = [];

  lines.push('');
  lines.push('Welcome to the MixShift plugin');
  lines.push('━'.repeat(60));
  lines.push('');

  if (authReady && profileReady) {
    lines.push('✓ You are already set up. You can:');
    lines.push('');
    lines.push('    • Discover your brands:');
    lines.push('        In chat:    "discover my brands"');
    lines.push('        Terminal:   mixshift brand discover');
    lines.push('');
    lines.push('    • Explore + export your data (no brand onboarding needed):');
    lines.push('        In chat:    "explore my data" / "show me a sample of <table>"');
    lines.push('                    / "export <brand>\'s campaigns to CSV"');
    lines.push('        Terminal:   mixshift data list-tables  (or sample / export / query)');
    lines.push('');
    lines.push('    • Onboard a brand for the analytical skills (daily-health-check, etc.):');
    lines.push('        In chat:    "onboard <brand-slug>" — Claude bootstraps the brand');
    lines.push('                    then say "run account cold start for <brand-slug>"');
    lines.push('                    to walk through AM intake.');
    lines.push('        Terminal:   mixshift brand add <slug>');
    lines.push('');
    lines.push('    • Re-run auth setup (new credentials / different account):');
    lines.push('        In chat:    "set up my credentials" / "run auth setup"');
    lines.push('        Terminal:   mixshift auth setup');
    lines.push('');
    lines.push('    • Send feedback / report bugs / request features:');
    lines.push('        In chat:    /feedback');
    lines.push('                    or "send feedback to mixshift: <your message>"');
    lines.push('                    or "report a bug: <description>"');
    lines.push('        Terminal:   mixshift feedback "<msg>" [--category bug|feature_request|comment]');
    lines.push('');
    lines.push('  We read every piece of feedback. Bugs, "this is broken", "I wish');
    lines.push('  this could…", general comments — all of it helps us iterate.');
    lines.push('');
    return lines.join('\n');
  }

  // First-time / partially-completed setup walkthrough
  lines.push('This is the MixShift Amazon plugin. Three quick steps to get going:');
  lines.push('');
  lines.push('━━ Step 1 — Get your warehouse credentials ━━');
  lines.push('');
  lines.push('  Open this URL in a browser (where you sign in to MixShift):');
  lines.push(`    ${cr.url_default}`);
  lines.push('');
  lines.push('  If that page does not recognize your session, use your tenant URL:');
  lines.push(`    ${cr.url_tenant_pattern}`);
  if (cr.master_password) {
    lines.push('');
    lines.push('  When prompted for "Master password", enter:');
    lines.push(`    ${cr.master_password}`);
    lines.push('');
    lines.push('  This is the same value for all MixShift customers — it just');
    lines.push('  prevents accidental credential exposure to other logged-in users.');
  }
  lines.push('');
  lines.push('  The credentials page shows:');
  lines.push('    HostName, Username, Port, Schema, and Password — copy them.');
  lines.push('');
  lines.push('  You\'ll plug these into Step 2 (auth setup) below — keep');
  lines.push('  them handy.');
  if (cr.notes) {
    lines.push('');
    cr.notes.split('\n').forEach((l) => {
      if (l.trim()) lines.push(`  ${l}`);
    });
  }
  lines.push('');
  lines.push('━━ Step 2 — Run auth setup ━━');
  lines.push('');
  lines.push('  In Claude Code / Cowork (recommended):');
  lines.push('    Say "set up my credentials" or "run auth setup" in chat.');
  lines.push('    Claude will walk you through the inputs safely — for the');
  lines.push('    password, you save it to a text file (so it never appears');
  lines.push('    in chat history) and tell Claude the path.');
  lines.push('');
  lines.push('  In a terminal:');
  lines.push('    mixshift auth setup');
  lines.push('    Walks you through interactive TTY prompts (password is masked).');
  lines.push('');
  lines.push('  Either way, we test the connection and auto-request an IP');
  lines.push('  whitelist if your IP isn\'t approved yet.');
  lines.push('');
  lines.push('━━ Step 3 — Try something ━━');
  lines.push('');
  lines.push('  In Claude Code / Cowork (chat):');
  lines.push('    "what brands do I have access to?"');
  lines.push('    "what tables can I query?"');
  lines.push('    "explore my data"');
  lines.push('    "export <brand>\'s campaigns to CSV"');
  lines.push('');
  lines.push('  In a terminal:');
  lines.push('    mixshift brand discover');
  lines.push('    mixshift data list-tables');
  lines.push('    mixshift data sample --table campaignmetric --seller-id <N>');
  lines.push('');
  lines.push('━'.repeat(60));
  lines.push('');
  lines.push('Got feedback? Bugs, "this is broken", "I wish this could…",');
  lines.push('feature requests, comments — all of it helps us iterate the');
  lines.push('plugin during beta. We read every piece.');
  lines.push('  In chat:     /feedback');
  lines.push('               or "send feedback to mixshift: <your message>"');
  lines.push('  Terminal:    mixshift feedback "<your message>"');
  lines.push('');

  if (authReady) {
    lines.push('Current state: ✓ auth credentials saved, ' +
      (profileReady ? '✓ profile saved' : '✗ profile incomplete') + '.');
  } else {
    lines.push('Current state: ✗ no credentials yet. Start with Step 1 above.');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Chat-format renderer (markdown). Used when invoked as `mixshift welcome
 * --format chat` — the welcome SKILL.md surfaces this output verbatim as
 * Claude's chat reply, instead of having Claude paraphrase. This way the
 * harness owns the chat wording (one place to iterate) and every install
 * renders the same text regardless of Claude's interpretation.
 *
 * Design: each step is a separate paragraph with a bolded ### heading. The
 * three sub-sections inside Step 1 (URL + master password + field list +
 * Step-2 handoff) each get their own paragraph break to address the past
 * "crushed paragraph" complaint.
 */
function renderWelcomeChat(args: {
  authReady: boolean;
  profileReady: boolean;
  cr: {
    url_default: string;
    url_tenant_pattern: string;
    master_password: string;
    notes: string;
  };
  brandCounts: {
    total: number;
    active: number;
    dormant: number;
    cold_started: number;
    key: number;
  } | null;
}): string {
  const { authReady, profileReady, cr, brandCounts } = args;
  const lines: string[] = [];

  if (authReady && profileReady) {
    lines.push("**Welcome back to the MixShift plugin** — you're already set up.");
    lines.push('');

    // Brand-count summary (when the registry is populated).
    if (brandCounts && brandCounts.total > 0) {
      const dormantSuffix =
        brandCounts.dormant > 0
          ? ` (${brandCounts.dormant} dormant hidden by default — say *"show all my brands"* to see them)`
          : '';
      const coldStartedSuffix =
        brandCounts.cold_started > 0
          ? `, of which **${brandCounts.cold_started}** is/are cold-started for analytical skills`
          : '';
      const keySuffix =
        brandCounts.key > 0
          ? ` You currently have **${brandCounts.key}** marked as key — portfolio skills default to those.`
          : '';
      lines.push(
        `You have access to **${brandCounts.active} active brand(s)**${coldStartedSuffix}${dormantSuffix}.${keySuffix}`,
      );
      lines.push('');

      // Nudge: many active brands and no key set → suggest curating.
      if (brandCounts.active > 5 && brandCounts.key === 0) {
        lines.push(
          `With ${brandCounts.active} active brands, you probably focus on a smaller set day-to-day. Tell me which ones (e.g. *"I manage Skratch, Hydro Cell, AOP, and Home IQ"*) and I'll mark them as **key** so portfolio skills default to those instead of all ${brandCounts.active}.`,
        );
        lines.push('');
      }
    } else if (brandCounts && brandCounts.total === 0) {
      // Edge: auth complete but registry shows zero brands. Surface the
      // activation handoff so the user knows what to do.
      lines.push(
        "Your warehouse access shows **no brands yet** — this means you have not yet activated data in MixShift for your brands.",
      );
      lines.push('');
      lines.push(
        'Head to the Account Manager view to begin: https://dash.mydashapplications.com/account-manager',
      );
      lines.push('');
      lines.push(
        'Onboarding help doc: https://know.mixshift.io/en/articles/9584082-getting-started-with-mixshift',
      );
      lines.push('');
      return lines.join('\n');
    }

    lines.push('A few directions you can go:');
    lines.push('');
    lines.push('- **See your brands** — say *"show my brands"* or *"what brands do I have"*. (Dormant brands hidden by default; say *"show all my brands"* to include them.)');
    lines.push('- **Curate your key brands** — *"mark \\<brand\\> as key"* or *"I manage \\<brand1\\>, \\<brand2\\>, ..."*. Portfolio skills default to these.');
    lines.push('- **Explore + export your data** (no brand onboarding required) — *"explore my data"*, *"show me a sample of \\<table\\>"*, *"export \\<brand\\>\'s campaigns to CSV"*.');
    lines.push('- **Onboard a brand for analytical skills** (daily-health-check, runaway-spend, etc.) — *"onboard \\<brand\\>"*, then *"run account cold start for \\<brand\\>"*.');
    lines.push('- **Re-run auth setup** if credentials need changing — *"set up my credentials"*.');
    lines.push('- **Send feedback** — *"send feedback to mixshift: \\<your message\\>"*. Bugs, gripes, feature requests — all welcome during beta.');
    lines.push('');
    lines.push("Where do you want to start?");
    lines.push('');
    return lines.join('\n');
  }

  // First-run / partially-set-up branch.
  lines.push("**Welcome to the MixShift plugin** — you're at the very start, no credentials configured yet. Three quick steps to get going:");
  lines.push('');

  // Step 1 — three deliberate paragraph breaks at sub-section boundaries.
  lines.push('### Step 1 — Get your warehouse credentials');
  lines.push('');
  lines.push(
    `Open ${cr.url_default} in a browser where you're signed in to MixShift. ` +
      `If the \`www\` URL doesn't recognize your session, use your tenant URL instead: ` +
      `${cr.url_tenant_pattern} (e.g. \`marpartners.mydashapplications.com/database-admin\`).`,
  );
  lines.push('');
  if (cr.master_password) {
    lines.push(
      `When the page prompts for "Master password", enter \`${cr.master_password}\` — ` +
        `this is the same value for every MixShift customer, a guard against accidental ` +
        `credential exposure on the page, not a per-user secret.`,
    );
    lines.push('');
  }
  lines.push(
    'The page shows your **HostName**, **Username**, **Port**, **Schema**, and **Password**. ' +
      "Copy all five — you'll plug them into Step 2 below.",
  );
  lines.push('');

  // Step 2 — single paragraph.
  lines.push('### Step 2 — Run auth setup');
  lines.push('');
  lines.push(
    'Once you have those credentials, say *"set up my credentials"* or *"run auth setup"* in chat. ' +
      "I'll walk you through it safely — for the password, you'll save it to a text file " +
      'and tell me the path, so the password never appears in chat history. ' +
      "We'll test the connection and auto-request an IP whitelist if your IP isn't approved yet.",
  );
  lines.push('');

  // Step 3 — bulleted list of common asks.
  lines.push('### Step 3 — Try something');
  lines.push('');
  lines.push('Once auth is done, ask things like:');
  lines.push('');
  lines.push('- *"what brands do I have access to?"*');
  lines.push('- *"what tables can I query?"*');
  lines.push('- *"explore my data"*');
  lines.push('- *"export \\<brand\\>\'s campaigns to CSV"*');
  lines.push('');

  // Status + feedback footer.
  lines.push('---');
  lines.push('');
  if (authReady) {
    lines.push(
      '**Current state:** ✓ credentials saved' +
        (profileReady ? ', ✓ profile saved.' : ', ✗ profile incomplete.') +
        ' You can skip to Step 3.',
    );
  } else {
    lines.push('**Current state:** ✗ no credentials yet — start with Step 1 above.');
  }
  lines.push('');
  lines.push(
    '> Feedback during beta? Just describe a friction point (*"it\'d be nice if…"*, *"this is broken"*, *"I wish this could…"*) ' +
      "and I'll offer to file it. Or say *\"send feedback to mixshift: \\<your message\\>\"* directly.",
  );
  lines.push('');

  return lines.join('\n');
}
