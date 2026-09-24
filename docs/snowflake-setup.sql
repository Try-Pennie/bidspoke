-- ============================================================================
-- Snowflake Setup — Bidspoke Lead Sightings Mirror
-- ============================================================================
-- Run this once in a Snowsight worksheet under ACCOUNTADMIN before the
-- nightly export job fires. Creates the destination tables + outcome view.
--
-- Service user, role, and grants are set up separately (see CLAUDE.md or
-- ask the engineer who created bidspoke_service / bidspoke_role).
-- ============================================================================

-- NOTE: this file is a record, not the authority. Columns have been added to the
-- live tables without reaching it: quoted_rate_cents (#1158) was live and
-- exporting while this file did not name it, found on 2026-09-04. Check the live
-- table before trusting the list below, and add the column here in the same
-- change that adds it to the export list in apps/worker/src/lib/sightings-export.ts.

USE DATABASE BIDSPOKE;
USE SCHEMA PUBLIC;
USE ROLE bidspoke_role;
USE WAREHOUSE COMPUTE_WH;


-- ============================================================================
-- lead_sightings — one row per lead (the trigger event + outcome)
-- ============================================================================
CREATE TABLE IF NOT EXISTS lead_sightings (
  id                          VARCHAR PRIMARY KEY,
  ssn                         VARCHAR(11),
  person_id                   VARCHAR,
  trace_id                    VARCHAR NOT NULL,
  execution_id                VARCHAR NOT NULL,
  workflow_id                 VARCHAR NOT NULL,
  workflow_version_id         VARCHAR(36),
  workflow_version_sha        VARCHAR(40),

  execution_started_at_et     TIMESTAMP_TZ NOT NULL,
  execution_finished_at_et    TIMESTAMP_TZ NOT NULL,
  execution_started_at_utc    TIMESTAMP_NTZ NOT NULL,
  execution_ended_at_utc      TIMESTAMP_NTZ NOT NULL,
  duration_ms                 NUMBER,

  source_name                 VARCHAR,
  subaccount_uuid             VARCHAR,
  lead_uuid                   VARCHAR,
  external_partner_name       VARCHAR,
  external_routing_code       VARCHAR,
  external_exchange_status    VARCHAR,
  offer_landing_page          VARCHAR,

  terminal_node_id            VARCHAR,
  terminal_node_label         VARCHAR,
  response_status_code        NUMBER,
  reject_reason               VARCHAR,

  prospect_id                 VARCHAR(18),
  equifax_status              VARCHAR,                       -- what the pull FOUND (#1381): completed (scored file) | unscored | no_hit | frozen | fraud | referred | error | skipped; 'completed' before 2026-09-24 was the call status and covered all of these
  equifax_error_type          VARCHAR,
  equifax_score               NUMBER,
  outcome                     VARCHAR,                 -- 'successful' | 'completed' | 'failed'

  winning_partner_slug        VARCHAR,
  winning_bid_cents           NUMBER,                  -- what the BUYER offered us
  quoted_rate_cents           NUMBER,                  -- what we quoted the SOURCE (#1158)
  partners_attempted          NUMBER,
  partners_responded          NUMBER,

  state                       VARCHAR(2),
  zip                         VARCHAR(5),
  fico_tier                   VARCHAR,
  employment_status           VARCHAR,
  education_level             VARCHAR,
  rent_or_own                 VARCHAR,
  loan_purpose                VARCHAR,
  income_pmt_frequency        VARCHAR,
  annual_income               NUMBER,
  external_debt               NUMBER,
  loan_amount                 NUMBER,

  tcpa_consent                BOOLEAN,
  fcra_consent                BOOLEAN,
  user_ip                     VARCHAR,
  user_agent                  VARCHAR,

  exported_at                 TIMESTAMP_NTZ
)
CLUSTER BY (execution_started_at_utc, source_name);


-- ============================================================================
-- lead_sighting_bids — one row per partner attempt within a lead
-- ============================================================================
CREATE TABLE IF NOT EXISTS lead_sighting_bids (
  id                          VARCHAR PRIMARY KEY,
  sighting_id                 VARCHAR NOT NULL,
  ssn                         VARCHAR(11),
  trace_id                    VARCHAR NOT NULL,
  execution_id                VARCHAR NOT NULL,

  partner_slug                VARCHAR NOT NULL,
  bid_position                NUMBER,
  is_winner                   BOOLEAN DEFAULT FALSE,

  attempted_at_utc            TIMESTAMP_NTZ NOT NULL,
  attempted_at_et             TIMESTAMP_TZ NOT NULL,
  responded_at_utc            TIMESTAMP_NTZ,
  responded_at_et             TIMESTAMP_TZ,
  duration_ms                 NUMBER,
  http_status                 NUMBER,

  bid_cents                   NUMBER,                  -- what the BUYER offered us
  estimated_revenue_cents     NUMBER,                  -- OUR estimate, from Salesforce (#354)
  classification              VARCHAR,
  decline_reason              VARCHAR,
  resolver_type               VARCHAR,
  skip_reason                 VARCHAR,

  exported_at                 TIMESTAMP_NTZ
)
CLUSTER BY (attempted_at_utc, partner_slug);


-- ============================================================================
-- lead_sightings_v — outcome view (raw facts → derived enum)
-- ============================================================================
CREATE OR REPLACE VIEW lead_sightings_v AS
SELECT *,
  CASE
    WHEN winning_partner_slug IS NOT NULL                THEN 'bid'
    WHEN response_status_code IS NOT NULL
         AND response_status_code >= 500                 THEN 'error'
    ELSE 'no_bid'
  END AS outcome
FROM lead_sightings;
