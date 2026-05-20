export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      credit_transactions: {
        Row: {
          amount: number;
          created_at: string;
          description: string | null;
          from_user: string | null;
          id: string;
          session_id: string | null;
          to_user: string | null;
        };
        Insert: {
          amount: number;
          created_at?: string;
          description?: string | null;
          from_user?: string | null;
          id?: string;
          session_id?: string | null;
          to_user?: string | null;
        };
        Update: {
          amount?: number;
          created_at?: string;
          description?: string | null;
          from_user?: string | null;
          id?: string;
          session_id?: string | null;
          to_user?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "credit_transactions_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      messages: {
        Row: {
          created_at: string;
          edited_at: string | null;
          id: string;
          sender_id: string | null;
          session_id: string;
          text: string;
        };
        Insert: {
          created_at?: never;
          edited_at?: never;
          id?: never;
          sender_id: string;
          session_id: string;
          text: string;
        };
        Update: {
          created_at?: never;
          edited_at?: never;
          id?: never;
          sender_id?: never;
          session_id?: never;
          text?: string;
        };
        Relationships: [
          {
            foreignKeyName: "messages_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      notifications: {
        Row: {
          body: string | null;
          created_at: string;
          id: string;
          link: string | null;
          metadata: Json;
          read_at: string | null;
          title: string;
          type: string;
          user_id: string;
        };
        Insert: {
          body?: never;
          created_at?: never;
          id?: never;
          link?: never;
          metadata?: never;
          read_at?: never;
          title?: never;
          type?: never;
          user_id?: never;
        };
        Update: {
          body?: never;
          created_at?: never;
          id?: never;
          link?: never;
          metadata?: never;
          read_at?: string | null;
          title?: never;
          type?: never;
          user_id?: never;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          bio: string | null;
          created_at: string;
          credits: number;
          full_name: string | null;
          id: string;
          is_admin: boolean;
          learning_mode: Database["public"]["Enums"]["learning_mode"] | null;
          onboarded: boolean;
          suspended_at: string | null;
          suspended_by: string | null;
          suspended_reason: string | null;
          updated_at: string;
        };
        Insert: {
          avatar_url?: string | null;
          bio?: string | null;
          created_at?: never;
          credits?: never;
          full_name?: string | null;
          id: string;
          is_admin?: never;
          learning_mode?: Database["public"]["Enums"]["learning_mode"] | null;
          onboarded?: boolean;
          updated_at?: never;
        };
        Update: {
          avatar_url?: string | null;
          bio?: string | null;
          created_at?: never;
          credits?: never;
          full_name?: string | null;
          id?: never;
          is_admin?: never;
          learning_mode?: Database["public"]["Enums"]["learning_mode"] | null;
          onboarded?: boolean;
          updated_at?: never;
        };
        Relationships: [];
      };
      reviews: {
        Row: {
          comment: string | null;
          created_at: string;
          edited_at: string | null;
          id: string;
          rating: number;
          reviewee_id: string | null;
          reviewer_id: string | null;
          session_id: string;
        };
        Insert: {
          comment?: string | null;
          created_at?: never;
          edited_at?: never;
          id?: never;
          rating: number;
          reviewee_id: string;
          reviewer_id: string;
          session_id: string;
        };
        Update: {
          comment?: string | null;
          created_at?: never;
          edited_at?: never;
          id?: never;
          rating?: number;
          reviewee_id?: never;
          reviewer_id?: never;
          session_id?: never;
        };
        Relationships: [
          {
            foreignKeyName: "reviews_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      reports: {
        Row: {
          created_at: string;
          details: string | null;
          id: string;
          message_id: string | null;
          reason: string;
          reported_user_id: string | null;
          reporter_id: string | null;
          review_id: string | null;
          session_id: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          created_at?: never;
          details?: string | null;
          id?: never;
          message_id?: string | null;
          reason: string;
          reported_user_id?: string | null;
          reporter_id?: never;
          review_id?: string | null;
          session_id?: string | null;
          status?: never;
          updated_at?: never;
        };
        Update: {
          created_at?: never;
          details?: never;
          id?: never;
          message_id?: never;
          reason?: never;
          reported_user_id?: never;
          reporter_id?: never;
          review_id?: never;
          session_id?: never;
          status?: string;
          updated_at?: never;
        };
        Relationships: [
          {
            foreignKeyName: "reports_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reports_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reports_review_id_fkey";
            columns: ["review_id"];
            isOneToOne: false;
            referencedRelation: "reviews";
            referencedColumns: ["id"];
          },
        ];
      };
      learning_tracks: {
        Row: {
          id: string;
          learner_id: string;
          teacher_id: string;
          skill_id: string;
          goal: string;
          pattern: string;
          planned_count: number;
          default_duration_minutes: number;
          cadence_days: number;
          first_start_at: string;
          status: string;
          end_reason: string | null;
          ended_by: string | null;
          ended_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: never;
          learner_id: string;
          teacher_id: string;
          skill_id: string;
          goal: string;
          pattern: string;
          planned_count: number;
          default_duration_minutes: number;
          cadence_days: number;
          first_start_at: string;
          status?: never;
          end_reason?: never;
          ended_by?: never;
          ended_at?: never;
          created_at?: never;
        };
        Update: {
          id?: never;
          learner_id?: never;
          teacher_id?: never;
          skill_id?: never;
          goal?: never;
          pattern?: never;
          planned_count?: never;
          default_duration_minutes?: never;
          cadence_days?: never;
          first_start_at?: never;
          status?: string;
          end_reason?: string | null;
          ended_by?: string | null;
          ended_at?: string | null;
          created_at?: never;
        };
        Relationships: [];
      };
      track_planned_sessions: {
        Row: {
          id: string;
          track_id: string;
          sequence_no: number;
          planned_start_at: string;
          materialized_session_id: string | null;
          status: string;
          skip_reason: string | null;
          created_at: string;
        };
        Insert: {
          id?: never;
          track_id: string;
          sequence_no: number;
          planned_start_at: string;
          materialized_session_id?: string | null;
          status?: never;
          skip_reason?: string | null;
          created_at?: never;
        };
        Update: {
          id?: never;
          track_id?: never;
          sequence_no?: never;
          planned_start_at?: never;
          materialized_session_id?: string | null;
          status?: string;
          skip_reason?: string | null;
          created_at?: never;
        };
        Relationships: [
          {
            foreignKeyName: "track_planned_sessions_track_id_fkey";
            columns: ["track_id"];
            isOneToOne: false;
            referencedRelation: "learning_tracks";
            referencedColumns: ["id"];
          },
        ];
      };
      reschedule_proposals: {
        Row: {
          id: string;
          session_id: string;
          proposer_id: string;
          old_scheduled_at: string | null;
          new_scheduled_at: string;
          status: string;
          responder_id: string | null;
          responded_at: string | null;
          note: string | null;
          created_at: string;
        };
        Insert: {
          id?: never;
          session_id: string;
          proposer_id: string;
          old_scheduled_at?: string | null;
          new_scheduled_at: string;
          status?: never;
          responder_id?: never;
          responded_at?: never;
          note?: string | null;
          created_at?: never;
        };
        Update: {
          id?: never;
          session_id?: never;
          proposer_id?: never;
          old_scheduled_at?: never;
          new_scheduled_at?: never;
          status?: string;
          responder_id?: string | null;
          responded_at?: string | null;
          note?: never;
          created_at?: never;
        };
        Relationships: [
          {
            foreignKeyName: "reschedule_proposals_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      sessions: {
        Row: {
          created_at: string;
          credits: number;
          duration_minutes: number;
          escrow_held: boolean;
          id: string;
          initiator_id: string | null;
          learner_id: string | null;
          meet_link: string | null;
          scheduled_at: string | null;
          skill_id: string;
          status: Database["public"]["Enums"]["session_status"];
          teacher_id: string | null;
          updated_at: string;
        };
        Insert: {
          created_at?: never;
          credits?: number;
          duration_minutes?: number;
          escrow_held?: false;
          id?: never;
          initiator_id?: string | null;
          learner_id?: string | null;
          meet_link?: string | null;
          scheduled_at?: string | null;
          skill_id: string;
          status?: "pending";
          teacher_id?: string | null;
          updated_at?: never;
        };
        Update: {
          created_at?: never;
          credits?: never;
          duration_minutes?: never;
          escrow_held?: never;
          id?: never;
          initiator_id?: never;
          learner_id?: never;
          meet_link?: string | null;
          scheduled_at?: string | null;
          skill_id?: never;
          status?: never;
          teacher_id?: never;
          updated_at?: never;
        };
        Relationships: [
          {
            foreignKeyName: "sessions_skill_id_fkey";
            columns: ["skill_id"];
            isOneToOne: false;
            referencedRelation: "skills";
            referencedColumns: ["id"];
          },
        ];
      };
      skills: {
        Row: {
          category: string | null;
          created_at: string;
          id: string;
          name: string;
        };
        Insert: {
          category?: string | null;
          created_at?: string;
          id?: string;
          name: string;
        };
        Update: {
          category?: string | null;
          created_at?: string;
          id?: string;
          name?: string;
        };
        Relationships: [];
      };
      user_learning_skills: {
        Row: {
          created_at: string;
          current_level: Database["public"]["Enums"]["skill_level"];
          id: string;
          learning_mode: Database["public"]["Enums"]["learning_mode"];
          skill_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          current_level?: Database["public"]["Enums"]["skill_level"];
          id?: string;
          learning_mode?: Database["public"]["Enums"]["learning_mode"];
          skill_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          current_level?: Database["public"]["Enums"]["skill_level"];
          id?: string;
          learning_mode?: Database["public"]["Enums"]["learning_mode"];
          skill_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_learning_skills_skill_id_fkey";
            columns: ["skill_id"];
            isOneToOne: false;
            referencedRelation: "skills";
            referencedColumns: ["id"];
          },
        ];
      };
      user_teaching_skills: {
        Row: {
          created_at: string;
          credits_per_hour: number;
          id: string;
          level: Database["public"]["Enums"]["skill_level"];
          skill_id: string;
          teaching_mode: Database["public"]["Enums"]["learning_mode"];
          user_id: string;
        };
        Insert: {
          created_at?: string;
          credits_per_hour?: number;
          id?: string;
          level?: Database["public"]["Enums"]["skill_level"];
          skill_id: string;
          teaching_mode?: Database["public"]["Enums"]["learning_mode"];
          user_id: string;
        };
        Update: {
          created_at?: string;
          credits_per_hour?: number;
          id?: string;
          level?: Database["public"]["Enums"]["skill_level"];
          skill_id?: string;
          teaching_mode?: Database["public"]["Enums"]["learning_mode"];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_teaching_skills_skill_id_fkey";
            columns: ["skill_id"];
            isOneToOne: false;
            referencedRelation: "skills";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      accept_session: {
        Args: { p_session_id: string; p_meet_link?: string | null };
        Returns: Database["public"]["Tables"]["sessions"]["Row"];
      };
      cancel_session: {
        Args: { p_session_id: string };
        Returns: Database["public"]["Tables"]["sessions"]["Row"];
      };
      notify_upcoming_sessions: {
        Args: Record<string, never>;
        Returns: number;
      };
      complete_session: {
        Args: { p_session_id: string };
        Returns: Database["public"]["Tables"]["sessions"]["Row"];
      };
      record_session_join: {
        Args: { p_session_id: string };
        Returns: string;
      };
      record_session_leave: {
        Args: { p_session_id: string };
        Returns: undefined;
      };
      session_attended_seconds: {
        Args: { p_session_id: string; p_user_id: string };
        Returns: number;
      };
      auto_settle_session: {
        Args: { p_session_id: string };
        Returns: Database["public"]["Tables"]["sessions"]["Row"];
      };
      dispute_session: {
        Args: { p_session_id: string };
        Returns: Database["public"]["Tables"]["sessions"]["Row"];
      };
      admin_resolve_dispute: {
        Args: { p_session_id: string; p_in_favor_of: string; p_notes?: string | null };
        Returns: Database["public"]["Tables"]["sessions"]["Row"];
      };
      move_due_sessions_to_review: {
        Args: Record<string, never>;
        Returns: number;
      };
      settle_pending_review_sessions: {
        Args: Record<string, never>;
        Returns: number;
      };
      user_active_strike_weight: {
        Args: { p_user: string; p_within?: string };
        Returns: number;
      };
      user_suspension_state: {
        Args: { p_user: string };
        Returns: { kind: string; expires_at: string | null }[];
      };
      my_strike_summary: {
        Args: Record<string, never>;
        Returns: {
          kind: string;
          suspension_expires_at: string | null;
          active_strike_weight: number;
          next_strike_expires_at: string | null;
        }[];
      };
      admin_issue_strike: {
        Args: {
          p_user: string;
          p_weight: number;
          p_reason: string;
          p_notes?: string | null;
          p_session_id?: string | null;
          p_report_id?: string | null;
        };
        Returns: string;
      };
      set_my_availability: {
        Args: { p_mode: string; p_windows: unknown; p_tz?: string | null };
        Returns: {
          id: string;
          user_id: string;
          mode: string;
          day_of_week: number;
          start_minute: number;
          end_minute: number;
          created_at: string;
        }[];
      };
      get_my_availability: {
        Args: { p_mode?: string | null };
        Returns: {
          id: string;
          user_id: string;
          mode: string;
          day_of_week: number;
          start_minute: number;
          end_minute: number;
          created_at: string;
        }[];
      };
      compute_intersection_slots: {
        Args: {
          p_learner_id: string;
          p_teacher_id: string;
          p_duration_minutes: number;
          p_horizon_days?: number;
          p_max_slots?: number;
        };
        Returns: { proposed_start: string }[];
      };
      get_teacher_windows: {
        Args: {
          p_teacher_id: string;
          p_horizon_days?: number;
        };
        Returns: { window_start: string; window_end: string }[];
      };
      propose_track: {
        Args: {
          p_teacher_id: string;
          p_skill_id: string;
          p_goal: string;
          p_pattern: string;
          p_planned_count: number;
          p_default_duration_minutes: number;
          p_first_start_at: string;
        };
        Returns: Database["public"]["Tables"]["learning_tracks"]["Row"];
      };
      accept_track: {
        Args: { p_track_id: string };
        Returns: Database["public"]["Tables"]["learning_tracks"]["Row"];
      };
      reject_track: {
        Args: { p_track_id: string; p_reason?: string | null };
        Returns: Database["public"]["Tables"]["learning_tracks"]["Row"];
      };
      end_track: {
        Args: { p_track_id: string; p_reason?: string | null };
        Returns: Database["public"]["Tables"]["learning_tracks"]["Row"];
      };
      materialize_due_planned_sessions: {
        Args: Record<string, never>;
        Returns: number;
      };
      get_my_tracks: {
        Args: Record<string, never>;
        Returns: {
          id: string;
          role: string;
          other_user_id: string;
          other_user_name: string | null;
          skill_id: string;
          skill_name: string | null;
          goal: string;
          pattern: string;
          planned_count: number;
          default_duration_minutes: number;
          cadence_days: number;
          status: string;
          first_start_at: string;
          ended_at: string | null;
          end_reason: string | null;
          created_at: string;
          sessions_materialized: number;
          sessions_completed: number;
          sessions_skipped: number;
        }[];
      };
      teachers_intersection_status: {
        Args: {
          p_teacher_ids: string[];
          p_duration_minutes?: number;
          p_horizon_days?: number;
        };
        Returns: { teacher_id: string; next_slot: string | null }[];
      };
      teachers_free_time_status: {
        Args: {
          p_teacher_ids: string[];
          p_duration_minutes?: number;
          p_horizon_days?: number;
        };
        Returns: { teacher_id: string; next_slot: string | null }[];
      };
      has_any_intersection: {
        Args: {
          p_learner_id: string;
          p_teacher_id: string;
          p_duration_minutes?: number;
          p_horizon_days?: number;
        };
        Returns: boolean;
      };
      propose_reschedule: {
        Args: {
          p_session_id: string;
          p_new_scheduled_at: string;
          p_note?: string | null;
        };
        Returns: {
          id: string;
          session_id: string;
          proposer_id: string;
          old_scheduled_at: string | null;
          new_scheduled_at: string;
          status: string;
          responder_id: string | null;
          responded_at: string | null;
          note: string | null;
          created_at: string;
        };
      };
      accept_reschedule: {
        Args: { p_proposal_id: string };
        Returns: Database["public"]["Tables"]["sessions"]["Row"];
      };
      reject_reschedule: {
        Args: { p_proposal_id: string };
        Returns: {
          id: string;
          session_id: string;
          proposer_id: string;
          status: string;
          responder_id: string | null;
          responded_at: string | null;
          new_scheduled_at: string;
          old_scheduled_at: string | null;
          note: string | null;
          created_at: string;
        };
      };
      withdraw_reschedule: {
        Args: { p_proposal_id: string };
        Returns: {
          id: string;
          session_id: string;
          proposer_id: string;
          status: string;
          responder_id: string | null;
          responded_at: string | null;
          new_scheduled_at: string;
          old_scheduled_at: string | null;
          note: string | null;
          created_at: string;
        };
      };
      admin_revoke_strike: {
        Args: { p_strike_id: string; p_reason: string };
        Returns: {
          id: string;
          user_id: string;
          reason: string;
          weight: number;
          session_id: string | null;
          report_id: string | null;
          notes: string | null;
          created_at: string;
          expires_at: string;
          created_by: string | null;
          revoked_at: string | null;
          revoked_by: string | null;
          revoke_reason: string | null;
        };
      };
      delete_my_account: {
        Args: Record<string, never>;
        Returns: undefined;
      };
      get_admin_report_queue: {
        Args: { p_limit?: number };
        Returns: {
          created_at: string;
          details: string | null;
          id: string;
          message_id: string | null;
          message_preview: string | null;
          reason: string;
          reported_user_id: string | null;
          reported_user_name: string | null;
          reporter_id: string | null;
          reporter_name: string | null;
          resolution: string | null;
          review_id: string | null;
          review_preview: string | null;
          session_id: string | null;
          session_skill: string | null;
          status: string;
        }[];
      };
      get_admin_cases: {
        Args: { p_limit?: number };
        Returns: {
          id: string;
          case_number: string;
          report_id: string | null;
          severity: string;
          status: string;
          assigned_to: string | null;
          assigned_to_email: string | null;
          sla_due_at: string;
          escalation_level: number;
          disposition: string | null;
          created_by: string | null;
          created_by_email: string | null;
          created_at: string;
          updated_at: string;
          report_reason: string | null;
          report_status: string | null;
          reported_user_id: string | null;
          reported_user_email: string | null;
          note_count: number;
        }[];
      };
      get_admin_case_notes: {
        Args: { p_case_id: string };
        Returns: {
          id: string;
          case_id: string;
          author_id: string | null;
          author_email: string | null;
          visibility: string;
          body: string;
          created_at: string;
        }[];
      };
      admin_create_case_from_report: {
        Args: {
          p_report_id: string;
          p_severity: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref?: string | null;
          p_idempotency_key?: string | null;
        };
        Returns: Json;
      };
      admin_assign_case: {
        Args: {
          p_case_id: string;
          p_assigned_to: string | null;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref?: string | null;
        };
        Returns: Json;
      };
      admin_update_case_status: {
        Args: {
          p_case_id: string;
          p_status: string;
          p_disposition: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref?: string | null;
        };
        Returns: Json;
      };
      admin_add_case_note: {
        Args: {
          p_case_id: string;
          p_body: string;
          p_visibility: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref?: string | null;
        };
        Returns: Json;
      };
      get_admin_access_governance: {
        Args: Record<string, never>;
        Returns: Json;
      };
      get_admin_finance_dashboard: {
        Args: Record<string, never>;
        Returns: Json;
      };
      request_finance_action: {
        Args: {
          p_action_type: string;
          p_target_user_id: string | null;
          p_amount: number | null;
          p_session_id: string | null;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
          p_idempotency_key?: string | null;
        };
        Returns: Json;
      };
      approve_finance_action: {
        Args: {
          p_request_id: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      reject_finance_action: {
        Args: {
          p_request_id: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      run_finance_reconciliation: {
        Args: {
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      create_finance_report_manifest: {
        Args: {
          p_from: string;
          p_to: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      get_admin_sessions_dashboard: {
        Args: {
          p_limit?: number;
          p_status?: string | null;
        };
        Returns: Json;
      };
      get_admin_users: {
        Args: {
          p_limit?: number;
          p_search?: string | null;
        };
        Returns: Json;
      };
      reveal_admin_user_pii: {
        Args: {
          p_user_id: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      get_admin_compliance_dashboard: {
        Args: Record<string, never>;
        Returns: Json;
      };
      create_privacy_request: {
        Args: {
          p_subject_user_id: string;
          p_request_type: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
          p_idempotency_key?: string | null;
        };
        Returns: Json;
      };
      complete_privacy_export: {
        Args: {
          p_request_id: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      execute_privacy_anonymization: {
        Args: {
          p_request_id: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      set_privacy_request_legal_hold: {
        Args: {
          p_request_id: string;
          p_legal_hold: boolean;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      run_retention_purge: {
        Args: {
          p_policy_id: string;
          p_dry_run: boolean;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      create_compliance_summary_manifest: {
        Args: {
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      get_admin_settings_dashboard: {
        Args: Record<string, never>;
        Returns: Json;
      };
      get_admin_feature_flags: {
        Args: Record<string, never>;
        Returns: Json;
      };
      admin_suspend_user: {
        Args: {
          p_user_id: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      admin_reinstate_user: {
        Args: {
          p_user_id: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      get_admin_skills_catalog: {
        Args: Record<string, never>;
        Returns: Json;
      };
      admin_create_skill: {
        Args: {
          p_name: string;
          p_category: string | null;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      admin_delete_skill: {
        Args: {
          p_skill_id: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      admin_broadcast_notification: {
        Args: {
          p_title: string;
          p_body: string | null;
          p_link: string | null;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: number;
      };
      get_admin_system_health: {
        Args: Record<string, never>;
        Returns: Json;
      };
      propose_admin_setting_change: {
        Args: {
          p_setting_key: string;
          p_proposed_value: Json;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
          p_idempotency_key?: string | null;
        };
        Returns: Json;
      };
      approve_admin_setting_version: {
        Args: {
          p_version_id: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      reject_admin_setting_version: {
        Args: {
          p_version_id: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      publish_admin_setting_version: {
        Args: {
          p_version_id: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      propose_admin_setting_rollback: {
        Args: {
          p_target_version_id: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
          p_idempotency_key?: string | null;
        };
        Returns: Json;
      };
      request_admin_access: {
        Args: {
          p_role_slug: string;
          p_duration_hours: number;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      approve_admin_access_request: {
        Args: {
          p_request_id: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      reject_admin_access_request: {
        Args: {
          p_request_id: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      revoke_admin_assignment: {
        Args: {
          p_assignment_id: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref: string;
        };
        Returns: Json;
      };
      get_admin_console_snapshot: {
        Args: Record<string, never>;
        Returns: Json;
      };
      get_admin_audit_events: {
        Args: {
          p_limit?: number;
          p_domain?: string | null;
          p_action?: string | null;
          p_actor_id?: string | null;
          p_entity_type?: string | null;
          p_entity_id?: string | null;
          p_from?: string | null;
          p_to?: string | null;
        };
        Returns: {
          sequence: number;
          id: string;
          created_at: string;
          actor_id: string | null;
          actor_email: string | null;
          actor_role_snapshot: Json;
          domain: string;
          action: string;
          entity_type: string;
          entity_id: string | null;
          reason_code: string;
          justification: string;
          ticket_ref: string | null;
          correlation_id: string;
          idempotency_key: string | null;
          retention_class: string;
          purge_after: string;
          legal_hold: boolean;
          checksum_version: number;
          prev_event_hash: string | null;
          event_hash: string;
          before_snapshot: Json | null;
          after_snapshot: Json | null;
        }[];
      };
      verify_admin_audit_chain: {
        Args: { p_limit?: number };
        Returns: Json;
      };
      create_admin_audit_export_manifest: {
        Args: {
          p_from: string;
          p_to: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref?: string | null;
        };
        Returns: Json;
      };
      get_admin_security_dashboard: {
        Args: Record<string, never>;
        Returns: Json;
      };
      get_my_admin_permissions: {
        Args: Record<string, never>;
        Returns: {
          action: string;
          break_glass: boolean;
          domain: string;
          expires_at: string | null;
          high_risk: boolean;
          requires_reauth: boolean;
          role_slug: string;
          scope_type: string;
          scope_value: string | null;
        }[];
      };
      admin_has_permission: {
        Args: {
          p_user: string;
          p_domain: string;
          p_action: string;
          p_scope_type?: string | null;
          p_scope_value?: string | null;
        };
        Returns: boolean;
      };
      admin_update_report_status: {
        Args: {
          p_report_id: string;
          p_status: string;
          p_reason_code: string;
          p_justification: string;
          p_ticket_ref?: string | null;
          p_idempotency_key?: string | null;
          p_resolution?: string | null;
        };
        Returns: Database["public"]["Tables"]["reports"]["Row"];
      };
      is_admin: {
        Args: { p_user: string };
        Returns: boolean;
      };
      my_credit_balance: {
        Args: Record<string, never>;
        Returns: number;
      };
      reject_session: {
        Args: { p_session_id: string };
        Returns: Database["public"]["Tables"]["sessions"]["Row"];
      };
    };
    Enums: {
      learning_mode:
        | "teaching"
        | "collaboration"
        | "mentorship"
        | "coaching"
        | "peer_review"
        | "project_based"
        | "study_group"
        | "hands_on";
      session_status:
        | "pending"
        | "accepted"
        | "rejected"
        | "active"
        | "completed"
        | "cancelled"
        | "pending_review"
        | "disputed";
      skill_level: "basic" | "intermediate" | "advanced";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      learning_mode: [
        "teaching",
        "collaboration",
        "mentorship",
        "coaching",
        "peer_review",
        "project_based",
        "study_group",
        "hands_on",
      ],
      session_status: [
        "pending",
        "accepted",
        "rejected",
        "active",
        "completed",
        "cancelled",
        "pending_review",
        "disputed",
      ],
      skill_level: ["basic", "intermediate", "advanced"],
    },
  },
} as const;
