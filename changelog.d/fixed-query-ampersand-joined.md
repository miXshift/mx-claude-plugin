- **Several parameters packed into one `--query` now get the corrected
  flags, not an Amazon-is-unavailable error.** Paging through FBA inventory
  with `--query "details=true&nextToken=..."` sent Amazon one parameter
  holding all the others in its value. Amazon rejected it, the plugin reported
  that as Amazon being temporarily unavailable, and the assistant retried a
  request that could never succeed. The plugin now stops before sending it and
  spells out one `--query` per parameter, the form that works. The same goes
  for `--path` on `amazon call` and `ads call` and for `--option` on
  `amazon report`. An `&` that is part of a value, such as a SKU like
  `R&D-KIT`, is still accepted.
