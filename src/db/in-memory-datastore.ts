import type {
  Conversation,
  Message,
  Memory,
  Reminder,
  UserProfile,
  MessageRole,
  Json,
  ConversationSession,
  HistorySearchResult,
  ScheduledBriefing,
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
  scheduledBriefings: Map<string, ScheduledBriefing> = new Map();
  userProfiles: Map<number, UserProfile> = new Map();
  lastClearedAt: Map<number, number> = new Map();
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
    let latestActiveConv: Conversation | null = null;

    for (const conv of this.conversations.values()) {
      if (
        conv.telegram_chat_id === chatId &&
        conv.is_active !== false &&
        conv.updated_at >= cutoff
      ) {
        if (!latestActiveConv || conv.updated_at > latestActiveConv.updated_at) {
          latestActiveConv = conv;
        }
      }
    }

    if (latestActiveConv) {
      return latestActiveConv.id;
    }

    // Archive any previous active conversations for this chat to maintain single-active invariant
    for (const conv of this.conversations.values()) {
      if (conv.telegram_chat_id === chatId && conv.is_active !== false) {
        conv.is_active = false;
      }
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Atomically deactivate older active sessions for this chat
    for (const conv of this.conversations.values()) {
      if (conv.telegram_chat_id === chatId && conv.is_active) {
        conv.is_active = false;
        conv.updated_at = now;
      }
    }

    const newConv: Conversation = {
      id,
      telegram_chat_id: chatId,
      title: null,
      summary: null,
      is_active: true,
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
    const currentConv = this.conversations.get(conversationId);
    const chatId = currentConv?.telegram_chat_id;
    const clearedTime = chatId ? (this.lastClearedAt.get(chatId) ?? 0) : 0;

    const relevant = Array.from(this.messages.values())
      .filter((m) => {
        if (m.compacted_at) return false;
        if (m.conversation_id !== conversationId) return false;
        if (clearedTime > 0 && new Date(m.created_at).getTime() <= clearedTime) return false;
        return true;
      })
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    // Bridge prior conversation if active session has fewer than limit messages
    if (relevant.length < limit && currentConv) {
      const chatId = currentConv.telegram_chat_id;
      const clearedTime = this.lastClearedAt.get(chatId) ?? 0;
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

      const priorConvs = Array.from(this.conversations.values())
        .filter(
          (c) =>
            c.telegram_chat_id === chatId &&
            c.id !== conversationId &&
            new Date(c.updated_at).getTime() > sevenDaysAgo &&
            new Date(c.updated_at).getTime() <= new Date(currentConv.created_at).getTime()
        )
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

      if (priorConvs.length > 0) {
        const priorConvId = priorConvs[0].id;
        const needed = limit - relevant.length;
        const priorMessages = Array.from(this.messages.values())
          .filter(
            (m) =>
              !m.compacted_at &&
              m.conversation_id === priorConvId &&
              new Date(m.created_at).getTime() > clearedTime
          )
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
          .slice(-needed);

        relevant.unshift(...priorMessages);
      }
    }

    return relevant.slice(-limit).map((m) => ({ role: m.role, content: m.content }));
  }

  async clearConversation(chatId: number, userId?: number): Promise<void> {
    for (const conv of this.conversations.values()) {
      if (conv.telegram_chat_id === chatId && conv.is_active !== false) {
        conv.is_active = false;
      }
    }

    this.lastClearedAt.set(chatId, Date.now());

    if (userId) {
      await this.logActivity(userId, "conversation_cleared", { chat_id: chatId });
    }
  }

  // ─── Sessions & History Search ─────────────────────────

  async listSessions(chatId: number, limit = 10): Promise<ConversationSession[]> {
    const sessions: ConversationSession[] = [];
    for (const conv of this.conversations.values()) {
      if (conv.telegram_chat_id === chatId) {
        let messageCount = 0;
        for (const msg of this.messages.values()) {
          if (msg.conversation_id === conv.id) {
            messageCount++;
          }
        }
        sessions.push({
          id: conv.id,
          telegramChatId: conv.telegram_chat_id,
          title: conv.title ?? null,
          summary: conv.summary ?? null,
          isActive: conv.is_active !== false,
          messageCount,
          createdAt: conv.created_at,
          updatedAt: conv.updated_at,
        });
      }
    }

    return sessions
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, limit);
  }

  async getActiveSession(chatId: number): Promise<ConversationSession | null> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let latest: Conversation | null = null;

    for (const conv of this.conversations.values()) {
      if (
        conv.telegram_chat_id === chatId &&
        conv.is_active !== false &&
        conv.updated_at >= cutoff
      ) {
        if (!latest || conv.updated_at > latest.updated_at) {
          latest = conv;
        }
      }
    }

    if (!latest) return null;

    let messageCount = 0;
    for (const msg of this.messages.values()) {
      if (msg.conversation_id === latest.id) {
        messageCount++;
      }
    }

    return {
      id: latest.id,
      telegramChatId: latest.telegram_chat_id,
      title: latest.title ?? null,
      summary: latest.summary ?? null,
      isActive: true,
      messageCount,
      createdAt: latest.created_at,
      updatedAt: latest.updated_at,
    };
  }

  async getSession(conversationId: string): Promise<ConversationSession | null> {
    const conv = this.conversations.get(conversationId);
    if (!conv) return null;

    let messageCount = 0;
    for (const msg of this.messages.values()) {
      if (msg.conversation_id === conv.id) {
        messageCount++;
      }
    }

    return {
      id: conv.id,
      telegramChatId: conv.telegram_chat_id,
      title: conv.title ?? null,
      summary: conv.summary ?? null,
      isActive: conv.is_active,
      messageCount,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
    };
  }

  async switchActiveSession(
    chatId: number,
    targetConversationId: string
  ): Promise<ConversationSession> {
    const target = this.conversations.get(targetConversationId);
    if (!target || target.telegram_chat_id !== chatId) {
      throw new Error(`Session ${targetConversationId} not found for chat ${chatId}`);
    }

    // Deactivate currently active sessions for this chat
    for (const conv of this.conversations.values()) {
      if (conv.telegram_chat_id === chatId) {
        conv.is_active = false;
      }
    }

    // Activate target session and touch updatedAt
    target.is_active = true;
    target.updated_at = new Date().toISOString();

    let messageCount = 0;
    for (const msg of this.messages.values()) {
      if (msg.conversation_id === target.id) {
        messageCount++;
      }
    }

    return {
      id: target.id,
      telegramChatId: target.telegram_chat_id,
      title: target.title ?? null,
      summary: target.summary ?? null,
      isActive: true,
      messageCount,
      createdAt: target.created_at,
      updatedAt: target.updated_at,
    };
  }

  async updateSessionTitle(conversationId: string, title: string): Promise<void> {
    const conv = this.conversations.get(conversationId);
    if (!conv) {
      throw new Error(`Session ${conversationId} not found`);
    }
    conv.title = title.trim();
    conv.updated_at = new Date().toISOString();
  }

  async archiveSession(chatId: number): Promise<void> {
    for (const conv of this.conversations.values()) {
      if (conv.telegram_chat_id === chatId && conv.is_active !== false) {
        conv.is_active = false;
      }
    }
  }

  async deleteSession(conversationId: string): Promise<void> {
    this.conversations.delete(conversationId);
    for (const [id, msg] of this.messages.entries()) {
      if (msg.conversation_id === conversationId) {
        this.messages.delete(id);
      }
    }
  }

  async getSessionMessages(
    conversationId: string,
    limit = 50
  ): Promise<Array<{ id: string; role: MessageRole; content: string; created_at: string }>> {
    const list: Array<{ id: string; role: MessageRole; content: string; created_at: string }> = [];
    for (const msg of this.messages.values()) {
      if (msg.conversation_id === conversationId) {
        list.push({
          id: msg.id,
          role: msg.role,
          content: msg.content,
          created_at: msg.created_at,
        });
      }
    }
    return list
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .slice(-limit);
  }

  async searchMessageHistory(
    chatId: number,
    query: string,
    options?: { limit?: number; conversationId?: string }
  ): Promise<HistorySearchResult[]> {
    const limit = options?.limit ?? 10;
    const qLower = query.toLowerCase().trim();
    const qWords = qLower.split(/\s+/).filter((w) => w.length > 0);
    const results: HistorySearchResult[] = [];

    // Filter relevant conversation IDs for this chat
    const validConvIds = new Set<string>();
    for (const conv of this.conversations.values()) {
      if (conv.telegram_chat_id === chatId) {
        if (!options?.conversationId || conv.id === options.conversationId) {
          validConvIds.add(conv.id);
        }
      }
    }

    for (const msg of this.messages.values()) {
      if (!validConvIds.has(msg.conversation_id)) continue;

      const contentLower = msg.content.toLowerCase();
      // Match full query or any word
      const matchesFull = contentLower.includes(qLower);
      const matchedWords = qWords.filter((w) => contentLower.includes(w)).length;

      if (matchesFull || matchedWords > 0) {
        const conv = this.conversations.get(msg.conversation_id);
        const score = matchesFull ? 1.0 : matchedWords / Math.max(qWords.length, 1);
        results.push({
          messageId: msg.id,
          conversationId: msg.conversation_id,
          sessionTitle: conv?.title ?? null,
          role: msg.role,
          content: msg.content,
          createdAt: msg.created_at,
          similarity: score,
        });
      }
    }

    return results
      .sort((a, b) => {
        const scoreDiff = (b.similarity ?? 0) - (a.similarity ?? 0);
        if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      })
      .slice(0, limit);
  }

  async getOldMessages(
    cutoffDateIso: string,
    limit = 100
  ): Promise<Array<{ conversation_id: string }>> {
    const cutoffTime = new Date(cutoffDateIso).getTime();
    const seen = new Set<string>();
    const result: Array<{ conversation_id: string }> = [];
    for (const msg of this.messages.values()) {
      if (!msg.compacted_at && new Date(msg.created_at).getTime() < cutoffTime) {
        if (!seen.has(msg.conversation_id)) {
          seen.add(msg.conversation_id);
          result.push({ conversation_id: msg.conversation_id });
          if (result.length >= limit) break;
        }
      }
    }
    return result;
  }

  async getConversationMessagesBefore(
    conversationId: string,
    cutoffDateIso: string,
    limit = 50
  ): Promise<Array<{ id: string; role: MessageRole; content: string; created_at: string }>> {
    const cutoffTime = new Date(cutoffDateIso).getTime();
    return Array.from(this.messages.values())
      .filter(
        (m) =>
          !m.compacted_at &&
          m.conversation_id === conversationId &&
          new Date(m.created_at).getTime() < cutoffTime
      )
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .slice(0, limit)
      .map((m) => ({ id: m.id, role: m.role, content: m.content, created_at: m.created_at }));
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

  async deleteMessagesByIds(messageIds: string[]): Promise<number> {
    let count = 0;
    for (const id of messageIds) {
      if (this.messages.delete(id)) {
        count++;
      }
    }
    return count;
  }

  async markMessagesCompacted(messageIds: string[]): Promise<number> {
    const now = new Date().toISOString();
    let count = 0;
    for (const id of messageIds) {
      const msg = this.messages.get(id);
      if (msg) {
        msg.compacted_at = now;
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
    embedding: number[] | null,
    source: "user" | "web" | "system" = "user"
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
      source,
      created_at: now,
      updated_at: now,
    };
    this.memories.set(id, memory);
    return memory;
  }

  async updateMemoryEmbedding(id: string, embedding: number[] | null): Promise<void> {
    const memory = this.memories.get(id);
    if (memory) {
      memory.embedding = embedding;
      memory.updated_at = new Date().toISOString();
    }
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
      lease_until: null,
      delivery_attempts: 0,
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

  async claimDueReminders(nowIso: string, leaseDurationMs: number): Promise<Reminder[]> {
    const nowTime = new Date(nowIso).getTime();
    const leaseUntilIso = new Date(nowTime + leaseDurationMs).toISOString();
    const claimed: Reminder[] = [];

    for (const reminder of this.reminders.values()) {
      if (reminder.is_completed || reminder.is_cancelled || reminder.sent_at) continue;
      const triggerTime = new Date(reminder.trigger_at).getTime();
      if (triggerTime > nowTime) continue;

      if (reminder.lease_until) {
        const leaseTime = new Date(reminder.lease_until).getTime();
        if (leaseTime > nowTime) {
          continue;
        }
      }

      reminder.lease_until = leaseUntilIso;
      reminder.delivery_attempts = (reminder.delivery_attempts ?? 0) + 1;
      claimed.push({ ...reminder });
    }

    return claimed;
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
    if (updates.is_completed && !updated.sent_at) {
      updated.sent_at = new Date().toISOString();
    }
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

  // ─── Scheduled Briefings & Concurrency ─────────────────

  async claimDailyBriefing(userId: number, briefingDate: string, scheduledAtIso: string): Promise<boolean> {
    const key = `${userId}:${briefingDate}`;
    const existing = this.scheduledBriefings.get(key);
    if (existing?.sent_at) {
      return false;
    }
    const now = new Date().toISOString();
    if (existing?.claimed_at) {
      const claimedTime = new Date(existing.claimed_at).getTime();
      if (Date.now() - claimedTime < 120_000) {
        return false;
      }
    }

    this.scheduledBriefings.set(key, {
      id: existing?.id ?? crypto.randomUUID(),
      user_id: userId,
      briefing_date: briefingDate,
      scheduled_at: scheduledAtIso,
      claimed_at: now,
      sent_at: existing?.sent_at ?? null,
      model_used: existing?.model_used ?? null,
      created_at: existing?.created_at ?? now,
    });
    return true;
  }

  async markDailyBriefingSent(userId: number, briefingDate: string, modelUsed?: string): Promise<void> {
    const key = `${userId}:${briefingDate}`;
    const existing = this.scheduledBriefings.get(key);
    if (existing) {
      existing.sent_at = new Date().toISOString();
      if (modelUsed) existing.model_used = modelUsed;
    }
  }

  async getLastBriefingDate(userId: number): Promise<string | null> {
    const sent = Array.from(this.scheduledBriefings.values())
      .filter((b) => b.user_id === userId && b.sent_at !== null)
      .sort((a, b) => b.briefing_date.localeCompare(a.briefing_date));
    return sent.length > 0 ? sent[0].briefing_date : null;
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
