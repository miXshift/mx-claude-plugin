import type { Command } from 'commander';
import { loadPluginDefaults } from '../lib/defaults/load.js';
import { loadProfile } from '../lib/profile/load.js';
import { loadCredentials } from '../lib/auth/credentials.js';

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
    .action(async (_opts, cmd: Command) => {
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
        process.exit(0);
      }

      // Welcome is informational, not an error — route to stdout so it
      // doesn't render red in tools that style stderr as error.
      process.stdout.write(renderWelcome({ authReady, profileReady, cr }));
      process.exit(0);
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
    lines.push('    • Send feedback / report bugs:');
    lines.push('        In chat:    "send feedback to mixshift: <your message>"');
    lines.push('        Terminal:   mixshift feedback "<your message>"');
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
  lines.push('Need help? In chat: "send feedback to mixshift: <your question>"');
  lines.push('         In terminal: mixshift feedback "<your question>"');
  lines.push('Bugs, requests, comments — all welcome.');
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
