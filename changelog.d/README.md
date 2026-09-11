# `changelog.d/` — one file per change, collected at the release cut

**Do not edit `CHANGELOG.md` in a feature PR.** Add a file here instead.

## Why

Every PR in a release used to edit the same `## X.Y.Z` section of `CHANGELOG.md`,
so every merge conflicted every other open PR in the cut. It is quadratic: four
PRs in one cut produced six pairwise conflicts (measured, 2026-09-10), six PRs
would produce fifteen. Two PRs now never touch the same file.

## How

Add one file per user-visible change:

```
changelog.d/<category>-<slug>.md
```

`<category>` is exactly one of **`added`**, **`changed`**, **`fixed`** — it
decides which subsection the bullet lands in. `<slug>` is anything short and
descriptive; it only has to be unique, so the PR number or branch name is fine.

The file contains the bullet itself, in the voice the changelog already uses
(bold lead sentence naming the user-visible change, then what it means for
them — never the mechanism):

```markdown
- **A report waiting in Amazon's queue is no longer checked flat out.** Some
  report types can sit in Amazon's queue for hours. The plugin used to re-check
  at the same rate for as long as you were willing to wait, which does not make
  it arrive sooner.
```

One change per file. A PR that ships two unrelated user-visible things adds two
files.

## At the release cut

`npm run changelog:collect -- --version X.Y.Z` (from
`plugins/mixshift-ai/harness/`) folds every fragment into `CHANGELOG.md` under
that version heading, in `Added` → `Changed` → `Fixed` order, and deletes the
fragments. The release-sweep skill runs this; you should not need to by hand.

## What CI checks

`npm run check-changelog-fragments` fails if a fragment's name does not carry a
valid category, or if a fragment is empty. It does **not** require a fragment
per PR: a docs-only or internal change legitimately ships none.

This README is not a fragment and is ignored by both the collector and the gate.
