import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Database,
  MessageRole,
  Memory,
  Reminder,
  UserProfile,
  Json,
  ConversationSession,
  HistorySearchResult,
} from "./schema.js";
import type { DataStore } from "./datastore.js";
import { getSupabaseClient } from "./supabase.js";

export class SupabaseDataStore implements DataStore {
  private db: SupabaseClient<Database>;

  constructor(client?: SupabaseClient<Database>) {
    this.db = client ?? getSupabaseClient();
  }

  // ─── Conversations & Messages ──────────────────────────

  async getOrCreateConversation(chatId: number): Promise<string> {
    // Look for recent active conversation (last 24h)
    const { data: existing, error: findError } = await this.db
      .from("conversations")
      .select("id")
      .eq("telegram_chat_id", chatId)
      .eq("is_active", true)
      .gte("updated_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (findError) {
      console.warn("[supabase-store] Error finding conversation:", findError.message);
    }

    if (existing) return existing.id;

    // Atomically deactivate older active sessions for this chat
    const { error: deactivateError } = await this.db
      .from("conversations")
      .update({ is_active: false })
      .eq("telegram_chat_id", chatId)
      .eq("is_active", true);

    if (deactivateError) {
      console.warn("[supabase-store] Error deactivating older sessions:", deactivateError.message);
    }

    const { data, error } = await this.db
      .from("conversations")
      .insert({
        telegram_chat_id: chatId,
        is_active: true,
      })
      .select("id")
      .single();

    if (error || !data) {
      // If unique constraint was hit due to concurrent insertion, re-fetch the active conversation
      const { data: retryExisting } = await this.db
        .from("conversations")
        .select("id")
        .eq("telegram_chat_id", chatId)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (retryExisting) {
        return retryExisting.id;
      }

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
      throw new Error(`Failed to save message: ${error.message}`);
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
      .is("compacted_at", null)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("[supabase-store] Failed to fetch context messages:", error.message);
      return [];
    }

    const currentMessages = (data ?? []).reverse();
    if (currentMessages.length >= limit) {
      return currentMessages;
    }

    // Bridge prior conversation if active session has fewer than limit messages
    try {
      const { data: conv } = await this.db
        .from("conversations")
        .select("telegram_chat_id, created_at")
        .eq("id", conversationId)
        .maybeSingle();

      if (conv) {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data: priorConv } = await this.db
          .from("conversations")
          .select("id")
          .eq("telegram_chat_id", conv.telegram_chat_id)
          .neq("id", conversationId)
          .gte("updated_at", sevenDaysAgo)
          .lte("created_at", conv.created_at)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (priorConv) {
          const needed = limit - currentMessages.length;
          const { data: lastClear } = await this.db
            .from("activity_logs")
            .select("created_at")
            .eq("event_type", "conversation_cleared")
            .contains("payload", { chat_id: conv.telegram_chat_id })
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          let query = this.db
            .from("messages")
            .select("role, content")
            .eq("conversation_id", priorConv.id)
            .is("compacted_at", null);

          if (lastClear?.created_at) {
            query = query.gt("created_at", lastClear.created_at);
          }

          const { data: priorData } = await query
            .order("created_at", { ascending: false })
            .limit(needed);

          if (priorData && priorData.length > 0) {
            return [...priorData.reverse(), ...currentMessages];
          }
        }
      }
    } catch (err) {
      console.warn("[supabase-store] Failed to bridge previous conversation context:", err);
    }

    return currentMessages;
  }

  async clearConversation(chatId: number, userId?: number): Promise<void> {
    const { error } = await this.db
      .from("conversations")
      .update({ is_active: false })
      .eq("telegram_chat_id", chatId)
      .eq("is_active", true);

    if (error) {
      console.warn("[supabase-store] Error archiving active conversation on clear:", error.message);
    }

    if (userId) {
      await this.logActivity(userId, "conversation_cleared", { chat_id: chatId });
    }
  }

  // ─── Sessions & History Search ─────────────────────────

  async listSessions(chatId: number, limit = 10): Promise<ConversationSession[]> {
    const { data: convs, error } = await this.db
      .from("conversations")
      .select("id, telegram_chat_id, title, summary, is_active, created_at, updated_at")
      .eq("telegram_chat_id", chatId)
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error || !convs) {
      console.error("[supabase-store] Failed to list sessions:", error?.message);
      return [];
    }

    // Fetch message counts for these conversations
    const convIds = convs.map((c) => c.id);
    const countMap = new Map<string, number>();

    if (convIds.length > 0) {
      const { data: messages } = await this.db
        .from("messages")
        .select("conversation_id")
        .in("conversation_id", convIds);

      if (messages) {
        for (const m of messages) {
          countMap.set(m.conversation_id, (countMap.get(m.conversation_id) ?? 0) + 1);
        }
      }
    }

    return convs.map((c) => ({
      id: c.id,
      telegramChatId: c.telegram_chat_id,
      title: c.title,
      summary: c.summary,
      isActive: c.is_active,
      messageCount: countMap.get(c.id) ?? 0,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    }));
  }

  async getActiveSession(chatId: number): Promise<ConversationSession | null> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.db
      .from("conversations")
      .select("id, telegram_chat_id, title, summary, is_active, created_at, updated_at")
      .eq("telegram_chat_id", chatId)
      .eq("is_active", true)
      .gte("updated_at", cutoff)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    const { count } = await this.db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", data.id);

    return {
      id: data.id,
      telegramChatId: data.telegram_chat_id,
      title: data.title,
      summary: data.summary,
      isActive: data.is_active,
      messageCount: count ?? 0,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async getSession(conversationId: string): Promise<ConversationSession | null> {
    const { data, error } = await this.db
      .from("conversations")
      .select("id, telegram_chat_id, title, summary, is_active, created_at, updated_at")
      .eq("id", conversationId)
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    const { count } = await this.db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", data.id);

    return {
      id: data.id,
      telegramChatId: data.telegram_chat_id,
      title: data.title,
      summary: data.summary,
      isActive: data.is_active,
      messageCount: count ?? 0,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async switchActiveSession(
    chatId: number,
    targetConversationId: string
  ): Promise<ConversationSession> {
    // 1. Deactivate other sessions for this chat
    await this.db
      .from("conversations")
      .update({ is_active: false })
      .eq("telegram_chat_id", chatId);

    // 2. Activate target session and touch updated_at
    const nowIso = new Date().toISOString();
    const { data, error } = await this.db
      .from("conversations")
      .update({ is_active: true, updated_at: nowIso })
      .eq("id", targetConversationId)
      .eq("telegram_chat_id", chatId)
      .select("id, telegram_chat_id, title, summary, is_active, created_at, updated_at")
      .single();

    if (error || !data) {
      throw new Error(`Failed to switch to session ${targetConversationId}: ${error?.message ?? "Not found"}`);
    }

    const { count } = await this.db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", data.id);

    return {
      id: data.id,
      telegramChatId: data.telegram_chat_id,
      title: data.title,
      summary: data.summary,
      isActive: data.is_active,
      messageCount: count ?? 0,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  }

  async updateSessionTitle(conversationId: string, title: string): Promise<void> {
    const { error } = await this.db
      .from("conversations")
      .update({ title: title.trim(), updated_at: new Date().toISOString() })
      .eq("id", conversationId);

    if (error) {
      throw new Error(`Failed to update session title: ${error.message}`);
    }
  }

  async archiveSession(chatId: number): Promise<void> {
    const { error } = await this.db
      .from("conversations")
      .update({ is_active: false })
      .eq("telegram_chat_id", chatId)
      .eq("is_active", true);

    if (error) {
      console.warn("[supabase-store] Failed to archive session:", error.message);
    }
  }

  async deleteSession(conversationId: string): Promise<void> {
    const { error } = await this.db
      .from("conversations")
      .delete()
      .eq("id", conversationId);

    if (error) {
      throw new Error(`Failed to delete session: ${error.message}`);
    }
  }

  async getSessionMessages(
    conversationId: string,
    limit = 50
  ): Promise<Array<{ id: string; role: MessageRole; content: string; created_at: string }>> {
    const { data, error } = await this.db
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error || !data) {
      return [];
    }
    return data;
  }

  async searchMessageHistory(
    chatId: number,
    query: string,
    options?: { limit?: number; conversationId?: string }
  ): Promise<HistorySearchResult[]> {
    const limit = options?.limit ?? 10;
    const trimmed = query.trim();
    if (!trimmed) return [];

    let convQuery = this.db
      .from("conversations")
      .select("id, title")
      .eq("telegram_chat_id", chatId);

    if (options?.conversationId) {
      convQuery = convQuery.eq("id", options.conversationId);
    }

    const { data: convs, error: convErr } = await convQuery;
    if (convErr || !convs || convs.length === 0) {
      return [];
    }

    const titleMap = new Map<string, string | null>();
    const convIds: string[] = [];
    for (const c of convs) {
      titleMap.set(c.id, c.title);
      convIds.push(c.id);
    }

    const { data: messages, error: msgErr } = await this.db
      .from("messages")
      .select("id, conversation_id, role, content, created_at")
      .in("conversation_id", convIds)
      .ilike("content", `%${trimmed}%`)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (msgErr || !messages) {
      console.warn("[supabase-store] History search failed:", msgErr?.message);
      return [];
    }

    return messages.map((m) => ({
      messageId: m.id,
      conversationId: m.conversation_id,
      sessionTitle: titleMap.get(m.conversation_id) ?? null,
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
      similarity: 1.0,
    }));
  }

  async getOldMessages(
    cutoffDateIso: string,
    limit = 100
  ): Promise<Array<{ conversation_id: string }>> {
    const { data, error } = await this.db
      .from("messages")
      .select("conversation_id")
      .is("compacted_at", null)
      .lt("created_at", cutoffDateIso)
      .order("created_at", { ascending: true })
      .limit(limit * 10);

    if (error) {
      console.error("[supabase-store] Failed to get old messages:", error.message);
      return [];
    }

    const seen = new Set<string>();
    const unique: Array<{ conversation_id: string }> = [];
    for (const row of data ?? []) {
      if (!seen.has(row.conversation_id)) {
        seen.add(row.conversation_id);
        unique.push(row);
        if (unique.length >= limit) break;
      }
    }
    return unique;
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
      .is("compacted_at", null)
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

  async markMessagesCompacted(messageIds: string[]): Promise<number> {
    if (messageIds.length === 0) return 0;
    const { count, error } = await this.db
      .from("messages")
      .update({ compacted_at: new Date().toISOString() }, { count: "exact" })
      .in("id", messageIds);

    if (error) {
      console.error("[supabase-store] Failed to mark messages compacted:", error.message);
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
    embedding: number[] | null,
    source: "user" | "web" | "system" = "user"
  ): Promise<Memory> {
    const { data, error } = await this.db
      .from("memories")
      .insert({
        user_id: userId,
        content,
        tags,
        embedding,
        importance,
        source,
      })
      .select()
      .single();

    if (error || !data) {
      throw new Error(`Failed to store memory: ${error?.message ?? "unknown error"}`);
    }
    return data;
  }

  async updateMemoryEmbedding(id: string, embedding: number[] | null): Promise<void> {
    const { error } = await this.db
      .from("memories")
      .update({ embedding, updated_at: new Date().toISOString() })
      .eq("id", id);

    if (error) {
      throw new Error(`Failed to update memory embedding: ${error.message}`);
    }
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

  async claimDueReminders(nowIso: string, leaseDurationMs: number): Promise<Reminder[]> {
    const nowTime = new Date(nowIso).getTime();
    const leaseUntilIso = new Date(nowTime + leaseDurationMs).toISOString();

    const { data: candidates, error: findError } = await this.db
      .from("reminders")
      .select()
      .lte("trigger_at", nowIso)
      .eq("is_completed", false)
      .eq("is_cancelled", false)
      .is("sent_at", null)
      .or(`lease_until.is.null,lease_until.lt.${nowIso}`);

    if (findError) {
      console.error("[supabase-store] Error fetching due reminders to claim:", findError.message);
      return [];
    }

    if (!candidates || candidates.length === 0) {
      return [];
    }

    const results = await Promise.all(
      candidates.map(async (reminder) => {
        let updateQuery = this.db
          .from("reminders")
          .update({
            lease_until: leaseUntilIso,
            delivery_attempts: (reminder.delivery_attempts ?? 0) + 1,
          })
          .eq("id", reminder.id)
          .eq("is_completed", false)
          .eq("is_cancelled", false)
          .is("sent_at", null);

        if (reminder.lease_until === null) {
          updateQuery = updateQuery.is("lease_until", null);
        } else {
          updateQuery = updateQuery.eq("lease_until", reminder.lease_until);
        }

        const { data: updated, error: updateError } = await updateQuery.select().maybeSingle();
        return !updateError && updated ? (updated as Reminder) : null;
      })
    );

    return results.filter((r): r is Reminder => r !== null);
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
    const finalUpdates = { ...updates };
    if (updates.is_completed && !finalUpdates.sent_at) {
      finalUpdates.sent_at = new Date().toISOString();
    }
    const { data, error } = await this.db
      .from("reminders")
      .update(finalUpdates)
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

  // ─── Scheduled Briefings & Concurrency ─────────────────

  async claimDailyBriefing(userId: number, briefingDate: string, scheduledAtIso: string): Promise<boolean> {
    const nowIso = new Date().toISOString();
    // 1. Try to insert new claim
    const { data: inserted, error: insertError } = await this.db
      .from("scheduled_briefings")
      .insert({
        user_id: userId,
        briefing_date: briefingDate,
        scheduled_at: scheduledAtIso,
        claimed_at: nowIso,
      })
      .select()
      .maybeSingle();

    if (!insertError && inserted) {
      return true;
    }

    // 2. If already exists, attempt atomic claim update where sent_at IS NULL and claimed_at expired
    const twoMinutesAgoIso = new Date(Date.now() - 120_000).toISOString();
    const { data: updated, error: updateError } = await this.db
      .from("scheduled_briefings")
      .update({ claimed_at: nowIso })
      .eq("user_id", userId)
      .eq("briefing_date", briefingDate)
      .is("sent_at", null)
      .or(`claimed_at.is.null,claimed_at.lt.${twoMinutesAgoIso}`)
      .select()
      .maybeSingle();

    return !updateError && Boolean(updated);
  }

  async markDailyBriefingSent(userId: number, briefingDate: string, modelUsed?: string): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db
      .from("scheduled_briefings")
      .update({
        sent_at: nowIso,
        ...(modelUsed ? { model_used: modelUsed } : {}),
      })
      .eq("user_id", userId)
      .eq("briefing_date", briefingDate);
  }

  async getLastBriefingDate(userId: number): Promise<string | null> {
    const { data, error } = await this.db
      .from("scheduled_briefings")
      .select("briefing_date")
      .eq("user_id", userId)
      .not("sent_at", "is", null)
      .order("briefing_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;
    return (data as { briefing_date: string }).briefing_date;
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
