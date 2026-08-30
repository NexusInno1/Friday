import { env } from "../config/env.js";
import type { DataStore } from "../db/datastore.js";
import { getDataStore } from "../db/datastore-provider.js";
import type { Memory, Reminder } from "../db/schema.js";
import { parseTimeString } from "../utils/time.js";
import { Cron } from "croner";

const EMBEDDING_MODEL = "text-embedding-004";
const SUPERSEDE_THRESHOLD = 0.85;

/**
 * Generates text embeddings using Google's text-embedding-004 model.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const { GEMINI_API_KEY } = env();
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: 768,
      }),
    }
  );

  if (!response.ok) {
    const errorDetails = await response.text().catch(() => "");
    throw new Error(
      `Embedding API error (${response.status} ${response.statusText}): ${errorDetails}`
    );
  }

  const data = (await response.json()) as {
    embedding: { values: number[] };
  };
  return data.embedding.values;
}

// ─── Memory Actions ──────────────────────────────────────────────────────────

export async function rememberAction(
  content: string,
  tags: string[] = [],
  importance: number = 3,
  store: DataStore = getDataStore(),
  userId: number = env().TELEGRAM_ALLOWED_USER_ID
): Promise<Memory> {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Memory content cannot be empty.");
  }

  let embedding: number[] | null = null;
  try {
    embedding = await generateEmbedding(trimmed);
  } catch (err) {
    console.warn("[actions:memory] Failed to generate embedding, storing without vector:", err);
  }

  // Conflict detection and superseding (ADR-0004)
  const supersededIds: string[] = [];
  if (embedding) {
    try {
      const conflicts = await store.matchMemories(userId, embedding, SUPERSEDE_THRESHOLD, 3);
      for (const conflict of conflicts) {
        supersededIds.push(conflict.id);
      }
      if (supersededIds.length > 0) {
        console.log(`[actions:memory] Superseding ${supersededIds.length} conflicting memory(ies)`);
      }
    } catch (err) {
      console.warn("[actions:memory] Conflict detection failed, proceeding with insert:", err);
    }
  }

  const memory = await store.storeMemory(userId, trimmed, tags, importance, embedding);

  if (supersededIds.length > 0 && memory) {
    await store.markMemoriesSuperseded(supersededIds, memory.id);
  }

  return memory;
}

export async function recallMemoriesAction(
  query: string,
  limit: number = 5,
  store: DataStore = getDataStore(),
  userId: number = env().TELEGRAM_ALLOWED_USER_ID
): Promise<Memory[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // Try semantic search first
  try {
    const embedding = await generateEmbedding(trimmed);
    const matches = await store.matchMemories(userId, embedding, 0.7, limit);
    if (matches.length > 0) {
      return matches;
    }
  } catch (err) {
    console.warn("[actions:memory] Semantic search failed, falling back to keyword search:", err);
  }

  // Fallback to keyword search
  return store.searchMemoriesKeyword(userId, trimmed, limit);
}

// ─── Web Search Action ───────────────────────────────────────────────────────

export interface WebSearchResult {
  answer: string | null;
  results: Array<{ title: string; url: string; snippet: string }>;
}

export async function webSearchAction(
  query: string,
  maxResults: number = 5
): Promise<WebSearchResult> {
  const { TAVILY_API_KEY } = env();
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("Search query cannot be empty.");
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query: trimmed,
      max_results: maxResults,
      search_depth: "basic",
      include_answer: true,
      include_raw_content: false,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(
      `Tavily search failed (${response.status} ${response.statusText}): ${errBody}`
    );
  }

  const data = (await response.json()) as {
    answer?: string;
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };

  return {
    answer: data.answer ?? null,
    results: (data.results ?? []).map((r) => ({
      title: r.title ?? "Untitled",
      url: r.url ?? "",
      snippet: r.content ? r.content.slice(0, 300) : "",
    })),
  };
}

// ─── Reminder Actions ────────────────────────────────────────────────────────

export function computeSnoozedTime(currentTriggerAt: string, minutes: number): string {
  if (minutes <= 0) {
    throw new Error("Snooze duration must be a positive number of minutes.");
  }
  const date = new Date(currentTriggerAt);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date string: ${currentTriggerAt}`);
  }
  return new Date(date.getTime() + minutes * 60 * 1000).toISOString();
}

export async function createReminderAction(
  params: {
    userId?: number;
    chatId: number;
    message: string;
    triggerAt: string;
    isRecurring?: boolean;
    cronExpression?: string | null;
  },
  store: DataStore = getDataStore()
): Promise<Reminder> {
  const userId = params.userId ?? env().TELEGRAM_ALLOWED_USER_ID;
  const date = new Date(params.triggerAt);
  if (isNaN(date.getTime())) {
    throw new Error(
      `Invalid trigger date/time format: "${params.triggerAt}". Expected a valid ISO 8601 datetime string.`
    );
  }

  if (params.isRecurring || params.cronExpression) {
    if (!params.cronExpression || !params.cronExpression.trim()) {
      throw new Error("Recurring reminders require a valid cron expression.");
    }
    try {
      new Cron(params.cronExpression.trim());
    } catch {
      throw new Error(
        `Invalid cron expression: "${params.cronExpression}". Expected a valid 5-part cron format (e.g. "0 9 * * 1-5").`
      );
    }
  }

  return store.createReminder({
    userId,
    chatId: params.chatId,
    message: params.message.trim(),
    triggerAt: date.toISOString(),
    isRecurring: params.isRecurring ?? false,
    cronExpression: params.cronExpression?.trim() ?? null,
  });
}

export async function snoozeReminderAction(
  reminderId: string,
  minutes: number,
  userId: number = env().TELEGRAM_ALLOWED_USER_ID,
  store: DataStore = getDataStore()
): Promise<{ reminder: Reminder; newTriggerAt: string }> {
  const reminder = await store.getReminder(reminderId, userId);
  if (!reminder) {
    throw new Error("Reminder not found.");
  }

  const newTriggerAt = computeSnoozedTime(reminder.trigger_at, minutes);
  const updated = await store.updateReminder(reminderId, {
    trigger_at: newTriggerAt,
    is_completed: false,
  });

  return { reminder: updated, newTriggerAt };
}

export async function cancelReminderAction(
  reminderId: string,
  userId: number = env().TELEGRAM_ALLOWED_USER_ID,
  store: DataStore = getDataStore()
): Promise<{ success: boolean; cancelledId: string }> {
  const reminder = await store.getReminder(reminderId, userId);
  if (!reminder) {
    throw new Error("Reminder not found.");
  }

  await store.updateReminder(reminderId, { is_cancelled: true });
  return { success: true, cancelledId: reminderId };
}

export async function listRemindersAction(
  userId: number = env().TELEGRAM_ALLOWED_USER_ID,
  limit: number = 20,
  store: DataStore = getDataStore()
): Promise<Reminder[]> {
  return store.listActiveReminders(userId, limit);
}

// ─── Daily Briefing Settings Action ──────────────────────────────────────────

export async function updateBriefingTimeAction(
  rawTime: string,
  userId: number = env().TELEGRAM_ALLOWED_USER_ID,
  store: DataStore = getDataStore()
): Promise<{ success: boolean; time: string }> {
  const normalizedTime = parseTimeString(rawTime);
  const { USER_NAME, USER_TIMEZONE } = env();

  await store.upsertUserProfile({
    id: userId,
    name: USER_NAME,
    timezone: USER_TIMEZONE,
    briefing_time: normalizedTime,
  });

  return { success: true, time: normalizedTime };
}
