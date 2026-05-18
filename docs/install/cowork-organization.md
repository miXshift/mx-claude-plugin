# Install in Cowork — Organization install

**Who this is for:** You're a Cowork organization owner / admin who wants to deploy `mixshift-ai` to everyone in your Cowork org at once. Common case: your MixShift account covers a team of AMs and ops people, and you want all of them to have the plugin available without each one going through a personal install.

**If you just want it on your own seat,** use [Cowork — Personal install](./cowork-personal.md) instead.

---

## The two-part install

This path has two distinct steps that happen at different times:

| Step | Who does it | When | What it accomplishes |
|---|---|---|---|
| **Part 1: Publish the plugin** | Org admin (you) | Once | Plugin code becomes available to every seat in your Cowork org |
| **Part 2: Auth setup** | Every user, individually | After Part 1, before first use | Each user writes their own `~/.mixshift/auth/credentials` |

Part 1 is org-wide. Part 2 is per-user. Both are required.

A note on credentials: today, MixShift's legacy system uses **a single MySQL login per customer organization** — no row-level permissions, no per-user data scoping. That means every user at your MixShift org sees the same merchants. The credentials values are identical for everyone; the per-user step (Part 2) is just because Cowork doesn't share filesystem state between users. Per-user roles + scoped data access are coming in MixShift 2.0.

---

## Part 1 — Publish the plugin to your org marketplace

You only do this once. Updates are also published from here.

In Cowork desktop:

1. Go to **Organization settings** → **Plugins**.
2. Click **Add plugin**.
3. Select **GitHub source**.
4. Enter `miXshift/mx-claude-plugin` (owner/repo).
5. Save / publish.
6. (Optional) Mark the plugin as **required** so it auto-installs for every seat instead of needing each user to click Install.

The repo must be public (it is). Plugin must already be shipped as a valid Cowork marketplace (`.claude-plugin/marketplace.json` at the repo root pointing at `plugins/mixshift-ai/` — we ship this).

After saving, `mixshift-ai` appears in the **"Your organization"** tab of the Directory modal for everyone in the org. If you marked it required, it auto-installs; otherwise users click Install to add it to their **Organization plugins** sidebar section.

## Part 2 — Tell your team to run auth setup

This is where the single-login-per-org model gets relevant. Two flows your team can use:

### Option A — Each user enters credentials individually (default)

Each user at your org:

1. Opens any Cowork chat.
2. Says "set up my credentials" or "run auth setup".
3. Claude walks them through the values: HostName, Port, Username, Schema, Password.
4. Password goes through a temporary file (Claude asks the user to save it locally and give the path).
5. Harness writes `~/.mixshift/auth/credentials` on the user's machine.

The values your team members enter are **identical across the team** because there's only one MySQL login per MixShift customer org. You'll need to share the values with them via your normal internal channels (1Password, Slack DM, internal wiki, etc.).

### Option B — Pre-bundle the credentials and let users install in one shot (recommended for >3 users)

Better UX for teams. As the admin, you produce two files once and share them with the team:

**Step B.1 — Get your warehouse credentials (admin does this once)**

1. Open the credentials retrieval URL (default `https://www.mydashapplications.com/database-admin`; `mixshift welcome` prints the right URL for your tenant).
2. Enter the master password (also from `mixshift welcome`).
3. Copy HostName, Port, Username, Schema, Password.

**Step B.2 — Create a values file**

Save this as `mixshift-creds.yaml` (substitute your real values):

```yaml
email: REPLACE@WITHUSER  # each user replaces this with their email
mysql:
  host: db.mydashapplications.studio   # from credentials page
  port: 3306
  user: yourmixshiftuser                # from credentials page
  database: yourmixshiftschema          # from credentials page
  password: ""                           # leave empty; password comes from --password-file
```

**Step B.3 — Create a password file**

Save the MySQL password to a separate file `mixshift-password.txt`. Just the password, nothing else, no quotes, no trailing newline.

**Step B.4 — Share both files with your team**

Use whatever your team uses for shared secrets — 1Password vault, Vanta, Doppler, encrypted Slack post, etc. Treat the password file like any other production credential.

**Step B.5 — Each team member runs (one command, from a terminal)**

```bash
mixshift auth setup \
  --from-file ~/Downloads/mixshift-creds.yaml \
  --password-file ~/Downloads/mixshift-password.txt \
  --request-whitelist
```

Each user replaces `email:` in their copy of the YAML with their actual email (so MixShift ops knows who's asking for IP whitelist if that's needed).

Or, in chat: "run auth setup using the files at `<paths>`" — Claude will invoke the harness with the right flags.

After auth setup, each user has their own `~/.mixshift/auth/credentials` on their machine. The plugin is fully usable.

---

## Verify the rollout

Once you've published in Part 1 and at least one teammate has run auth setup in Part 2:

1. Ask the teammate to say "welcome" in Cowork chat — should show the "already set up" view.
2. Ask them to say "what brands do I have access to" — should return your full brand list (because legacy single-login = full org visibility).
3. Ask them to say "explore my data" or "show me a sample of campaignmetric for seller X" — should return rows.

If the welcome shows the first-time view instead of the already-set-up view, the credentials file wasn't written — investigate the auth setup step on that user's machine.

---

## Updates

Plugin updates are published from your org's plugin admin page (the same place you published in Part 1). Cowork will prompt users to update, or auto-update if you marked the plugin as required + auto-update.

When MixShift ships a new plugin version (e.g. 0.3.1 → 0.4.0), point your org's plugin entry at the same GitHub source — Cowork pulls the latest tag/release. Auth credentials carry over; no re-auth needed unless the harness version explicitly bumps the credentials schema (rare).

---

## Troubleshooting

**You don't have the "Add plugin" option in Organization settings.**
You may not be an org owner. Cowork plugin admin requires owner permissions, not just admin. Ask whoever set up your Cowork organization.

**Plugin shows up but users can't install it.**
Confirm the repo is public (it must be for the GitHub source type). Check the published entry's status in the admin panel — Cowork should show whether the marketplace was successfully pulled.

**Plugin installs but `mixshift welcome` returns "command not found".**
Cowork didn't PATH-register the plugin's `bin/` directory for that user's seat. File a Cowork support ticket — this is the documented behavior. Workaround: invoke the harness via the absolute path: `node $CLAUDE_PLUGIN_ROOT/harness/dist/cli.js welcome`.

**One user's auth setup fails with "IP not whitelisted".**
That user's public IP isn't on the warehouse allowlist yet. The harness emits a telemetry event with the email + IP that MixShift ops sees in real time; an operator grants access (usually hours). Each user goes through this separately the first time they auth — IP whitelists are per-IP, not per-MixShift-org.

**My team is asking why they each have to enter the same credentials.**
Today, that's MixShift legacy's single-login-per-org reality. Option B above (the `--from-file` bundle approach) makes this a one-command operation per user. MixShift 2.0 will move to per-user logins with role-based data scoping.

---

## A note on telemetry

During the beta, the plugin sends anonymized usage events to MixShift so we can iterate. Each user sees a one-time notice on first run of `mixshift welcome`; full disclosure + opt-out in [Privacy & telemetry](../privacy.md). If your org has data-residency or compliance requirements that prevent telemetry submission, run `mixshift telemetry opt-out` on each user's machine after they install — or bake `MIXSHIFT_TELEMETRY=0` into your org's shell profile.

## What's next

- [Auth setup deep dive](../auth-setup.md) — full reference for the credentials flow including the `--from-file` + `--password-file` mechanism
- [Privacy & telemetry](../privacy.md) — what's collected during beta, how to opt out
- [FAQ](../faq.md) — common questions, including multi-user / team scenarios
- [Cowork personal install](./cowork-personal.md) — what your team would do if you weren't using the org marketplace
