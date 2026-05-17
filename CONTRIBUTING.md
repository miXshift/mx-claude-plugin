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
- Forks of existing skills (do this in your own user-scoped namespace — see `BRAND-MANAGEMENT.md`)
- Changes to the patent-relevant HCAM bridge methodology references
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

If you accidentally commit a secret: do **not** just `git revert` (history retains it). Rotate the secret immediately at its source (Discord settings, DB password reset, etc.). See `internal/SECRETS.md` for the incident-response playbook (gitignored — for MixShift internal use; the policy itself is enforced by the gitleaks config above).
