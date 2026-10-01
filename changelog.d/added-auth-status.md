- **New `mixshift auth status` shows whether you are signed in.** It reports who
  you are signed in as, which tenant login, whether it is a person or a service
  credential, and when the access token expires, as text or `--json`. It only
  reads what is saved on your computer: it never signs you in, prompts, contacts
  the sign-in service or refreshes your session. When you are signed out it tells
  you how to sign in from a chat.
