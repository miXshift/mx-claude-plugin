- **The service sign-in variables have clearer names.** `mixshift auth
  service-setup` now reads the secret from `MIXSHIFT_SERVICE_CLIENT_SECRET` and
  the client id from `MIXSHIFT_SERVICE_CLIENT_ID`, so it is no longer mistaken
  for an Amazon app secret and a scheduled prompt no longer needs to pass
  `--client-id`. The older `MIXSHIFT_CLIENT_SECRET` keeps working.
