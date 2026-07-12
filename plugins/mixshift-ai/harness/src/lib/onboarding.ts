/**
 * Canonical new-user onboarding links + copy.
 *
 * The plugin does not do native MixShift registration: a brand-new user
 * (no MixShift login yet) is handed off to the web platform to create an
 * account, connect Amazon accounts, and activate ads + retail data, then
 * comes back here to sign in. Every surface that renders that handoff
 * (welcome, guide, doctor, empty-brand states) pulls from this module so
 * the copy and the timing expectation cannot drift between commands.
 */

export const REGISTRATION_URL =
  'https://www.mydashapplications.com/auth/registration';

export const GETTING_STARTED_URL =
  'https://know.mixshift.io/en/articles/9584082-getting-started-with-mixshift';

export const DATA_TIMING_URL =
  'https://know.mixshift.io/en/articles/9584153-how-long-will-it-take-for-my-data-to-populate-in-mixshift';

/**
 * Markdown variant for chat-format surfaces (welcome --format chat,
 * guide --format chat).
 */
export const NO_ACCOUNT_CHAT =
  '**No MixShift account yet?** Create one at ' +
  REGISTRATION_URL +
  ', then connect your Amazon accounts and activate ads + retail data ' +
  '(walkthrough: ' +
  GETTING_STARTED_URL +
  '). Most accounts are fully populated within 24-48 hours of activation; ' +
  'large catalogs can take longer (' +
  DATA_TIMING_URL +
  '). MixShift emails you when your data is ready; come back and sign in then.';

/** Plain-text variant for terminal surfaces. */
export const NO_ACCOUNT_TERMINAL =
  'No MixShift account yet? Create one first, then connect your Amazon\n' +
  'accounts and activate ads + retail data:\n' +
  '  ' +
  REGISTRATION_URL +
  '\n' +
  'Walkthrough:\n' +
  '  ' +
  GETTING_STARTED_URL +
  '\n' +
  'Most accounts are fully populated within 24-48 hours of activation\n' +
  '(large catalogs can take longer). MixShift emails you when your data\n' +
  'is ready; come back and sign in then.\n';

/**
 * Timing expectation appended to the "no brands yet" activation handoffs,
 * so a freshly activated user is not surprised by an empty warehouse.
 * Markdown variant.
 */
export const DATA_TIMING_CHAT =
  'After activation, most accounts are fully populated within 24-48 hours; ' +
  'large catalogs can take longer (' +
  DATA_TIMING_URL +
  '). MixShift emails you when your data is ready to work with.';

/** Plain-text variant of the timing expectation. */
export const DATA_TIMING_TERMINAL =
  'After activation, most accounts are fully populated within 24-48 hours\n' +
  '(large catalogs can take longer). MixShift emails you when your data\n' +
  'is ready. Details:\n' +
  '  ' +
  DATA_TIMING_URL +
  '\n';
