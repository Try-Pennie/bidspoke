-- A page's join refused for a missing partition is a live miss (#2288, part of
-- #2114).
--
-- A partners page whose join Realtime refuses with MissingPartition can hear
-- nothing until the day's realtime.messages partition exists. It now reports
-- the first such refusal of each outage through POST /api/partners/live-miss,
-- with cause missing_partition and nothing observed, so the miss data #2220
-- sets its threshold from holds it beside delivery and direct_sql.
--
-- Expand only (docs/adr/0007): the cause CHECK gains one value in a single
-- ALTER, so no moment accepts a value outside the list. Every stored row is
-- delivery or direct_sql, which the new list keeps; no row changes.

ALTER TABLE public.partner_page_live_misses
  DROP CONSTRAINT IF EXISTS partner_page_live_misses_cause_check,
  ADD CONSTRAINT partner_page_live_misses_cause_check CHECK (cause IN ('delivery', 'direct_sql', 'missing_partition'));

COMMENT ON TABLE public.partner_page_live_misses IS
  'A partners page that found, by its versions probe, a save it was never told about (#2135), or whose join was refused because the day''s partition did not exist yet (#2288). cause direct_sql when the change had no actor (a hand run SQL write, which the database sender does tell, so still a miss), missing_partition for the refused join (nothing observed), delivery otherwise. Written by POST /api/partners/live-miss; read to set the miss threshold.';
