// GENERATED — do not edit by hand. Regenerate: pnpm --filter worker db:types
// Supabase types for the typed client (lib/supabase.ts). ESLint-excluded.
// Drift from the live schema is checked nightly (.github/workflows/db-types-drift.yml).

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  porting: {
    Tables: {
      pipedream_inventory: {
        Row: {
          absent_since_export_at: string | null
          definition_sha256: string | null
          deployment_count: number
          first_seen_export_at: string
          last_seen_export_at: string
          name: string
          organization_id: string
          pipedream_hashid: string
          pipedream_state: string
          porting_stage: string
          project_hashid: string
          step_count: number
          trigger_types: string[]
          updated_at: string
        }
        Insert: {
          absent_since_export_at?: string | null
          definition_sha256?: string | null
          deployment_count: number
          first_seen_export_at: string
          last_seen_export_at: string
          name: string
          organization_id: string
          pipedream_hashid: string
          pipedream_state: string
          porting_stage?: string
          project_hashid: string
          step_count: number
          trigger_types?: string[]
          updated_at?: string
        }
        Update: {
          absent_since_export_at?: string | null
          definition_sha256?: string | null
          deployment_count?: number
          first_seen_export_at?: string
          last_seen_export_at?: string
          name?: string
          organization_id?: string
          pipedream_hashid?: string
          pipedream_state?: string
          porting_stage?: string
          project_hashid?: string
          step_count?: number
          trigger_types?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      pipedream_workflow_map: {
        Row: {
          created_at: string
          id: string
          pipedream_hashid: string
          role: string
          trigger_index: number
          updated_at: string
          workflow_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          pipedream_hashid: string
          role: string
          trigger_index: number
          updated_at?: string
          workflow_id: string
        }
        Update: {
          created_at?: string
          id?: string
          pipedream_hashid?: string
          role?: string
          trigger_index?: number
          updated_at?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipedream_workflow_map_pipedream_hashid_fkey"
            columns: ["pipedream_hashid"]
            isOneToOne: false
            referencedRelation: "pipedream_inventory"
            referencedColumns: ["pipedream_hashid"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      achieve_evaluations: {
        Row: {
          achieve_request_id: string | null
          cf_ray: string | null
          created_at: string
          credit_metrics: Json | null
          duration_ms: number | null
          enrollment_view: Json | null
          execution_id: string
          exported_at: string | null
          http_status: number | null
          id: string
          is_sandbox: boolean
          is_test: boolean
          node_namespace: string
          offer_count: number
          offers: Json | null
          request_payload: Json | null
          requested_at_utc: string
          response_body: Json | null
          response_reason: string | null
          response_status: string | null
          submission_id: string | null
          trace_id: string
          trades: Json | null
          workflow_id: string
        }
        Insert: {
          achieve_request_id?: string | null
          cf_ray?: string | null
          created_at?: string
          credit_metrics?: Json | null
          duration_ms?: number | null
          enrollment_view?: Json | null
          execution_id: string
          exported_at?: string | null
          http_status?: number | null
          id?: string
          is_sandbox?: boolean
          is_test?: boolean
          node_namespace: string
          offer_count?: number
          offers?: Json | null
          request_payload?: Json | null
          requested_at_utc: string
          response_body?: Json | null
          response_reason?: string | null
          response_status?: string | null
          submission_id?: string | null
          trace_id: string
          trades?: Json | null
          workflow_id: string
        }
        Update: {
          achieve_request_id?: string | null
          cf_ray?: string | null
          created_at?: string
          credit_metrics?: Json | null
          duration_ms?: number | null
          enrollment_view?: Json | null
          execution_id?: string
          exported_at?: string | null
          http_status?: number | null
          id?: string
          is_sandbox?: boolean
          is_test?: boolean
          node_namespace?: string
          offer_count?: number
          offers?: Json | null
          request_payload?: Json | null
          requested_at_utc?: string
          response_body?: Json | null
          response_reason?: string | null
          response_status?: string | null
          submission_id?: string | null
          trace_id?: string
          trades?: Json | null
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "achieve_evaluations_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      alert_incidents: {
        Row: {
          closed_at: string | null
          created_at: string
          ended_at: string | null
          ended_reason: string | null
          failed_runs: number | null
          id: string
          last_seen_at: string
          marker_missing_at: string | null
          organization_id: string | null
          paged_event_ids: string[]
          pages_sent: number
          previous_starts: string[]
          scope: string
          signal: string
          started_at: string
          subject: string
          subject_label: string | null
          successor_signal: string | null
          updated_at: string
          window_minutes: number | null
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          ended_at?: string | null
          ended_reason?: string | null
          failed_runs?: number | null
          id?: string
          last_seen_at: string
          marker_missing_at?: string | null
          organization_id?: string | null
          paged_event_ids?: string[]
          pages_sent?: number
          previous_starts?: string[]
          scope: string
          signal: string
          started_at: string
          subject: string
          subject_label?: string | null
          successor_signal?: string | null
          updated_at?: string
          window_minutes?: number | null
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          ended_at?: string | null
          ended_reason?: string | null
          failed_runs?: number | null
          id?: string
          last_seen_at?: string
          marker_missing_at?: string | null
          organization_id?: string | null
          paged_event_ids?: string[]
          pages_sent?: number
          previous_starts?: string[]
          scope?: string
          signal?: string
          started_at?: string
          subject?: string
          subject_label?: string | null
          successor_signal?: string | null
          updated_at?: string
          window_minutes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "alert_incidents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      api_sources: {
        Row: {
          api_key: string
          created_at: string
          id: string
          name: string
          organization_id: string
        }
        Insert: {
          api_key: string
          created_at?: string
          id?: string
          name: string
          organization_id: string
        }
        Update: {
          api_key?: string
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_sources_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      app_config: {
        Row: {
          key: string
          note: string | null
          value: string
        }
        Insert: {
          key: string
          note?: string | null
          value: string
        }
        Update: {
          key?: string
          note?: string | null
          value?: string
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          key: string
          organization_id: string
          updated_at: string
          updated_by: string | null
          updated_by_email: string | null
          value_encrypted: string | null
        }
        Insert: {
          key: string
          organization_id: string
          updated_at?: string
          updated_by?: string | null
          updated_by_email?: string | null
          value_encrypted?: string | null
        }
        Update: {
          key?: string
          organization_id?: string
          updated_at?: string
          updated_by?: string | null
          updated_by_email?: string | null
          value_encrypted?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "app_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          changed_at: string
          changed_by: string | null
          changes: Json | null
          entity_id: string
          entity_type: string
          id: string
          organization_id: string
        }
        Insert: {
          action: string
          changed_at?: string
          changed_by?: string | null
          changes?: Json | null
          entity_id: string
          entity_type: string
          id?: string
          organization_id: string
        }
        Update: {
          action?: string
          changed_at?: string
          changed_by?: string | null
          changes?: Json | null
          entity_id?: string
          entity_type?: string
          id?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      bid_config_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          config_id: string
          diff: Json
          id: string
          source: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          config_id: string
          diff: Json
          id?: string
          source: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          config_id?: string
          diff?: Json
          id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "bid_config_history_config_id_fkey"
            columns: ["config_id"]
            isOneToOne: false
            referencedRelation: "partner_bid_configs"
            referencedColumns: ["id"]
          },
        ]
      }
      bid_matrix_rows: {
        Row: {
          bid_amount: number
          config_id: string
          id: string
          is_sell_off: boolean
          range_high: number | null
          range_low: number | null
          row_high: number | null
          row_id: string | null
          row_low: number | null
          source_id: string | null
          source_synced_at: string | null
          updated_at: string
        }
        Insert: {
          bid_amount: number
          config_id: string
          id?: string
          is_sell_off?: boolean
          range_high?: number | null
          range_low?: number | null
          row_high?: number | null
          row_id?: string | null
          row_low?: number | null
          source_id?: string | null
          source_synced_at?: string | null
          updated_at?: string
        }
        Update: {
          bid_amount?: number
          config_id?: string
          id?: string
          is_sell_off?: boolean
          range_high?: number | null
          range_low?: number | null
          row_high?: number | null
          row_id?: string | null
          row_low?: number | null
          source_id?: string | null
          source_synced_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bid_matrix_rows_config_id_fkey"
            columns: ["config_id"]
            isOneToOne: false
            referencedRelation: "partner_bid_configs"
            referencedColumns: ["id"]
          },
        ]
      }
      buyer_blackout_dates: {
        Row: {
          blackout_date: string
          id: string
          note: string | null
          organization_id: string
          partner_id: string
        }
        Insert: {
          blackout_date: string
          id?: string
          note?: string | null
          organization_id: string
          partner_id: string
        }
        Update: {
          blackout_date?: string
          id?: string
          note?: string | null
          organization_id?: string
          partner_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "buyer_blackout_dates_profile_fkey"
            columns: ["partner_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "buyer_profiles"
            referencedColumns: ["partner_id", "organization_id"]
          },
        ]
      }
      buyer_operating_windows: {
        Row: {
          closes_minute: number
          day_of_week: number
          id: string
          opens_minute: number
          organization_id: string
          partner_id: string
        }
        Insert: {
          closes_minute: number
          day_of_week: number
          id?: string
          opens_minute: number
          organization_id: string
          partner_id: string
        }
        Update: {
          closes_minute?: number
          day_of_week?: number
          id?: string
          opens_minute?: number
          organization_id?: string
          partner_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "buyer_operating_windows_profile_fkey"
            columns: ["partner_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "buyer_profiles"
            referencedColumns: ["partner_id", "organization_id"]
          },
        ]
      }
      buyer_pricing_tiers: {
        Row: {
          debt_from: number
          debt_to: number | null
          id: string
          multiplier: number
          organization_id: string
          partner_id: string
          population: string
        }
        Insert: {
          debt_from: number
          debt_to?: number | null
          id?: string
          multiplier: number
          organization_id: string
          partner_id: string
          population: string
        }
        Update: {
          debt_from?: number
          debt_to?: number | null
          id?: string
          multiplier?: number
          organization_id?: string
          partner_id?: string
          population?: string
        }
        Relationships: [
          {
            foreignKeyName: "buyer_pricing_tiers_profile_fkey"
            columns: ["partner_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "buyer_profiles"
            referencedColumns: ["partner_id", "organization_id"]
          },
        ]
      }
      buyer_profiles: {
        Row: {
          allowed_states: string[]
          click_delivery: Json | null
          created_at: string
          daily_lead_cap: number | null
          daily_spend_cap_cents: number | null
          debt_max: number | null
          debt_min: number | null
          display_time_zone: string | null
          hourly_lead_cap: number | null
          hourly_spend_cap_cents: number | null
          is_enabled: boolean
          last_save_id: string | null
          loan_amount_min: number | null
          organization_id: string
          partner_id: string
          priority: number | null
          sold_on: string
          updated_at: string
          updated_by: string | null
          updated_by_email: string | null
          updated_by_name: string | null
          version: number
        }
        Insert: {
          allowed_states?: string[]
          click_delivery?: Json | null
          created_at?: string
          daily_lead_cap?: number | null
          daily_spend_cap_cents?: number | null
          debt_max?: number | null
          debt_min?: number | null
          display_time_zone?: string | null
          hourly_lead_cap?: number | null
          hourly_spend_cap_cents?: number | null
          is_enabled?: boolean
          last_save_id?: string | null
          loan_amount_min?: number | null
          organization_id: string
          partner_id: string
          priority?: number | null
          sold_on?: string
          updated_at?: string
          updated_by?: string | null
          updated_by_email?: string | null
          updated_by_name?: string | null
          version?: number
        }
        Update: {
          allowed_states?: string[]
          click_delivery?: Json | null
          created_at?: string
          daily_lead_cap?: number | null
          daily_spend_cap_cents?: number | null
          debt_max?: number | null
          debt_min?: number | null
          display_time_zone?: string | null
          hourly_lead_cap?: number | null
          hourly_spend_cap_cents?: number | null
          is_enabled?: boolean
          last_save_id?: string | null
          loan_amount_min?: number | null
          organization_id?: string
          partner_id?: string
          priority?: number | null
          sold_on?: string
          updated_at?: string
          updated_by?: string | null
          updated_by_email?: string | null
          updated_by_name?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "buyer_profiles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "buyer_profiles_partner_org_fkey"
            columns: ["partner_id", "organization_id"]
            isOneToOne: true
            referencedRelation: "partner_configs"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "buyer_profiles_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      buyer_sales: {
        Row: {
          buyer_reference: string | null
          caps_in_force: Json | null
          created_at: string
          debt: number | null
          et_day: string
          execution_id: string | null
          hour_bucket: string
          http_status: number | null
          id: string
          kind: string
          lead_key: string
          live_percent_in_force: number | null
          multiplier: number | null
          organization_id: string
          partner_id: string
          payout_cents: number
          population: string
          reserved_at: string
          resolution_source: string | null
          resolved_at: string | null
          resolved_by: string | null
          result_code: string | null
          status: string
          trace_id: string | null
          updated_at: string
          workflow_id: string | null
        }
        Insert: {
          buyer_reference?: string | null
          caps_in_force?: Json | null
          created_at?: string
          debt?: number | null
          et_day: string
          execution_id?: string | null
          hour_bucket: string
          http_status?: number | null
          id: string
          kind: string
          lead_key: string
          live_percent_in_force?: number | null
          multiplier?: number | null
          organization_id: string
          partner_id: string
          payout_cents: number
          population: string
          reserved_at?: string
          resolution_source?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          result_code?: string | null
          status: string
          trace_id?: string | null
          updated_at?: string
          workflow_id?: string | null
        }
        Update: {
          buyer_reference?: string | null
          caps_in_force?: Json | null
          created_at?: string
          debt?: number | null
          et_day?: string
          execution_id?: string | null
          hour_bucket?: string
          http_status?: number | null
          id?: string
          kind?: string
          lead_key?: string
          live_percent_in_force?: number | null
          multiplier?: number | null
          organization_id?: string
          partner_id?: string
          payout_cents?: number
          population?: string
          reserved_at?: string
          resolution_source?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          result_code?: string | null
          status?: string
          trace_id?: string | null
          updated_at?: string
          workflow_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "buyer_sales_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "buyer_sales_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "partner_configs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "buyer_sales_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      buyer_select_parity_days: {
        Row: {
          classification_agree: number
          classification_disagree: number
          counts_hash: string | null
          decide_only_latency_p50_ms: number | null
          decide_only_latency_p95_ms: number | null
          disagreement_execution_ids: string[]
          et_day: string
          executions_unpaired: number
          hash_match: number
          hash_mismatch: number
          hash_unmeasured: number
          incumbent_unknown_count: number | null
          organization_id: string
          outcome_unknown_count: number
          refusal_counts: Json
          rehearsal_expired_in_flight: number
          rehearsal_in_doubt_heals: number
          sell_off_agree: number
          sell_off_disagree: number
          sign_off_cleared_at: string | null
          sign_off_counts_hash: string | null
          sign_off_note: string | null
          signed_off_at: string | null
          signed_off_by: string | null
          stage_b: Json | null
          state_resolved: number
          state_unresolved: number
          summarised_at: string
          unmeasured: string[]
          window_complete: boolean
          workflow_id: string
        }
        Insert: {
          classification_agree?: number
          classification_disagree?: number
          counts_hash?: string | null
          decide_only_latency_p50_ms?: number | null
          decide_only_latency_p95_ms?: number | null
          disagreement_execution_ids?: string[]
          et_day: string
          executions_unpaired?: number
          hash_match?: number
          hash_mismatch?: number
          hash_unmeasured?: number
          incumbent_unknown_count?: number | null
          organization_id: string
          outcome_unknown_count?: number
          refusal_counts?: Json
          rehearsal_expired_in_flight?: number
          rehearsal_in_doubt_heals?: number
          sell_off_agree?: number
          sell_off_disagree?: number
          sign_off_cleared_at?: string | null
          sign_off_counts_hash?: string | null
          sign_off_note?: string | null
          signed_off_at?: string | null
          signed_off_by?: string | null
          stage_b?: Json | null
          state_resolved?: number
          state_unresolved?: number
          summarised_at?: string
          unmeasured?: string[]
          window_complete?: boolean
          workflow_id: string
        }
        Update: {
          classification_agree?: number
          classification_disagree?: number
          counts_hash?: string | null
          decide_only_latency_p50_ms?: number | null
          decide_only_latency_p95_ms?: number | null
          disagreement_execution_ids?: string[]
          et_day?: string
          executions_unpaired?: number
          hash_match?: number
          hash_mismatch?: number
          hash_unmeasured?: number
          incumbent_unknown_count?: number | null
          organization_id?: string
          outcome_unknown_count?: number
          refusal_counts?: Json
          rehearsal_expired_in_flight?: number
          rehearsal_in_doubt_heals?: number
          sell_off_agree?: number
          sell_off_disagree?: number
          sign_off_cleared_at?: string | null
          sign_off_counts_hash?: string | null
          sign_off_note?: string | null
          signed_off_at?: string | null
          signed_off_by?: string | null
          stage_b?: Json | null
          state_resolved?: number
          state_unresolved?: number
          summarised_at?: string
          unmeasured?: string[]
          window_complete?: boolean
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "buyer_select_parity_days_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "buyer_select_parity_days_signed_off_by_fkey"
            columns: ["signed_off_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      cron_guard_fail_opens: {
        Row: {
          cron: string | null
          event_id: string
          line: string
          occurred_at: string
          recorded_at: string
        }
        Insert: {
          cron?: string | null
          event_id: string
          line: string
          occurred_at: string
          recorded_at?: string
        }
        Update: {
          cron?: string | null
          event_id?: string
          line?: string
          occurred_at?: string
          recorded_at?: string
        }
        Relationships: []
      }
      env_var_folders: {
        Row: {
          created_at: string
          id: string
          name: string
          organization_id: string
          parent_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          organization_id: string
          parent_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          parent_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "env_var_folders_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "env_var_folders_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "env_var_folders"
            referencedColumns: ["id"]
          },
        ]
      }
      environment_variables: {
        Row: {
          created_at: string
          created_by: string | null
          folder_id: string | null
          id: string
          is_secret: boolean
          key: string
          organization_id: string
          scope: string
          updated_at: string
          updated_by: string | null
          updated_by_email: string | null
          value: string | null
          workflow_id: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          folder_id?: string | null
          id?: string
          is_secret?: boolean
          key: string
          organization_id: string
          scope?: string
          updated_at?: string
          updated_by?: string | null
          updated_by_email?: string | null
          value?: string | null
          workflow_id?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          folder_id?: string | null
          id?: string
          is_secret?: boolean
          key?: string
          organization_id?: string
          scope?: string
          updated_at?: string
          updated_by?: string | null
          updated_by_email?: string | null
          value?: string | null
          workflow_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "environment_variables_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "environment_variables_folder_id_fkey"
            columns: ["folder_id"]
            isOneToOne: false
            referencedRelation: "env_var_folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "environment_variables_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "environment_variables_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "environment_variables_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      execution_archive_days: {
        Row: {
          archive_day: string
          erased_execution_count: number | null
          executions_truncated_at: string | null
          first_measured_at: string | null
          hours_execution_count: number | null
          hours_recorded: number | null
          incomplete_count: number | null
          measured_at: string | null
          orphan_execution_count: number | null
          orphan_sample_size: number | null
          orphan_step_count_seen: number | null
          pg_execution_count: number | null
          pg_step_count: number | null
          probe_failure_reason: string | null
          probe_ok: boolean | null
          probe_sampled: number | null
          sf_execution_count: number | null
          sf_step_count: number | null
        }
        Insert: {
          archive_day: string
          erased_execution_count?: number | null
          executions_truncated_at?: string | null
          first_measured_at?: string | null
          hours_execution_count?: number | null
          hours_recorded?: number | null
          incomplete_count?: number | null
          measured_at?: string | null
          orphan_execution_count?: number | null
          orphan_sample_size?: number | null
          orphan_step_count_seen?: number | null
          pg_execution_count?: number | null
          pg_step_count?: number | null
          probe_failure_reason?: string | null
          probe_ok?: boolean | null
          probe_sampled?: number | null
          sf_execution_count?: number | null
          sf_step_count?: number | null
        }
        Update: {
          archive_day?: string
          erased_execution_count?: number | null
          executions_truncated_at?: string | null
          first_measured_at?: string | null
          hours_execution_count?: number | null
          hours_recorded?: number | null
          incomplete_count?: number | null
          measured_at?: string | null
          orphan_execution_count?: number | null
          orphan_sample_size?: number | null
          orphan_step_count_seen?: number | null
          pg_execution_count?: number | null
          pg_step_count?: number | null
          probe_failure_reason?: string | null
          probe_ok?: boolean | null
          probe_sampled?: number | null
          sf_execution_count?: number | null
          sf_step_count?: number | null
        }
        Relationships: []
      }
      execution_archive_erasures: {
        Row: {
          archive_day: string
          erased_at: string
          execution_id: string
          reason: string
        }
        Insert: {
          archive_day: string
          erased_at?: string
          execution_id: string
          reason: string
        }
        Update: {
          archive_day?: string
          erased_at?: string
          execution_id?: string
          reason?: string
        }
        Relationships: []
      }
      execution_archive_hours: {
        Row: {
          archive_day: string
          execution_count: number
          hour_start: string
          recorded_at: string
          step_count: number
        }
        Insert: {
          archive_day: string
          execution_count: number
          hour_start: string
          recorded_at?: string
          step_count: number
        }
        Update: {
          archive_day?: string
          execution_count?: number
          hour_start?: string
          recorded_at?: string
          step_count?: number
        }
        Relationships: []
      }
      execution_archive_ids: {
        Row: {
          archive_day: string
          archived_at: string
          execution_id: string
        }
        Insert: {
          archive_day: string
          archived_at?: string
          execution_id: string
        }
        Update: {
          archive_day?: string
          archived_at?: string
          execution_id?: string
        }
        Relationships: []
      }
      execution_archive_progress: {
        Row: {
          stream: string
          updated_at: string
          watermark_hour: string
        }
        Insert: {
          stream: string
          updated_at?: string
          watermark_hour: string
        }
        Update: {
          stream?: string
          updated_at?: string
          watermark_hour?: string
        }
        Relationships: []
      }
      execution_archive_refusals: {
        Row: {
          archive_day: string
          execution_id: string
          reason: string
          refused_at: string
          resolved_at: string | null
        }
        Insert: {
          archive_day: string
          execution_id: string
          reason: string
          refused_at?: string
          resolved_at?: string | null
        }
        Update: {
          archive_day?: string
          execution_id?: string
          reason?: string
          refused_at?: string
          resolved_at?: string | null
        }
        Relationships: []
      }
      execution_steps: {
        Row: {
          completed_at: string | null
          duration_ms: number | null
          error_message: string | null
          error_type: string | null
          execution_id: string
          execution_started_at: string
          id: string
          input: Json | null
          is_test: boolean | null
          logs: Json | null
          output: Json | null
          parallel_group_id: string | null
          retries_used: number
          started_at: string
          status: string
          step_namespace: string
          step_node_id: string | null
          step_order: number | null
          step_subtype: string | null
          step_type: string
          workflow_id: string | null
        }
        Insert: {
          completed_at?: string | null
          duration_ms?: number | null
          error_message?: string | null
          error_type?: string | null
          execution_id: string
          execution_started_at: string
          id?: string
          input?: Json | null
          is_test?: boolean | null
          logs?: Json | null
          output?: Json | null
          parallel_group_id?: string | null
          retries_used?: number
          started_at?: string
          status?: string
          step_namespace: string
          step_node_id?: string | null
          step_order?: number | null
          step_subtype?: string | null
          step_type: string
          workflow_id?: string | null
        }
        Update: {
          completed_at?: string | null
          duration_ms?: number | null
          error_message?: string | null
          error_type?: string | null
          execution_id?: string
          execution_started_at?: string
          id?: string
          input?: Json | null
          is_test?: boolean | null
          logs?: Json | null
          output?: Json | null
          parallel_group_id?: string | null
          retries_used?: number
          started_at?: string
          status?: string
          step_namespace?: string
          step_node_id?: string | null
          step_order?: number | null
          step_subtype?: string | null
          step_type?: string
          workflow_id?: string | null
        }
        Relationships: []
      }
      field_presence_daily: {
        Row: {
          day: string
          field_path: string
          is_test: boolean
          key_measured_count: number
          key_present_count: number
          present_count: number
          ran_count: number
          workflow_id: string
        }
        Insert: {
          day: string
          field_path: string
          is_test: boolean
          key_measured_count?: number
          key_present_count?: number
          present_count?: number
          ran_count?: number
          workflow_id: string
        }
        Update: {
          day?: string
          field_path?: string
          is_test?: boolean
          key_measured_count?: number
          key_present_count?: number
          present_count?: number
          ran_count?: number
          workflow_id?: string
        }
        Relationships: []
      }
      field_presence_rollup_state: {
        Row: {
          id: boolean
          updated_at: string
          watermark: string
        }
        Insert: {
          id?: boolean
          updated_at?: string
          watermark: string
        }
        Update: {
          id?: boolean
          updated_at?: string
          watermark?: string
        }
        Relationships: []
      }
      field_presence_silences: {
        Row: {
          created_at: string
          created_by: string | null
          field_path: string
          id: string
          reason: string
          workflow_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          field_path: string
          id?: string
          reason: string
          workflow_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          field_path?: string
          id?: string
          reason?: string
          workflow_id?: string
        }
        Relationships: []
      }
      folders: {
        Row: {
          created_at: string
          id: string
          name: string
          organization_id: string
          parent_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          organization_id: string
          parent_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          parent_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "folders_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "folders_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "folders"
            referencedColumns: ["id"]
          },
        ]
      }
      held_click_claims: {
        Row: {
          detail: string
          execution_id: string
          held_at: string
          id: string
          last_execution_id: string
          last_seen_at: string
          organization_id: string
          partner_id: string
          partner_lead_id: string | null
          prospect_id: string
          reason: string
          trace_id: string | null
          workflow_id: string | null
        }
        Insert: {
          detail: string
          execution_id: string
          held_at?: string
          id?: string
          last_execution_id: string
          last_seen_at?: string
          organization_id: string
          partner_id: string
          partner_lead_id?: string | null
          prospect_id: string
          reason: string
          trace_id?: string | null
          workflow_id?: string | null
        }
        Update: {
          detail?: string
          execution_id?: string
          held_at?: string
          id?: string
          last_execution_id?: string
          last_seen_at?: string
          organization_id?: string
          partner_id?: string
          partner_lead_id?: string | null
          prospect_id?: string
          reason?: string
          trace_id?: string | null
          workflow_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "held_click_claims_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "held_click_claims_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "partner_configs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_runs: {
        Row: {
          detail: string | null
          finished_at: string | null
          id: string
          job: string
          outcome: string | null
          started_at: string
          summary: Json | null
        }
        Insert: {
          detail?: string | null
          finished_at?: string | null
          id?: string
          job: string
          outcome?: string | null
          started_at?: string
          summary?: Json | null
        }
        Update: {
          detail?: string | null
          finished_at?: string | null
          id?: string
          job?: string
          outcome?: string | null
          started_at?: string
          summary?: Json | null
        }
        Relationships: []
      }
      lead_sighting_bids: {
        Row: {
          attempted_at_et: string
          attempted_at_utc: string
          bid_cents: number | null
          bid_position: number | null
          classification: string | null
          created_at: string
          decline_reason: string | null
          duration_ms: number | null
          estimated_revenue_cents: number | null
          execution_id: string
          export_rejected_at: string | null
          export_rejected_reason: string | null
          exported_at: string | null
          http_status: number | null
          id: string
          is_test: boolean
          is_winner: boolean
          partner_slug: string
          resolver_type: string | null
          responded_at_et: string | null
          responded_at_utc: string | null
          sighting_id: string
          skip_reason: string | null
          ssn: string | null
          trace_id: string
        }
        Insert: {
          attempted_at_et: string
          attempted_at_utc: string
          bid_cents?: number | null
          bid_position?: number | null
          classification?: string | null
          created_at?: string
          decline_reason?: string | null
          duration_ms?: number | null
          estimated_revenue_cents?: number | null
          execution_id: string
          export_rejected_at?: string | null
          export_rejected_reason?: string | null
          exported_at?: string | null
          http_status?: number | null
          id?: string
          is_test?: boolean
          is_winner?: boolean
          partner_slug: string
          resolver_type?: string | null
          responded_at_et?: string | null
          responded_at_utc?: string | null
          sighting_id: string
          skip_reason?: string | null
          ssn?: string | null
          trace_id: string
        }
        Update: {
          attempted_at_et?: string
          attempted_at_utc?: string
          bid_cents?: number | null
          bid_position?: number | null
          classification?: string | null
          created_at?: string
          decline_reason?: string | null
          duration_ms?: number | null
          estimated_revenue_cents?: number | null
          execution_id?: string
          export_rejected_at?: string | null
          export_rejected_reason?: string | null
          exported_at?: string | null
          http_status?: number | null
          id?: string
          is_test?: boolean
          is_winner?: boolean
          partner_slug?: string
          resolver_type?: string | null
          responded_at_et?: string | null
          responded_at_utc?: string | null
          sighting_id?: string
          skip_reason?: string | null
          ssn?: string | null
          trace_id?: string
        }
        Relationships: []
      }
      lead_sightings: {
        Row: {
          annual_income: number | null
          created_at: string
          duration_ms: number | null
          education_level: string | null
          employment_status: string | null
          equifax_error_type: string | null
          equifax_score: number | null
          equifax_status: string | null
          execution_ended_at_utc: string | null
          execution_finished_at_et: string | null
          execution_id: string
          execution_started_at_et: string
          execution_started_at_utc: string
          export_rejected_at: string | null
          export_rejected_reason: string | null
          exported_at: string | null
          external_debt: number | null
          external_exchange_status: string | null
          external_partner_name: string | null
          external_routing_code: string | null
          fcra_consent: boolean | null
          fico_tier: string | null
          id: string
          income_pmt_frequency: string | null
          is_test: boolean
          lead_uuid: string | null
          loan_amount: number | null
          loan_purpose: string | null
          offer_landing_page: string | null
          outcome: string | null
          outcome_state: string
          partners_attempted: number | null
          partners_responded: number | null
          person_id: string | null
          prospect_id: string | null
          quoted_rate_cents: number | null
          recovered_by: string | null
          reject_reason: string | null
          rent_or_own: string | null
          response_status_code: number | null
          source_name: string | null
          ssn: string | null
          state: string | null
          subaccount_uuid: string | null
          tcpa_consent: boolean | null
          terminal_node_id: string | null
          terminal_node_label: string | null
          trace_id: string
          updated_at: string
          user_agent: string | null
          user_ip: string | null
          winning_bid_cents: number | null
          winning_partner_slug: string | null
          workflow_id: string
          workflow_version_id: string | null
          workflow_version_sha: string | null
          zip: string | null
        }
        Insert: {
          annual_income?: number | null
          created_at?: string
          duration_ms?: number | null
          education_level?: string | null
          employment_status?: string | null
          equifax_error_type?: string | null
          equifax_score?: number | null
          equifax_status?: string | null
          execution_ended_at_utc?: string | null
          execution_finished_at_et?: string | null
          execution_id: string
          execution_started_at_et: string
          execution_started_at_utc: string
          export_rejected_at?: string | null
          export_rejected_reason?: string | null
          exported_at?: string | null
          external_debt?: number | null
          external_exchange_status?: string | null
          external_partner_name?: string | null
          external_routing_code?: string | null
          fcra_consent?: boolean | null
          fico_tier?: string | null
          id?: string
          income_pmt_frequency?: string | null
          is_test?: boolean
          lead_uuid?: string | null
          loan_amount?: number | null
          loan_purpose?: string | null
          offer_landing_page?: string | null
          outcome?: string | null
          outcome_state?: string
          partners_attempted?: number | null
          partners_responded?: number | null
          person_id?: string | null
          prospect_id?: string | null
          quoted_rate_cents?: number | null
          recovered_by?: string | null
          reject_reason?: string | null
          rent_or_own?: string | null
          response_status_code?: number | null
          source_name?: string | null
          ssn?: string | null
          state?: string | null
          subaccount_uuid?: string | null
          tcpa_consent?: boolean | null
          terminal_node_id?: string | null
          terminal_node_label?: string | null
          trace_id: string
          updated_at?: string
          user_agent?: string | null
          user_ip?: string | null
          winning_bid_cents?: number | null
          winning_partner_slug?: string | null
          workflow_id: string
          workflow_version_id?: string | null
          workflow_version_sha?: string | null
          zip?: string | null
        }
        Update: {
          annual_income?: number | null
          created_at?: string
          duration_ms?: number | null
          education_level?: string | null
          employment_status?: string | null
          equifax_error_type?: string | null
          equifax_score?: number | null
          equifax_status?: string | null
          execution_ended_at_utc?: string | null
          execution_finished_at_et?: string | null
          execution_id?: string
          execution_started_at_et?: string
          execution_started_at_utc?: string
          export_rejected_at?: string | null
          export_rejected_reason?: string | null
          exported_at?: string | null
          external_debt?: number | null
          external_exchange_status?: string | null
          external_partner_name?: string | null
          external_routing_code?: string | null
          fcra_consent?: boolean | null
          fico_tier?: string | null
          id?: string
          income_pmt_frequency?: string | null
          is_test?: boolean
          lead_uuid?: string | null
          loan_amount?: number | null
          loan_purpose?: string | null
          offer_landing_page?: string | null
          outcome?: string | null
          outcome_state?: string
          partners_attempted?: number | null
          partners_responded?: number | null
          person_id?: string | null
          prospect_id?: string | null
          quoted_rate_cents?: number | null
          recovered_by?: string | null
          reject_reason?: string | null
          rent_or_own?: string | null
          response_status_code?: number | null
          source_name?: string | null
          ssn?: string | null
          state?: string | null
          subaccount_uuid?: string | null
          tcpa_consent?: boolean | null
          terminal_node_id?: string | null
          terminal_node_label?: string | null
          trace_id?: string
          updated_at?: string
          user_agent?: string | null
          user_ip?: string | null
          winning_bid_cents?: number | null
          winning_partner_slug?: string | null
          workflow_id?: string
          workflow_version_id?: string | null
          workflow_version_sha?: string | null
          zip?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_sightings_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          name: string
          slug: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          slug: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          slug?: string
        }
        Relationships: []
      }
      outcome_writeback_deadletters: {
        Row: {
          attempts: number
          body_encrypted: string
          created_at: string
          error_encrypted: string
          error_type: string | null
          execution_id: string
          finished_at: string | null
          id: string
          last_error_encrypted: string | null
          organization_id: string
          replayable: boolean
          sf_object: string
          sf_operation: string
          sf_record_id: string
          status: string
          step_namespace: string
          updated_at: string
          workflow_id: string
        }
        Insert: {
          attempts?: number
          body_encrypted: string
          created_at?: string
          error_encrypted: string
          error_type?: string | null
          execution_id: string
          finished_at?: string | null
          id?: string
          last_error_encrypted?: string | null
          organization_id: string
          replayable: boolean
          sf_object: string
          sf_operation: string
          sf_record_id: string
          status?: string
          step_namespace: string
          updated_at?: string
          workflow_id: string
        }
        Update: {
          attempts?: number
          body_encrypted?: string
          created_at?: string
          error_encrypted?: string
          error_type?: string | null
          execution_id?: string
          finished_at?: string | null
          id?: string
          last_error_encrypted?: string | null
          organization_id?: string
          replayable?: boolean
          sf_object?: string
          sf_operation?: string
          sf_record_id?: string
          status?: string
          step_namespace?: string
          updated_at?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "outcome_writeback_deadletters_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      partner_bid_configs: {
        Row: {
          created_at: string
          dimensions: Json
          id: string
          is_active: boolean
          is_default: boolean
          last_sync_error: string | null
          last_synced_at: string | null
          name: string
          organization_id: string
          partner_id: string
          sf_filters: Json | null
          sf_object: string | null
          slug: string
          sync_source: string
          updated_at: string
          updated_by: string | null
          updated_by_email: string | null
          updated_by_name: string | null
        }
        Insert: {
          created_at?: string
          dimensions?: Json
          id?: string
          is_active?: boolean
          is_default?: boolean
          last_sync_error?: string | null
          last_synced_at?: string | null
          name: string
          organization_id: string
          partner_id: string
          sf_filters?: Json | null
          sf_object?: string | null
          slug: string
          sync_source?: string
          updated_at?: string
          updated_by?: string | null
          updated_by_email?: string | null
          updated_by_name?: string | null
        }
        Update: {
          created_at?: string
          dimensions?: Json
          id?: string
          is_active?: boolean
          is_default?: boolean
          last_sync_error?: string | null
          last_synced_at?: string | null
          name?: string
          organization_id?: string
          partner_id?: string
          sf_filters?: Json | null
          sf_object?: string | null
          slug?: string
          sync_source?: string
          updated_at?: string
          updated_by?: string | null
          updated_by_email?: string | null
          updated_by_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "partner_bid_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "partner_bid_configs_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "partner_configs"
            referencedColumns: ["id"]
          },
        ]
      }
      partner_configs: {
        Row: {
          accept_signals: Json
          alert_config: Json | null
          api_endpoint: string | null
          bid_comparison_source: string
          bid_formula: string | null
          bid_mode: string
          bid_resolver_config: Json
          bid_resolver_type: string
          cf_secret_key: string | null
          circuit_cooldown_seconds: number
          circuit_enabled: boolean
          circuit_error_threshold: number
          circuit_window_seconds: number
          click_url: string | null
          confirmation_window_ms: number | null
          created_at: string
          daily_cap: number | null
          dedup_endpoint: string | null
          duplicate_signals: Json
          external_routing_code: number | null
          extra_extraction: Json | null
          id: string
          is_active: boolean
          last_probe_response: Json | null
          last_save_id: string | null
          min_bid: number | null
          name: string
          organization_id: string
          outbound_field_mapping: Json | null
          partner_type: string
          priority: number
          response_classification: Json | null
          sell_off_offer_details: string | null
          sell_off_offer_title: string | null
          slug: string
          sub_account_min_bids: Json | null
          updated_at: string
          updated_by: string | null
          updated_by_email: string | null
          updated_by_name: string | null
          version: number
        }
        Insert: {
          accept_signals?: Json
          alert_config?: Json | null
          api_endpoint?: string | null
          bid_comparison_source?: string
          bid_formula?: string | null
          bid_mode?: string
          bid_resolver_config?: Json
          bid_resolver_type?: string
          cf_secret_key?: string | null
          circuit_cooldown_seconds?: number
          circuit_enabled?: boolean
          circuit_error_threshold?: number
          circuit_window_seconds?: number
          click_url?: string | null
          confirmation_window_ms?: number | null
          created_at?: string
          daily_cap?: number | null
          dedup_endpoint?: string | null
          duplicate_signals?: Json
          external_routing_code?: number | null
          extra_extraction?: Json | null
          id?: string
          is_active?: boolean
          last_probe_response?: Json | null
          last_save_id?: string | null
          min_bid?: number | null
          name: string
          organization_id: string
          outbound_field_mapping?: Json | null
          partner_type?: string
          priority?: number
          response_classification?: Json | null
          sell_off_offer_details?: string | null
          sell_off_offer_title?: string | null
          slug: string
          sub_account_min_bids?: Json | null
          updated_at?: string
          updated_by?: string | null
          updated_by_email?: string | null
          updated_by_name?: string | null
          version?: number
        }
        Update: {
          accept_signals?: Json
          alert_config?: Json | null
          api_endpoint?: string | null
          bid_comparison_source?: string
          bid_formula?: string | null
          bid_mode?: string
          bid_resolver_config?: Json
          bid_resolver_type?: string
          cf_secret_key?: string | null
          circuit_cooldown_seconds?: number
          circuit_enabled?: boolean
          circuit_error_threshold?: number
          circuit_window_seconds?: number
          click_url?: string | null
          confirmation_window_ms?: number | null
          created_at?: string
          daily_cap?: number | null
          dedup_endpoint?: string | null
          duplicate_signals?: Json
          external_routing_code?: number | null
          extra_extraction?: Json | null
          id?: string
          is_active?: boolean
          last_probe_response?: Json | null
          last_save_id?: string | null
          min_bid?: number | null
          name?: string
          organization_id?: string
          outbound_field_mapping?: Json | null
          partner_type?: string
          priority?: number
          response_classification?: Json | null
          sell_off_offer_details?: string | null
          sell_off_offer_title?: string | null
          slug?: string
          sub_account_min_bids?: Json | null
          updated_at?: string
          updated_by?: string | null
          updated_by_email?: string | null
          updated_by_name?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "partner_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "partner_configs_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      partner_daily_counts: {
        Row: {
          count: number
          date: string
          id: string
          partner_id: string
          updated_at: string
        }
        Insert: {
          count?: number
          date: string
          id?: string
          partner_id: string
          updated_at?: string
        }
        Update: {
          count?: number
          date?: string
          id?: string
          partner_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "partner_daily_counts_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "partner_configs"
            referencedColumns: ["id"]
          },
        ]
      }
      partner_uuid_map: {
        Row: {
          created_at: string
          id: string
          org_id: string
          partner_slug: string
          uuid: string
        }
        Insert: {
          created_at?: string
          id?: string
          org_id: string
          partner_slug: string
          uuid: string
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string
          partner_slug?: string
          uuid?: string
        }
        Relationships: [
          {
            foreignKeyName: "partner_uuid_map_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      persons: {
        Row: {
          apt_enc: string | null
          city: string | null
          created_at: string
          dob_enc: string | null
          email_enc: string | null
          first_name_enc: string | null
          first_seen_at: string
          id: string
          last_name_enc: string | null
          last_seen_at: string
          middle_name_enc: string | null
          organization_id: string
          phone_enc: string | null
          ssn_encrypted: string
          ssn_hash: string
          state: string | null
          street_enc: string | null
          updated_at: string
          zip_enc: string | null
        }
        Insert: {
          apt_enc?: string | null
          city?: string | null
          created_at?: string
          dob_enc?: string | null
          email_enc?: string | null
          first_name_enc?: string | null
          first_seen_at?: string
          id?: string
          last_name_enc?: string | null
          last_seen_at?: string
          middle_name_enc?: string | null
          organization_id: string
          phone_enc?: string | null
          ssn_encrypted: string
          ssn_hash: string
          state?: string | null
          street_enc?: string | null
          updated_at?: string
          zip_enc?: string | null
        }
        Update: {
          apt_enc?: string | null
          city?: string | null
          created_at?: string
          dob_enc?: string | null
          email_enc?: string | null
          first_name_enc?: string | null
          first_seen_at?: string
          id?: string
          last_name_enc?: string | null
          last_seen_at?: string
          middle_name_enc?: string | null
          organization_id?: string
          phone_enc?: string | null
          ssn_encrypted?: string
          ssn_hash?: string
          state?: string | null
          street_enc?: string | null
          updated_at?: string
          zip_enc?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "persons_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      purge_run_log: {
        Row: {
          archive_day: string | null
          id: number
          job: string
          outcome: string
          parent: string | null
          partition_name: string | null
          reason: string | null
          recorded_at: string
          run_id: string
        }
        Insert: {
          archive_day?: string | null
          id?: never
          job: string
          outcome: string
          parent?: string | null
          partition_name?: string | null
          reason?: string | null
          recorded_at?: string
          run_id: string
        }
        Update: {
          archive_day?: string | null
          id?: never
          job?: string
          outcome?: string
          parent?: string | null
          partition_name?: string | null
          reason?: string | null
          recorded_at?: string
          run_id?: string
        }
        Relationships: []
      }
      service_connections: {
        Row: {
          auth_type: string
          cf_secret_key: string
          config: Json | null
          created_at: string
          id: string
          organization_id: string
          schema_cache: Json | null
          schema_synced_at: string | null
          service_type: string
          updated_at: string
          updated_by: string | null
          updated_by_email: string | null
          user_id: string | null
        }
        Insert: {
          auth_type: string
          cf_secret_key: string
          config?: Json | null
          created_at?: string
          id?: string
          organization_id: string
          schema_cache?: Json | null
          schema_synced_at?: string | null
          service_type: string
          updated_at?: string
          updated_by?: string | null
          updated_by_email?: string | null
          user_id?: string | null
        }
        Update: {
          auth_type?: string
          cf_secret_key?: string
          config?: Json | null
          created_at?: string
          id?: string
          organization_id?: string
          schema_cache?: Json | null
          schema_synced_at?: string | null
          service_type?: string
          updated_at?: string
          updated_by?: string | null
          updated_by_email?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "service_connections_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_connections_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_connections_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      service_presets: {
        Row: {
          auth_type: string
          base_url: string | null
          created_at: string
          id: string
          name: string
          organization_id: string
          slug: string
        }
        Insert: {
          auth_type?: string
          base_url?: string | null
          created_at?: string
          id?: string
          name: string
          organization_id: string
          slug: string
        }
        Update: {
          auth_type?: string
          base_url?: string | null
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          slug?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_presets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      sf_bid_matrix_audit: {
        Row: {
          bid_amount: number
          is_sell_off: boolean
          partner_flags: Json
          range_high: number | null
          range_low: number | null
          row_high: number | null
          row_id: string | null
          row_low: number | null
          source_id: string
          source_synced_at: string
          updated_at: string
        }
        Insert: {
          bid_amount: number
          is_sell_off?: boolean
          partner_flags?: Json
          range_high?: number | null
          range_low?: number | null
          row_high?: number | null
          row_id?: string | null
          row_low?: number | null
          source_id: string
          source_synced_at?: string
          updated_at?: string
        }
        Update: {
          bid_amount?: number
          is_sell_off?: boolean
          partner_flags?: Json
          range_high?: number | null
          range_low?: number | null
          row_high?: number | null
          row_id?: string | null
          row_low?: number | null
          source_id?: string
          source_synced_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      source_workflow_assignments: {
        Row: {
          created_at: string
          organization_id: string
          source_name: string
          workflow_id: string
        }
        Insert: {
          created_at?: string
          organization_id: string
          source_name: string
          workflow_id: string
        }
        Update: {
          created_at?: string
          organization_id?: string
          source_name?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "source_workflow_assignments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_workflow_assignments_organization_id_source_name_fkey"
            columns: ["organization_id", "source_name"]
            isOneToOne: false
            referencedRelation: "api_sources"
            referencedColumns: ["organization_id", "name"]
          },
          {
            foreignKeyName: "source_workflow_assignments_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      user_allowlist: {
        Row: {
          added_at: string
          added_by: string
          email: string
        }
        Insert: {
          added_at?: string
          added_by?: string
          email: string
        }
        Update: {
          added_at?: string
          added_by?: string
          email?: string
        }
        Relationships: []
      }
      users: {
        Row: {
          created_at: string
          display_name: string | null
          email: string
          id: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email: string
          id: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "users_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_endpoints: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          organization_id: string
          path: string
          source_name: string
          subdomain: string
          updated_at: string
          workflow_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          organization_id: string
          path?: string
          source_name: string
          subdomain: string
          updated_at?: string
          workflow_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          organization_id?: string
          path?: string
          source_name?: string
          subdomain?: string
          updated_at?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_endpoints_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "webhook_endpoints_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_executions: {
        Row: {
          completed_at: string | null
          cost_usd: number | null
          cpu_ms: number | null
          duration_ms: number | null
          email_dropped: boolean | null
          error_message: string | null
          failed_step_type: string | null
          field_presence: Json | null
          field_presence_version: number | null
          final_node_id: string | null
          final_node_namespace: string | null
          id: string
          is_test: boolean
          outcome: string | null
          parent_execution_id: string | null
          response_body: Json | null
          response_status: number | null
          resumed_from_execution_id: string | null
          sighting_finalize: Json | null
          slack_alert_fired_at: string | null
          slack_alert_reason: Json | null
          slack_alert_type: string | null
          source: string | null
          started_at: string
          status: string
          trace_id: string | null
          trigger_payload: Json | null
          trigger_type: string
          workflow_id: string
          workflow_version_id: string | null
        }
        Insert: {
          completed_at?: string | null
          cost_usd?: number | null
          cpu_ms?: number | null
          duration_ms?: number | null
          email_dropped?: boolean | null
          error_message?: string | null
          failed_step_type?: string | null
          field_presence?: Json | null
          field_presence_version?: number | null
          final_node_id?: string | null
          final_node_namespace?: string | null
          id?: string
          is_test?: boolean
          outcome?: string | null
          parent_execution_id?: string | null
          response_body?: Json | null
          response_status?: number | null
          resumed_from_execution_id?: string | null
          sighting_finalize?: Json | null
          slack_alert_fired_at?: string | null
          slack_alert_reason?: Json | null
          slack_alert_type?: string | null
          source?: string | null
          started_at?: string
          status?: string
          trace_id?: string | null
          trigger_payload?: Json | null
          trigger_type?: string
          workflow_id: string
          workflow_version_id?: string | null
        }
        Update: {
          completed_at?: string | null
          cost_usd?: number | null
          cpu_ms?: number | null
          duration_ms?: number | null
          email_dropped?: boolean | null
          error_message?: string | null
          failed_step_type?: string | null
          field_presence?: Json | null
          field_presence_version?: number | null
          final_node_id?: string | null
          final_node_namespace?: string | null
          id?: string
          is_test?: boolean
          outcome?: string | null
          parent_execution_id?: string | null
          response_body?: Json | null
          response_status?: number | null
          resumed_from_execution_id?: string | null
          sighting_finalize?: Json | null
          slack_alert_fired_at?: string | null
          slack_alert_reason?: Json | null
          slack_alert_type?: string | null
          source?: string | null
          started_at?: string
          status?: string
          trace_id?: string | null
          trigger_payload?: Json | null
          trigger_type?: string
          workflow_id?: string
          workflow_version_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "workflow_executions_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_executions_workflow_version_id_fkey"
            columns: ["workflow_version_id"]
            isOneToOne: false
            referencedRelation: "workflow_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      workflow_stats_daily: {
        Row: {
          cost_usd_sum: number
          day: string
          duration_ms_count: number
          duration_ms_sum: number
          is_test: boolean
          outcome: string
          run_count: number
          status: string
          workflow_id: string
        }
        Insert: {
          cost_usd_sum?: number
          day: string
          duration_ms_count?: number
          duration_ms_sum?: number
          is_test: boolean
          outcome?: string
          run_count?: number
          status: string
          workflow_id: string
        }
        Update: {
          cost_usd_sum?: number
          day?: string
          duration_ms_count?: number
          duration_ms_sum?: number
          is_test?: boolean
          outcome?: string
          run_count?: number
          status?: string
          workflow_id?: string
        }
        Relationships: []
      }
      workflow_versions: {
        Row: {
          commit_sha: string | null
          created_at: string
          created_by: string | null
          definition: Json
          id: string
          message: string | null
          version_number: number
          workflow_id: string
        }
        Insert: {
          commit_sha?: string | null
          created_at?: string
          created_by?: string | null
          definition: Json
          id?: string
          message?: string | null
          version_number: number
          workflow_id: string
        }
        Update: {
          commit_sha?: string | null
          created_at?: string
          created_by?: string | null
          definition?: Json
          id?: string
          message?: string | null
          version_number?: number
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workflow_versions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflow_versions_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      workflows: {
        Row: {
          capture_sightings: boolean
          created_at: string
          created_by: string | null
          definition: Json
          deleted_at: string | null
          description: string | null
          folder_id: string | null
          id: string
          is_active: boolean
          lane: string
          name: string
          organization_id: string
          slack_channel: string | null
          test_payloads: Json
          updated_at: string
          updated_by: string | null
          updated_by_email: string | null
          updated_by_name: string | null
        }
        Insert: {
          capture_sightings?: boolean
          created_at?: string
          created_by?: string | null
          definition?: Json
          deleted_at?: string | null
          description?: string | null
          folder_id?: string | null
          id?: string
          is_active?: boolean
          lane?: string
          name: string
          organization_id: string
          slack_channel?: string | null
          test_payloads?: Json
          updated_at?: string
          updated_by?: string | null
          updated_by_email?: string | null
          updated_by_name?: string | null
        }
        Update: {
          capture_sightings?: boolean
          created_at?: string
          created_by?: string | null
          definition?: Json
          deleted_at?: string | null
          description?: string | null
          folder_id?: string | null
          id?: string
          is_active?: boolean
          lane?: string
          name?: string
          organization_id?: string
          slack_channel?: string | null
          test_payloads?: Json
          updated_at?: string
          updated_by?: string | null
          updated_by_email?: string | null
          updated_by_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "workflows_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflows_folder_id_fkey"
            columns: ["folder_id"]
            isOneToOne: false
            referencedRelation: "folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflows_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workflows_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _apply_buyer_profile: {
        Args: {
          p_actor: string
          p_actor_email: string
          p_audit_extra: Json
          p_org: string
          p_partner: string
          p_profile: Json
        }
        Returns: Json
      }
      alert_incident_moved_from: {
        Args: { p_signal: string; p_started_at: string; p_subject: string }
        Returns: string
      }
      archive_day_measurements: {
        Args: { p_day: string }
        Returns: {
          erased_execution_count: number
          hours_execution_count: number
          hours_recorded: number
          orphan_execution_count: number
          orphan_sample_size: number
          orphan_step_count_seen: number
          pg_execution_count: number
          pg_step_count: number
        }[]
      }
      archive_day_probe_sample: {
        Args: { p_day: string; p_sample_size: number }
        Returns: {
          execution_id: string
          step_count: number
          trace_id: string
        }[]
      }
      archive_index_health: {
        Args: { p_index?: string; p_parent?: string }
        Returns: {
          attached: number
          index_name: string
          index_present: boolean
          index_valid: boolean
          partitions: number
        }[]
      }
      auth_user_with_allowlist: {
        Args: { p_user_id: string }
        Returns: {
          allowed: boolean
          display_name: string
          email: string
          id: string
          organization_id: string
        }[]
      }
      bid_recording_coverage_v2: {
        Args: { p_org_id: string; p_since: string }
        Returns: {
          attempt_rows: number
          bid_rows: number
          is_active: boolean
          sightings: number
          winners: number
          workflow_id: string
          workflow_name: string
        }[]
      }
      bid_recording_coverage_v3: {
        Args: { p_org_id: string; p_since: string; p_until: string }
        Returns: {
          attempt_rows: number
          bid_rows: number
          is_active: boolean
          sightings: number
          winners: number
          workflow_id: string
          workflow_name: string
        }[]
      }
      buyer_profile_document: { Args: { p_partner: string }; Returns: Json }
      buyer_profile_flatten: {
        Args: { p_doc: Json }
        Returns: {
          path: string
          value: Json
        }[]
      }
      buyer_sale_status_rank: { Args: { p_status: string }; Returns: number }
      click_delivery_problem: { Args: { p_delivery: Json }; Returns: string }
      create_monthly_analytics_partitions: { Args: never; Returns: undefined }
      create_next_month_partitions: { Args: never; Returns: undefined }
      create_upcoming_daily_partitions: {
        Args: { p_days_ahead?: number }
        Returns: number
      }
      delete_partner_config: {
        Args: {
          p_actor: string
          p_actor_email: string
          p_id: string
          p_org: string
        }
        Returns: undefined
      }
      drain_lead_sightings_purge: { Args: never; Returns: undefined }
      drop_exported_sighting_partitions: {
        Args: { p_grace?: string }
        Returns: {
          outcome: string
          parent: string
          partition_name: string
          reason: string
        }[]
      }
      email_drop_counts_by_source: {
        Args: { p_org_id: string; p_since: string }
        Returns: {
          dropped: number
          source_name: string
          total: number
        }[]
      }
      execution_counts_per_minute: {
        Args: { p_since: string; p_workflow_ids: string[] }
        Returns: {
          cnt: number
          minute: string
          workflow_id: string
        }[]
      }
      execution_purge_retention: {
        Args: never
        Returns: {
          active: boolean
          command: string
          jobname: string
          retention_days: number
        }[]
      }
      expired_day_verdicts: {
        Args: {
          p_max_measurement_age?: string
          p_now?: string
          p_retention_days: number
        }
        Returns: {
          archive_day: string
          refusal: string
        }[]
      }
      field_presence_window: {
        Args: { p_since: string; p_workflow_ids: string[] }
        Returns: {
          field_path: string
          present_count: number
          ran_count: number
          workflow_id: string
        }[]
      }
      finalize_unrecoverable_stranded: {
        Args: { p_min_age_hours?: number }
        Returns: number
      }
      is_allowlisted: { Args: never; Returns: boolean }
      partner_configs_unversioned_columns: { Args: never; Returns: string[] }
      pg_cron_health: {
        Args: { window_hours?: number }
        Returns: {
          active: boolean
          failures_in_window: number
          jobid: number
          jobname: string
          last_failure_at: string
          last_failure_message: string
          last_success_at: string
          schedule: string
        }[]
      }
      prune_orphan_auth_users: { Args: never; Returns: number }
      purge_alert_incidents: { Args: never; Returns: number }
      purge_cron_guard_fail_opens: { Args: never; Returns: number }
      purge_outcome_writeback_deadletters: { Args: never; Returns: number }
      query_timeout_watch: {
        Args: { p_min_calls?: number }
        Returns: {
          calls: number
          max_ms: number
          mean_ms: number
          query_sample: string
          queryid: string
          role: string
          timeout_ms: number
        }[]
      }
      record_alert_incident_ended: {
        Args: {
          p_ended_at: string
          p_organization_id: string
          p_reason: string
          p_scope: string
          p_signal: string
          p_started_at: string
          p_subject: string
          p_subject_label: string
          p_successor: string
          p_window_minutes: number
        }
        Returns: string
      }
      record_alert_incident_marker_check: {
        Args: { p_id: string; p_marker_present: boolean; p_now: string }
        Returns: string
      }
      record_alert_incident_opened: {
        Args: {
          p_organization_id: string
          p_previous_started_at: string
          p_scope: string
          p_signal: string
          p_started_at: string
          p_subject: string
          p_subject_label: string
          p_window_minutes: number
        }
        Returns: string
      }
      record_alert_incident_paged: {
        Args: {
          p_event_id: string
          p_organization_id: string
          p_paged_at: string
          p_scope: string
          p_signal: string
          p_started_at: string
          p_subject: string
          p_subject_label: string
          p_window_minutes: number
        }
        Returns: string
      }
      record_archive_day_measurement: {
        Args: {
          p_day: string
          p_erased_execution_count: number
          p_hours_execution_count: number
          p_hours_recorded: number
          p_incomplete_count: number
          p_orphan_execution_count: number
          p_orphan_sample_size: number
          p_orphan_step_count_seen: number
          p_pg_execution_count: number
          p_pg_step_count: number
          p_probe_failure_reason: string
          p_probe_ok: boolean
          p_probe_sampled: number
          p_sf_execution_count: number
          p_sf_step_count: number
        }
        Returns: undefined
      }
      record_buyer_sale: { Args: { p_row: Json }; Returns: Json }
      record_held_click: {
        Args: {
          p_detail: string
          p_execution: string
          p_org: string
          p_partner: string
          p_partner_lead_id: string
          p_prospect: string
          p_reason: string
          p_trace: string
          p_workflow: string
        }
        Returns: Json
      }
      reduce_finalize_stranded: {
        Args: { p_lookback_days?: number }
        Returns: number
      }
      refresh_field_presence_daily: {
        Args: { p_lookback_days?: number }
        Returns: undefined
      }
      refresh_field_presence_incremental: { Args: never; Returns: undefined }
      refresh_workflow_stats_daily: {
        Args: { p_lookback_days?: number }
        Returns: undefined
      }
      rename_partner_step_namespace: {
        Args: {
          p_actor: string
          p_actor_email: string
          p_columns: Json
          p_context: Json
          p_org: string
          p_partner: string
        }
        Returns: number
      }
      save_buyer_profile: {
        Args: {
          p_actor: string
          p_actor_email: string
          p_expected_version: number
          p_org: string
          p_partner: string
          p_profile: Json
        }
        Returns: Json
      }
      save_partner_config: {
        Args: {
          p_actor: string
          p_actor_email: string
          p_actor_name: string
          p_expected_version: number
          p_id: string
          p_org: string
          p_patch: Json
          p_save_id: string
        }
        Returns: Json
      }
      save_partner_page: {
        Args: {
          p_actor: string
          p_actor_email: string
          p_actor_name: string
          p_expected_partner_version: number
          p_expected_profile_version: number
          p_org: string
          p_partner_id: string
          p_patch: Json
          p_profile: Json
          p_save_id: string
        }
        Returns: Json
      }
      sightings_buffer_lag: {
        Args: {
          p_cap?: number
          p_exported_before: string
          p_table: string
          p_waiting_before: string
        }
        Returns: {
          oldest_exported_at: string
          oldest_waiting: string
          overdue_rows: number
          waiting_rows: number
        }[]
      }
      sign_off_buyer_select_parity_day: {
        Args: {
          p_actor: string
          p_counts_hash: string
          p_day: string
          p_note: string
          p_org: string
          p_workflow: string
        }
        Returns: Json
      }
      step_duration_percentiles: {
        Args: { p_namespace: string; p_since: string; p_workflow_id: string }
        Returns: {
          max_ms: number
          p50: number
          p95: number
          p99: number
          sample_size: number
        }[]
      }
      step_duration_percentiles_by_workflow: {
        Args: { p_namespaces: string[]; p_since: string; p_workflow_id: string }
        Returns: {
          max_ms: number
          p50: number
          p99: number
          sample_size: number
          step_namespace: string
        }[]
      }
      step_duration_percentiles_typed: {
        Args: {
          p_org_id: string
          p_since: string
          p_step_subtype: string
          p_step_type: string
        }
        Returns: {
          max_ms: number
          p50: number
          p95: number
          p99: number
          sample_size: number
        }[]
      }
      stranded_step_partitions: {
        Args: {
          p_max_measurement_age?: string
          p_now?: string
          p_retention_days: number
        }
        Returns: {
          archive_day: string
          blocked_by: string
          blocked_by_refusal: string
          partition_name: string
        }[]
      }
      unpaginated_big_tables: {
        Args: { p_min_rows?: number }
        Returns: {
          est_rows: number
          table_name: string
        }[]
      }
      upsert_buyer_select_parity_day: { Args: { p_row: Json }; Returns: Json }
      user_org_id: { Args: never; Returns: string }
      verified_day_refusal:
        | {
            Args: {
              p_erased_execution_count: number
              p_hours_execution_count: number
              p_hours_recorded: number
              p_incomplete_count: number
              p_max_measurement_age: string
              p_measured_at: string
              p_now: string
              p_orphan_execution_count: number
              p_pg_execution_count: number
              p_pg_step_count: number
              p_probe_ok: boolean
              p_probe_sampled: number
              p_sf_execution_count: number
              p_sf_step_count: number
            }
            Returns: string
          }
        | {
            Args: {
              p_erased_execution_count: number
              p_hours_execution_count: number
              p_hours_recorded: number
              p_incomplete_count: number
              p_max_measurement_age: string
              p_measured_at: string
              p_now: string
              p_orphan_execution_count: number
              p_partition_empty?: boolean
              p_pg_execution_count: number
              p_pg_step_count: number
              p_probe_ok: boolean
              p_probe_sampled: number
              p_sf_execution_count: number
              p_sf_step_count: number
            }
            Returns: string
          }
      verified_purgeable_days: {
        Args: {
          p_max_measurement_age?: string
          p_now?: string
          p_parent: string
          p_retention_days: number
        }
        Returns: string[]
      }
      workflow_stats_rollup: {
        Args: { p_org_id: string; p_since: string }
        Returns: {
          cost_usd_sum: number
          day: string
          duration_ms_count: number
          duration_ms_sum: number
          is_test: boolean
          outcome: string
          run_count: number
          status: string
          workflow_id: string
          workflow_name: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  porting: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
