# Install in Cowork — Personal install

**Who this is for:** You're a MixShift customer (or an end user at a MixShift customer org) who wants to install `mixshift-ai` on your own Cowork seat. The plugin lives on your personal Cowork install; it doesn't deploy to anyone else.

**If you're a Cowork org admin** who wants to roll the plugin out to your whole team at once, you want [Cowork — Organization install](./cowork-organization.md) instead.

---

## Prereqs

- A Cowork account
- An active MixShift customer account (you can log in to mixshift.ai / your MixShift portal)
- Cowork desktop app installed (the web app's plugin UX may be more limited)

You don't need org admin access for this path.

---

## Step 1 — Add the GitHub marketplace

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

The plugin appears in your **Personal plugins** section in the sidebar.

**Tip — reopening the Directory modal later.** It's not obvious how to get back to this view after install. The path is: Customize → click **+** next to **Personal plugins** → the Directory reopens with your marketplaces and plugins listed. From there you can install other plugins, toggle **Sync automatically**, hit **Check for updates**, or **Remove** anything. You'll use this surface again whenever MixShift ships a new version (see Troubleshooting at the bottom for the workaround if the version field gets stuck).

## Step 3 — Sign in

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
- Onboard a brand for analytical skills (pre-beta — not generally enabled yet)
- Re-run sign-in (if you need to switch accounts)

Then try the data-explore skill:

- "what tables can I query"
- "show me a sample of campaignmetric for seller [your SellerID]"
- "export [brand]'s campaign data for last week to CSV"

If you don't know your SellerIDs, say "discover my brands" and Claude runs `mixshift brand discover` to list them.

---

## Troubleshooting

**"Add marketplace from GitHub" option is missing in Customize.**
The exact UI label may differ between Cowork versions. Look for "+" next to **Marketplaces** or a similar add-marketplace control. If you can't find it, your Cowork build may not expose user-level marketplace adds (older builds didn't). Fall back to [Claude Code install](./claude-code.md) or ask your team admin to use the [Organization install](./cowork-organization.md) path.

**"command not found: mixshift" when Claude tries to run the welcome.**
This means Cowork didn't auto-PATH the plugin's `bin/` directory. File a Cowork support request — this is the documented behavior per Cowork's plugin install docs and should be auto-handled. Workaround: ask Claude to invoke the harness via its absolute path: `node $CLAUDE_PLUGIN_ROOT/harness/dist/cli.js welcome`.

**Browser didn't open during sign-in.**
The PKCE flow tries to open your default browser via the OS-native handler. If that fails (rare), the harness auto-falls-back to a device-code flow and prints a URL Claude surfaces in chat — open that URL in any browser. If the chat skill never showed a URL at all, the harness may not be on PATH inside Cowork's Bash tool — say "run welcome" again, and if the issue persists open a feedback ticket.

**"Sign-in page won't accept my credentials."**
Use the same email + password you use to log into MixShift. If those don't work, your MixShift account itself may be locked or expired — contact your MixShift account team.

**"Your session expired."**
Your refresh token expired (>30d since last sign-in) or was revoked. Just say "sign in to mixshift" again and the chat skill drives a fresh sign-in.

**Plugin update available.**
In Cowork: Customize → **+** next to Personal plugins → Directory modal → three-dot menu next to `mx-claude-plugin` → **Check for updates**. Cowork pulls the latest marketplace manifest. Same auth credentials carry over across updates.

**Plugin shows an old version even after Check for updates / Sync automatically.**
Known Cowork bug — "Sync automatically" pulls the latest commit and refreshes file contents on disk, but doesn't refresh the displayed version field. The plugin behavior reflects the latest synced files; only the version label is stale. Workaround: remove + re-add the marketplace via the Directory modal (same surface — three-dot menu → **Remove**, then re-add via "Add marketplace from GitHub"). `marketplace_*` and `plugin_*` IDs are preserved so it's safe — your auth credentials live in `~/.mixshift/` independently of Cowork's plugin state and carry over.

---

## A note on telemetry

During the beta, the plugin sends anonymized usage events to MixShift so we can iterate on it. The welcome screen prints a one-time notice the first time you run it; full details + opt-out in [Privacy & telemetry](../privacy.md).

## What's next

- [Auth setup deep dive](../auth-setup.md) — how the credentials flow works, share-with-team patterns, troubleshooting
- [Privacy & telemetry](../privacy.md) — what's collected during beta, how to opt out
- [FAQ](../faq.md) — common questions about data visibility, multi-user setups, etc.
- [Cowork organization install](./cowork-organization.md) — if you decide your whole team should have this, the admin can publish to your Cowork org marketplace
