import type { Command } from 'commander';
import { loadPluginDefaults } from '../lib/defaults/load.js';
import { loadProfile } from '../lib/profile/load.js';
import { loadCredentials } from '../lib/auth/credentials.js';
import { readIndex, countByActivity } from '../lib/clients/index.js';
import { loadKeyBrands } from '../lib/clients/key-brands.js';
import { loadBrain } from '../lib/brain/read.js';
import { track, EventName } from '../lib/telemetry/index.js';
import { checkForUpdate, renderUpdateBanner } from '../lib/version-check.js';

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
      // Auth-ready when ANY credential block is present: v2 `datahub`
      // (token flow via `mixshift auth login`), `service` (admin-issued
      // machine credential for unattended runs), or v1 legacy `mysql`.
      // Matches the coexistence model in auth/schema.ts and every other
      // consumer (query-runner, getValidAccessToken).
      const authReady =
        !!credentials?.datahub || !!credentials?.service || !!credentials?.mysql;
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
              },
              next_step: authReady ? 'mixshift brand discover' : 'mixshift auth login',
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

      // Brand counts + key brand state feed the chat-format welcome
      // ladder. Best-effort: if the index hasn't been populated yet
      // (fresh install) or read fails, fall through to the no-counts
      // code path.
      let brandCounts: {
        total: number;
        active: number;
        dormant: number;
        cold_started: number;
        key: number;
        key_cold_started: number; // intersection: keys that are also cold-started
        key_brain_populated: number; // keys with a Tier-2 brand-brain on disk
        first_key_display_name: string | null;
        first_key_uncold_display_name: string | null; // first key brand that ISN'T cold-started
      } | null = null;
      if (authReady) {
        try {
          const idxResult = await readIndex(root.dataDir);
          if (idxResult.source === 'file') {
            const base = countByActivity(idxResult.index);
            const keys = await loadKeyBrands(root.dataDir);
            const keyEntries = keys
              .map((k) => k.registry_entry)
              .filter((e): e is NonNullable<typeof e> => e !== null);
            const firstKey = keyEntries[0] ?? null;
            const firstUncold =
              keyEntries.find((e) => !e.cold_started) ?? null;
            // Brain population is per key slug; N is small (curated list)
            // so sequential loads are fine.
            let brainPopulated = 0;
            for (const k of keys) {
              const brain = await loadBrain(k.slug, root.dataDir);
              if (brain.ok && brain.brain.sources.seller) brainPopulated++;
            }
            brandCounts = {
              ...base,
              key: keys.length,
              key_cold_started: keyEntries.filter((e) => e.cold_started).length,
              key_brain_populated: brainPopulated,
              first_key_display_name: firstKey?.display_name ?? null,
              first_key_uncold_display_name: firstUncold?.display_name ?? null,
            };
          }
        } catch {
          // Malformed registry — treat as if there's no index.
        }
      }

      // Best-effort update check. Cached 24h on disk; network failures
      // collapse to "no banner" without breaking welcome.
      const updateCheck = await checkForUpdate({
        dataDirOverride: root.dataDir,
      }).catch(() => null);
      const banner = updateCheck
        ? renderUpdateBanner(updateCheck, format === 'chat' ? 'chat' : 'terminal')
        : '';

      const rendered =
        format === 'chat'
          ? renderWelcomeChat({ authReady, profileReady, cr, brandCounts })
          : renderWelcome({ authReady, profileReady, cr });
      process.stdout.write(banner + rendered);
      await track(
        {
          event_name: EventName.WelcomeViewed,
          payload: {
            auth_ready: authReady,
            profile_ready: profileReady,
            format,
            update_available: updateCheck?.isStale === true,
            latest_version: updateCheck?.latest ?? undefined,
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
    lines.push('    • Onboard a brand for the analytical skills (mx-daily-health-check, etc.):');
    lines.push('        In chat:    "onboard <brand-slug>" — Claude bootstraps the brand');
    lines.push('                    then say "set up <brand-slug>"');
    lines.push('                    to walk through AM intake.');
    lines.push('        Terminal:   mixshift brand add <slug>');
    lines.push('');
    lines.push('    • Re-run sign-in (new account / switch accounts):');
    lines.push('        In chat:    "sign in to mixshift"');
    lines.push('        Terminal:   mixshift auth login');
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

  // First-time / partially-completed setup walkthrough.
  //
  // The token-based mx-auth-login flow doesn't need the user to retrieve
  // raw MySQL credentials anymore, so the welcome shrinks to two steps:
  // sign in, try something. The legacy raw-MySQL CLI command
  // (`mixshift auth setup`) is still available for users who need it
  // (per-user IP whitelist, direct DB access for tooling outside the
  // plugin) but we don't surface it here — the recommended flow drives
  // the message. The `cr` (credential_retrieval) defaults are still
  // loaded and JSON-emitted for backward compat with any programmatic
  // consumers; we just don't render them in the primary welcome.
  void cr;

  lines.push('This is the MixShift Amazon plugin. Two quick steps to get going:');
  lines.push('');
  lines.push('━━ Step 1 — Sign in to MixShift ━━');
  lines.push('');
  lines.push('  Sign in so the plugin can read your Amazon ads + retail data.');
  lines.push('  You\'ll need your MixShift account (the same email + password');
  lines.push('  you use to log into MixShift). Your credentials stay in your');
  lines.push('  browser; the plugin only holds a token after.');
  lines.push('');
  lines.push('  In Claude Code / Cowork (recommended):');
  lines.push('    I\'ll get you a sign-in link in a moment — no need to say anything.');
  lines.push('');
  lines.push('  In a terminal:');
  lines.push('    mixshift auth login');
  lines.push('');
  lines.push('━━ Step 2 — Try something ━━');
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
  lines.push('Got feedback? Bugs, "this is broken", "I wish this could...",');
  lines.push('feature requests, comments. All of it helps us iterate the');
  lines.push('plugin during beta. We read every piece.');
  lines.push('  In chat:     /feedback');
  lines.push('               or "send feedback to mixshift: <your message>"');
  lines.push('  Terminal:    mixshift feedback "<your message>"');
  lines.push('');

  if (authReady) {
    lines.push('Current state: ✓ auth credentials saved, ' +
      (profileReady ? '✓ profile saved' : '✗ profile incomplete') + '.');
  } else {
    lines.push('Current state: ✗ not signed in yet. Start with Step 1 above.');
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
    notes: string;
  };
  brandCounts: {
    total: number;
    active: number;
    dormant: number;
    cold_started: number;
    key: number;
    key_cold_started: number;
    key_brain_populated: number;
    first_key_display_name: string | null;
    first_key_uncold_display_name: string | null;
  } | null;
}): string {
  const { authReady, profileReady, cr, brandCounts } = args;
  const lines: string[] = [];

  if (authReady && profileReady) {
    // Empty-active edge case (auth done, but no brands at all) — surface
    // the activation handoff and bail before the ladder logic.
    if (brandCounts && brandCounts.total === 0) {
      lines.push("**Welcome back to the MixShift plugin** — you're authenticated, but your warehouse access shows **no brands yet**.");
      lines.push('');
      lines.push("This means you haven't activated data in MixShift for your brands. Head to the Account Manager view to begin: https://dash.mydashapplications.com/account-manager");
      lines.push('');
      lines.push('Onboarding help doc: https://know.mixshift.io/en/articles/9584082-getting-started-with-mixshift');
      lines.push('');
      return lines.join('\n');
    }

    // Determine which state on the welcome ladder the user is in.
    // A — just authed, no key brands set (and many active to choose from)
    // B — key brands set, none cold-started yet → explain cold-start
    // C — at least one key brand cold-started → surface unlocked skills
    // D — all key brands cold-started → tight navigation
    let state: 'A' | 'B' | 'C' | 'D' = 'D';
    if (brandCounts) {
      if (brandCounts.key === 0) state = 'A';
      else if (brandCounts.key_cold_started === 0) state = 'B';
      else if (brandCounts.key_cold_started < brandCounts.key) state = 'C';
      else state = 'D';
    }

    lines.push("**Welcome back to the MixShift plugin** — you're already set up.");
    lines.push('');

    // Brand-count summary (renders for all states A-D when registry populated)
    if (brandCounts && brandCounts.total > 0) {
      const dormantSuffix =
        brandCounts.dormant > 0
          ? ` (${brandCounts.dormant} dormant hidden by default — say *"show all my brands"* to see them)`
          : '';
      const keyClause =
        brandCounts.key > 0
          ? ` **${brandCounts.key}** marked as key${brandCounts.key_cold_started > 0 ? `, ${brandCounts.key_cold_started} set up` : ''}.`
          : '';
      lines.push(
        `You have access to **${brandCounts.active} active brand(s)**${dormantSuffix}.${keyClause}`,
      );
      lines.push('');

      // Brain population status (states B/C/D; key list exists). The
      // brain is the Tier-2 auto pre-fill, distinct from cold-start.
      if (brandCounts.key > 0) {
        const pending = brandCounts.key - brandCounts.key_brain_populated;
        if (pending > 0) {
          lines.push(
            `Brand brains populated for **${brandCounts.key_brain_populated} of ${brandCounts.key}** key brand(s). ` +
              `${pending} pending: run \`mixshift brand brain fetch <slug>\` to fill them in (normally automatic when you key a brand).`,
          );
        } else {
          lines.push(
            `Brand brains populated for **all ${brandCounts.key}** key brand(s).`,
          );
        }
        lines.push('');
      }
    }

    // State-specific content
    if (state === 'A') {
      // Nudge to set key brands. Only if many active — for 1-3 brand
      // accounts, asking them to "narrow" feels weird.
      if (brandCounts && brandCounts.active > 3) {
        lines.push(
          `With ${brandCounts.active} active brands, you probably focus on a smaller set day-to-day. Tell me which ones (e.g. *"I manage Summit, Ridgeline Cell, AOP, and Hearth IQ"*) and I'll mark them as **key** — portfolio skills will default to those instead of all ${brandCounts.active}.`,
        );
      } else {
        lines.push(
          'You have a small number of brands, so you may not need to curate a key list — but if you want to, say *"mark <brand> as key"* anytime.',
        );
      }
      lines.push('');
      lines.push("Or, if you'd rather just look at data: say *\"explore my data\"*.");
      lines.push('');
    } else if (state === 'B') {
      // The key step: explain brand setup in user-centric terms + nudge
      // to do the first one.
      const targetBrand =
        brandCounts?.first_key_uncold_display_name ?? brandCounts?.first_key_display_name ?? 'your top key brand';
      lines.push(
        '### Next step: set up your first brand',
      );
      lines.push('');
      lines.push(
        '**Brand setup** teaches the plugin about your brand: catalog, marketplaces, target ACOS, recent launches and events. After ~3-5 minutes of mostly-automated setup (plus a few intake questions from me), every analytical skill (daily health check, runaway-spend, monthly report) already knows your brand and doesn\'t need re-explaining each time you run it.',
      );
      lines.push('');
      lines.push(
        `Until you set up at least one brand, the analytical skills are locked. You can still explore data via *"explore my data"*. **Want to start with ${targetBrand}?** Just say *"set up ${targetBrand}"*.`,
      );
      lines.push('');
      lines.push(
        `Other options while you decide: *"explore my data"* lets you sample tables and export CSVs without any brand setup. (Portfolio-quick-scan needs at least one brand set up first; it produces a green/yellow/red verdict per brand by aggregating per-brand health checks.)`,
      );
      lines.push('');
    } else if (state === 'C') {
      // At least one key brand is set up (cold_started flag in the
      // registry). Surface the unlocked skills, naming that brand. If
      // there are still keys awaiting setup, mention that too.
      const coldStartedKey = brandCounts?.first_key_display_name ?? 'your first set-up brand';
      const uncoldKey = brandCounts?.first_key_uncold_display_name;
      lines.push(
        `**${coldStartedKey}** is ready for analytical skills. A few things to try:`,
      );
      lines.push('');
      lines.push(
        `- *"run daily health check on ${coldStartedKey}"* — exception-based daily review (what's broken today?)`,
      );
      lines.push(
        `- *"run runaway spend check on ${coldStartedKey}"* — flags acute keyword overspend`,
      );
      lines.push(
        `- *"write monthly report for ${coldStartedKey}"* — MoM/YoY analysis with item-group breakdown`,
      );
      lines.push(
        `- *"run portfolio quick scan"* — multi-brand triage across your ${brandCounts?.key ?? 0} key brand(s); GREEN/YELLOW/RED verdicts`,
      );
      lines.push('');
      if (uncoldKey) {
        lines.push(
          `When you're ready to unlock the same surface on the rest of your key brands, just say *"set up ${uncoldKey}"* (or any of the others).`,
        );
        lines.push('');
      }
    } else {
      // State D — fully onboarded. Tight navigation.
      lines.push('All your key brands are set up and ready. Common moves:');
      lines.push('');
      lines.push('- *"run portfolio quick scan"* — multi-brand daily triage');
      lines.push('- *"run daily health check on \\<brand\\>"* — single-brand exception review');
      lines.push('- *"run runaway spend on \\<brand\\>"* — keyword overspend flagging');
      lines.push('- *"write monthly report for \\<brand\\>"* — MoM/YoY analysis');
      lines.push('- *"explore my data"* — ad-hoc queries / CSV exports');
      lines.push('- *"show my brands"* — see your portfolio, *"add \\<brand\\> to key brands"* to expand the focused set');
      lines.push('- *"send feedback to mixshift: \\<your message\\>"* — bugs, gripes, requests');
      lines.push('');
    }

    lines.push('Not sure where to look? Say **"help"** anytime to see everything this plugin can do in one place.');
    lines.push('');
    lines.push("Where do you want to start?");
    lines.push('');
    return lines.join('\n');
  }

  // First-run / partially-set-up branch.
  //
  // The token-based mx-auth-login flow doesn't need users to retrieve raw
  // MySQL credentials anymore, so the welcome shrinks to two steps:
  // sign in, try something. The `cr` (credential_retrieval) defaults
  // are still loaded and JSON-emitted for backward compat; not surfaced
  // in chat. The legacy `mixshift auth setup` CLI is still available
  // for users who explicitly need the raw-MySQL path, but isn't part
  // of the recommended welcome.
  void cr;

  lines.push("**Welcome to the MixShift plugin.** You're not signed in yet. Two quick steps:");
  lines.push('');

  // Step 1 — Sign in. Short and direct: what, why, how.
  // The welcome skill orchestrates the actual sign-in inline (see
  // skills/mx-welcome/SKILL.md), so this copy primes the user for what's
  // about to happen rather than telling them to invoke another phrase.
  lines.push('### Step 1 — Sign in to MixShift');
  lines.push('');
  lines.push(
    'Sign in so the plugin can read your Amazon ads + retail data. ' +
      "You'll need your MixShift account (the same email + password you " +
      'use to log into MixShift). Your credentials stay in your browser; ' +
      'the plugin only holds a token after.',
  );
  lines.push('');
  lines.push("I'll set up a sign-in link for you right after this. (Or run `mixshift auth login` in a terminal yourself.)");
  lines.push('');

  // Step 2 — Try something.
  lines.push('### Step 2 — Try something');
  lines.push('');
  lines.push('Once you\'re signed in, ask:');
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
        ' You can skip to Step 2.',
    );
  } else {
    lines.push('**Current state:** ✗ not signed in yet. Start with Step 1.');
  }
  lines.push('');
  lines.push(
    '> Feedback during beta? Describe any friction point (*"it\'d be nice if..."*, *"this is broken"*, *"I wish this could..."*) ' +
      "and I'll offer to file it. Or say *\"send feedback to mixshift: \\<your message\\>\"* directly.",
  );
  lines.push('');
  lines.push('Once you are in, say **"help"** anytime to see everything this plugin can do.');
  lines.push('');

  return lines.join('\n');
}
