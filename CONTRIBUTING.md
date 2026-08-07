# Contributing

Thanks for the interest in contributing. This repository is the productized public release of MixShift's internal PPC agent skills, and contributions are welcome subject to the items below.

## Scope of contributions

We welcome:
- Bug fixes in skill prompts, SQL queries, harness scripts, or documentation
- Improvements to skill prose for clarity, format consistency, or error handling
- New schemas, gotchas, or reference patterns that help skills run reliably
- Localization / accessibility improvements to renderer output
- Documentation improvements throughout `docs/`

We do not accept (without prior discussion):
- New skills (the canonical skill set is curated by MixShift)
- Forks of existing skills (do this in your own user-scoped namespace)
- Changes to the patent-relevant MixShift bridge methodology references
- License changes

If you have an idea that doesn't fit the "welcome" list, open an issue first to discuss before sending a PR.

## Contributor License Agreement (CLA)

Because the underlying domain has patent surface (App. No. 19/070,768), contributors must agree to a CLA that assigns copyright in their contribution to MixShift, with a license back for their own use. This is a one-time step.

When you open your first PR, a bot (or a maintainer) will provide the CLA. We will not merge contributions until the CLA is signed.

The CLA is structured so that:
- You retain authorship credit
- You can use your own contribution freely
- MixShift retains the right to relicense, enforce, or extend protection on the contribution as part of the broader product

If the CLA is a blocker for you, please reach out before investing time in a PR.

## Development setup

(To be filled in as the productization work lands. For now, the plugin is in pre-beta and not yet ready for outside development. Watch the repo for updates.)

## Releasing

The plugin's release mechanics have known friction with Cowork's plugin update path (see [`docs/install/cowork-personal.md` troubleshooting](docs/install/cowork-personal.md#troubleshooting) for user-facing workarounds). To keep release state internally consistent, every version bump must update three places together. If any drift, the install lands wrong in a different way (see "Drift consequences" below).

**Quick checklist:**

- [ ] **Docs & changelog current** (run the `release-docs` skill): `npm run check-docs` passes; `CHANGELOG.md` has the new version's entry; the `<!-- unreleased -->` marker under the version heading is stripped (the release workflow's `check-changelog-marker` enforces this — a stale marker renders verbatim in `whatsnew`, the `/releases` page, and the Discord announce); if the skill roster or capability surface changed this release, the README skills table + count and the `plugin.json` / `marketplace.json` descriptions are updated too.
- [ ] `npm run check-named-pack` passes against the public deployed-pack manifest (every named id resolves against the DEPLOYED auth-service pack — deploy pack entries first, or users hit `unknown_query`). `MIXSHIFT_SKIP_PACK_CHECK=1` bypasses this for local/offline use ONLY — never set it as a repository or organization Actions variable, since a skipped gate still renders as a green check.
- [ ] `plugins/mixshift-ai/.claude-plugin/plugin.json` version bumped
- [ ] `.claude-plugin/marketplace.json` version bumped (same value)
- [ ] `harness/dist/cli.js` + `harness/dist/build-meta.json` rebuilt and committed
- [ ] Release commit titled `release: X.Y.Z <summary>`
- [ ] Annotated tag `mixshift-ai--vX.Y.Z`
- [ ] Branch + tag pushed to origin together
- [ ] **Release zips attached to the GitHub Release** — the `mixshift-ai--vX.Y.Z` tag push triggers `.github/workflows/release.yml`, which re-runs the gates, runs `npm run package-zip`, and attaches both zips (`mixshift-ai-plugin-X.Y.Z.zip` + `mixshift-ai-marketplace-X.Y.Z.zip`) to the release. **Verify explicitly** — do not assume the tag push worked: `gh release view mixshift-ai--vX.Y.Z --json assets` must show BOTH zips. The final publish step can fail on a transient GitHub API error even when every gate is green (happened on 0.8.3: gates passed, publish returned an HTML error page, and no Release existed until someone noticed). Recovery: `gh run rerun <run-id> --failed`.
- [ ] **Fast-forward the `stable` beta channel** — beta users install pinned to `.git#stable`. Stable is kept on main's line (as of 2026-07-24; it was previously a divergent `--no-ff` merge), so this is a real fast-forward, no merge commit: `git push origin <release-commit>:stable`. Confirm: `gh api repos/miXshift/mx-claude-plugin/branches/stable --jq .commit.sha` equals the release commit. Never delete or prune `stable` (breaks the `.git#stable` install pin).
- [ ] **Announce the release to the releases Discord** — `node plugins/mixshift-ai/harness/scripts/announce-release.mjs --version X.Y.Z` (one `release.published` per version bump; reads that version's `CHANGELOG.md` entry). Announcements must stay in sync with releases, so reconcile first: compare `SELECT payload->>'version' FROM events WHERE event_name='release.published'` (Supabase `izurufltfnwxsljvtksy`) against the `CHANGELOG.md` `## X.Y.Z` headings, and catch up any gap with one announcement per missing version. Announcements started at 0.6.3; do not retro-announce earlier versions.
- [ ] Post-release Cowork desktop sanity check

### Pre-flight build

From `plugins/mixshift-ai/harness/`:

```bash
npm run typecheck
npm run test
npm run validate-manifests
npm run check-skills
npm run check-docs          # README skills table + count, plugin/marketplace version sync
npm run check-no-internal-exposure  # no maintainer skills tracked under .claude/ (also gated per-push in CI)
npm run check-changelog-marker      # run AFTER stripping the version's unreleased marker (release CI also enforces)
npm run check-named-pack   # checks the public deployed-pack manifest; no customer session required
npm run build
```

The build rewrites `harness/dist/cli.js` and `harness/dist/build-meta.json`. Commit those alongside the version bumps below.

### Files in the release commit

1. **`plugins/mixshift-ai/.claude-plugin/plugin.json`**: bump `version`.
2. **`.claude-plugin/marketplace.json`**: bump `plugins[0].version` to match.
3. **`plugins/mixshift-ai/harness/dist/cli.js`** + **`harness/dist/build-meta.json`**: the rebuilt bundle, so shipped code matches the new manifest.

Subject convention: `release: X.Y.Z <one-line summary>` (matches existing log).

### Drift consequences

- Only `plugin.json` bumped: runtime reports the new version, but Cowork's Directory listing shows the old number.
- Only `marketplace.json` bumped: Directory listing shows the new number, but the runtime still identifies as old, and the install record pins the old commit.
- Only `dist/cli.js` bumped: manifests claim the old version while users run the new code.

### Tag and push

```bash
git tag -a mixshift-ai--vX.Y.Z -m "X.Y.Z <summary>"
git push origin main mixshift-ai--vX.Y.Z
```

Branch and tag go to origin together. Pushing the branch alone leaves the marketplace able to list the new version but unable to anchor it.

### Release zips (org distribution)

Pushing the `mixshift-ai--vX.Y.Z` tag triggers `.github/workflows/release.yml`. It re-runs the deterministic gates, verifies the tag version matches `plugin.json`, runs `npm run package-zip`, and attaches both artifacts to the tag's GitHub Release:

- `mixshift-ai-plugin-X.Y.Z.zip` — single-plugin layout (contents at the zip root).
- `mixshift-ai-marketplace-X.Y.Z.zip` — marketplace layout (`.claude-plugin/marketplace.json` + `plugins/mixshift-ai/`).

These are what the [org admin-console install](docs/install/org-admin-console.md) consumes (release-zip upload, or a private mirror of `stable`). The zips read `dist/cli.js` from the committed git blob, so the `harness/dist/` rebuild must already be committed on the tagged commit (it is, per the release-commit files above). To build them locally for inspection: `npm run package-zip` from `plugins/mixshift-ai/harness/` writes to `dist-zip/` at the repo root (gitignored). After the tag push, confirm the workflow is green and both zips are on the release (`gh release view mixshift-ai--vX.Y.Z --json assets`); if the publish step failed transiently, `gh run rerun <run-id> --failed`.

**claude.ai payload constraints (server-side validator, learned 2026-07-16 the hard way):** hosted payloads (org-console zips AND marketplace URL syncs) may NOT contain a top-level `bin/` directory — the validator rejects the whole payload, and the rule is enforced ahead of Anthropic's own docs (the plugins reference still documents `bin/` as supported for CLI installs). PATH registration ships as the SessionStart hook (`hooks/session-start.mjs`) instead; `npm run package-zip` fails the build if `bin/` reappears in the payload set or if `hooks/hooks.json` is missing/malformed. Other known validator rules: directory depth ≤ 10, plugin description ≤ 500 chars, no XML-ish tags in metadata.

### Post-release sanity check

In Cowork desktop: fully quit + reopen, then Customize → Directory → check for updates. The new version should appear; install should pull a working bundle. If you hit "This plugin doesn't have any skills or agents," the version label sticks at the previous number, or the install seems to roll back across sessions, see [the install troubleshooting](docs/install/cowork-personal.md#troubleshooting) for known Cowork-side workarounds.

## Reporting issues

Please use GitHub Issues for:
- Bug reports (include skill ID, plugin version, brand context shape, observed vs. expected output)
- Documentation gaps
- Feature requests (low priority — we have a defined roadmap, but ideas are welcome)

For security-sensitive issues, do not open a public issue. Email security@mixshift.ai (or your account team if you are a MixShift customer).

## Style

- Match the existing prose voice in `SKILL.md` files. It is deliberately direct, low-hedge, no em dashes.
- SQL files declare their purpose, parameters, and consumers in a header comment.
- Manifests are valid against the schema in `shared/skill-manifest.schema.yaml` — bad manifests will not load.
- No emojis in skill output. The skill format conventions are part of the product.

## Secrets / committed credentials

This repo is **public**. Anything you commit is forever visible in git history regardless of later deletes. Before pushing, scan locally:

```bash
# Install gitleaks once: https://github.com/gitleaks/gitleaks#installing
# Then in the repo root:
gitleaks detect --no-banner --redact --source .
```

The repo's `.gitleaks.toml` config defines what counts as a leaked secret and what's allowlisted (the customer-facing master password is intentional, for example). The CI workflow at `.github/workflows/gitleaks.yml` re-runs the same check on every push + PR — a finding fails the build.

Things that **never** belong in commits:

- Discord webhook URLs (any kind — they grant write access to channels)
- MySQL passwords, OAuth client secrets, AWS / GCP / Azure keys, GitHub PATs
- Supabase `service_role` keys (the `anon` key is fine — designed for client embedding)
- Customer email addresses or other PII

If you accidentally commit a secret: do **not** just `git revert` (history retains it). Rotate the secret immediately at its source (Discord settings, DB password reset, etc.). MixShift maintains the incident-response playbook internally (it is not part of this repo); the policy itself is enforced by the gitleaks config above.
