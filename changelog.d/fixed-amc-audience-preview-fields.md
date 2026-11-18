- **An AMC audience preview no longer shows settings that would be ignored.**
  Creating or fixing an AMC audience now refuses any setting that kind of
  audience does not take, in the preview too, and lists the settings it does
  take. Before, a lookalike setting added to a rule-based audience appeared in
  the preview as if it counted, and confirming would have built a plain
  rule-based audience. Fixing a failed audience in place now sends the whole
  audience back, as Amazon requires, instead of only the changed settings.
