-- The ops run engine's tables, its write functions and the write choke point
-- (#1948, track B1 of the #1698 run engine, plan: discussion #1945).
--
-- WHAT. Seven tables and fourteen functions in the ops project:
--   run_requests   every run, from intake to its end (#1698 section 1.3);
--   run_queue      only the runs waiting to be claimed, deleted by the claim, so
--                  the claim never reads history (#1698 D9);
--   workflow_executions  one row per attempt of a run, in the ops database (the
--                  bidding database's table of that name is untouched);
--   send_ledger    an intent row written BEFORE every non GET egress and its
--                  result after, the record a crash between a forward and its
--                  database write is recovered from (L33, L561);
--   schedule_fires one row per schedule slot, UNIQUE (workflow_id, scheduled_for),
--                  written with its run in one transaction;
--   run_request_dedup_tombstones  a purged run's dedup key, until its window
--                  ends, so purging rows never shortens deduplication (#1698 D5);
--   ops_audit_log  old and new values of every human mutation (L593).
--
-- THE CHOKE POINT (the escalated decision in discussion #1945: one per database).
-- service_role, which the ops Worker connects as, may SELECT these tables (for
-- readOpsRows) and holds no INSERT, UPDATE, DELETE or TRUNCATE on any of them.
-- Every write is one of the SECURITY DEFINER functions below, which run as the
-- table owner, fence the write (a claim token and a state version) and scope it to
-- an organization. So the rule is the database's, not a scan's (L621, L96); the
-- Worker side adds one helper as the only .rpc( on the ops client
-- (apps/worker/src/ops/ops-writes.ts) and the scan that holds it there.
--
-- DESIGN NOTES, each a decision a later reader would otherwise have to rediscover.
-- * Not partitioned. UNIQUE (workflow_id, trigger_kind, dedup_key) must span all
--   time, and a unique constraint on a partitioned table must include the
--   partition key, which would let one key run once per partition. So history is
--   purged by batched DELETE over a partial index, never by dropping a partition,
--   and there is no partition DDL to time out.
-- * No lane column. This database is the ops lane (a separate project, D8), so a
--   column holding 'ops' on every row would say nothing.
-- * Organization. Every function that acts on a run takes the organization and
--   matches it; the claim, the sweeps, the purge and the agreement read are lane
--   wide system work and return each row's organization instead.
-- * Concurrency. A workflow's limit is the concurrency_limit of the run at the head
--   of its queue (a run executes its recorded version, whose limit it carries).
--   The claim takes a transaction advisory lock per workflow before it counts the
--   workflow's active runs, so two overlapping ticks cannot both read the same
--   free permits; a workflow another claimer is holding is skipped, as SKIP LOCKED
--   skips a row. A suspended (sleeping) run holds no permit (#1945 decision 3,
--   the recommended answer) and is claimed ahead of new starts on waking.
-- * Overlap (L693). 'skip' is a partial unique index over the ACTIVE states of a
--   workflow's runs, never over a fire time; 'queue' is at most one waiting first
--   start plus a concurrency limit of one, so its runs go one at a time.
-- * Lease. The claim gives a lease of 10 to 300 s; extend renews it while the
--   claim token still holds and never past 15 minutes from the claim, the wall
--   clock of the tick that dispatched the run (spike P1 and P4: a dispatched run
--   dies with its tick). Start and a send intent need an unexpired lease; complete
--   needs only the token, because until a sweep moves the run nobody else holds it.
-- * Timeouts. PostgREST requests on this project stop at the authenticator's 8 s
--   (spike P8). Every function is bounded by a limit of at most 1,000 rows over an
--   index, and sets lock_timeout 2 s so a wait on a row lock fails by name, inside
--   the 8 s, instead of being cut off.
-- * Lock order: run_queue row, then run_requests row, then send_ledger. Only the
--   claim and the expiry sweep lock a run_queue row, and both take it first.
-- * Retention. Terminal runs are purged by purge_terminal_run_requests, which
--   nothing schedules yet: how long runs are kept is Dan's decision (#1945
--   decision 1, L9). The dedup window defaults to 30 days (#1698 D5, until Dan
--   picks one, #1945 decision 2) and is kept by a tombstone past a row's purge.
--   send_ledger has no foreign key to run_requests and is never purged with it.
--
-- Additive only (ADR 0007): new tables and functions, nothing existing changes.
-- Guarded by supabase-ops/supabase/tests/run_engine_*.test.sql.

-- ── run_requests ──────────────────────────────────────────────────────────────
CREATE TABLE public.run_requests (
  id                         uuid PRIMARY KEY,
  organization_id            uuid NOT NULL,
  workflow_id                uuid NOT NULL,
  workflow_version           integer NOT NULL,
  trigger_kind               text NOT NULL,
  dedup_key                  text NOT NULL,
  payload                    jsonb,
  payload_ref                text,
  status                     text NOT NULL,
  status_reason              text,
  priority                   smallint NOT NULL DEFAULT 0,
  not_before                 timestamptz NOT NULL,
  overlap                    text,
  concurrency_limit          integer,
  claimed_by                 text,
  claim_token                uuid,
  claimed_at                 timestamptz,
  claim_expires_at           timestamptz,
  lease_requeues             integer NOT NULL DEFAULT 0,
  state_version              bigint NOT NULL DEFAULT 1,
  attempts                   integer NOT NULL DEFAULT 0,
  max_attempts               integer NOT NULL,
  expires_at                 timestamptz,
  dedup_expires_at           timestamptz NOT NULL,
  kept_by                    uuid,
  kept_at                    timestamptz,
  last_error                 text,
  execution_chain_id         uuid NOT NULL,
  resumed_from_execution_id  uuid,
  resume_reason              text,
  evidence_ref               text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  terminal_at                timestamptz,
  CONSTRAINT run_requests_dedup_key UNIQUE (workflow_id, trigger_kind, dedup_key),
  -- The vocabularies. Their one TypeScript home is apps/worker/src/ops/run-vocabulary.ts,
  -- and apps/web/src/lib/__tests__/ops-run-vocabulary-matches-db.test.ts fails when the two differ.
  CONSTRAINT run_requests_status_check CHECK (status IN
    ('queued', 'claimed', 'running', 'suspended', 'done', 'failed', 'needs_human', 'dead', 'expired', 'skipped')),
  CONSTRAINT run_requests_trigger_kind_check CHECK (trigger_kind IN
    ('http_webhook', 'schedule', 'slack_event', 'email_inbound', 'poll', 'app_webhook', 'call', 'rerun')),
  CONSTRAINT run_requests_status_reason_check CHECK (status_reason IS NULL OR status_reason IN
    ('workflow_inactive', 'workflow_deleted', 'halted_by_rule', 'lease_requeue_cap', 'max_attempts',
     'lease_expired_after_send', 'send_outcome_unknown',
     'paused', 'rate_limited', 'overlap',
     'not_started_in_time',
     'max_compute_exceeded', 'max_steps_exceeded', 'max_state_exceeded')),
  CONSTRAINT run_requests_resume_reason_check CHECK (resume_reason IS NULL OR resume_reason IN ('continue', 'wake', 'retry')),
  CONSTRAINT run_requests_overlap_check CHECK (overlap IS NULL OR overlap IN ('skip', 'queue')),
  -- A reason is required where the status alone does not say why, and absent where nothing ended.
  CONSTRAINT run_requests_reason_required CHECK (
    CASE
      WHEN status IN ('needs_human', 'dead', 'expired', 'skipped') THEN status_reason IS NOT NULL
      WHEN status = 'failed' THEN true
      ELSE status_reason IS NULL
    END),
  CONSTRAINT run_requests_terminal_at_check CHECK ((status IN ('done', 'failed', 'dead', 'expired', 'skipped')) = (terminal_at IS NOT NULL)),
  CONSTRAINT run_requests_lease_check CHECK (
    (status IN ('claimed', 'running')) = (claim_expires_at IS NOT NULL)
    AND (status NOT IN ('claimed', 'running') OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL))),
  CONSTRAINT run_requests_numbers_check CHECK (
    workflow_version >= 1 AND attempts >= 0 AND max_attempts BETWEEN 1 AND 100 AND lease_requeues >= 0
    AND priority BETWEEN 0 AND 100 AND (concurrency_limit IS NULL OR concurrency_limit >= 1) AND state_version >= 1),
  CONSTRAINT run_requests_dedup_key_length CHECK (length(dedup_key) BETWEEN 1 AND 512),
  -- A large body goes to R2 and is named by payload_ref.
  CONSTRAINT run_requests_payload_size CHECK (payload IS NULL OR octet_length(payload::text) <= 262144),
  CONSTRAINT run_requests_kept_check CHECK ((kept_by IS NULL) = (kept_at IS NULL))
) WITH (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);

-- The lease sweep: only runs holding a lease.
CREATE INDEX run_requests_lease_idx ON public.run_requests (claim_expires_at, id) WHERE status IN ('claimed', 'running');
-- The claim's permit count: a workflow's runs holding a permit.
CREATE INDEX run_requests_active_idx ON public.run_requests (workflow_id) WHERE status IN ('claimed', 'running');
-- The expiry sweep: waiting runs that can expire.
CREATE INDEX run_requests_expiry_idx ON public.run_requests (expires_at, id) WHERE status IN ('queued', 'suspended') AND expires_at IS NOT NULL;
-- The agreement read: every waiting run.
CREATE INDEX run_requests_waiting_idx ON public.run_requests (id) WHERE status IN ('queued', 'suspended');
-- The purge: terminal runs nobody kept, oldest first.
CREATE INDEX run_requests_purge_idx ON public.run_requests (terminal_at, id) WHERE terminal_at IS NOT NULL AND kept_by IS NULL;
-- The purge's live work check: chains with a run still going.
CREATE INDEX run_requests_live_chain_idx ON public.run_requests (execution_chain_id) WHERE terminal_at IS NULL;
-- Overlap (L693): skip allows one run per workflow in any active state ...
CREATE UNIQUE INDEX run_requests_overlap_skip_idx ON public.run_requests (workflow_id)
  WHERE overlap = 'skip' AND status IN ('queued', 'claimed', 'running', 'suspended');
-- ... and queue allows one waiting FIRST start (a retry or continuation is not one).
CREATE UNIQUE INDEX run_requests_overlap_queue_idx ON public.run_requests (workflow_id)
  WHERE overlap = 'queue' AND status = 'queued' AND resume_reason IS NULL;

-- ── run_queue ─────────────────────────────────────────────────────────────────
CREATE TABLE public.run_queue (
  run_request_id     uuid PRIMARY KEY REFERENCES public.run_requests (id) ON DELETE CASCADE,
  organization_id    uuid NOT NULL,
  workflow_id        uuid NOT NULL,
  not_before         timestamptz NOT NULL,
  priority           smallint NOT NULL,
  concurrency_limit  integer,
  -- The run's own creation time, so a requeued run keeps its place.
  created_at         timestamptz NOT NULL,
  queued_at          timestamptz NOT NULL DEFAULT now()
) WITH (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 500,
        autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 500);

-- Per workflow, in claim order, with not_before a KEY column so it is checked in
-- the index rather than on the heap (pg-boss src/plans.ts createIndexJobFetch, MIT,
-- v12.35.1: an INCLUDE column cannot be an index condition).
CREATE INDEX run_queue_claim_idx ON public.run_queue (workflow_id, priority DESC, created_at, run_request_id, not_before);
CREATE INDEX run_queue_due_idx ON public.run_queue (not_before);

-- ── workflow_executions ───────────────────────────────────────────────────────
CREATE TABLE public.workflow_executions (
  id                         uuid PRIMARY KEY,
  organization_id            uuid NOT NULL,
  run_request_id             uuid NOT NULL REFERENCES public.run_requests (id) ON DELETE CASCADE,
  execution_chain_id         uuid NOT NULL,
  attempt                    integer NOT NULL CHECK (attempt >= 1),
  workflow_id                uuid NOT NULL,
  workflow_version           integer NOT NULL,
  trigger_type               text NOT NULL CONSTRAINT workflow_executions_trigger_type_check CHECK (trigger_type IN
    ('http_webhook', 'schedule', 'slack_event', 'email_inbound', 'poll', 'app_webhook', 'call', 'rerun')),
  status                     text NOT NULL CONSTRAINT workflow_executions_status_check CHECK (status IN
    ('running', 'success', 'failed', 'suspended', 'needs_human')),
  resume_reason              text CONSTRAINT workflow_executions_resume_reason_check CHECK (resume_reason IS NULL OR resume_reason IN ('continue', 'wake', 'retry')),
  resumed_from_execution_id  uuid,
  error                      text,
  started_at                 timestamptz NOT NULL DEFAULT now(),
  finished_at                timestamptz,
  CONSTRAINT workflow_executions_attempt_key UNIQUE (run_request_id, attempt),
  CONSTRAINT workflow_executions_finished_check CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX workflow_executions_workflow_idx ON public.workflow_executions (workflow_id, started_at DESC);

-- ── send_ledger ───────────────────────────────────────────────────────────────
CREATE TABLE public.send_ledger (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  -- No foreign key: the ledger outlives the run it belongs to (L202, L592).
  run_request_id      uuid NOT NULL,
  execution_chain_id  uuid NOT NULL,
  attempt             integer NOT NULL,
  node_id             text NOT NULL CHECK (length(node_id) BETWEEN 1 AND 200),
  seq                 integer NOT NULL CHECK (seq >= 0),
  method              text NOT NULL CONSTRAINT send_ledger_method_check CHECK (method IN ('POST', 'PUT', 'PATCH', 'DELETE')),
  host                text NOT NULL CHECK (length(host) BETWEEN 1 AND 255),
  -- The node declared the request idempotent (an attempt scoped key the partner
  -- honours), so a lapsed lease after it may be retried rather than sent to a person.
  idempotent          boolean NOT NULL,
  attempt_key         text,
  state_version       bigint NOT NULL,
  status              text NOT NULL CONSTRAINT send_ledger_status_check CHECK (status IN ('intent', 'forwarded', 'failed')),
  response_status     integer,
  response_ref        text,
  intent_at           timestamptz NOT NULL DEFAULT now(),
  result_at           timestamptz,
  CONSTRAINT send_ledger_attempt_send_key UNIQUE (run_request_id, attempt, node_id, seq),
  CONSTRAINT send_ledger_result_check CHECK ((status = 'intent') = (result_at IS NULL))
);
CREATE INDEX send_ledger_attempt_key_idx ON public.send_ledger (attempt_key) WHERE attempt_key IS NOT NULL;
CREATE INDEX send_ledger_intent_idx ON public.send_ledger (intent_at);

-- ── schedule_fires ────────────────────────────────────────────────────────────
CREATE TABLE public.schedule_fires (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  workflow_id      uuid NOT NULL,
  scheduled_for    timestamptz NOT NULL,
  run_request_id   uuid REFERENCES public.run_requests (id) ON DELETE SET NULL,
  outcome          text CHECK (outcome IS NULL OR outcome IN ('enqueued', 'skipped_overlap', 'duplicate')),
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_fires_slot_key UNIQUE (workflow_id, scheduled_for)
);

-- ── run_request_dedup_tombstones ──────────────────────────────────────────────
CREATE TABLE public.run_request_dedup_tombstones (
  workflow_id       uuid NOT NULL,
  trigger_kind      text NOT NULL,
  dedup_key         text NOT NULL,
  organization_id   uuid NOT NULL,
  run_request_id    uuid NOT NULL,
  dedup_expires_at  timestamptz NOT NULL,
  purged_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_id, trigger_kind, dedup_key)
);
CREATE INDEX run_request_dedup_tombstones_expiry_idx ON public.run_request_dedup_tombstones (dedup_expires_at);

-- ── ops_audit_log ─────────────────────────────────────────────────────────────
CREATE TABLE public.ops_audit_log (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  uuid NOT NULL,
  actor_id         uuid,
  actor_email      text,
  action           text NOT NULL,
  subject_table    text NOT NULL,
  subject_id       uuid NOT NULL,
  -- An audit that cannot say what the state was is the gap #1085 recorded.
  old_values       jsonb NOT NULL CHECK (jsonb_typeof(old_values) = 'object' AND old_values <> '{}'::jsonb),
  new_values       jsonb NOT NULL CHECK (jsonb_typeof(new_values) = 'object' AND new_values <> '{}'::jsonb),
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ops_audit_log_subject_idx ON public.ops_audit_log (subject_table, subject_id, at);

-- ── privileges: the choke point ───────────────────────────────────────────────
ALTER TABLE public.run_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.send_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_fires ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.run_request_dedup_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ops_audit_log ENABLE ROW LEVEL SECURITY;
-- No policies: the browser roles get no row (they hold no privilege either), and
-- service_role bypasses row level security, so a policy would govern nobody.

REVOKE ALL ON public.run_requests, public.run_queue, public.workflow_executions, public.send_ledger,
  public.schedule_fires, public.run_request_dedup_tombstones, public.ops_audit_log FROM anon, authenticated, PUBLIC;
-- The platform's default privileges give service_role everything on a new table;
-- it keeps only SELECT, so its every write is a function below.
REVOKE ALL ON public.run_requests, public.run_queue, public.workflow_executions, public.send_ledger,
  public.schedule_fires, public.run_request_dedup_tombstones, public.ops_audit_log FROM service_role;
GRANT SELECT ON public.run_requests, public.run_queue, public.workflow_executions, public.send_ledger,
  public.schedule_fires, public.run_request_dedup_tombstones, public.ops_audit_log TO service_role;
REVOKE ALL ON SEQUENCE public.ops_audit_log_id_seq FROM anon, authenticated, PUBLIC, service_role;

-- ── enqueue_run_request ───────────────────────────────────────────────────────
-- Answers inserted (a new run, queued), skipped (refused by its overlap rule,
-- recorded as skipped), duplicate (the key already has a run, possibly purged,
-- whose id and status it returns) or neither (the conflicting row vanished between
-- the insert and the read three times running; retry). From graphile-worker
-- website/docs/job-key.md (MIT, 4cda192): ON CONFLICT DO NOTHING returns no row
-- both for a duplicate and for a conflict that was rolled back.
CREATE FUNCTION public.enqueue_run_request(
  p_organization_id   uuid,
  p_workflow_id       uuid,
  p_workflow_version  integer,
  p_trigger_kind      text,
  p_dedup_key         text,
  p_payload           jsonb DEFAULT NULL,
  p_payload_ref       text DEFAULT NULL,
  p_not_before        timestamptz DEFAULT NULL,
  p_expires_at        timestamptz DEFAULT NULL,
  p_max_attempts      integer DEFAULT 3,
  p_overlap           text DEFAULT NULL,
  p_concurrency_limit integer DEFAULT NULL,
  p_id                uuid DEFAULT NULL
) RETURNS TABLE (outcome text, run_request_id uuid, run_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_limit integer := CASE WHEN p_overlap = 'queue' THEN 1 ELSE p_concurrency_limit END;
  v_status text;
  v_rows integer;
  v_constraint text;
  v_try integer;
  v_found record;
BEGIN
  IF p_organization_id IS NULL OR p_workflow_id IS NULL OR p_workflow_version IS NULL OR p_trigger_kind IS NULL OR p_dedup_key IS NULL THEN
    RAISE EXCEPTION 'enqueue_run_request: organization, workflow, version, trigger kind and dedup key are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT t.run_request_id, t.organization_id INTO v_found FROM public.run_request_dedup_tombstones t
  WHERE t.workflow_id = p_workflow_id AND t.trigger_kind = p_trigger_kind AND t.dedup_key = p_dedup_key AND t.dedup_expires_at > v_now;
  IF FOUND THEN
    IF v_found.organization_id <> p_organization_id THEN
      RAISE EXCEPTION 'enqueue_run_request: this dedup key belongs to another organization' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN QUERY SELECT 'duplicate'::text, v_found.run_request_id, 'purged'::text;
    RETURN;
  END IF;

  FOR v_try IN 1..3 LOOP
    v_status := 'queued';
    BEGIN
      INSERT INTO public.run_requests (id, organization_id, workflow_id, workflow_version, trigger_kind, dedup_key, payload, payload_ref,
        status, not_before, overlap, concurrency_limit, max_attempts, expires_at, dedup_expires_at, execution_chain_id, created_at, updated_at)
      VALUES (v_id, p_organization_id, p_workflow_id, p_workflow_version, p_trigger_kind, p_dedup_key, p_payload, p_payload_ref,
        'queued', coalesce(p_not_before, v_now), p_overlap, v_limit, p_max_attempts, p_expires_at, v_now + interval '30 days', v_id, v_now, v_now)
      ON CONFLICT ON CONSTRAINT run_requests_dedup_key DO NOTHING;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint NOT IN ('run_requests_overlap_skip_idx', 'run_requests_overlap_queue_idx') THEN RAISE; END IF;
      -- Refused by the overlap rule: recorded, never dropped silently.
      v_status := 'skipped';
      INSERT INTO public.run_requests (id, organization_id, workflow_id, workflow_version, trigger_kind, dedup_key, payload, payload_ref,
        status, status_reason, not_before, overlap, concurrency_limit, max_attempts, expires_at, dedup_expires_at, execution_chain_id,
        created_at, updated_at, terminal_at)
      VALUES (v_id, p_organization_id, p_workflow_id, p_workflow_version, p_trigger_kind, p_dedup_key, p_payload, p_payload_ref,
        'skipped', 'overlap', coalesce(p_not_before, v_now), p_overlap, v_limit, p_max_attempts, p_expires_at, v_now + interval '30 days', v_id,
        v_now, v_now, v_now)
      ON CONFLICT ON CONSTRAINT run_requests_dedup_key DO NOTHING;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    END;

    IF v_rows = 1 THEN
      IF v_status = 'queued' THEN
        INSERT INTO public.run_queue (run_request_id, organization_id, workflow_id, not_before, priority, concurrency_limit, created_at)
        VALUES (v_id, p_organization_id, p_workflow_id, coalesce(p_not_before, v_now), 0, v_limit, v_now);
        RETURN QUERY SELECT 'inserted'::text, v_id, 'queued'::text;
      ELSE
        RETURN QUERY SELECT 'skipped'::text, v_id, 'skipped'::text;
      END IF;
      RETURN;
    END IF;

    SELECT r.id, r.status, r.organization_id INTO v_found FROM public.run_requests r
    WHERE r.workflow_id = p_workflow_id AND r.trigger_kind = p_trigger_kind AND r.dedup_key = p_dedup_key;
    IF FOUND THEN
      IF v_found.organization_id <> p_organization_id THEN
        RAISE EXCEPTION 'enqueue_run_request: this dedup key belongs to another organization' USING ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN QUERY SELECT 'duplicate'::text, v_found.id, v_found.status;
      RETURN;
    END IF;
  END LOOP;
  RETURN QUERY SELECT 'neither'::text, NULL::uuid, NULL::text;
END
$fn$;

-- ── claim_run_requests ────────────────────────────────────────────────────────
-- Claims up to p_limit waiting runs, at most p_per_workflow of any one workflow
-- (#1698 D1: one workflow's flood cannot fill every claim), continuations first
-- (higher priority), each workflow within its concurrency limit, counting every
-- claim. The issue's sketch (row_number() over a partition with FOR UPDATE SKIP
-- LOCKED) is not valid Postgres: a window function cannot sit in WHERE and FOR
-- UPDATE is refused beside one. So: the due workflows in head order, then per
-- workflow a try advisory lock, its permit count, and a LIMITed SKIP LOCKED pick
-- over the claim index, each its own statement so the count sees every claim
-- committed before the lock was taken.
CREATE FUNCTION public.claim_run_requests(
  p_worker         text,
  p_limit          integer,
  p_per_workflow   integer,
  p_lease_seconds  integer
) RETURNS TABLE (
  run_request_id uuid, organization_id uuid, workflow_id uuid, workflow_version integer, trigger_kind text,
  claim_token uuid, claim_expires_at timestamptz, state_version bigint, attempts integer, max_attempts integer,
  resume_reason text, execution_chain_id uuid, resumed_from_execution_id uuid, payload jsonb, payload_ref text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_left integer;
  v_wf uuid;
  v_active integer;
  v_head_limit integer;
  v_take integer;
  v_ids uuid[];
  v_rows integer;
BEGIN
  IF p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'claim_run_requests: a worker name of 1 to 200 characters is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'claim_run_requests: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_per_workflow IS NULL OR p_per_workflow NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'claim_run_requests: per workflow must be 1 to 1000, not %', p_per_workflow USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 300 THEN
    RAISE EXCEPTION 'claim_run_requests: lease must be 10 to 300 seconds, not %', p_lease_seconds USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_left := p_limit;

  FOR v_wf IN
    SELECT q.workflow_id FROM public.run_queue q
    WHERE q.not_before <= v_now
    GROUP BY q.workflow_id
    ORDER BY max(q.priority) DESC, min(q.created_at), q.workflow_id
    LIMIT 1000
  LOOP
    EXIT WHEN v_left <= 0;
    -- Another claimer holds this workflow: skip it, as SKIP LOCKED skips a row.
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(hashtextextended('run_claim:' || v_wf::text, 0));

    SELECT count(*) INTO v_active FROM public.run_requests r WHERE r.workflow_id = v_wf AND r.status IN ('claimed', 'running');
    SELECT q.concurrency_limit INTO v_head_limit FROM public.run_queue q
    WHERE q.workflow_id = v_wf AND q.not_before <= v_now
    ORDER BY q.priority DESC, q.created_at, q.run_request_id LIMIT 1;
    v_take := least(p_per_workflow, v_left, coalesce(v_head_limit - v_active, p_per_workflow));
    CONTINUE WHEN v_take <= 0;

    WITH picked AS (
      SELECT q.run_request_id FROM public.run_queue q
      WHERE q.workflow_id = v_wf AND q.not_before <= v_now
      ORDER BY q.priority DESC, q.created_at, q.run_request_id
      LIMIT v_take
      FOR UPDATE SKIP LOCKED
    ), gone AS (
      DELETE FROM public.run_queue q USING picked WHERE q.run_request_id = picked.run_request_id RETURNING q.run_request_id
    )
    SELECT array_agg(gone.run_request_id ORDER BY gone.run_request_id) INTO v_ids FROM gone;
    CONTINUE WHEN v_ids IS NULL;

    -- A run past its expiry is never started (#1698 D4).
    UPDATE public.run_requests r
    SET status = 'expired', status_reason = 'not_started_in_time', terminal_at = v_now, updated_at = v_now, state_version = r.state_version + 1
    WHERE r.id = ANY (v_ids) AND r.status IN ('queued', 'suspended') AND r.expires_at IS NOT NULL AND r.expires_at <= v_now;

    RETURN QUERY
    WITH claimed AS (
      UPDATE public.run_requests r
      SET status = 'claimed', claimed_by = p_worker, claim_token = gen_random_uuid(), claimed_at = v_now,
          claim_expires_at = v_now + make_interval(secs => p_lease_seconds), state_version = r.state_version + 1, updated_at = v_now
      WHERE r.id = ANY (v_ids) AND r.status IN ('queued', 'suspended')
      RETURNING r.id, r.organization_id, r.workflow_id, r.workflow_version, r.trigger_kind, r.claim_token, r.claim_expires_at,
        r.state_version, r.attempts, r.max_attempts, r.resume_reason, r.execution_chain_id, r.resumed_from_execution_id, r.payload, r.payload_ref
    )
    SELECT * FROM claimed;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_left := v_left - v_rows;
  END LOOP;
END
$fn$;

-- ── start_run_execution ───────────────────────────────────────────────────────
-- The holder of an unexpired claim starts an attempt: the run goes running, the
-- attempt is counted, and its execution row is written. Answers started (with the
-- new state version the holder fences its sends with), already_started (this
-- execution id already started under this token) or claim_lost.
CREATE FUNCTION public.start_run_execution(
  p_organization_id  uuid,
  p_run_request_id   uuid,
  p_claim_token      uuid,
  p_execution_id     uuid
) RETURNS TABLE (outcome text, state_version bigint, attempt integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_run record;
BEGIN
  IF p_execution_id IS NULL THEN
    RAISE EXCEPTION 'start_run_execution: an execution id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.run_requests r
  SET status = 'running', attempts = r.attempts + 1, state_version = r.state_version + 1, updated_at = v_now
  WHERE r.id = p_run_request_id AND r.organization_id = p_organization_id AND r.claim_token = p_claim_token
    AND r.status = 'claimed' AND r.claim_expires_at > v_now
  RETURNING r.* INTO v_run;

  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.workflow_executions e JOIN public.run_requests r ON r.id = e.run_request_id
               WHERE e.id = p_execution_id AND r.id = p_run_request_id AND r.organization_id = p_organization_id
                 AND r.claim_token = p_claim_token AND r.status = 'running') THEN
      RETURN QUERY SELECT 'already_started'::text, r.state_version, r.attempts FROM public.run_requests r WHERE r.id = p_run_request_id;
    ELSE
      RETURN QUERY SELECT 'claim_lost'::text, NULL::bigint, NULL::integer;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.workflow_executions (id, organization_id, run_request_id, execution_chain_id, attempt, workflow_id, workflow_version,
    trigger_type, status, resume_reason, resumed_from_execution_id, started_at)
  VALUES (p_execution_id, v_run.organization_id, v_run.id, v_run.execution_chain_id, v_run.attempts, v_run.workflow_id, v_run.workflow_version,
    v_run.trigger_kind, 'running', v_run.resume_reason, v_run.resumed_from_execution_id, v_now);
  RETURN QUERY SELECT 'started'::text, v_run.state_version, v_run.attempts;
END
$fn$;

-- ── extend_run_lease ──────────────────────────────────────────────────────────
-- The heartbeat (#1698 D3, pg-boss docs/api/queues.md). False means the claim was
-- lost: the holder stops before its next send. Never past 15 minutes from the
-- claim, the most a dispatched run can live (spike P1, P4).
CREATE FUNCTION public.extend_run_lease(
  p_organization_id  uuid,
  p_run_request_id   uuid,
  p_claim_token      uuid,
  p_lease_seconds    integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 300 THEN
    RAISE EXCEPTION 'extend_run_lease: lease must be 10 to 300 seconds, not %', p_lease_seconds USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.run_requests r
  SET claim_expires_at = least(v_now + make_interval(secs => p_lease_seconds), r.claimed_at + interval '15 minutes'), updated_at = v_now
  WHERE r.id = p_run_request_id AND r.organization_id = p_organization_id AND r.claim_token = p_claim_token
    AND r.status IN ('claimed', 'running') AND r.claim_expires_at > v_now AND v_now < r.claimed_at + interval '15 minutes';
  RETURN FOUND;
END
$fn$;

-- ── complete_run_request ──────────────────────────────────────────────────────
-- The holder ends its claim. Outcomes: done, failed (terminal), retry (back to
-- the queue, or dead at max_attempts), suspend (sleeping until p_not_before,
-- p_reason continue or wake, claimed ahead of new starts on waking), needs_human,
-- dead (p_reason workflow_inactive, workflow_deleted or halted_by_rule). Answers
-- completed, already_completed (this token already ended it), claim_lost
-- (another holder, or swept) or not_found (no such run in this organization).
CREATE FUNCTION public.complete_run_request(
  p_organization_id  uuid,
  p_run_request_id   uuid,
  p_claim_token      uuid,
  p_outcome          text,
  p_reason           text DEFAULT NULL,
  p_error            text DEFAULT NULL,
  p_not_before       timestamptz DEFAULT NULL
) RETURNS TABLE (outcome text, run_status text, state_version bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_run record;
  v_status text;
  v_reason text := NULL;
  v_resume text := NULL;
  v_queue boolean := false;
  v_priority smallint;
  v_exec_status text;
BEGIN
  CASE p_outcome
    WHEN 'done' THEN v_status := 'done'; v_exec_status := 'success';
    WHEN 'failed' THEN
      IF p_reason IS NOT NULL AND p_reason NOT IN ('max_compute_exceeded', 'max_steps_exceeded', 'max_state_exceeded') THEN
        RAISE EXCEPTION 'complete_run_request: % is not a reason a run fails for', p_reason USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_status := 'failed'; v_reason := p_reason; v_exec_status := 'failed';
    WHEN 'retry' THEN v_status := 'queued'; v_resume := 'retry'; v_queue := true; v_exec_status := 'failed';
    WHEN 'suspend' THEN
      IF p_reason IS NULL OR p_reason NOT IN ('continue', 'wake') THEN
        RAISE EXCEPTION 'complete_run_request: a suspend needs the reason continue or wake, not %', p_reason USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_status := 'suspended'; v_resume := p_reason; v_queue := true; v_exec_status := 'suspended';
    WHEN 'needs_human' THEN
      IF p_reason IS NULL OR p_reason NOT IN ('lease_expired_after_send', 'send_outcome_unknown') THEN
        RAISE EXCEPTION 'complete_run_request: % is not a reason a run needs a person for', p_reason USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_status := 'needs_human'; v_reason := p_reason; v_exec_status := 'needs_human';
    WHEN 'dead' THEN
      IF p_reason IS NULL OR p_reason NOT IN ('workflow_inactive', 'workflow_deleted', 'halted_by_rule') THEN
        RAISE EXCEPTION 'complete_run_request: % is not a reason a run is ended for', p_reason USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_status := 'dead'; v_reason := p_reason; v_exec_status := 'failed';
    ELSE
      RAISE EXCEPTION 'complete_run_request: % is not an outcome', p_outcome USING ERRCODE = 'invalid_parameter_value';
  END CASE;
  -- No token is no claim: refused, so it can never match a swept or never
  -- claimed run's absent token and be told already_completed.
  IF p_claim_token IS NULL THEN
    RAISE EXCEPTION 'complete_run_request: a claim token is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT r.* INTO v_run FROM public.run_requests r
  WHERE r.id = p_run_request_id AND r.organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;
  IF v_run.claim_token IS NULL OR v_run.claim_token <> p_claim_token THEN
    RETURN QUERY SELECT 'claim_lost'::text, v_run.status, v_run.state_version;
    RETURN;
  END IF;
  IF v_run.status NOT IN ('claimed', 'running') THEN
    RETURN QUERY SELECT 'already_completed'::text, v_run.status, v_run.state_version;
    RETURN;
  END IF;

  IF p_outcome = 'retry' AND v_run.attempts >= v_run.max_attempts THEN
    v_status := 'dead'; v_reason := 'max_attempts'; v_resume := NULL; v_queue := false;
  END IF;
  v_priority := CASE WHEN v_status = 'suspended' THEN 10 ELSE v_run.priority END;

  UPDATE public.run_requests r
  SET status = v_status, status_reason = v_reason,
      resume_reason = CASE WHEN v_queue THEN v_resume ELSE r.resume_reason END,
      priority = v_priority, not_before = CASE WHEN v_queue THEN coalesce(p_not_before, v_now) ELSE r.not_before END,
      claim_expires_at = NULL, last_error = coalesce(p_error, r.last_error), state_version = r.state_version + 1, updated_at = v_now,
      terminal_at = CASE WHEN v_status IN ('done', 'failed', 'dead', 'expired', 'skipped') THEN v_now END
  WHERE r.id = v_run.id
  RETURNING r.* INTO v_run;

  IF v_queue THEN
    INSERT INTO public.run_queue (run_request_id, organization_id, workflow_id, not_before, priority, concurrency_limit, created_at)
    VALUES (v_run.id, v_run.organization_id, v_run.workflow_id, v_run.not_before, v_run.priority, v_run.concurrency_limit, v_run.created_at);
  END IF;
  UPDATE public.workflow_executions e SET status = v_exec_status, finished_at = v_now, error = p_error
  WHERE e.run_request_id = v_run.id AND e.attempt = v_run.attempts AND e.status = 'running';

  RETURN QUERY SELECT 'completed'::text, v_run.status, v_run.state_version;
END
$fn$;

-- ── sweep_expired_leases ──────────────────────────────────────────────────────
-- Up to p_limit runs whose lease lapsed, oldest first, skipping any row another
-- sweep or writer holds (so overlapping ticks share the work, and it never waits
-- on the live claim, which locks queue rows, L519). A run claimed but never
-- started is requeued without spending an attempt, three times at most; a run
-- that lapsed mid flight spends its attempt (#1698 D4) and goes to needs_human if
-- it made any send not declared idempotent, else is retried or ends dead at
-- max_attempts. more says a full page was taken, so call again.
CREATE FUNCTION public.sweep_expired_leases(p_limit integer)
RETURNS TABLE (requeued integer, retried integer, needs_human integer, dead integer, more boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_run record;
  v_requeued integer := 0;
  v_retried integer := 0;
  v_human integer := 0;
  v_dead integer := 0;
  v_seen integer := 0;
  v_status text;
  v_reason text;
  v_queue boolean;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'sweep_expired_leases: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR v_run IN
    SELECT r.id, r.status, r.attempts, r.max_attempts, r.lease_requeues FROM public.run_requests r
    WHERE r.status IN ('claimed', 'running') AND r.claim_expires_at < v_now
    ORDER BY r.claim_expires_at, r.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    v_seen := v_seen + 1;
    v_reason := NULL;
    v_queue := false;
    IF v_run.status = 'claimed' THEN
      IF v_run.lease_requeues < 3 THEN
        v_status := 'queued'; v_queue := true; v_requeued := v_requeued + 1;
      ELSE
        v_status := 'dead'; v_reason := 'lease_requeue_cap'; v_dead := v_dead + 1;
      END IF;
    ELSE
      UPDATE public.workflow_executions e SET status = 'failed', finished_at = v_now, error = 'lease expired'
      WHERE e.run_request_id = v_run.id AND e.attempt = v_run.attempts AND e.status = 'running';
      IF EXISTS (SELECT 1 FROM public.send_ledger l WHERE l.run_request_id = v_run.id AND NOT l.idempotent) THEN
        v_status := 'needs_human'; v_reason := 'lease_expired_after_send'; v_human := v_human + 1;
      ELSIF v_run.attempts >= v_run.max_attempts THEN
        v_status := 'dead'; v_reason := 'max_attempts'; v_dead := v_dead + 1;
      ELSE
        v_status := 'queued'; v_queue := true; v_retried := v_retried + 1;
      END IF;
    END IF;

    -- The claim is over: its token goes, so the old holder's complete answers
    -- claim_lost, never already_completed (a token is kept past a complete only
    -- so that the holder's own repeat is recognised).
    UPDATE public.run_requests r
    SET status = v_status, status_reason = v_reason, claim_expires_at = NULL, claim_token = NULL,
        lease_requeues = r.lease_requeues + CASE WHEN v_run.status = 'claimed' AND v_queue THEN 1 ELSE 0 END,
        resume_reason = CASE WHEN v_run.status = 'running' AND v_queue THEN 'retry' ELSE r.resume_reason END,
        not_before = CASE WHEN v_queue THEN v_now ELSE r.not_before END,
        last_error = CASE WHEN v_run.status = 'running' THEN 'lease expired' ELSE r.last_error END,
        state_version = r.state_version + 1, updated_at = v_now,
        terminal_at = CASE WHEN v_status = 'dead' THEN v_now END
    WHERE r.id = v_run.id;
    IF v_queue THEN
      INSERT INTO public.run_queue (run_request_id, organization_id, workflow_id, not_before, priority, concurrency_limit, created_at)
      SELECT r.id, r.organization_id, r.workflow_id, r.not_before, r.priority, r.concurrency_limit, r.created_at
      FROM public.run_requests r WHERE r.id = v_run.id;
    END IF;
  END LOOP;
  RETURN QUERY SELECT v_requeued, v_retried, v_human, v_dead, v_seen = p_limit;
END
$fn$;

-- ── expire_overdue_run_requests ───────────────────────────────────────────────
-- Waiting runs past their expiry end expired, even when no claim reaches them.
-- Takes the queue row first (the lock order the claim keeps).
CREATE FUNCTION public.expire_overdue_run_requests(p_limit integer)
RETURNS TABLE (expired integer, more boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_ids uuid[];
  v_rows integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'expire_overdue_run_requests: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH overdue AS (
    SELECT r.id FROM public.run_requests r
    WHERE r.status IN ('queued', 'suspended') AND r.expires_at IS NOT NULL AND r.expires_at <= v_now
    ORDER BY r.expires_at, r.id
    LIMIT p_limit
  ), locked AS (
    SELECT q.run_request_id FROM public.run_queue q JOIN overdue o ON o.id = q.run_request_id
    FOR UPDATE OF q SKIP LOCKED
  ), gone AS (
    DELETE FROM public.run_queue q USING locked WHERE q.run_request_id = locked.run_request_id RETURNING q.run_request_id
  )
  SELECT array_agg(gone.run_request_id) INTO v_ids FROM gone;

  UPDATE public.run_requests r
  SET status = 'expired', status_reason = 'not_started_in_time', terminal_at = v_now, updated_at = v_now, state_version = r.state_version + 1
  WHERE r.id = ANY (coalesce(v_ids, ARRAY[]::uuid[])) AND r.status IN ('queued', 'suspended');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows, coalesce(array_length(v_ids, 1), 0) = p_limit;
END
$fn$;

-- ── record_send_intent ────────────────────────────────────────────────────────
-- Written BEFORE a non GET egress (L33). Only the current holder of an unexpired
-- claim at the state version it started with may record one (#1698 D2), so a
-- stalled holder whose run was re-claimed records nothing and must not send.
-- Answers recorded, duplicate (this attempt already recorded this send; its row
-- is returned, so a retried insert is safe) or stale.
CREATE FUNCTION public.record_send_intent(
  p_organization_id  uuid,
  p_run_request_id   uuid,
  p_claim_token      uuid,
  p_state_version    bigint,
  p_node_id          text,
  p_seq              integer,
  p_method           text,
  p_host             text,
  p_idempotent       boolean,
  p_attempt_key      text DEFAULT NULL
) RETURNS TABLE (outcome text, ledger_id uuid, ledger_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_run record;
  v_id uuid;
  v_found record;
BEGIN
  SELECT r.* INTO v_run FROM public.run_requests r
  WHERE r.id = p_run_request_id AND r.organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND OR v_run.status <> 'running' OR v_run.claim_token IS DISTINCT FROM p_claim_token
     OR v_run.state_version IS DISTINCT FROM p_state_version OR v_run.claim_expires_at <= v_now THEN
    RETURN QUERY SELECT 'stale'::text, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  INSERT INTO public.send_ledger (organization_id, run_request_id, execution_chain_id, attempt, node_id, seq, method, host,
    idempotent, attempt_key, state_version, status, intent_at)
  VALUES (v_run.organization_id, v_run.id, v_run.execution_chain_id, v_run.attempts, p_node_id, p_seq, p_method, p_host,
    p_idempotent, p_attempt_key, v_run.state_version, 'intent', v_now)
  ON CONFLICT ON CONSTRAINT send_ledger_attempt_send_key DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT 'recorded'::text, v_id, 'intent'::text;
    RETURN;
  END IF;
  SELECT l.id, l.status INTO v_found FROM public.send_ledger l
  WHERE l.run_request_id = v_run.id AND l.attempt = v_run.attempts AND l.node_id = p_node_id AND l.seq = p_seq;
  RETURN QUERY SELECT 'duplicate'::text, v_found.id, v_found.status;
END
$fn$;

-- ── record_send_result ────────────────────────────────────────────────────────
-- What happened to a send, written after it. Not fenced by the claim: a forward
-- that landed is a fact about the partner whoever holds the run now, and the
-- person resolving a needs_human run needs it. The first result wins.
CREATE FUNCTION public.record_send_result(
  p_organization_id  uuid,
  p_ledger_id        uuid,
  p_status           text,
  p_response_status  integer DEFAULT NULL,
  p_response_ref     text DEFAULT NULL
) RETURNS TABLE (outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('forwarded', 'failed') THEN
    RAISE EXCEPTION 'record_send_result: status must be forwarded or failed, not %', p_status USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.send_ledger l
  SET status = p_status, response_status = p_response_status, response_ref = p_response_ref, result_at = now()
  WHERE l.id = p_ledger_id AND l.organization_id = p_organization_id AND l.status = 'intent';
  IF FOUND THEN
    RETURN QUERY SELECT 'recorded'::text;
  ELSIF EXISTS (SELECT 1 FROM public.send_ledger l WHERE l.id = p_ledger_id AND l.organization_id = p_organization_id) THEN
    RETURN QUERY SELECT 'already_recorded'::text;
  ELSE
    RETURN QUERY SELECT 'not_found'::text;
  END IF;
END
$fn$;

-- ── record_schedule_fire ──────────────────────────────────────────────────────
-- One schedule slot: its fire row and its run in one transaction. Answers
-- enqueued, skipped_overlap, duplicate (the slot's run key already had a run) or
-- already_recorded (this slot was recorded before; its run is returned). The run
-- carries its slot and the previous slot (#1698 1.6) in its payload. What is due
-- is B-sched's to compute (#1952); this only makes recording a slot safe to run
-- twice.
CREATE FUNCTION public.record_schedule_fire(
  p_organization_id         uuid,
  p_workflow_id             uuid,
  p_workflow_version        integer,
  p_scheduled_for           timestamptz,
  p_previous_scheduled_for  timestamptz,
  p_overlap                 text DEFAULT 'skip',
  p_concurrency_limit       integer DEFAULT NULL,
  p_not_before              timestamptz DEFAULT NULL,
  p_expires_at              timestamptz DEFAULT NULL,
  p_max_attempts            integer DEFAULT 3
) RETURNS TABLE (outcome text, fire_id uuid, run_request_id uuid, run_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_fire uuid;
  v_found record;
  v_run record;
  v_slot text;
BEGIN
  IF p_scheduled_for IS NULL THEN
    RAISE EXCEPTION 'record_schedule_fire: the slot time is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.schedule_fires (organization_id, workflow_id, scheduled_for)
  VALUES (p_organization_id, p_workflow_id, p_scheduled_for)
  ON CONFLICT ON CONSTRAINT schedule_fires_slot_key DO NOTHING
  RETURNING id INTO v_fire;
  IF v_fire IS NULL THEN
    SELECT f.id, f.organization_id, f.run_request_id INTO v_found FROM public.schedule_fires f
    WHERE f.workflow_id = p_workflow_id AND f.scheduled_for = p_scheduled_for;
    IF v_found.organization_id <> p_organization_id THEN
      RAISE EXCEPTION 'record_schedule_fire: this slot belongs to another organization' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN QUERY SELECT 'already_recorded'::text, v_found.id, v_found.run_request_id,
      (SELECT r.status FROM public.run_requests r WHERE r.id = v_found.run_request_id);
    RETURN;
  END IF;

  v_slot := to_char(p_scheduled_for AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  SELECT * INTO v_run FROM public.enqueue_run_request(
    p_organization_id => p_organization_id, p_workflow_id => p_workflow_id, p_workflow_version => p_workflow_version,
    p_trigger_kind => 'schedule', p_dedup_key => 'slot:' || v_slot,
    p_payload => jsonb_build_object('scheduled_for', v_slot,
      'previous_scheduled_for', to_char(p_previous_scheduled_for AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    p_not_before => p_not_before, p_expires_at => p_expires_at, p_max_attempts => p_max_attempts,
    p_overlap => p_overlap, p_concurrency_limit => p_concurrency_limit);
  IF v_run.outcome = 'neither' THEN
    RAISE EXCEPTION 'record_schedule_fire: the slot''s run could not be enqueued or found; retry' USING ERRCODE = 'serialization_failure';
  END IF;
  UPDATE public.schedule_fires f
  SET run_request_id = v_run.run_request_id,
      outcome = CASE v_run.outcome WHEN 'inserted' THEN 'enqueued' WHEN 'skipped' THEN 'skipped_overlap' ELSE 'duplicate' END
  WHERE f.id = v_fire;
  RETURN QUERY SELECT CASE v_run.outcome WHEN 'inserted' THEN 'enqueued' WHEN 'skipped' THEN 'skipped_overlap' ELSE 'duplicate' END,
    v_fire, v_run.run_request_id, v_run.run_status;
END
$fn$;

-- ── purge_terminal_run_requests ───────────────────────────────────────────────
-- Deletes up to p_limit terminal runs that ended before the cutoff, never one a
-- person kept and never one whose chain still has a run going (a purge checks
-- live work, never the date alone, L211). A purged run's key that is still inside
-- its dedup window leaves a tombstone. Its executions go with it; its send ledger
-- rows do not. Refuses a cutoff inside the last day, which is never a retention
-- window and is how a mistaken now() would empty the table. Nothing schedules
-- this yet: the retention window is Dan's decision (#1945 decision 1, L9).
CREATE FUNCTION public.purge_terminal_run_requests(p_terminal_before timestamptz, p_limit integer)
RETURNS TABLE (purged integer, tombstoned integer, more boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_purged integer;
  v_tombs integer;
BEGIN
  IF p_terminal_before IS NULL OR p_terminal_before > v_now - interval '1 day' THEN
    RAISE EXCEPTION 'purge_terminal_run_requests: the cutoff must be at least a day ago, not %', p_terminal_before USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'purge_terminal_run_requests: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH doomed AS (
    SELECT r.id, r.organization_id, r.workflow_id, r.trigger_kind, r.dedup_key, r.dedup_expires_at FROM public.run_requests r
    WHERE r.terminal_at IS NOT NULL AND r.kept_by IS NULL AND r.terminal_at < p_terminal_before
      AND NOT EXISTS (SELECT 1 FROM public.run_requests live WHERE live.execution_chain_id = r.execution_chain_id AND live.terminal_at IS NULL)
    ORDER BY r.terminal_at, r.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), tombs AS (
    INSERT INTO public.run_request_dedup_tombstones (workflow_id, trigger_kind, dedup_key, organization_id, run_request_id, dedup_expires_at, purged_at)
    SELECT d.workflow_id, d.trigger_kind, d.dedup_key, d.organization_id, d.id, d.dedup_expires_at, v_now FROM doomed d
    WHERE d.dedup_expires_at > v_now
    ON CONFLICT (workflow_id, trigger_kind, dedup_key) DO UPDATE SET dedup_expires_at = greatest(EXCLUDED.dedup_expires_at, public.run_request_dedup_tombstones.dedup_expires_at)
    RETURNING 1
  ), gone AS (
    DELETE FROM public.run_requests r USING doomed d WHERE r.id = d.id RETURNING 1
  )
  SELECT (SELECT count(*) FROM gone), (SELECT count(*) FROM tombs) INTO v_purged, v_tombs;
  RETURN QUERY SELECT v_purged, v_tombs, v_purged = p_limit;
END
$fn$;

-- ── purge_expired_dedup_tombstones ────────────────────────────────────────────
CREATE FUNCTION public.purge_expired_dedup_tombstones(p_limit integer)
RETURNS TABLE (purged integer, more boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_rows integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'purge_expired_dedup_tombstones: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH doomed AS (
    SELECT t.workflow_id, t.trigger_kind, t.dedup_key FROM public.run_request_dedup_tombstones t
    WHERE t.dedup_expires_at <= now() ORDER BY t.dedup_expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.run_request_dedup_tombstones t USING doomed d
  WHERE t.workflow_id = d.workflow_id AND t.trigger_kind = d.trigger_kind AND t.dedup_key = d.dedup_key;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows, v_rows = p_limit;
END
$fn$;

-- ── set_run_request_kept ──────────────────────────────────────────────────────
-- A person keeps a run (exempt from every purge until un-kept) or un-keeps it
-- (#1698 1.3, from n8n softDeletePrunableExecutions). Audited with old and new
-- values in the same transaction (L593). Answers changed, unchanged or not_found.
CREATE FUNCTION public.set_run_request_kept(
  p_organization_id  uuid,
  p_run_request_id   uuid,
  p_kept             boolean,
  p_actor_id         uuid,
  p_actor_email      text
) RETURNS TABLE (outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout = '2s'
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_run record;
BEGIN
  IF p_kept IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'set_run_request_kept: whether to keep, and who asked, are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT r.id, r.kept_by, r.kept_at INTO v_run FROM public.run_requests r
  WHERE r.id = p_run_request_id AND r.organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text;
    RETURN;
  END IF;
  IF (v_run.kept_by IS NOT NULL) = p_kept THEN
    RETURN QUERY SELECT 'unchanged'::text;
    RETURN;
  END IF;
  UPDATE public.run_requests r
  SET kept_by = CASE WHEN p_kept THEN p_actor_id END, kept_at = CASE WHEN p_kept THEN v_now END, updated_at = v_now
  WHERE r.id = v_run.id;
  INSERT INTO public.ops_audit_log (organization_id, actor_id, actor_email, action, subject_table, subject_id, old_values, new_values, at)
  VALUES (p_organization_id, p_actor_id, p_actor_email, CASE WHEN p_kept THEN 'keep_run' ELSE 'unkeep_run' END, 'run_requests', v_run.id,
    jsonb_build_object('kept_by', v_run.kept_by),
    jsonb_build_object('kept_by', CASE WHEN p_kept THEN p_actor_id END), v_now);
  RETURN QUERY SELECT 'changed'::text;
END
$fn$;

-- ── run_queue_disagreements ───────────────────────────────────────────────────
-- The registered agreement check's read (#1698 D9, R4): a queue row whose run is
-- not waiting, and a waiting run with no queue row. Every write keeps the two in
-- one transaction, so any row here is a defect to report, never to repair in
-- place. Read only.
CREATE FUNCTION public.run_queue_disagreements(p_limit integer)
RETURNS TABLE (kind text, run_request_id uuid, organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'run_queue_disagreements: limit must be 1 to 1000, not %', p_limit USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  (SELECT 'queue_row_without_waiting_run'::text, q.run_request_id, q.organization_id
   FROM public.run_queue q JOIN public.run_requests r ON r.id = q.run_request_id
   WHERE r.status NOT IN ('queued', 'suspended') OR r.organization_id <> q.organization_id
   LIMIT p_limit)
  UNION ALL
  (SELECT 'waiting_run_without_queue_row'::text, r.id, r.organization_id
   FROM public.run_requests r
   WHERE r.status IN ('queued', 'suspended') AND NOT EXISTS (SELECT 1 FROM public.run_queue q WHERE q.run_request_id = r.id)
   LIMIT p_limit);
END
$fn$;

-- ── function privileges ───────────────────────────────────────────────────────
DO $grants$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'enqueue_run_request', 'claim_run_requests', 'start_run_execution', 'extend_run_lease',
      'complete_run_request', 'sweep_expired_leases', 'expire_overdue_run_requests',
      'record_send_intent', 'record_send_result', 'record_schedule_fire',
      'purge_terminal_run_requests', 'purge_expired_dedup_tombstones', 'set_run_request_kept',
      'run_queue_disagreements')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$grants$;
