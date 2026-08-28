import type {
  Conversation,
  Message,
  Memory,
  Reminder,
  UserProfile,
  MessageRole,
  Json,
} from "./schema.js";
import type { DataStore } from "./datastore.js";
import crypto from "crypto";

/**
 * Calculates cosine similarity between two vector embeddings.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class InMemoryDataStore implements DataStore {
  conversations: Map<string, Conversation> = new Map();
  messages: Map<string, Message> = new Map();
  memories: Map<string, Memory> = new Map();
  reminders: Map<string, Reminder> = new Map();
  userProfiles: Map<number, UserProfile> = new Map();
  activityLogs: Array<{
    id: string;
    user_id: number | null;
    event_type: string;
    payload: Json | null;
    error: string | null;
    created_at: string;
  }> = [];

  // ─── Conversations & Messages ──────────────────────────

  async getOrCreateConversation(chatId: number): Promise<string> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    for (const conv of this.conversations.values()) {
      if (conv.telegram_chat_id === chatId && conv.updated_at >= cutoff) {
        return conv.id;
      }
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const newConv: Conversation = {
      id,
      telegram_chat_id: chatId,
      created_at: now,
      updated_at: now,
    };
    this.conversations.set(id, newConv);
    return id;
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
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const msg: Message = {
      id,
      conversation_id: conversationId,
      role,
      content,
      tool_name: options.toolName ?? null,
      tool_call_id: options.toolCallId ?? null,
      tokens_used: options.tokensUsed ?? null,
      created_at: now,
    };
    this.messages.set(id, msg);

    const conv = this.conversations.get(conversationId);
    if (conv) {
      conv.updated_at = now;
    }
  }

  async getContextMessages(
    conversationId: string,
    limit = 20
  ): Promise<Array<{ role: MessageRole; content: string }>> {
    const relevant = Array.from(this.messages.values())
      .filter((m) => m.conversation_id === conversationId)
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    return relevant.slice(-limit).map((m) => ({ role: m.role, content: m.content }));
  }

  async clearConversation(chatId: number, userId?: number): Promise<void> {
    const convIdsToDelete = new Set<string>();
    for (const conv of this.conversations.values()) {
      if (conv.telegram_chat_id === chatId) {
        convIdsToDelete.add(conv.id);
      }
    }

    for (const [id, msg] of this.messages.entries()) {
      if (convIdsToDelete.has(msg.conversation_id)) {
        this.messages.delete(id);
      }
    }

    if (userId) {
      await this.logActivity(userId, "conversation_cleared", { chat_id: chatId });
    }
  }

  async getOldMessages(
    cutoffDateIso: string,
    limit = 100
  ): Promise<Array<{ conversation_id: string }>> {
    const cutoffTime = new Date(cutoffDateIso).getTime();
    const result: Array<{ conversation_id: string }> = [];
    for (const msg of this.messages.values()) {
      if (new Date(msg.created_at).getTime() < cutoffTime) {
        result.push({ conversation_id: msg.conversation_id });
        if (result.length >= limit) break;
      }
    }
    return result;
  }

  async getConversationMessagesBefore(
    conversationId: string,
    cutoffDateIso: string,
    limit = 50
  ): Promise<Array<{ role: MessageRole; content: string; created_at: string }>> {
    const cutoffTime = new Date(cutoffDateIso).getTime();
    return Array.from(this.messages.values())
      .filter(
        (m) =>
          m.conversation_id === conversationId &&
          new Date(m.created_at).getTime() < cutoffTime
      )
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .slice(0, limit)
      .map((m) => ({ role: m.role, content: m.content, created_at: m.created_at }));
  }

  async deleteConversationMessagesBefore(
    conversationId: string,
    cutoffDateIso: string
  ): Promise<number> {
    const cutoffTime = new Date(cutoffDateIso).getTime();
    let count = 0;
    for (const [id, msg] of this.messages.entries()) {
      if (
        msg.conversation_id === conversationId &&
        new Date(msg.created_at).getTime() < cutoffTime
      ) {
        this.messages.delete(id);
        count++;
      }
    }
    return count;
  }

  // ─── Long-Term Memories ────────────────────────────────

  async storeMemory(
    userId: number,
    content: string,
    tags: string[],
    importance: number,
    embedding: number[] | null
  ): Promise<Memory> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const memory: Memory = {
      id,
      user_id: userId,
      content,
      tags,
      embedding,
      importance,
      is_active: true,
      superseded_by: null,
      created_at: now,
      updated_at: now,
    };
    this.memories.set(id, memory);
    return memory;
  }

  async matchMemories(
    userId: number,
    queryEmbedding: number[],
    threshold: number,
    limit: number
  ): Promise<Array<Memory & { similarity: number }>> {
    const matches: Array<Memory & { similarity: number }> = [];

    for (const mem of this.memories.values()) {
      if (mem.user_id !== userId || !mem.is_active || !mem.embedding) continue;
      const sim = cosineSimilarity(queryEmbedding, mem.embedding);
      if (sim >= threshold) {
        matches.push({ ...mem, similarity: sim });
      }
    }

    return matches.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  async searchMemoriesKeyword(
    userId: number,
    query: string,
    limit: number
  ): Promise<Memory[]> {
    const q = query.toLowerCase();
    return Array.from(this.memories.values())
      .filter((m) => m.user_id === userId && m.is_active && m.content.toLowerCase().includes(q))
      .sort((a, b) => {
        if (b.importance !== a.importance) return b.importance - a.importance;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      })
      .slice(0, limit);
  }

  async markMemoriesSuperseded(
    supersededIds: string[],
    newMemoryId: string
  ): Promise<void> {
    const now = new Date().toISOString();
    for (const id of supersededIds) {
      const mem = this.memories.get(id);
      if (mem) {
        mem.is_active = false;
        mem.superseded_by = newMemoryId;
        mem.updated_at = now;
      }
    }
  }

  async listMemories(userId: number, limit = 20): Promise<Memory[]> {
    return Array.from(this.memories.values())
      .filter((m) => m.user_id === userId && m.is_active)
      .sort((a, b) => {
        if (b.importance !== a.importance) return b.importance - a.importance;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      })
      .slice(0, limit);
  }

  async deleteMemory(memoryId: string): Promise<void> {
    this.memories.delete(memoryId);
  }

  async getMemoryCount(userId?: number): Promise<number> {
    if (!userId) return this.memories.size;
    let count = 0;
    for (const m of this.memories.values()) {
      if (m.user_id === userId && m.is_active) count++;
    }
    return count;
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
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const reminder: Reminder = {
      id,
      user_id: params.userId,
      telegram_chat_id: params.chatId,
      message: params.message,
      trigger_at: params.triggerAt,
      is_recurring: params.isRecurring ?? false,
      cron_expression: params.cronExpression ?? null,
      is_completed: false,
      is_cancelled: false,
      created_at: now,
    };
    this.reminders.set(id, reminder);
    return reminder;
  }

  async listActiveReminders(userId: number, limit = 20): Promise<Reminder[]> {
    return Array.from(this.reminders.values())
      .filter((r) => r.user_id === userId && !r.is_cancelled && !r.is_completed)
      .sort((a, b) => new Date(a.trigger_at).getTime() - new Date(b.trigger_at).getTime())
      .slice(0, limit);
  }

  async getDueReminders(nowIso: string): Promise<Reminder[]> {
    const nowTime = new Date(nowIso).getTime();
    return Array.from(this.reminders.values()).filter(
      (r) => !r.is_completed && !r.is_cancelled && new Date(r.trigger_at).getTime() <= nowTime
    );
  }

  async getReminder(id: string, userId: number): Promise<Reminder | null> {
    const r = this.reminders.get(id);
    if (!r || r.user_id !== userId) return null;
    return r;
  }

  async updateReminder(id: string, updates: Partial<Reminder>): Promise<Reminder> {
    const r = this.reminders.get(id);
    if (!r) throw new Error("Reminder not found");
    const updated = { ...r, ...updates };
    this.reminders.set(id, updated);
    return updated;
  }

  async getTodayReminders(userId: number, endOfDayIso: string): Promise<Reminder[]> {
    const endOfDayTime = new Date(endOfDayIso).getTime();
    return Array.from(this.reminders.values())
      .filter(
        (r) =>
          r.user_id === userId &&
          !r.is_completed &&
          !r.is_cancelled &&
          new Date(r.trigger_at).getTime() <= endOfDayTime
      )
      .sort((a, b) => new Date(a.trigger_at).getTime() - new Date(b.trigger_at).getTime());
  }

  async getActiveReminderCount(userId?: number): Promise<number> {
    let count = 0;
    for (const r of this.reminders.values()) {
      if ((!userId || r.user_id === userId) && !r.is_completed && !r.is_cancelled) {
        count++;
      }
    }
    return count;
  }

  // ─── User Profile & Telemetry ──────────────────────────

  async getUserProfile(userId: number): Promise<UserProfile | null> {
    return this.userProfiles.get(userId) ?? null;
  }

  async upsertUserProfile(
    profile: Partial<UserProfile> & { id: number }
  ): Promise<void> {
    const existing = this.userProfiles.get(profile.id);
    const now = new Date().toISOString();
    const updated: UserProfile = {
      id: profile.id,
      name: profile.name ?? existing?.name ?? "Boss",
      timezone: profile.timezone ?? existing?.timezone ?? "Asia/Kolkata",
      briefing_time: profile.briefing_time ?? existing?.briefing_time ?? "07:00",
      custom_instructions: profile.custom_instructions ?? existing?.custom_instructions ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.userProfiles.set(profile.id, updated);
  }

  async logActivity(
    userId: number | null,
    eventType: string,
    payload?: Json,
    error?: string | null
  ): Promise<void> {
    this.activityLogs.push({
      id: crypto.randomUUID(),
      user_id: userId,
      event_type: eventType,
      payload: payload ?? null,
      error: error ?? null,
      created_at: new Date().toISOString(),
    });
  }
}
