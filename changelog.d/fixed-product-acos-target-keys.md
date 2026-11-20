- **Per-ASIN ACoS targets in Brand Context are read more carefully.** An ASIN
  key that is not 10 letters and digits (for example `B0EXAMPLE1:UK`) is now
  listed as "not an ASIN" with the entries that could not be read, instead of
  being kept as a target that never matches a product. A target written with a
  percent sign is read as written, so `"0.5%"` is 0.5%, not 50% (a bare `0.25`
  is still read as 25%). An empty product target map is treated as no map.
