-- The measured identities of connections bidding never stored (#2573).
--
-- WHY. Saving a new connection verifies its login on ops BEFORE the bidding
-- Worker inserts its row, under the fresh id the row will carry. For a
-- Salesforce login that verify writes the measured identity
-- (connection_measured_identity, generation 1); no other service's verify
-- writes anything. When the insert then fails, the create route revokes the id
-- on ops, and the tombstone deletes that row. When the revoke fails too, or the
-- Worker is stopped between verify and insert and nothing is logged at all, the
-- row is left for good: nothing ever deleted it, since a tombstone needs a
-- removal and bidding never stored the connection to remove.
--
-- It is inert: every reader of measured identities either joins a copy
-- (sf_limits_targets, connection_check_targets), which a connection bidding
-- never stored never has, or asks for that one connection id (acquire_sf_lease,
-- the budget reading), which nothing will ever ask for again. So this is
-- tidying a record with no reader, made visible, not stopping harm.
--
-- WHAT. remove_unserved_measured_identities(p_served_at, p_named): called by
-- the ops tick after it saved a COMPLETE list in one save (connection-serve.ts),
-- with the list's served_at and every connection id it names. It deletes, at
-- most 1,000 at a time, each measured identity for which all three hold:
--   - it was measured more than an hour before the earlier of served_at and the
--     database's clock. A create's insert lands within seconds of its verify,
--     so a list served an hour later names every connection that was stored;
--     the hour is margin for the two clocks and a slow insert, and errs toward
--     keeping a row (L648): a row kept is harmless, a row of a stored
--     connection removed would leave its Salesforce calls refused until a
--     Reconnect;
--   - the list does not name its connection, so bidding holds no ops row for it;
--   - ops holds no copy of that connection at all, withdrawn or not, so no list
--     ever named it. A connection bidding stored once, then lost, is a removal's
--     business (record_connection_tombstone), never this function's.
-- It answers each removed row (organization, connection, generation and when
-- it was measured), so the tick logs every one by id and the create route's
-- connection_create_left_on_ops line can be matched to its removal.
--
-- Lane wide, like save_connection_copies: the list spans organizations, and
-- each answered row carries its own.
--
-- Additive only (ADR 0007): one new function, nothing else changes. Nothing
-- calls it until the ops Worker that carries the call deploys, and Deploy Ops
-- Worker refuses to deploy while this migration is unapplied. Guarded by
-- supabase-ops/supabase/tests/unserved_measured_identities.test.sql.

SET lock_timeout = '5s';

CREATE FUNCTION public.remove_unserved_measured_identities(p_served_at timestamptz, p_named uuid[])
RETURNS TABLE (organization_id uuid, connection_id uuid, generation bigint, measured_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_served_at IS NULL OR p_named IS NULL THEN
    RAISE EXCEPTION 'remove_unserved_measured_identities: served_at and the named connections are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF array_position(p_named, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'remove_unserved_measured_identities: the named connections list holds a null' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(p_named) > 1000 THEN
    RAISE EXCEPTION 'remove_unserved_measured_identities: at most 1000 named connections, as one save carries, not %', cardinality(p_named)
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH gone AS (
    SELECT m.connection_id, m.generation
    FROM public.connection_measured_identity m
    WHERE m.measured_at < least(p_served_at, now()) - interval '1 hour'
      AND m.connection_id <> ALL (p_named)
      AND NOT EXISTS (SELECT 1 FROM public.connection_copies c WHERE c.connection_id = m.connection_id)
    ORDER BY m.connection_id, m.generation
    LIMIT 1000
    FOR UPDATE
  )
  DELETE FROM public.connection_measured_identity m
  USING gone
  WHERE m.connection_id = gone.connection_id AND m.generation = gone.generation
  RETURNING m.organization_id, m.connection_id, m.generation, m.measured_at;
END
$fn$;

REVOKE ALL ON FUNCTION public.remove_unserved_measured_identities(timestamptz, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_unserved_measured_identities(timestamptz, uuid[]) TO service_role;

RESET lock_timeout;
