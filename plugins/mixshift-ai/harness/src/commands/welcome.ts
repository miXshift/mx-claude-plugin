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
    lines.push('        mixshift brand discover');
    lines.push('');
    lines.push('    • Explore + export your data (no brand onboarding needed):');
    lines.push('        Type "explore my data" in chat, or run');
    lines.push('        mixshift data list-tables');
    lines.push('');
    lines.push('    • Onboard a specific brand for analytical skills:');
    lines.push('        mixshift brand add <slug>');
    lines.push('        /account-cold-start <slug>     (in Claude)');
    lines.push('');
    lines.push('    • Re-run auth setup (new credentials / different account):');
    lines.push('        mixshift auth setup');
    lines.push('');
    lines.push('    • Send feedback / report bugs:');
    lines.push('        mixshift feedback "<your message>"');
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
  lines.push('    mixshift auth setup');
  lines.push('');
  lines.push('  Paste the credentials when prompted. We test the connection and');
  lines.push('  request an IP whitelist automatically if your IP is not approved.');
  lines.push('');
  lines.push('━━ Step 3 — Try something ━━');
  lines.push('');
  lines.push('  Discover the brands you have access to:');
  lines.push('    mixshift brand discover');
  lines.push('');
  lines.push('  See what data tables you can query:');
  lines.push('    mixshift data list-tables');
  lines.push('');
  lines.push('  Or just say "explore my data" in chat — Claude will guide you.');
  lines.push('');
  lines.push('━'.repeat(60));
  lines.push('');
  lines.push('Need help? Run `mixshift feedback "<your question>"` and we will');
  lines.push('reach out. Issues, requests, comments — all welcome.');
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
