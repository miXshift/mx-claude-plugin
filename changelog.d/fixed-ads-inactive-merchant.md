- **MixShift no longer offers Amazon Ads merchants it cannot actually call, and stops blaming your
  authorization when one does not work.** The merchant list used to include merchants that are
  inactive in MixShift, which Amazon will not serve data for. Picking one failed with a message
  saying your Amazon authorization had been lost, so people went and re-connected accounts that
  were working fine. Listing merchants now shows the active ones by default and tells you how many
  inactive ones it left out, and calling an inactive merchant says plainly that it is inactive and
  that activating it in MixShift is the fix. A separate message now covers the case where Amazon
  itself denies a merchant to the advertising login it is connected through, which is also not
  something re-authorizing can fix.
