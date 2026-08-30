import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, MessageRole, Memory, Reminder, UserProfile, Json } from "./schema.js";
import type { DataStore } from "./datastore.js";
import { getSupabaseClient } from "./supabase.js";

export class SupabaseDataStore implements DataStore {
  private db: SupabaseClient<Database>;

  constructor(client?: SupabaseClient<Database>) {
    this.db = client ?? getSupabaseClient();
  }

  // ─── Conversations & Messages ──────────────────────────

  async getOrCreateConversation(chatId: number): Promise<string> {
    // Look for recent conversation (last 24h)
    const { data: existing, error: findError } = await this.db
      .from("conversations")
      .select("id")
      .eq("telegram_chat_id", chatId)
      .gte("updated_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (findError) {
      console.warn("[supabase-store] Error finding conversation:", findError.message);
    }

    if (existing) return existing.id;

    const { data, error } = await this.db
      .from("conversations")
      .insert({ telegram_chat_id: chatId })
      .select("id")
      .single();

    if (error || !data) {
      throw new Error(`Failed to create conversation: ${error?.message ?? "unknown error"}`);
    }
    return data.id;
  }

  async saveMessage(
    conversationId: string,
    role: MessageRole,
    content: string,
    options: {
      toolName?: string;
      toolCallId?: string;
      tokensUsed?: number;
    } = {}
  ): Promise<void> {
    const { error } = await this.db.from("messages").insert({
      conversation_id: conversationId,
      role,
      content,
      tool_name: options.toolName ?? null,
      tool_call_id: options.toolCallId ?? null,
      tokens_used: options.tokensUsed ?? null,
    });

    if (error) {
      console.error("[supabase-store] Failed to save message:", error.message);
    }

    await this.db
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);
  }

  async getContextMessages(
    conversationId: string,
    limit = 20
  ): Promise<Array<{ role: MessageRole; content: string }>> {
    const { data, error } = await this.db
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("[supabase-store] Failed to fetch context messages:", error.message);
      return [];
    }

    return (data ?? []).reverse();
  }

  async clearConversation(chatId: number, userId?: number): Promise<void> {
    const { data: convs } = await this.db
      .from("conversations")
      .select("id")
      .eq("telegram_chat_id", chatId);

    if (!convs?.length) return;

    for (const conv of convs) {
      await this.db.from("messages").delete().eq("conversation_id", conv.id);
    }

    if (userId) {
      await this.logActivity(userId, "conversation_cleared", { chat_id: chatId });
    }
  }

  async getOldMessages(
    cutoffDateIso: string,
    limit = 100
  ): Promise<Array<{ conversation_id: string }>> {
    const { data, error } = await this.db
      .from("messages")
      .select("conversation_id")
      .lt("created_at", cutoffDateIso)
      .limit(limit);

    if (error) {
      console.error("[supabase-store] Failed to get old messages:", error.message);
      return [];
    }
    return data ?? [];
  }

  async getConversationMessagesBefore(
    conversationId: string,
    cutoffDateIso: string,
    limit = 50
  ): Promise<Array<{ id: string; role: MessageRole; content: string; created_at: string }>> {
    const { data, error } = await this.db
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conversationId)
      .lt("created_at", cutoffDateIso)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error || !data) {
      return [];
    }
    return data;
  }

  async deleteConversationMessagesBefore(
    conversationId: string,
    cutoffDateIso: string
  ): Promise<number> {
    const { count, error } = await this.db
      .from("messages")
      .delete({ count: "exact" })
      .eq("conversation_id", conversationId)
      .lt("created_at", cutoffDateIso);

    if (error) {
      console.error("[supabase-store] Failed to delete messages:", error.message);
      return 0;
    }
    return count ?? 0;
  }

  async deleteMessagesByIds(messageIds: string[]): Promise<number> {
    if (messageIds.length === 0) return 0;
    const { count, error } = await this.db
      .from("messages")
      .delete({ count: "exact" })
      .in("id", messageIds);

    if (error) {
      console.error("[supabase-store] Failed to delete messages by IDs:", error.message);
      return 0;
    }
    return count ?? 0;
  }

  // ─── Long-Term Memories ────────────────────────────────

  async storeMemory(
    userId: number,
    content: string,
    tags: string[],
    importance: number,
    embedding: number[] | null
  ): Promise<Memory> {
    const { data, error } = await this.db
      .from("memories")
      .insert({
        user_id: userId,
        content,
        tags,
        embedding,
        importance,
      })
      .select()
      .single();

    if (error || !data) {
      throw new Error(`Failed to store memory: ${error?.message ?? "unknown error"}`);
    }
    return data;
  }

  async matchMemories(
    userId: number,
    queryEmbedding: number[],
    threshold: number,
    limit: number
  ): Promise<Array<Memory & { similarity: number }>> {
    const { data, error } = await this.db.rpc("match_memories", {
      query_embedding: queryEmbedding,
      match_threshold: threshold,
      match_count: limit,
      p_user_id: userId,
    });

    if (error) {
      console.warn("[supabase-store] match_memories RPC error:", error.message);
      return [];
    }
    return (data ?? []) as Array<Memory & { similarity: number }>;
  }

  async searchMemoriesKeyword(
    userId: number,
    query: string,
    limit: number
  ): Promise<Memory[]> {
    const { data, error } = await this.db
      .from("memories")
      .select()
      .eq("user_id", userId)
      .eq("is_active", true)
      .ilike("content", `%${query}%`)
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to search memories: ${error.message}`);
    }
    return data ?? [];
  }

  async markMemoriesSuperseded(
    supersededIds: string[],
    newMemoryId: string
  ): Promise<void> {
    if (supersededIds.length === 0) return;
    const { error } = await this.db
      .from("memories")
      .update({ is_active: false, superseded_by: newMemoryId })
      .in("id", supersededIds);

    if (error) {
      console.warn("[supabase-store] Failed to mark memories superseded:", error.message);
    }
  }

  async listMemories(userId: number, limit = 20): Promise<Memory[]> {
    const { data, error } = await this.db
      .from("memories")
      .select()
      .eq("user_id", userId)
      .eq("is_active", true)
      .order("importance", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to list memories: ${error.message}`);
    }
    return data ?? [];
  }

  async deleteMemory(memoryId: string): Promise<void> {
    const { error } = await this.db.from("memories").delete().eq("id", memoryId);
    if (error) {
      throw new Error(`Failed to delete memory: ${error.message}`);
    }
  }

  async getMemoryCount(userId?: number): Promise<number> {
    let query = this.db.from("memories").select("*", { count: "exact", head: true });
    if (userId) {
      query = query.eq("user_id", userId);
    }
    const { count } = await query;
    return count ?? 0;
  }

  // ─── Reminders ─────────────────────────────────────────

  async createReminder(params: {
    userId: number;
    chatId: number;
    message: string;
    triggerAt: string;
    isRecurring?: boolean;
    cronExpression?: string | null;
  }): Promise<Reminder> {
    const { data, error } = await this.db
      .from("reminders")
      .insert({
        user_id: params.userId,
        telegram_chat_id: params.chatId,
        message: params.message,
        trigger_at: params.triggerAt,
        is_recurring: params.isRecurring ?? false,
        cron_expression: params.cronExpression ?? null,
        is_completed: false,
        is_cancelled: false,
      })
      .select()
      .single();

    if (error || !data) {
      throw new Error(`Failed to create reminder: ${error?.message ?? "unknown error"}`);
    }
    return data;
  }

  async listActiveReminders(userId: number, limit = 20): Promise<Reminder[]> {
    const { data, error } = await this.db
      .from("reminders")
      .select()
      .eq("user_id", userId)
      .eq("is_cancelled", false)
      .eq("is_completed", false)
      .order("trigger_at", { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to list reminders: ${error.message}`);
    }
    return data ?? [];
  }

  async getDueReminders(nowIso: string): Promise<Reminder[]> {
    const { data, error } = await this.db
      .from("reminders")
      .select()
      .lte("trigger_at", nowIso)
      .eq("is_completed", false)
      .eq("is_cancelled", false);

    if (error) {
      console.error("[supabase-store] Error fetching due reminders:", error.message);
      return [];
    }
    return data ?? [];
  }

  async getReminder(id: string, userId: number): Promise<Reminder | null> {
    const { data, error } = await this.db
      .from("reminders")
      .select()
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.warn("[supabase-store] Error fetching reminder:", error.message);
      return null;
    }
    return data;
  }

  async updateReminder(id: string, updates: Partial<Reminder>): Promise<Reminder> {
    const { data, error } = await this.db
      .from("reminders")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error || !data) {
      throw new Error(`Failed to update reminder: ${error?.message ?? "unknown error"}`);
    }
    return data;
  }

  async getTodayReminders(userId: number, endOfDayIso: string): Promise<Reminder[]> {
    const { data, error } = await this.db
      .from("reminders")
      .select()
      .eq("user_id", userId)
      .eq("is_completed", false)
      .eq("is_cancelled", false)
      .lte("trigger_at", endOfDayIso)
      .order("trigger_at", { ascending: true });

    if (error) {
      console.warn("[supabase-store] Error fetching today reminders:", error.message);
      return [];
    }
    return data ?? [];
  }

  async getActiveReminderCount(userId?: number): Promise<number> {
    let query = this.db
      .from("reminders")
      .select("*", { count: "exact", head: true })
      .eq("is_completed", false)
      .eq("is_cancelled", false);

    if (userId) {
      query = query.eq("user_id", userId);
    }
    const { count } = await query;
    return count ?? 0;
  }

  // ─── User Profile & Telemetry ──────────────────────────

  async getUserProfile(userId: number): Promise<UserProfile | null> {
    const { data, error } = await this.db
      .from("user_profiles")
      .select()
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      console.warn("[supabase-store] Error fetching user profile:", error.message);
      return null;
    }
    return data;
  }

  async upsertUserProfile(
    profile: Partial<UserProfile> & { id: number }
  ): Promise<void> {
    const { error } = await this.db
      .from("user_profiles")
      .upsert(
        {
          ...profile,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      );

    if (error) {
      console.error("[supabase-store] Failed to upsert user profile:", error.message);
    }
  }

  async logActivity(
    userId: number | null,
    eventType: string,
    payload?: Json,
    error?: string | null
  ): Promise<void> {
    try {
      await this.db.from("activity_logs").insert({
        user_id: userId,
        event_type: eventType,
        payload: payload ?? null,
        error: error ?? null,
      });
    } catch (err) {
      console.error("[supabase-store] Failed to insert activity log:", err);
    }
  }
}
