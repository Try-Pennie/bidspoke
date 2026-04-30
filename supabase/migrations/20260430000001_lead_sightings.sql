-- ============================================================
-- Lead sightings: persons + sightings + bids
-- ============================================================
-- persons: encrypted PII keyed by SSN hash (hot-path dedup linkage)
-- lead_sightings: write buffer for Snowflake; one row per lead trigger
-- lead_sighting_bids: write buffer for Snowflake; one row per partner attempt
--
-- Sightings + bids are pushed to Snowflake daily and deleted from Supabase
-- after successful export. Persons stays in Supabase indefinitely.
-- ============================================================


-- ============================================================
-- persons
-- ============================================================
CREATE TABLE persons (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ssn_hash            VARCHAR(64) NOT NULL,                -- peppered SHA-256 hex
  ssn_encrypted       BYTEA NOT NULL,                       -- AES-GCM with SECRET_ENCRYPTION_KEY

  first_name_enc      BYTEA,
  middle_name_enc     BYTEA,
  last_name_enc       BYTEA,
  dob_enc             BYTEA,
  email_enc           BYTEA,
  phone_enc           BYTEA,
  street_enc          BYTEA,
  apt_enc             BYTEA,
  city                VARCHAR,
  state               VARCHAR(2),
  zip_enc             BYTEA,

  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (organization_id, ssn_hash)
);

CREATE INDEX persons_ssn_hash_idx ON persons (organization_id, ssn_hash);
CREATE INDEX persons_last_seen_idx ON persons (organization_id, last_seen_at DESC);

ALTER TABLE persons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "persons_org" ON persons
  FOR ALL USING (organization_id = public.user_org_id());


-- ============================================================
-- lead_sightings (partitioned monthly on execution_started_at_utc)
-- ============================================================
CREATE TABLE lead_sightings (
  id                          UUID NOT NULL DEFAULT gen_random_uuid(),
  ssn                         VARCHAR(11),                  -- formatted XXX-XX-XXXX
  person_id                   UUID,                          -- soft ref to persons; not FK (cross-partition)
  trace_id                    VARCHAR NOT NULL,
  execution_id                UUID NOT NULL,
  workflow_id                 UUID NOT NULL REFERENCES workflows(id),
  workflow_version_id         UUID,                          -- workflow_versions.id
  workflow_version_sha        VARCHAR(40),                   -- GitHub commit SHA from auto-backup

  -- timing
  execution_started_at_et     TIMESTAMPTZ NOT NULL,
  execution_finished_at_et    TIMESTAMPTZ,                   -- nullable while in_flight; required at finalize
  execution_started_at_utc    TIMESTAMP NOT NULL,
  execution_ended_at_utc      TIMESTAMP,                     -- nullable while in_flight
  duration_ms                 INTEGER,

  -- source / routing
  source_name                 VARCHAR,
  subaccount_uuid             VARCHAR,
  lead_uuid                   VARCHAR,
  external_partner_name       VARCHAR,
  external_routing_code       VARCHAR,
  external_exchange_status    VARCHAR,
  offer_landing_page          VARCHAR,

  -- outcome (raw facts; outcome enum derived in Snowflake view)
  terminal_node_id            VARCHAR,
  terminal_node_label         VARCHAR,
  response_status_code        INTEGER,
  reject_reason               VARCHAR,                       -- set by Exit/Response node config

  -- enrichment
  prospect_id                 VARCHAR(18),                   -- Salesforce Prospect__c 18-char ID
  equifax_status              VARCHAR,                       -- 'skipped' | 'success' | 'no_hit' | 'frozen' | 'fraud' | 'error'
  equifax_error_type          VARCHAR,                       -- 'transient' | 'permanent'; populated when status='error'
  equifax_score               INTEGER,                       -- actual pulled FICO

  -- bid summary (winner only; per-attempt detail in lead_sighting_bids)
  winning_partner_slug        VARCHAR,
  winning_bid_cents           INTEGER,
  partners_attempted          INTEGER,
  partners_responded          INTEGER,

  -- demographics / financials
  state                       VARCHAR(2),
  zip                         VARCHAR(5),
  fico_tier                   VARCHAR,
  employment_status           VARCHAR,
  education_level             VARCHAR,
  rent_or_own                 VARCHAR,
  loan_purpose                VARCHAR,
  income_pmt_frequency        VARCHAR,
  annual_income               INTEGER,
  external_debt               INTEGER,
  loan_amount                 INTEGER,

  -- compliance
  tcpa_consent                BOOLEAN,
  fcra_consent                BOOLEAN,
  user_ip                     VARCHAR,
  user_agent                  VARCHAR,

  -- supabase-only meta (stripped at export)
  outcome_state               TEXT NOT NULL DEFAULT 'in_flight'
                                CHECK (outcome_state IN ('in_flight','finalized')),
  is_test                     BOOLEAN NOT NULL DEFAULT FALSE,
  exported_at                 TIMESTAMPTZ,                   -- null until pushed to Snowflake
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (id, execution_started_at_utc)
) PARTITION BY RANGE (execution_started_at_utc);

CREATE INDEX lead_sightings_export_idx
  ON lead_sightings (execution_started_at_utc)
  WHERE outcome_state = 'finalized' AND exported_at IS NULL;
CREATE INDEX lead_sightings_ssn_idx ON lead_sightings (ssn);
CREATE INDEX lead_sightings_person_idx ON lead_sightings (person_id);
CREATE INDEX lead_sightings_execution_idx ON lead_sightings (execution_id);
CREATE INDEX lead_sightings_prospect_idx ON lead_sightings (prospect_id) WHERE prospect_id IS NOT NULL;
CREATE INDEX lead_sightings_workflow_idx ON lead_sightings (workflow_id);

ALTER TABLE lead_sightings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sightings_org" ON lead_sightings
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM workflows w
      WHERE w.id = workflow_id
        AND w.organization_id = public.user_org_id()
    )
  );


-- ============================================================
-- lead_sighting_bids (partitioned monthly on attempted_at_utc)
-- ============================================================
CREATE TABLE lead_sighting_bids (
  id                          UUID NOT NULL DEFAULT gen_random_uuid(),
  sighting_id                 UUID NOT NULL,                 -- soft ref to lead_sightings
  ssn                         VARCHAR(11),
  trace_id                    VARCHAR NOT NULL,
  execution_id                UUID NOT NULL,

  partner_slug                VARCHAR NOT NULL,
  bid_position                INTEGER,                       -- 1=winner, 2=second, etc; null for skipped/failed
  is_winner                   BOOLEAN NOT NULL DEFAULT FALSE,

  attempted_at_utc            TIMESTAMP NOT NULL,
  attempted_at_et             TIMESTAMPTZ NOT NULL,
  responded_at_utc            TIMESTAMP,                     -- null when skipped or timed out
  responded_at_et             TIMESTAMPTZ,
  duration_ms                 INTEGER,
  http_status                 INTEGER,

  bid_cents                   INTEGER,
  classification              VARCHAR,                       -- 'accept' | 'decline' | 'no_bid' | 'transient' | 'permanent'
  decline_reason              VARCHAR,
  resolver_type               VARCHAR,                       -- 'formula' | 'matrix' | 'api'
  skip_reason                 VARCHAR,                       -- 'cap_hit' | 'circuit_open' | 'dedup' | 'inactive'

  is_test                     BOOLEAN NOT NULL DEFAULT FALSE,
  exported_at                 TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (id, attempted_at_utc)
) PARTITION BY RANGE (attempted_at_utc);

CREATE INDEX lead_sighting_bids_sighting_idx ON lead_sighting_bids (sighting_id);
CREATE INDEX lead_sighting_bids_partner_idx ON lead_sighting_bids (partner_slug);
CREATE INDEX lead_sighting_bids_execution_idx ON lead_sighting_bids (execution_id);
CREATE INDEX lead_sighting_bids_export_idx
  ON lead_sighting_bids (attempted_at_utc)
  WHERE exported_at IS NULL;

ALTER TABLE lead_sighting_bids ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sighting_bids_org" ON lead_sighting_bids
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM lead_sightings s
      JOIN workflows w ON w.id = s.workflow_id
      WHERE s.id = sighting_id
        AND w.organization_id = public.user_org_id()
    )
  );


-- ============================================================
-- Initial monthly partitions: current month + 5 months ahead
-- (matches workflow_executions/execution_steps pattern)
-- ============================================================
DO $$
DECLARE
  m DATE := date_trunc('month', now())::DATE;
  next_m DATE;
  partition_name TEXT;
BEGIN
  FOR i IN 0..5 LOOP
    next_m := (m + (i || ' months')::interval + interval '1 month')::DATE;
    partition_name := 'lead_sightings_' || to_char(m + (i || ' months')::interval, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF lead_sightings FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      (m + (i || ' months')::interval)::DATE,
      next_m
    );

    partition_name := 'lead_sighting_bids_' || to_char(m + (i || ' months')::interval, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF lead_sighting_bids FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      (m + (i || ' months')::interval)::DATE,
      next_m
    );
  END LOOP;
END $$;
