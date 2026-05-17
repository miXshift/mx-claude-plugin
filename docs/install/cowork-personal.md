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

## Step 3 — First run

In any Cowork chat, say one of:

- "welcome"
- "how do I get started with MixShift"
- "first time setup"

Claude runs the `welcome` skill, which invokes `mixshift welcome` and prints:

- The credential-retrieval URL (where you'll go to get your MySQL credentials)
- The master password (a value shared across all MixShift customers — it's a guard against accidental credential exposure, not a per-user secret)
- The three quick-start steps to follow

## Step 4 — Get your warehouse credentials

1. Open the credential-retrieval URL from the welcome screen (default: `https://www.mydashapplications.com/database-admin`; your screen shows the right URL for your tenant if it's different).
2. Enter the **master password** from the welcome screen when prompted.
3. The page shows your warehouse credentials:
   - **HostName** — usually `db.mydashapplications.studio`; some tenants have a tenant-specific subdomain
   - **Username** — typically matches your MixShift tenant slug
   - **Port** — `3306`
   - **Schema** — usually matches Username; the canonical legacy schema is `dashamazon`
   - **Password** — your MySQL password

Keep this page open. You'll paste the values in the next step.

## Step 5 — Run auth setup

In Cowork chat, say:

- "set up my credentials"
- "run auth setup"

Claude walks you through the values from Step 4. Crucially, **your MySQL password goes through a temporary file**, not directly into chat — Claude will ask you to save the password to a text file (e.g. `/tmp/pw.txt`) and give it the path. This keeps the password out of your chat transcript.

Behind the scenes, the harness runs:

```bash
mixshift auth setup --from-file <values.yaml> --password-file <pw.txt>
```

The values file contains your email + host + port + username + schema. The password file contains just the password. The harness validates everything, tests the connection, and writes credentials to `~/.mixshift/auth/credentials`.

If your IP isn't whitelisted on the warehouse yet, the harness asks you for permission to send a whitelist request to MixShift ops. The request includes your email + public IP — an operator grants access manually, typically within a few hours. You'll get an email when access is live, then re-run any skill.

Full details on auth setup: [`docs/auth-setup.md`](../auth-setup.md).

## Step 6 — Verify it works

Re-run the welcome skill to confirm everything is set up:

- "welcome"

Now you should see the "you are already set up" view with four actions:

- Discover your brands
- Explore + export your data
- Onboard a brand for analytical skills (pre-beta — not generally enabled yet)
- Re-run auth setup (if you need to change credentials)

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

**"User force closed the prompt" during auth setup.**
This means Claude tried to drive the interactive TTY prompts, which Cowork's Bash tool can't support. The chat-orchestrated `--from-file` + `--password-file` flow handles this — make sure Claude isn't trying to run `mixshift auth setup` without the file flags. If Claude is asking for your password directly in chat (instead of asking you to save it to a file), say "use the password file flow instead" — that's the correct path.

**Connection test hangs forever.**
Your IP isn't whitelisted on the warehouse. The auth-setup skill should have asked your permission to send a whitelist request automatically. If it didn't, run in a terminal:

```bash
mixshift auth setup --request-whitelist
```

Or in chat: "request IP whitelist". You'll get an email when access is live.

**Plugin update available.**
In Cowork: Customize → find `mixshift-ai` → check for updates. Cowork pulls the latest marketplace manifest and prompts you to update. Same auth credentials carry over.

---

## What's next

- [Auth setup deep dive](../auth-setup.md) — how the credentials flow works, share-with-team patterns, troubleshooting
- [FAQ](../faq.md) — common questions about data visibility, multi-user setups, etc.
- [Cowork organization install](./cowork-organization.md) — if you decide your whole team should have this, the admin can publish to your Cowork org marketplace
