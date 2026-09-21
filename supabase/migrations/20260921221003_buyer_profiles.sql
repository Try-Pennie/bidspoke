-- Buyer profiles: the eligibility conditions a buyer has for a lead, on the
-- partner record as typed rows (#1409, milestone 52, Discussion #1406).
--
-- Today the only per partner eligibility gates are is_active, daily_cap, the
-- circuit breaker and two bid floors; states, hours, blackout days, hourly and
-- spend caps and debt bounds are hand coded per workflow in Constants and Code
-- nodes (measured 2026-09-20). Liberty One's buy box (Slack, 2026-09-20) needs
-- all of them at once, plus a debt maximum and a loan amount minimum.
--
-- Four tables. The parent buyer_profiles hangs one to one off partner_configs
-- through a composite key, so a profile can never belong to a different
-- organization than its partner. The children hold the repeating rows: weekly
-- operating windows, blackout dates, and pricing tiers per lead population.
--
-- Fail closed defaults (L72): no profile row means not a direct buyer;
-- is_enabled defaults false; allowed_states is NOT NULL and an empty list
-- accepts nothing; no windows means never open; a population with no tiers
-- means not sold from that population. Numeric bounds and caps are nullable
-- because absence there legitimately means no limit.
--
-- The database refuses what the form must never be trusted alone to refuse:
-- overlapping tiers and windows (gist exclusion), a hourly cap above a daily
-- one, a minimum above a maximum, a state outside the 51 codes, a multiplier
-- outside (0, 1], an enabled profile with no priority, and a tier for a
-- population the buyer_select node is not yet wired to (L46: pricing nothing
-- reads cannot be stored). Widening the wired list is a migration that names
-- this constraint, which is the deliberate cost.
--
-- Access (L18): RLS on with no policy for authenticated, and every privilege
-- revoked from anon and authenticated, because the only reader and writer is
-- the Worker as service_role through save_buyer_profile. Production's default
-- ACLs otherwise grant both roles full privileges on any new table (measured
-- 2026-09-21), which with the FOR ALL pattern would let any signed in member
-- write a profile past the validator.
--
-- Expand only: new tables and a unique key nothing yet references. Code and
-- schema deploy in either order.

CREATE TABLE public.buyer_profiles (
  partner_id              uuid PRIMARY KEY,
  organization_id         uuid NOT NULL REFERENCES public.organizations(id),
  is_enabled              boolean NOT NULL DEFAULT false,
  priority                integer,
  allowed_states          text[] NOT NULL DEFAULT '{}',
  debt_min                numeric,
  debt_max                numeric,
  loan_amount_min         numeric,
  hourly_lead_cap         integer,
  daily_lead_cap          integer,
  hourly_spend_cap_cents  bigint,
  daily_spend_cap_cents   bigint,
  version                 integer NOT NULL DEFAULT 1,
  updated_by              uuid REFERENCES public.users(id),
  updated_by_email        text,
  updated_by_name         text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT buyer_profiles_partner_org_fkey
    FOREIGN KEY (partner_id, organization_id)
    REFERENCES public.partner_configs(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT buyer_profiles_partner_org_key UNIQUE (partner_id, organization_id),
  CONSTRAINT buyer_profiles_priority_positive CHECK (priority IS NULL OR priority >= 1),
  CONSTRAINT buyer_profiles_enabled_has_priority CHECK (NOT is_enabled OR priority IS NOT NULL),
  CONSTRAINT buyer_profiles_caps_positive CHECK (
    coalesce(hourly_lead_cap, 1) > 0 AND coalesce(daily_lead_cap, 1) > 0
    AND coalesce(hourly_spend_cap_cents, 1) > 0 AND coalesce(daily_spend_cap_cents, 1) > 0
  ),
  CONSTRAINT buyer_profiles_hourly_not_above_daily CHECK (
    (hourly_lead_cap IS NULL OR daily_lead_cap IS NULL OR hourly_lead_cap <= daily_lead_cap)
    AND (hourly_spend_cap_cents IS NULL OR daily_spend_cap_cents IS NULL OR hourly_spend_cap_cents <= daily_spend_cap_cents)
  ),
  CONSTRAINT buyer_profiles_bounds_positive CHECK (
    coalesce(debt_min, 1) > 0 AND coalesce(debt_max, 1) > 0 AND coalesce(loan_amount_min, 1) > 0
  ),
  CONSTRAINT buyer_profiles_debt_min_not_above_max CHECK (debt_min IS NULL OR debt_max IS NULL OR debt_min <= debt_max),
  CONSTRAINT buyer_profiles_states_known CHECK (
    allowed_states <@ ARRAY[
      'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
      'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI',
      'SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
    ]::text[]
  )
);

COMMENT ON TABLE public.buyer_profiles IS
  'Eligibility conditions and rank for a partner that buys leads through buyer_select (#1409). One row per partner; no row means not a direct buyer. Written only by save_buyer_profile.';
COMMENT ON COLUMN public.buyer_profiles.priority IS '1 is offered the lead first. A lower number outranks a higher one. Null means never chosen, which cannot be enabled.';
COMMENT ON COLUMN public.buyer_profiles.allowed_states IS 'Two letter codes. Empty accepts nothing.';
COMMENT ON COLUMN public.buyer_profiles.version IS 'Bumped by every save that changes something; a save carrying a stale version is refused with the current document.';

CREATE INDEX buyer_profiles_org_idx ON public.buyer_profiles (organization_id);
CREATE TRIGGER buyer_profiles_updated_at BEFORE UPDATE ON public.buyer_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.buyer_operating_windows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id       uuid NOT NULL,
  organization_id  uuid NOT NULL,
  day_of_week      smallint NOT NULL,
  opens_minute     smallint NOT NULL,
  closes_minute    smallint NOT NULL,
  CONSTRAINT buyer_operating_windows_profile_fkey
    FOREIGN KEY (partner_id, organization_id)
    REFERENCES public.buyer_profiles(partner_id, organization_id) ON DELETE CASCADE,
  CONSTRAINT buyer_operating_windows_day_range CHECK (day_of_week BETWEEN 0 AND 6),
  CONSTRAINT buyer_operating_windows_minutes CHECK (opens_minute >= 0 AND closes_minute <= 1440 AND opens_minute < closes_minute),
  CONSTRAINT buyer_operating_windows_no_overlap
    EXCLUDE USING gist (partner_id WITH =, day_of_week WITH =, int4range(opens_minute::int, closes_minute::int) WITH &&)
);
COMMENT ON TABLE public.buyer_operating_windows IS
  'When a buyer takes leads, in Eastern minutes of the day (#1409). day_of_week 0 is Sunday. An overnight window is two rows. No rows means never open.';
CREATE INDEX buyer_operating_windows_partner_idx ON public.buyer_operating_windows (partner_id);

CREATE TABLE public.buyer_blackout_dates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id       uuid NOT NULL,
  organization_id  uuid NOT NULL,
  blackout_date    date NOT NULL,
  note             text,
  CONSTRAINT buyer_blackout_dates_profile_fkey
    FOREIGN KEY (partner_id, organization_id)
    REFERENCES public.buyer_profiles(partner_id, organization_id) ON DELETE CASCADE,
  CONSTRAINT buyer_blackout_dates_partner_date_key UNIQUE (partner_id, blackout_date)
);
COMMENT ON TABLE public.buyer_blackout_dates IS 'Eastern dates on which a buyer takes no leads (#1409).';

CREATE TABLE public.buyer_pricing_tiers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id       uuid NOT NULL,
  organization_id  uuid NOT NULL,
  population       text NOT NULL,
  debt_from        numeric NOT NULL,
  debt_to          numeric,
  multiplier       numeric(8,6) NOT NULL,
  CONSTRAINT buyer_pricing_tiers_profile_fkey
    FOREIGN KEY (partner_id, organization_id)
    REFERENCES public.buyer_profiles(partner_id, organization_id) ON DELETE CASCADE,
  -- The wired population list. A population joins it in the migration that puts
  -- a buyer_select node on that workflow (L46). Mirrors WIRED_POPULATIONS in
  -- packages/buyer-profile, and a guard asserts the two agree.
  CONSTRAINT buyer_pricing_tiers_population_wired CHECK (population IN ('engine')),
  CONSTRAINT buyer_pricing_tiers_bounds CHECK (debt_from >= 0 AND (debt_to IS NULL OR debt_to > debt_from)),
  CONSTRAINT buyer_pricing_tiers_multiplier_range CHECK (multiplier > 0 AND multiplier <= 1),
  CONSTRAINT buyer_pricing_tiers_no_overlap
    EXCLUDE USING gist (partner_id WITH =, population WITH =, numrange(debt_from, debt_to, '[)') WITH &&)
);
COMMENT ON TABLE public.buyer_pricing_tiers IS
  'Price a buyer pays per lead population as a multiplier on debt over a half open range [debt_from, debt_to) in dollars (#1409). Inclusive lower bound: 15,000 and up starts at exactly 15,000.';
CREATE INDEX buyer_pricing_tiers_partner_idx ON public.buyer_pricing_tiers (partner_id, population);

-- Access: Worker only.
ALTER TABLE public.buyer_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buyer_operating_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buyer_blackout_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buyer_pricing_tiers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buyer_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.buyer_operating_windows FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.buyer_blackout_dates FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.buyer_pricing_tiers FROM PUBLIC, anon, authenticated;
