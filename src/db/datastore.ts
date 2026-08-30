import type {
  Conversation,
  Message,
  Memory,
  Reminder,
  UserProfile,
  MessageRole,
  Json,
} from "./schema.js";

export interface DataStore {
  // ─── Conversations & Messages ──────────────────────────
  getOrCreateConversation(chatId: number): Promise<string>;
  saveMessage(
    conversationId: string,
    role: MessageRole,
    content: string,
    options?: {
      toolName?: string;
      toolCallId?: string;
      tokensUsed?: number;
    }
  ): Promise<void>;
  getContextMessages(
    conversationId: string,
    limit?: number
  ): Promise<Array<{ role: MessageRole; content: string }>>;
  clearConversation(chatId: number, userId?: number): Promise<void>;
  getOldMessages(
    cutoffDateIso: string,
    limit?: number
  ): Promise<Array<{ conversation_id: string }>>;
  getConversationMessagesBefore(
    conversationId: string,
    cutoffDateIso: string,
    limit?: number
  ): Promise<Array<{ id: string; role: MessageRole; content: string; created_at: string }>>;
  deleteConversationMessagesBefore(
    conversationId: string,
    cutoffDateIso: string
  ): Promise<number>;
  deleteMessagesByIds(messageIds: string[]): Promise<number>;

  // ─── Long-Term Memories ────────────────────────────────
  storeMemory(
    userId: number,
    content: string,
    tags: string[],
    importance: number,
    embedding: number[] | null
  ): Promise<Memory>;
  matchMemories(
    userId: number,
    queryEmbedding: number[],
    threshold: number,
    limit: number
  ): Promise<Array<Memory & { similarity: number }>>;
  searchMemoriesKeyword(
    userId: number,
    query: string,
    limit: number
  ): Promise<Memory[]>;
  markMemoriesSuperseded(
    supersededIds: string[],
    newMemoryId: string
  ): Promise<void>;
  listMemories(userId: number, limit?: number): Promise<Memory[]>;
  deleteMemory(memoryId: string): Promise<void>;
  getMemoryCount(userId?: number): Promise<number>;

  // ─── Reminders ─────────────────────────────────────────
  createReminder(params: {
    userId: number;
    chatId: number;
    message: string;
    triggerAt: string;
    isRecurring?: boolean;
    cronExpression?: string | null;
  }): Promise<Reminder>;
  listActiveReminders(userId: number, limit?: number): Promise<Reminder[]>;
  getDueReminders(nowIso: string): Promise<Reminder[]>;
  getReminder(id: string, userId: number): Promise<Reminder | null>;
  updateReminder(id: string, updates: Partial<Reminder>): Promise<Reminder>;
  getTodayReminders(userId: number, endOfDayIso: string): Promise<Reminder[]>;
  getActiveReminderCount(userId?: number): Promise<number>;

  // ─── User Profile & Telemetry ──────────────────────────
  getUserProfile(userId: number): Promise<UserProfile | null>;
  upsertUserProfile(
    profile: Partial<UserProfile> & { id: number }
  ): Promise<void>;
  logActivity(
    userId: number | null,
    eventType: string,
    payload?: Json,
    error?: string | null
  ): Promise<void>;
}
