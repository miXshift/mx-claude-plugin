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
