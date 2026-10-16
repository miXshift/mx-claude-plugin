- **A query that names a column the table does not have now stops before it is
  sent, and comes back with the table's real columns and the closest match.**
  Until now the warehouse answered with a bare "Unknown column" and the next
  attempt was another guess; this was the most common query failure across
  every current version. The check runs offline against the table list the
  plugin ships, only on plain single-table SELECTs it can read with certainty,
  and never rewrites your SQL: it names the column it could not find, and the
  agent re-runs with a real one and tells you which column it used instead.
  Queries with joins, subqueries or tables the catalog does not list are sent
  unchanged; when one of those fails on a column name, the error now also
  carries the real columns for the table it could identify.
