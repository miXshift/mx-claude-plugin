# Install the CLI directly (no plugin host)

**Who this is for:** You want `mixshift` as a standalone command-line tool, separate from any Claude plugin install. Common cases:

- You're scripting / automating against the MixShift warehouse (cron, CI, ad-hoc shell pipelines).
- You want to use the CLI from a different agent host (not Cowork, not Claude Code).
- You want to develop / contribute to the plugin and need the harness invokable for tests.

This path skips Claude entirely. You won't get the chat-orchestrated experience — just a working `mixshift` binary you can call from a terminal.

---

## Prereqs

- `node` ≥ 20 (`node --version` to check)
- `git` (to clone the repo)
- An active MixShift customer account with warehouse access

---

## Option A — Clone and build from source

The most flexible install. Lets you stay current with the repo.

```bash
git clone https://github.com/miXshift/mx-claude-plugin.git
cd mx-claude-plugin/plugins/mixshift-ai/harness
npm install
npm run build
```

The build emits `dist/cli.js` — a bundled, self-contained executable. Make `harness/bin/mixshift` (the public entry point) available on your PATH:

```bash
# Replace ~/path/to with where you cloned
export PATH="$HOME/path/to/mx-claude-plugin/plugins/mixshift-ai/harness/bin:$PATH"

# Or symlink globally
sudo ln -sf "$HOME/path/to/mx-claude-plugin/plugins/mixshift-ai/harness/bin/mixshift" /usr/local/bin/mixshift
```

Test:

```bash
mixshift --version
mixshift --help
```

## Option B — Run from the built artifact in the repo

The repo ships the pre-built `dist/cli.js` so you can invoke it without running `npm install`. Useful for one-off use:

```bash
git clone https://github.com/miXshift/mx-claude-plugin.git
node mx-claude-plugin/plugins/mixshift-ai/harness/dist/cli.js --help
```

Less convenient because you have to type the full path each time. Add an alias:

```bash
alias mixshift='node $HOME/path/to/mx-claude-plugin/plugins/mixshift-ai/harness/dist/cli.js'
```

## Option C — npm install -g (not yet published)

We don't currently publish `@mixshift/harness` to the public npm registry, since the harness is meant to ship as part of the plugin. If you want a globally-installable CLI as a separate distribution channel, file a GitHub issue requesting it and we'll consider scoping a public release.

---

## Step — Sign in

The recommended path is token-based browser sign-in:

```bash
mixshift auth login --person-label you@yourcompany.com
```

This opens your default browser via PKCE, you sign in with your MixShift account, and tokens write to `~/.mixshift/auth/credentials`. Takes about 30 seconds. No raw database passwords on disk, no IP whitelist setup.

If your environment can't open a browser (headless server, container, SSH session), the harness auto-falls-back to a device-code flow and prints a URL you can open elsewhere. To force the device-code mode up front:

```bash
mixshift auth login --person-label you@yourcompany.com --mode device
```

For development against a non-prod auth service:

```bash
mixshift auth login \
  --person-label dev@example.com \
  --api-base http://localhost:8080 \
  --client-id mx-claude-plugin-dev
```

The retired `mixshift auth setup` raw-MySQL flow is no longer supported; `auth login` (or an admin-issued service credential) is the only path for new setups.

Full reference: [`docs/auth-setup.md`](../auth-setup.md).

---

## Step — Use it

The CLI surface is fully documented via `--help`:

```bash
mixshift --help
mixshift data --help
mixshift brand --help
mixshift amazon --help
mixshift ads --help
```

Common operations:

```bash
# Discover brands you have access to
mixshift brand discover --json

# Onboard a brand (creates ~/.mixshift/clients/<slug>/)
mixshift brand add <brand-slug>

# Explore the warehouse
mixshift data list-tables
mixshift data describe campaignmetric
mixshift data sample --table campaignmetric --seller-id <N> --limit 10
mixshift data query --sql "SELECT COUNT(*) FROM campaignmetric WHERE SellerID = <N>"
mixshift data export --table campaignmetric --seller-id <N> \
  --start 2026-04-01 --end 2026-04-30 --out ~/campaign-q2.csv

# Pull live from Amazon (SP-API reports, retail lookups, AMC, DSP, pricing)
mixshift amazon merchants
mixshift amazon list-reports
mixshift amazon report start --type GET_SALES_AND_TRAFFIC_REPORT --seller-id <N>   # then: report poll / report get
mixshift amazon operations                                                         # browse live SP-API read operations

# Amazon Ads: reads + audited writes
mixshift ads profiles
mixshift ads operations                                                            # browse callable Ads operations
mixshift ads call <operation> --profile-id <id> --body-file changes.json           # DRY-RUN by default: validates + previews, nothing reaches Amazon
mixshift ads call <operation> --profile-id <id> --body-file changes.json --commit  # only --commit mutates, after you review the preview

# Send feedback / report bugs / request table access
mixshift feedback "your message" --category bug

# Run an analytical-skill prefetch + sidecar write (needs brand context set up)
mixshift prefetch --brand <slug> --skill <skill-id>
mixshift sidecar write --input-file <path>
```

---

## Updates

Pull and rebuild:

```bash
cd mx-claude-plugin
git pull
cd plugins/mixshift-ai/harness
npm install   # if dependencies changed
npm run build
```

Or, if you're using the shipped `dist/cli.js` directly without building, just `git pull` — the latest `dist/cli.js` is committed to the repo.

---

## Troubleshooting

**`node: command not found` or `node --version` shows < 20.**
Install a current Node. The plugin requires `node ≥ 20.0.0` per the harness's `package.json::engines`. Use `nvm` or `volta` to manage versions.

**`mysql2` install errors during `npm install`.**
`mysql2` is a native module; some environments need build tools. Try `npm install --build-from-source` or `npm install --omit=optional` to skip optional native deps.

**`mixshift` works in one terminal but not another.**
Your PATH isn't persisted. Add the `export PATH=...` line to your shell rc file (`~/.bashrc`, `~/.zshrc`, etc.).

**You want to test a fork / development branch.**
Clone, `git checkout <branch>`, then `npm install && npm run build`. The harness/bin/mixshift wrapper forwards to whichever `dist/cli.js` is in your local working tree.

**Any command fails with "fetch failed" or a "403 from proxy after CONNECT".**
You're running inside a network-restricted sandbox (most often Claude Code's Bash sandbox). The MixShift host has to be on the egress allowlist. Run `mixshift doctor` for the exact remediation. See [A note on sandbox egress](#a-note-on-sandbox-egress) below. In a plain terminal with normal outbound access, this error means something else (DNS, VPN, or the service being down) and `mixshift doctor` will tell you which.

---

## A note on sandbox egress

If you run this CLI inside a network-restricted sandbox, outbound traffic is forced through an egress proxy that is **deny-by-default**. The CLI talks to the MixShift service (`mcp.mixshift.io`) and, for report pulls, to presigned S3 URLs (`*.amazonaws.com`), so both must be on the allowlist or every command fails with a bare `fetch failed`.

The two environments where this applies:

- **Standalone Claude Code:** add the domains in `~/.claude/settings.json` under `sandbox.network.allowedDomains`, unless managed settings set `allowManagedDomainsOnly: true` (then it's admin-controlled). The minimal set is `mcp.mixshift.io` and `*.amazonaws.com`.
- **A plain terminal / CI runner:** normally no proxy is involved, so this doesn't apply. If your CI host does enforce egress filtering, allowlist the same two domains there.

`mixshift doctor` is the fastest way to tell which situation you're in: it reports whether a proxy is active, probes the service `/health` endpoint, and prints the precise allowlist fix when the host is blocked.

**Caveat — this does NOT fix the plugin inside Cowork.** Installing the CLI standalone on your PATH is unrelated to what Cowork runs. Cowork executes its own bundled copy of the plugin inside its own sandbox, governed by its own network policy. If your problem is "the plugin fails to reach MixShift inside Cowork," fixing it is a Cowork-side allowlist change, not a CLI install. See [Cowork organization install](./cowork-organization.md#troubleshooting) (admin allowlist) or [Cowork personal install](./cowork-personal.md#troubleshooting).

---

## A note on telemetry

During the beta, the harness sends usage events to MixShift (skills invoked, query timings, command lines and outcomes, never query results or credentials). These events are attributed to your MixShift account and actor rather than anonymized, with secret-shaped values stripped from captured command lines first. The first time you run any `mixshift` command, you'll see a short FYI notice in stderr; full disclosure + opt-out in [Privacy & telemetry](../privacy.md). For CI / scripted use where you want zero telemetry, set `MIXSHIFT_TELEMETRY=0` in your environment.

## What's next

- [Authentication deep dive](../auth-setup.md) — full reference for token-based sign-in and service credentials
- [Privacy & telemetry](../privacy.md) — what's collected during beta, how to opt out
- [FAQ](../faq.md) — common questions
- [Repo README](../../README.md) — high-level architecture + license + contributing
