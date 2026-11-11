- **The DSP readiness check now catches another order's responsive ad on a line
  item.** The creative chooser in the DSP console lists every order's
  automatically created responsive ad, so it is easy to attach the wrong one when
  you build orders first and creatives later. Each line item is now checked
  against the responsive ad recorded for its own order: a responsive ad MixShift
  builds is recorded for the order you name, and one built in the console is
  recorded once you confirm which order it belongs to (`mixshift dsp creative-map
  confirm`). A creative recorded for another order fails the check with the
  order, line item and creative ids and how to fix it in the console; one nobody
  recorded is shown for you to confirm, never guessed from its name or products.
  The check only reads; it never removes or swaps a creative.
