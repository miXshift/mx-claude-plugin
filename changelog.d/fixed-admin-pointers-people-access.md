- **Credential messages now send you to the page you can use.** When a service
  credential is rejected, when `mixshift task` finds a stale credential, or when a
  setup code fails, the message now points to People & access
  (https://build.mixshift.ai/people) first, and to mcp.mixshift.io/admin only for
  organizations that still sign in with one shared team login. People who sign in
  with Google or Microsoft cannot reach `/admin`, so the old pointer left them
  with nowhere to go. The sign-in, scheduled task and FBA inbound skills now say the
  same, and the inbound skill adds that only an owner or admin can grant
  shipment write access. Report Max now says a run
  counts as usage and is not a charge per run, the same as the forecast skill.
