export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Database {
  public: {
    Tables: {
      user_profiles: {
        Row: {
          id: number;
          name: string;
          timezone: string;
          briefing_time: string;
          custom_instructions: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: number;
          name?: string;
          timezone?: string;
          briefing_time?: string;
          custom_instructions?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: number;
          name?: string;
          timezone?: string;
          briefing_time?: string;
          custom_instructions?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      conversations: {
        Row: {
          id: string;
          telegram_chat_id: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          telegram_chat_id: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          telegram_chat_id?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          id: string;
          conversation_id: string;
          role: MessageRole;
          content: string;
          tool_name: string | null;
          tool_call_id: string | null;
          tokens_used: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          conversation_id: string;
          role: MessageRole;
          content: string;
          tool_name?: string | null;
          tool_call_id?: string | null;
          tokens_used?: number | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          conversation_id?: string;
          role?: MessageRole;
          content?: string;
          tool_name?: string | null;
          tool_call_id?: string | null;
          tokens_used?: number | null;
          created_at?: string;
        };
        Relationships: [];
      };
      memories: {
        Row: {
          id: string;
          user_id: number;
          content: string;
          tags: string[];
          embedding: number[] | null;
          importance: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: number;
          content: string;
          tags?: string[];
          embedding?: number[] | null;
          importance?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: number;
          content?: string;
          tags?: string[];
          embedding?: number[] | null;
          importance?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      reminders: {
        Row: {
          id: string;
          user_id: number;
          message: string;
          trigger_at: string;
          cron_expression: string | null;
          is_recurring: boolean;
          is_completed: boolean;
          is_cancelled: boolean;
          telegram_chat_id: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: number;
          message: string;
          trigger_at: string;
          cron_expression?: string | null;
          is_recurring?: boolean;
          is_completed?: boolean;
          is_cancelled?: boolean;
          telegram_chat_id: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: number;
          message?: string;
          trigger_at?: string;
          cron_expression?: string | null;
          is_recurring?: boolean;
          is_completed?: boolean;
          is_cancelled?: boolean;
          telegram_chat_id?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      activity_logs: {
        Row: {
          id: string;
          user_id: number | null;
          event_type: string;
          payload: Json | null;
          error: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: number | null;
          event_type: string;
          payload?: Json | null;
          error?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: number | null;
          event_type?: string;
          payload?: Json | null;
          error?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      match_memories: {
        Args: {
          query_embedding: number[];
          match_threshold: number;
          match_count: number;
          p_user_id: number;
        };
        Returns: {
          id: string;
          user_id: number;
          content: string;
          tags: string[];
          embedding: number[] | null;
          importance: number;
          created_at: string;
          updated_at: string;
          similarity: number;
        }[];
      };
    };
  };
}

export type UserProfile = Database["public"]["Tables"]["user_profiles"]["Row"];
export type Conversation = Database["public"]["Tables"]["conversations"]["Row"];
export type Message = Database["public"]["Tables"]["messages"]["Row"];
export type Memory = Database["public"]["Tables"]["memories"]["Row"];
export type Reminder = Database["public"]["Tables"]["reminders"]["Row"];
export type ActivityLog = Database["public"]["Tables"]["activity_logs"]["Row"];
