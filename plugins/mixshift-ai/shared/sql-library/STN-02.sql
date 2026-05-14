-- ID: STN-02
-- Purpose: ASIN-targeting cleanup — extract the bare ASIN from KeywordText
--          (form 'asin="XXXXXXXXXX"') into the SearchTerm column on a
--          caller-prepared scratch table when SearchTerm is blank.
-- Params: (none — operates on caller-prepared scratch table)
-- Consumers: search-term-negation (Data Preparation)
-- Tier: 1
--
-- SCHEMA NOTE: `search_term_data` is a caller-prepared scratch / temp
-- table populated upstream by STN-01 (or equivalent). It is intentionally
-- not in shared/tables.yaml. The drift checker should treat this query
-- accordingly; if it flags `search_term_data` as unknown, mark this query
-- as scratch-table operative rather than adding the table to tables.yaml.

UPDATE search_term_data
SET SearchTerm = SUBSTRING(KeywordText, LOCATE('="', KeywordText) + 2, 10)
WHERE KeywordText LIKE 'asin="%"'
  AND (SearchTerm IS NULL OR SearchTerm = '');
