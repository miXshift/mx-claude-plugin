---
name: release-docs
description: >
  Maintainer release tool. Audit and update the customer-facing docs so they match
  the shipped reality, and draft the CHANGELOG entry. Use this before cutting a
  release, after adding/removing/renaming a skill, after a capability change (new
  Amazon surface, a new write path, an availability change), or whenever someone
  says the README / FAQ / install docs look stale. This is a repo maintainer skill,
  not a customer plugin skill.
---

# release-docs — keep the customer-facing docs current

The plugin's docs drift behind the code every release (the 0.5.39 README still said
"20 skills" and claimed the plugin "never pushes to Amazon's APIs" after Amazon Ads
writes had shipped). `npm run check-docs` catches the mechanical drift; this skill
does the prose-level pass a script cannot, and drafts the changelog.

## When to run

- Before cutting any release (it is a line item in `CONTRIBUTING.md` → Releasing).
- After a skill is added, removed, or renamed.
- After a capability change: a new Amazon surface, a new write path, an availability
  change (a skill moving from staged to generally available).
- Any time the README / FAQ / install docs are reported stale.

## What "current" means

The customer-facing surface is: `README.md`, the public `CHANGELOG.md` (rendered
verbatim to users by `mixshift whatsnew` and the public `/releases` page),
`docs/faq.md`, `docs/privacy.md`,
`docs/auth-setup.md`, `docs/install/*.md`, `UPSTREAM.md`, and the `description`
fields in `plugins/mixshift-ai/.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json` (those two show in the Cowork directory). Ground
truth is the shipped code: `plugins/mixshift-ai/skills/<id>/` (the roster + each
`skill.manifest.yaml`) and the harness command surface in
`plugins/mixshift-ai/harness/src/commands/`.

## Steps

1. **Run the deterministic gate first.** From `plugins/mixshift-ai/harness/`:
   `npm run check-docs`. It checks the README skill count, that every skill dir is
   mentioned in the README, and that `plugin.json` and `marketplace.json` versions
   agree. Fix anything it reports before continuing. (It does not read prose; the
   rest of this skill does.)

2. **Reconcile the skill roster.** Diff `ls plugins/mixshift-ai/skills/` against the
   README "Available skills" tables. Every skill belongs in one of the two tiers:
   *available right after sign-in* (needs only `mixshift auth login`) vs *requires a
   brand-context build*. Decide a new skill's tier from its `skill.manifest.yaml`
   (`required_context_fields` empty → tier 1) and place it. Remove rows for deleted
   skills.

3. **Audit capability accuracy.** Read the README "What the plugin can do" + Security
   sections, the FAQ "Data + analytical scope" answers, and the two `description`
   fields. Confirm they still match the harness command groups (`auth`, `data`,
   `amazon`, `ads`, `brand`, ...) and especially the Amazon Ads write contract
   (dry-run by default, explicit confirm, `--commit`). Correct anything that
   over- or under-claims. Keep customer-facing copy free of em dashes.

4. **Draft the CHANGELOG entry — two tiers (the public file is a customer surface).**
   `git log <last-tag>..HEAD --oneline` (last tag: `git describe --tags --abbrev=0`),
   then split the work into two destinations:
   - **Public `CHANGELOG.md`** (repo root) — customer-safe ONLY. Group into
     Added / Changed / Fixed / Removed, in the plain-language, customer-readable
     voice of the existing entries (describe behavior, not commit subjects), under a
     new `## X.Y.Z` heading at the top. This file is **rendered verbatim to users**
     by `mixshift whatsnew` and the public `/releases` page, so treat every line as
     public marketing copy. **Do NOT add an `### Internal` section here.**
   - **Internal `internal/CHANGELOG-internal.md`** (gitignored, main checkout) — the
     engineering detail that is NOT for customers: CI / test-infra, internal
     mechanics, refactors, anything naming internal-only tooling, unreleased roadmap,
     or competitive posture. Same `## X.Y.Z` heading; this never ships or renders.
   Apply the **public-safe screen** to every public line before it lands: no
   customer/brand names, no internal-only tooling names, no unreleased roadmap, no
   competitive positioning, no internal mechanics a competitor would value (describe
   the user-visible benefit, not the algorithm). When in doubt, it goes in the
   internal tier. Rationale: release notes are competitor-visible (a competitor can
   install the plugin and run `whatsnew`), so the public tier is protected
   **editorially**, not by the delivery channel.

5. **Flag terminology drift, do not churn it.** If "cold start" vs "brand context"
   wording is mid-transition, list the inconsistent spots but coordinate the actual
   reframe with whoever owns the brand-context work rather than rewriting unilaterally.
   Never rename a skill as part of a docs pass (a rename touches the manifest, the
   slash command, CI, and needs its own CHANGELOG entry).

6. **Re-run `npm run check-docs`** and hand back a short summary of what changed for
   human review. Do not bump versions, tag, or push from this skill unless explicitly
   asked — that is the release commit's job (see `CONTRIBUTING.md`).

## Guardrails

- Edit docs only. No skill renames, no version bumps, no Amazon catalog/query-ID
  changes (the `CS-*` and named-pack IDs are append-only).
- Customer-facing copy (README, docs/, UI strings, the two descriptions): no em dashes.
- The README "ships **N** skills" line is load-bearing for `check-docs`; keep that
  exact phrasing when you update the count.
- **Two-tier changelog (Step 4):** the public `CHANGELOG.md` is customer-facing copy
  (rendered by `mixshift whatsnew` + the public `/releases` page) — keep it
  public-safe, with no `### Internal` section. Engineering / internal detail goes in
  the gitignored `internal/CHANGELOG-internal.md`. The `/releases` page is de-indexed
  (noindex + out of the sitemap) and also strips any `### Internal` at render as a
  backstop, but the public file itself is the thing to keep clean.
