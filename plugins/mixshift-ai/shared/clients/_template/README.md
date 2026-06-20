# Brand Template (`_template/`)

This directory is a **schema-conforming starter** for a brand context. It is NOT a runtime context — real per-brand contexts live at `~/.mixshift/clients/<brand-slug>/` on the user's machine.

## Purpose

1. **Validator reference.** `context.schema.yaml` validators run against this file to confirm the schema itself is self-consistent.
2. **User-facing example.** A new user can read these files to see what a populated brand context looks like before running `mx-brand-context`.
3. **Skill documentation.** `SKILL.md` files point at `shared/clients/_template/context.yaml` for structural illustration without exposing real customer data.

## Files

| File | Purpose |
|---|---|
| `context.yaml` | Schema-conforming context with all required fields and commonly-used optional fields shown. Placeholders use `<your-brand-slug>`, `<integer-seller-id>`, etc. |
| `narrative.md` | Starter narrative with the canonical H2 headings the renderer recognizes (Brand Identity / Current Quarter Context / Historical Notes / Per-skill guidance). |
| `README.md` | This file. |

## How real brand contexts get created

```
1. User onboards (MySQL creds + IP whitelist).
2. Plugin queries the warehouse `seller` table to list available brands.
3. User selects which brands to manage.
4. For each selected brand, plugin runs mx-brand-context, which:
   a. Loads this template
   b. Populates fields from warehouse data (SellerID, account_type, etc.)
   c. Walks the AM through Phase 2 questions for the rest
   d. Writes the result to ~/.mixshift/clients/<brand-slug>/
```

This template is read-only from the user's perspective. Edits to it ship as plugin updates.

## Adding a field

When the schema gains a new required or optional field:

1. Update `_schema/context.schema.yaml`
2. Update this template (`context.yaml`) to include the field with a placeholder
3. Update `mx-brand-context` to populate the new field at run time
4. Document the field in `_schema/context.schema.yaml`'s `note:` blocks
5. Bump `schema_version` if the change is breaking

The validator will fail closed on missing required fields, so step 3 is mandatory before any required field change ships.
