# Install in Cowork — Personal install

**Who this is for:** You're a MixShift customer (or an end user at a MixShift customer org) who wants to install `mixshift-ai` on your own Cowork seat. The plugin lives on your personal Cowork install; it doesn't deploy to anyone else.

**If you're a Cowork org admin** who wants to roll the plugin out to your whole team at once, you want [Cowork — Organization install](./cowork-organization.md) instead.

---

## Prereqs

- A Cowork account
- An active MixShift customer account (you can log in to mixshift.ai / your MixShift portal)
- Cowork desktop app installed (the web app's plugin UX may be more limited)
- `node` ≥ 20 on your machine (the plugin's bundled CLI runs on Node.js). Check with `node --version` in a terminal; if it's missing, see ["Everything hangs or fails silently on first run"](#troubleshooting) below for the quick install.

You don't need org admin access for this path.

---

## Step 1 — Add the GitHub marketplace

Quick concept check: the **marketplace** is the catalog; the **plugin** (`mixshift-ai`) is what you actually install from it in Step 2.

In Cowork desktop:

1. Click **Customize** in the left sidebar.
2. Click the **+** button.
3. Choose **"Add marketplace from GitHub"**.
4. Paste either:
   - `miXshift/mx-claude-plugin` (owner/repo shorthand), or
   - `https://github.com/miXshift/mx-claude-plugin` (full URL)
5. Confirm.

Cowork pulls the marketplace manifest and registers the marketplace locally — only on your seat, not org-wide.

## Step 2 — Install the plugin

1. Open the Cowork **Directory** modal (look for "Skills / Connectors / Plugins" in Customize).
2. Find `mixshift-ai` in the listed plugins.
3. Click **Install**.
4. In the same Directory modal, turn on **Sync automatically** for the `mx-claude-plugin` marketplace. It is off by default on some machines, and without it your install stays pinned to whatever version you first pulled, so you silently miss every update MixShift ships.

The plugin appears in your **Personal plugins** section in the sidebar.

**Tip — reopening the Directory modal later.** It's not obvious how to get back to this view after install. The path is: Customize → click **+** next to **Personal plugins** → the Directory reopens with your marketplaces and plugins listed. From there you can install other plugins, toggle **Sync automatically**, hit **Check for updates**, or **Remove** anything. You'll use this surface again whenever MixShift ships a new version (see Troubleshooting at the bottom for the workaround if the version field gets stuck).

## Step 3 — Sign in

**Before you start: set the permission mode.** By default Claude asks you to approve every command it runs, which makes onboarding a slog of approval prompts (and "always allow" doesn't always stick). In the Claude app settings, switch the permission mode to **auto-accept** for this first session; power users who trust the plugin can use **bypass permissions** instead. On personal (Pro/Max) plans, if commands will not run at all, also check that code execution is enabled under claude.ai **Settings → Capabilities** ([claude.ai/settings/capabilities](https://claude.ai/settings/capabilities)).

In any Cowork chat, say one of:

- "welcome"
- "sign in to mixshift"
- "how do I get started with MixShift"

Claude runs the `welcome` skill and walks you through sign-in inline. The full flow takes about 30 seconds:

1. Claude asks for your work email (used to attribute your session — same email you use to log into MixShift is fine).
2. Claude opens a browser tab at the MixShift sign-in page (`https://mcp.mixshift.io/login`).
3. You sign in with your MixShift account — the same email + password you use to log into MixShift. Your credentials stay on the sign-in page; the plugin never sees them.
4. You return to chat and say "done".
5. Claude confirms the sign-in, runs a verification query, and shows you the brands you have access to.

That's it. The plugin stores a short-lived token at `~/.mixshift/auth/credentials` (24h access / 30d refresh). No raw database passwords on disk, no IP whitelist setup — MixShift's auth service holds the single static egress IP that talks to the warehouse server-side.

Full details on how sign-in works: [`docs/auth-setup.md`](../auth-setup.md).

## Step 4 — Verify it works

Re-run the welcome skill to confirm everything is set up:

- "welcome"

Now you should see the "you are already set up" view with four actions:

- Discover your brands
- Explore + export your data
- Set up a brand for the analytical skills (these roll out in waves)
- Re-run sign-in (if you need to switch accounts)

Then try a skill. For your warehouse data:

- "what tables can I query"
- "show me a sample of campaignmetric for seller [your SellerID]"
- "export [brand]'s campaign data for last week to CSV"

Or pull live from Amazon (no brand setup needed):

- "list my Amazon merchants"
- "pull a Brand Analytics report for [brand] for last month"
- "show my live Amazon Ads campaigns for [brand]"

If you don't know your SellerIDs, say "discover my brands" and Claude runs `mixshift brand discover` to list them.

---

## Troubleshooting

**Everything hangs or fails silently on first run.**
The most common cause: Node.js is not installed on the machine. The plugin's bundled CLI runs on Node (version 20 or newer), and without it every `mixshift` command dies before it can print a friendly error. In Cowork this can look like tool calls churning forever with NO error message at all (Claude Code at least reports that `node` is missing). Check with `node --version` in a terminal. If it is missing, install it (macOS: `brew install node` if you have Homebrew, otherwise the [nodejs.org](https://nodejs.org) LTS installer; Windows: `winget install OpenJS.NodeJS.LTS`), then fully restart the Claude app. If this Mac has never run a terminal tool before, you may also need Apple's Command Line Tools: run `xcode-select --install` in Terminal.

**"Add marketplace" / "Add plugin" menu is missing.**
First, fully quit and restart the Claude app (macOS: Cmd+Q, not just closing the window), then look again under Customize. We've seen the menu fail to appear on multiple machines until a full restart. If it's still missing: the exact UI label may differ between Cowork versions. Look for "+" next to **Marketplaces** or a similar add-marketplace control. If you can't find it, your Cowork build may not expose user-level marketplace adds (older builds didn't). Fall back to [Claude Code install](./claude-code.md) or ask your team admin to use the [Organization install](./cowork-organization.md) path.

**"Failed to add marketplace" with no error detail.**
Retry once first: transient network hiccups produce the same blank error. If it keeps failing, check the network egress allowlist (same fix as the "fetch failed" entry below; the marketplace fetch goes through the same sandbox). Also note the URL form: the branch-pinned form (`https://github.com/miXshift/mx-claude-plugin.git#stable`) may fail in Cowork's add-marketplace UI. Use the plain repo URL (`https://github.com/miXshift/mx-claude-plugin`) there.

**"command not found: mixshift" when Claude tries to run the welcome.**
This means Cowork didn't auto-PATH the plugin's `bin/` directory. File a Cowork support request — this is the documented behavior per Cowork's plugin install docs and should be auto-handled. Workaround: ask Claude to invoke the harness via its absolute path: `node $CLAUDE_PLUGIN_ROOT/harness/dist/cli.js welcome`.

**Browser didn't open during sign-in.**
The PKCE flow tries to open your default browser via the OS-native handler. If that fails (rare), the harness auto-falls-back to a device-code flow and prints a URL Claude surfaces in chat — open that URL in any browser. If the chat skill never showed a URL at all, the harness may not be on PATH inside Cowork's Bash tool — say "run welcome" again, and if the issue persists open a feedback ticket.

**"Sign-in page won't accept my credentials."**
Use the same email + password you use to log into MixShift. If those don't work, your MixShift account itself may be locked or expired — contact your MixShift account team.

**"Your session expired."**
Your refresh token expired (>30d since last sign-in) or was revoked. Just say "sign in to mixshift" again and the chat skill drives a fresh sign-in.

**Plugin update available.**
In Cowork: Customize → **+** next to Personal plugins → Directory modal → three-dot menu next to `mx-claude-plugin` → **Check for updates**. Cowork pulls the latest marketplace manifest. Then fully quit and reopen Cowork so the new version actually loads: a running session keeps the plugin version it started with, so the update only takes effect after a restart (a new conversation in the same session is not enough). Same auth credentials carry over across updates.

**Plugin shows an old version even after Check for updates / Sync automatically.**
Known Cowork bug — "Sync automatically" pulls the latest commit and refreshes file contents on disk, but doesn't refresh the displayed version field. The plugin behavior reflects the latest synced files; only the version label is stale. Workaround: remove + re-add the marketplace via the Directory modal (same surface — three-dot menu → **Remove**, then re-add via "Add marketplace from GitHub"). `marketplace_*` and `plugin_*` IDs are preserved so it's safe — your auth credentials live in `~/.mixshift/` independently of Cowork's plugin state and carry over.

**"This plugin doesn't have any skills or agents" in the Customize panel after a restart or after manually cleaning up plugin files.**
This usually means Cowork's plugin cache extraction (`~/.claude/plugins/cache/mixshift/mixshift-ai/<version>/`) is empty or missing while the install record (`~/.claude/plugins/installed_plugins.json`) still points at that path. Triggered most commonly by manually deleting the cache directory, or by a botched update where the new version's files never landed.

Fix: in the Customize panel, click the three-dot menu next to `mixshift-ai` and choose **Uninstall**, then reinstall from the Directory modal. This forces Cowork to re-extract the plugin from its marketplace clone into a fresh cache directory. Auth credentials in `~/.mixshift/` are unaffected, so no re-sign-in.

If that doesn't help, the marketplace clone itself may be stale (Cowork doesn't always auto-fetch new origin commits on restart). Also remove + re-add the marketplace (Directory → three-dot menu next to `mx-claude-plugin` → **Remove**, then "Add marketplace from GitHub" again) to force Cowork to re-clone from origin.

**Sign-in fails with "fetch failed" or a "403 from proxy" error.**
Your Cowork environment is blocking the plugin's outbound connection to the MixShift service. Cowork runs plugin commands in a sandbox whose network is locked down by default, so the MixShift host has to be on the egress allowlist. First, diagnose it: say "run mixshift doctor" (or run `mixshift doctor` in a terminal). It detects the sandbox proxy, probes the service, and tells you exactly which domains need allowlisting.

The required domains are `mcp.mixshift.io` (everything depends on it) and `*.amazonaws.com` (report downloads). Who adds them depends on your setup:

- **If you're on a personal Pro or Max plan (most individual Cowork users):** you add the domains yourself, no admin needed. Open **Settings → Capabilities** ([claude.ai/settings/capabilities](https://claude.ai/settings/capabilities)) → **Code execution and file creation**, turn on **Allow network egress**, and add both domains under **Additional allowed domains**. Then **start a new conversation** (network settings apply at session creation, so an existing chat won't pick up the change). Known Cowork bug: if the domains don't take under the **"Package managers only"** mode, set the mode to **"All domains"**.
- **If your Cowork seat is part of a Team/Enterprise org:** you can't change the network allowlist yourself; it's an org-admin setting. Send your admin the [Organization install troubleshooting](./cowork-organization.md#troubleshooting) section. They add the domains under Organization settings → Capabilities → Code execution, then you **start a new conversation** (the change only applies to conversations created after it).
- **If you're running standalone Claude Code (not Cowork):** add the domains yourself in `~/.claude/settings.json` under `sandbox.network.allowedDomains` (unless managed settings set `allowManagedDomainsOnly: true`, in which case it's admin-controlled). See the [CLI install notes](./cli-direct.md#a-note-on-sandbox-egress).

---

## A note on telemetry

During the beta, the plugin sends usage events to MixShift so we can iterate on it. During the beta these are attributed to your MixShift account and the person or service credential that ran them (not anonymous), with secret-shaped values stripped from captured command lines. The welcome screen prints a one-time notice the first time you run it; full details + opt-out in [Privacy & telemetry](../privacy.md).

## What's next

- [Auth setup deep dive](../auth-setup.md) — how the credentials flow works, share-with-team patterns, troubleshooting
- [Privacy & telemetry](../privacy.md) — what's collected during beta, how to opt out
- [FAQ](../faq.md) — common questions about data visibility, multi-user setups, etc.
- [Cowork organization install](./cowork-organization.md) — if you decide your whole team should have this, the admin can publish to your Cowork org marketplace
