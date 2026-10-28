-- Drop the four argument Slack alert settings save (#2896). CONTRACT step
-- after the expand of 20261027230000 (#2870, PR #2899).
--
-- 20261027230000 added save_slack_alert_settings(uuid, uuid, jsonb, uuid, text),
-- which also names the changer in updated_by_email, and kept the four argument
-- form for the Worker deployed before it. The Worker calling the five argument
-- form is live, so nothing calls the four argument form any more: PostgREST
-- picks a function by the argument names a call sends, and the settings route
-- (routes/api/integrations.ts) sends p_actor_email
-- (docs/adr/0007-expand-contract-migrations.md).
--
-- Only the four argument signature is named, so the five argument form, its
-- grants and its comment are untouched. IF EXISTS makes a second run a no op.
--
-- After this, a call sending the four old argument names finds no function
-- (PostgREST answers PGRST202) rather than saving without naming who changed
-- the setting.

SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.save_slack_alert_settings(uuid, uuid, jsonb, uuid);
