# Install in Claude Code

**Who this is for:** You use Claude Code (Anthropic's terminal-based Claude CLI) instead of, or in addition to, Cowork desktop. Plugins in Claude Code install via slash commands.

If you use Cowork, you want [Cowork — Personal install](./cowork-personal.md) or [Cowork — Organization install](./cowork-organization.md) instead.

---

## Prereqs

- Claude Code installed and working (`claude` command available in your terminal)
- An active MixShift customer account with warehouse access
- `node` ≥ 20 on your machine (the bundled CLI requires it)

You can install the plugin into any Claude Code session — it lives on your local machine, per-user.

---

## Step 1 — Add the marketplace

In any Claude Code session, run:

```
/plugin marketplace add https://github.com/miXshift/mx-claude-plugin
```

Claude Code fetches the marketplace manifest from the public GitHub repo. This is a per-user operation — only your Claude Code install knows about the marketplace, not anyone else's.

### Beta testers: pin the `stable` channel

The command above tracks the default branch (the internal / latest build). To install the **stable beta** build, add the marketplace pinned to the `stable` branch instead:

```
/plugin marketplace add https://github.com/miXshift/mx-claude-plugin.git#stable
```

Use the `.git#stable` form (full git URL plus a `#ref`). Ref pinning needs the full git URL: the `owner/repo@stable` shorthand resolves to an SSH clone and fails without SSH keys. To update later, run `/plugin marketplace update mixshift`, then `/plugin update mixshift-ai`.

> **Use the full HTTPS URL, not the `owner/repo` shorthand.** The shorthand (`miXshift/mx-claude-plugin`) expands to an SSH clone URL (`git@github.com:...`), which fails with "Permission denied (publickey)" unless you have GitHub SSH keys configured. The HTTPS URL clones without any key setup.
>
> Run this on its own. Do not paste it together with the install command on the next line, or the add command will swallow the second line as part of the URL.

## Step 2 — Install the plugin

```
/plugin install mixshift-ai@mixshift
```

(The `@mixshift` suffix is the marketplace's name: the `name` field in its manifest, which is `mixshift`, **not** the GitHub repo name. Step 1 confirms it: the add prints "Successfully added marketplace: mixshift". The suffix tells Claude Code which marketplace to install from. It is necessary if you have multiple marketplaces registered, harmless otherwise.)

Confirm:

```
/plugin
```

Should list `mixshift-ai` with the latest version.

## Step 3 — Set the permission mode (recommended)

Claude Code's default permission mode ("accept edits") asks you to approve every command Claude runs. During onboarding that means a long series of approval prompts before you see any data, and "always allow" choices don't always stick between prompts.

For a smoother first run:

1. Find the **permission-mode selector in the lower-left of the input box** (same spot in the Claude Code terminal UI and the desktop app).
2. Switch it to **auto-accept** for the onboarding session. You can switch back afterwards.
3. Power users who trust the plugin can pick **bypass permissions** instead, which skips prompts entirely.

**On personal (Pro/Max) plans:** some execution capabilities are gated by claude.ai settings, separate from the permission mode. If commands will not run at all, open **Settings → Capabilities** ([claude.ai/settings/capabilities](https://claude.ai/settings/capabilities)) and make sure code execution is enabled.

## Step 4 — Sign in

In Claude Code chat, say:

- "welcome"
- "sign in to mixshift"

Claude walks you through sign-in inline:

1. Asks for your work email (used to attribute your session — same email you use to log into MixShift is fine).
2. Opens a browser tab at the MixShift sign-in page (`https://mcp.mixshift.io/login`).
3. You sign in with your MixShift account — same email + password you use for MixShift.
4. You say "done" in chat, and Claude confirms.

Alternatively, run directly from a terminal:

```bash
mixshift auth login --person-label you@yourcompany.com
```

This opens your default browser via PKCE and waits for the callback. If your environment can't open a browser, the harness auto-falls-back to a device-code flow and prints a URL you can open elsewhere.

That's it. Tokens land at `~/.mixshift/auth/credentials` (24h access / 30d refresh). No raw database passwords on disk, no IP whitelist setup — MixShift's auth service holds the single static egress IP that talks to the warehouse server-side.

Full details: [`docs/auth-setup.md`](../auth-setup.md).

## Step 5 — Verify

```bash
mixshift welcome
```

Should print the "you are already set up" view.

Then try data exploration:

```
"what tables can I query"
"show me a sample of campaignmetric for seller [your SellerID]"
"export [brand]'s campaign data for last week to CSV"
```

Or from a terminal directly:

```bash
mixshift data list-tables
mixshift data sample --table campaignmetric --seller-id <N> --limit 10
mixshift brand discover --json
```

You can also pull live from Amazon right after sign-in, no brand setup required:

```
"list my Amazon merchants"
"pull a Sales and Traffic report for seller [your SellerID] for last week"
"show my live Amazon Ads campaigns for [brand]"
```

Amazon Ads changes (pause, bid and budget edits, negatives) run through `mx-amazon-ads`, which previews every change and applies it only after you confirm. See the [README capability overview](../../README.md#what-the-plugin-can-do).

---

## Updates

Run both in your terminal. The first refreshes your local copy of the marketplace catalog; the second installs the newest version it now sees:

```
claude plugin marketplace update mixshift
claude plugin update mixshift-ai
```

Refreshing the catalog first matters: `claude plugin update` installs whatever version your local catalog knows about, so without the refresh it can reinstall the version you already have. To update every installed plugin at once, use `claude plugin update --all` (still refresh first).

**Then load it: start a new session.** An update never takes effect in a running session, which keeps the plugin version it started with. Fully quit the `claude` process and relaunch; opening a new chat in the same process is not enough.

Tokens carry over across plugin updates.

---

## Troubleshooting

**Everything hangs or fails silently on first run.**
The most common cause: Node.js is not installed on the machine. The plugin's bundled CLI runs on Node (version 20 or newer), and without it every `mixshift` command dies before it can print a friendly error. Check with `node --version` in a terminal. If it is missing, install it (macOS: `brew install node` if you have Homebrew, otherwise the [nodejs.org](https://nodejs.org) LTS installer; Windows: `winget install OpenJS.NodeJS.LTS`), then start a new session. If this Mac has never run a terminal tool before, you may also need Apple's Command Line Tools: run `xcode-select --install`.

**"Marketplace not found" when running `/plugin marketplace add`.**
Confirm the GitHub repo is reachable from your machine: `curl -sI https://github.com/miXshift/mx-claude-plugin/blob/main/.claude-plugin/marketplace.json` should return a 200 (or redirect). If you're behind a corporate proxy, configure `git` to use it; Claude Code uses `git` under the hood for marketplace fetches.

**A fresh install shows an old version (e.g. you expected the latest but `/plugin` lists an older number).**
`/plugin marketplace add` is a no-op if a marketplace of that name is already registered; it does **not** re-fetch an existing local clone. So if you (or a previous session) added `mixshift` before, a later `add` reuses the stale clone and installs whatever version it was pinned at. Fix: refresh the clone, then update the plugin, then restart:
```
claude plugin marketplace update mixshift
claude plugin update mixshift-ai
```
Confirm what your local clone is actually pinned at with `git -C ~/.claude/plugins/marketplaces/mixshift log --oneline -1`, and what's installed in `~/.claude/plugins/installed_plugins.json` (`version` + `gitCommitSha`). As always, the new version only loads after a full restart.

**"command not found: mixshift" after install.**
Claude Code should auto-add the plugin's `bin/` directory to the Bash tool's PATH. If it doesn't, you have two workarounds:
- Run via the absolute path: `node $CLAUDE_PLUGIN_ROOT/harness/dist/cli.js welcome`
- Add the bin path to your shell's PATH manually: `export PATH="$HOME/.claude/plugins/mixshift-ai/bin:$PATH"` (exact path may vary)

**Browser didn't open during sign-in.**
PKCE tries to open your default browser via the OS-native handler. On Linux without a display environment (headless server, container, SSH session), the open call fails. The harness detects this and falls back to device-code, printing a URL you can open on any machine with a browser. To force the device-code flow up front: `mixshift auth login --mode device --person-label you@yourcompany.com`.

**"Your session expired."**
Refresh token expired (>30d) or was revoked. Run `mixshift auth login` (or "sign in to mixshift" in chat) to get a fresh pair.

---

## A note on telemetry

During the beta, the plugin sends anonymized usage events to MixShift so we can iterate. You'll see a one-time notice the first time you run `mixshift welcome`; full disclosure + opt-out in [Privacy & telemetry](../privacy.md).

## What's next

- [Auth setup deep dive](../auth-setup.md)
- [Privacy & telemetry](../privacy.md)
- [FAQ](../faq.md)
- [CLI direct install](./cli-direct.md) — if you want the harness CLI without going through a plugin host at all (e.g. for scripting or CI)
