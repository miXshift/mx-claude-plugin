# Install in Cowork — Organization install

**Who this is for:** You're a Cowork organization owner / admin who wants to deploy `mixshift-ai` to everyone in your Cowork org at once. Common case: your MixShift account covers a team of AMs and ops people, and you want all of them to have the plugin available without each one going through a personal install.

**If you just want it on your own seat,** use [Cowork — Personal install](./cowork-personal.md) instead.

---

## The two-part install

This path has two distinct steps that happen at different times:

| Step | Who does it | When | What it accomplishes |
|---|---|---|---|
| **Part 1: Publish the plugin** | Org admin (you) | Once | Plugin code becomes available to every seat in your Cowork org |
| **Part 2: Sign-in** | Every user, individually | After Part 1, before first use | Each user signs in with their MixShift account; tokens write to `~/.mixshift/auth/credentials` |

Part 1 is org-wide. Part 2 is per-user. Both are required.

A note on data access: today, MixShift's legacy system uses **a single MySQL backing login per customer organization** — no row-level permissions, no per-user data scoping. That means every user at your MixShift org sees the same merchants once they sign in. Per-user roles + scoped data access are coming in MixShift 2.0. The per-user sign-in step (Part 2) is just because Cowork doesn't share filesystem state across users, AND because each person signs in with their own MixShift account for attribution purposes (the auth service maps their `person_label` to your tenant's data access).

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

## Part 2 — Each team member signs in

Sign-in is per-user but trivial. Each person at your org:

1. Opens any Cowork chat.
2. Says "welcome" or "sign in to mixshift".
3. Claude asks for their work email (used to attribute their session — same email they use to log into MixShift is fine).
4. Claude opens a browser tab at the MixShift sign-in page.
5. They sign in with their MixShift account — same email + password they use for MixShift.
6. They return to chat, say "done", and Claude confirms.

That's it. The plugin stores a short-lived token at `~/.mixshift/auth/credentials` on each person's machine. No shared credentials to distribute, no password files, no IP whitelist coordination.

**Compared to the legacy path:** the old `mixshift auth setup` flow required the admin to fetch shared MySQL credentials from MixShift's portal, distribute them via a secrets manager, coordinate per-user IP whitelists, and have each user run a `--from-file` + `--password-file` command. That flow has been retired; token-based sign-in removed that overhead entirely.

---

## Verify the rollout

Once you've published in Part 1 and at least one teammate has signed in in Part 2:

1. Ask the teammate to say "welcome" in Cowork chat — should show the "already set up" view.
2. Ask them to say "what brands do I have access to" — should return your full brand list (because the legacy single-login backing model = full org visibility once authenticated).
3. Ask them to say "explore my data" or "show me a sample of campaignmetric for seller X" — should return rows.

If the welcome shows the first-time view instead of the already-set-up view, the sign-in didn't complete — have them re-run "sign in to mixshift".

---

## Updates

Plugin updates are published from your org's plugin admin page (the same place you published in Part 1). Cowork will prompt users to update, or auto-update if you marked the plugin as required + auto-update.

When MixShift ships a new plugin version, point your org's plugin entry at the same GitHub source — Cowork pulls the latest tag/release. Tokens carry over across plugin updates; no re-auth needed unless the harness version explicitly bumps the credentials schema (rare).

---

## Troubleshooting

**You don't have the "Add plugin" option in Organization settings.**
You may not be an org owner. Cowork plugin admin requires owner permissions, not just admin. Ask whoever set up your Cowork organization.

**Plugin shows up but users can't install it.**
Confirm the repo is public (it must be for the GitHub source type). Check the published entry's status in the admin panel — Cowork should show whether the marketplace was successfully pulled.

**Plugin installs but `mixshift welcome` returns "command not found".**
This is expected on Cowork: Cowork does not run plugin session hooks, so the `mixshift` shorthand is never on PATH there. It is not an error and needs no support ticket. The skills handle it automatically by locating the plugin's install directory and running `node "<plugin root>/harness/dist/cli.js" welcome` — ask Claude to continue. Scheduled tasks are the one case that needs care: their stored prompts must resolve the CLI path at runtime (see the mx-auth-service-setup skill).

**A user's plugin seems stuck on an old version after an update was published.**
Two common causes:

1. The user's Cowork desktop was already running when the update was pushed. Cowork loads the plugin bundle at session start, so a running session keeps the old version. Have them fully quit + reopen Cowork (not just start a new chat).

2. Their local plugin cache at `~/.claude/plugins/cache/mixshift/mixshift-ai/` may be stale, empty, or out-of-sync with `installed_plugins.json`. Have them uninstall + reinstall from Customize → Directory to force a fresh extract. Auth credentials in `~/.mixshift/` carry over.

If the symptom is specifically "This plugin doesn't have any skills or agents" in the Customize panel, see the [personal install troubleshooting](./cowork-personal.md#troubleshooting) for the same fix.

**One user's sign-in browser tab won't open / sign-in stalls.**
The PKCE flow tries to open the user's default browser via the OS-native handler. If that fails (rare — headless WSL, container, etc.), the harness auto-falls-back to a device-code flow and prints a URL. Claude surfaces it in chat — the user can open it on any device with a browser.

**My team is asking whether they all see the same data.**
Yes. MixShift's legacy backing model is a single MySQL login per customer org, so once authenticated every team member sees the full merchant set. Per-user roles + scoped data access are coming in MixShift 2.0. The chat-driven sign-in still has each user enter their own work email (`person_label`) so MixShift admin tooling can see WHO ran what session — that's attribution, not authorization.

**Sign-in or any command fails with "fetch failed", and your org enforces network restrictions.**
This is the single most common org-rollout blocker. Symptoms: the welcome / sign-in step returns a bare `fetch failed`, or a command errors with something like `403 from proxy after CONNECT`, or `mixshift doctor` reports the service is "NOT reachable" with an egress-proxy note.

Root cause: Cowork Team/Enterprise runs plugin Bash commands inside a sandbox whose outbound network is **deny-by-default**. The plugin talks to MixShift's service over HTTPS from that sandbox, so the service host must be on the egress allowlist. If it isn't, every network call the plugin makes is blocked at the proxy before it ever leaves the machine. (This is separate from Cowork's web-fetch / connector traffic, which uses a different, non-gated path. That is why a connector can reach the internet while the plugin cannot.)

Fix (org admin):

1. Open **Organization settings** → **Capabilities** → **Code execution**.
2. Add these domains to the network allowlist:
   - `mcp.mixshift.io` — **required.** Auth, device flow, every warehouse query, all Amazon API calls (reports, retail, AMC, DSP, and Amazon Ads reads and writes), report start/poll, and feedback. Nothing works without it.
   - `*.amazonaws.com` — **required for report pulls.** SP-API report downloads come back as presigned S3 URLs the plugin fetches directly, so S3 egress is needed for the `amazon-report` workflow. (If you don't use report pulls, sign-in and queries work without it, but add it anyway so reports don't fail later.)
   - Optional, safe to omit: `github.com` + `raw.githubusercontent.com` (plugin version check only), and your telemetry endpoint (best-effort usage events; `MIXSHIFT_TELEMETRY=0` disables it).
3. **Start a NEW conversation.** Network settings are applied at session creation, so an existing chat will not pick up the change. This trips people up constantly: the allowlist edit is correct, but the open chat is still running under the old policy. A fresh conversation is required.

To confirm the fix end-to-end, have a teammate run `mixshift doctor` in a new conversation. It detects whether an egress proxy is active, probes the service `/health` endpoint through it, and prints the exact allowlist remediation if the host is still blocked. A clean "reachable" line means sign-in will work.

---

## A note on telemetry

During the beta, the plugin sends usage events to MixShift so we can iterate. These events are attributed to each user's MixShift account and the person or service credential that ran them (not anonymous), with secret-shaped values stripped from captured command lines. Each user sees a one-time notice on first run of `mixshift welcome`; full disclosure + opt-out in [Privacy & telemetry](../privacy.md). If your org has data-residency or compliance requirements that prevent telemetry submission, run `mixshift telemetry opt-out` on each user's machine after they install, or bake `MIXSHIFT_TELEMETRY=0` into your org's shell profile.

## What's next

- [Authentication deep dive](../auth-setup.md) — full reference for token-based sign-in and service credentials
- [Privacy & telemetry](../privacy.md) — what's collected during beta, how to opt out
- [FAQ](../faq.md) — common questions, including multi-user / team scenarios
- [Cowork personal install](./cowork-personal.md) — what your team would do if you weren't using the org marketplace
