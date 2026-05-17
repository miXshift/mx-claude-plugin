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

The build emits `dist/cli.js` — a bundled, self-contained executable. Make `bin/mixshift` (the public entry point) available on your PATH:

```bash
# Replace ~/path/to with where you cloned
export PATH="$HOME/path/to/mx-claude-plugin/plugins/mixshift-ai/bin:$PATH"

# Or symlink globally
sudo ln -sf "$HOME/path/to/mx-claude-plugin/plugins/mixshift-ai/bin/mixshift" /usr/local/bin/mixshift
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

## Step — Auth setup

Same auth flow as the plugin paths, just driven directly via the CLI. Interactive prompts work in your own terminal (the harness detects TTY):

```bash
mixshift auth setup
```

You'll be prompted for email, MySQL host, port, user, schema, and password (masked). The harness writes credentials to `~/.mixshift/auth/credentials`.

For scripted / CI use, pass `--from-file` and `--password-file`:

```bash
mixshift auth setup \
  --from-file ~/.mixshift/creds.yaml \
  --password-file ~/.mixshift/pw.txt \
  --request-whitelist
```

YAML schema:

```yaml
email: you@example.com
mysql:
  host: db.mydashapplications.studio
  port: 3306
  user: yourmixshiftuser
  database: yourmixshiftschema
  password: ""   # leave empty; harness uses --password-file
```

Full details: [`docs/auth-setup.md`](../auth-setup.md).

---

## Step — Use it

The CLI surface is fully documented via `--help`:

```bash
mixshift --help
mixshift data --help
mixshift brand --help
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

# Send feedback / report bugs / request table access
mixshift feedback "your message" --category bug

# (Pre-beta) run an analytical-skill prefetch + sidecar write
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
Clone, `git checkout <branch>`, then `npm install && npm run build`. The bin/mixshift wrapper forwards to whichever `dist/cli.js` is in your local working tree.

---

## A note on telemetry

During the beta, the harness sends anonymized usage events to MixShift (skills invoked, query timings, command outcomes — never query results or credentials). The first time you run any `mixshift` command, you'll see a short FYI notice in stderr; full disclosure + opt-out in [Privacy & telemetry](../privacy.md). For CI / scripted use where you want zero telemetry, set `MIXSHIFT_TELEMETRY=0` in your environment.

## What's next

- [Auth setup deep dive](../auth-setup.md) — the full credentials flow, share-with-team patterns, IP whitelist
- [Privacy & telemetry](../privacy.md) — what's collected during beta, how to opt out
- [FAQ](../faq.md) — common questions
- [Repo README](../../README.md) — high-level architecture + license + contributing
