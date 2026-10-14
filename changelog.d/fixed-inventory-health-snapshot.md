- **The inventory planning table is no longer described as a history.**
  `mws_inventory_health` holds today's planning snapshot for each account's main
  marketplace, and each daily load replaces the last one. The table guide used to call
  it a time series, which led to trend questions it cannot answer. It now says so, names
  `mws_inventory_history` for trends, and shows how to pull the planning report on demand
  for any other marketplace (DE covers a pan-EU pool).
