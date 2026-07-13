# Organization-level install (Claude admin console)

**Who this is for:** You administer a Claude Team or Enterprise organization and want to make `mixshift-ai` available to your members through the Claude admin console, rather than each person adding a GitHub marketplace themselves. This is the managed-org path for Claude Code and the Claude apps (not Cowork; for Cowork use [Cowork Organization install](./cowork-organization.md)).

The admin console offers two ways to bring in an external plugin. Pick one:

1. **Release-zip upload** (simplest). You download a release zip and upload it in the console. Best when you want an explicit, reviewed version and are comfortable re-uploading to update.
2. **Private-mirror auto-sync** (hands-off updates). You keep a private copy of our repo that syncs itself from our public `stable` branch on a schedule, and point the console at that private copy with automatic sync turned on.

Both land members at the same place: the `mixshift-ai` skills available to Claude plus the bundled `mixshift` CLI. After install, everyone still signs in individually (see [Sign-in](#sign-in-per-member) below).

---

## Why you cannot add our public repo directly

The admin console's "Sync from GitHub" only accepts a repository your organization owns and that is private or internal. Our repo (`miXshift/mx-claude-plugin`) is public and owned by MixShift, so the console will not accept its URL. That is the whole reason the two paths below exist: the release-zip path sidesteps GitHub entirely, and the private-mirror path gives the console a private repo it will accept while still tracking our public `stable` branch automatically.

---

## Option 1: Release-zip upload

Each tagged release publishes two zips on our GitHub Releases page. For the admin console, use the marketplace-layout zip:

- `mixshift-ai-marketplace-<version>.zip` (marketplace layout: `.claude-plugin/marketplace.json` at the root plus the plugin under `plugins/mixshift-ai/`). Use this one for the console.
- `mixshift-ai-plugin-<version>.zip` (single-plugin layout, contents at the zip root). This is for hosts that ingest a bare plugin folder rather than a marketplace.

Steps:

1. Open [github.com/miXshift/mx-claude-plugin/releases](https://github.com/miXshift/mx-claude-plugin/releases) and download `mixshift-ai-marketplace-<version>.zip` from the latest release.
2. In the Claude admin console, go to the plugins section and choose **Upload plugin**.
3. Upload the zip. The console reads `.claude-plugin/marketplace.json` and lists `mixshift-ai` for your organization.
4. (Optional) Mark it required so it installs for every member automatically.

The console validates every upload before accepting it: it checks folder depth, plugin description length, and that descriptions contain no XML-like tags, among other rules. Our release zips are pre-validated against these same rules by the packaging gates that build them, so a zip downloaded from our Releases page uploads cleanly.

If an upload does fail validation, the console can leave an empty marketplace entry behind (it shows as "No plugins in this source yet"). Delete that empty entry before retrying, so the retry registers cleanly.

**Updating:** re-upload. When we ship a new version, download the new `mixshift-ai-marketplace-<version>.zip` and upload it the same way; the console replaces the prior version. There is no auto-update on this path, which is exactly why some admins prefer it: nothing changes for your members until you upload.

---

## Option 2: Private-mirror auto-sync

Here you create a private repository your org owns, mirror our public `stable` branch into it on a schedule, and let the console sync from your private mirror. Once set up, your members get new `stable` builds without you touching anything.

### 1. Create the private mirror

Create an empty private repository in your GitHub organization, for example `your-org/mx-claude-plugin-mirror`.

### 2. Add the sync workflow

Commit this workflow to the mirror repo at `.github/workflows/mirror.yml`. It fetches our public `stable` branch daily and force-pushes it to the mirror's `main`, so the mirror is always a faithful copy of our stable channel:

```yaml
name: mirror-mixshift-stable
on:
  schedule:
    - cron: '17 6 * * *' # daily, ~06:17 UTC
  workflow_dispatch:       # lets you sync on demand from the Actions tab
permissions:
  contents: write          # required to push to this repo
jobs:
  mirror:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout the mirror
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Sync from MixShift public stable
        run: |
          git fetch https://github.com/miXshift/mx-claude-plugin.git stable
          git push --force origin FETCH_HEAD:refs/heads/main
```

The built-in `GITHUB_TOKEN` (with `contents: write` as declared above) is enough to push within the mirror repo, so no extra secret is needed. If your org policy blocks the default token from pushing, or you want the sync to run under a specific identity, swap the fetch/push for a fine-grained personal access token scoped to this one repo with contents read and write, and reference it as a secret in the `git push` URL.

Run the workflow once by hand from the Actions tab (**Run workflow**) so `main` is populated before the next step.

### 3. Point the console at the mirror

In the Claude admin console plugins section, choose **Sync from GitHub**, enter your private mirror (`your-org/mx-claude-plugin-mirror`), and turn on **Sync automatically**. The console will pull each time your mirror's `main` updates, so a new MixShift `stable` build flows out to your members within a day with no manual step.

**Updating:** automatic. The scheduled workflow refreshes the mirror, and the console's automatic sync picks it up. To force an immediate update, run the mirror workflow by hand, then trigger a sync in the console.

---

## Sign-in (per member)

Publishing the plugin does not sign anyone in. Each member signs in once with their own MixShift account: in any Claude chat they say "welcome" or "sign in to mixshift", enter their work email, and complete the browser sign-in. Tokens land at `~/.mixshift/auth/credentials` on their machine and carry over across plugin updates. Full reference: [Authentication deep dive](../auth-setup.md).

If your organization enforces network egress restrictions, add `mcp.mixshift.io` (and `*.amazonaws.com` for report pulls) to your code-execution allowlist, then have members start a new conversation. The same egress note in [Cowork Organization install](./cowork-organization.md#troubleshooting) applies here.

---

## What's next

- [Authentication deep dive](../auth-setup.md) - token-based sign-in and service credentials
- [Privacy & telemetry](../privacy.md) - what is collected during beta, how to opt out
- [FAQ](../faq.md) - common questions, including multi-user scenarios
- [Claude Code install](./claude-code.md) - the per-user path if a member wants to add the marketplace themselves
