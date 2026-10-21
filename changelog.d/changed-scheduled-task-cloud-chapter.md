- **Scheduled tasks now cover cloud routines.** The scheduled-task skill used to
  say that cloud sessions were not supported. A routine that fires in a Claude
  Code cloud session works: the sign-in lives in environment variables, the
  plugin is installed fresh on each run, and a read-only credential is the
  default for digests. The skill now walks through that setup instead of
  sending you elsewhere.
