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
  public: {
    Tables: {
      achieve_evaluations: {
        Row: {
          created_at: string
          duration_ms: number | null
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
          created_at?: string
          duration_ms?: number | null
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
          created_at?: string
          duration_ms?: number | null
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
          present_count: number
          ran_count: number
          workflow_id: string
        }
        Insert: {
          day: string
          field_path: string
          is_test: boolean
          present_count?: number
          ran_count?: number
          workflow_id: string
        }
        Update: {
          day?: string
          field_path?: string
          is_test?: boolean
          present_count?: number
          ran_count?: number
          workflow_id?: string
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
          execution_id: string
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
          execution_id: string
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
          execution_id?: string
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
          extra_extraction: Json | null
          id: string
          is_active: boolean
          last_probe_response: Json | null
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
        }
        Insert: {
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
          extra_extraction?: Json | null
          id?: string
          is_active?: boolean
          last_probe_response?: Json | null
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
        }
        Update: {
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
          extra_extraction?: Json | null
          id?: string
          is_active?: boolean
          last_probe_response?: Json | null
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
      create_monthly_analytics_partitions: { Args: never; Returns: undefined }
      create_next_month_partitions: { Args: never; Returns: undefined }
      bid_recording_coverage: {
        Args: { p_org_id: string; p_since: string }
        Returns: {
          bid_rows: number
          is_active: boolean
          sightings: number
          winners: number
          workflow_id: string
          workflow_name: string
        }[]
      }
      create_upcoming_daily_partitions: {
        Args: { p_days_ahead?: number }
        Returns: number
      }
      drain_lead_sightings_purge: { Args: never; Returns: undefined }
      drop_expired_execution_partitions: {
        Args: { p_retention_days?: number }
        Returns: number
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
      reduce_finalize_stranded: {
        Args: { p_lookback_days?: number }
        Returns: number
      }
      refresh_field_presence_daily: {
        Args: { p_lookback_days?: number }
        Returns: undefined
      }
      refresh_workflow_stats_daily: {
        Args: { p_lookback_days?: number }
        Returns: undefined
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
      unpaginated_big_tables: {
        Args: { p_min_rows?: number }
        Returns: {
          est_rows: number
          table_name: string
        }[]
      }
      user_org_id: { Args: never; Returns: string }
      verified_day_refusal: {
        Args: {
          p_erased_execution_count: number
          p_incomplete_count: number
          p_max_measurement_age: string
          p_measured_at: string
          p_now: string
          p_orphan_execution_count: number
          p_pg_execution_count: number
          p_pg_step_count: number
          p_probe_ok: boolean
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
  public: {
    Enums: {},
  },
} as const
