import { env } from "../config/env.js";
import type { DataStore } from "../db/datastore.js";
import { getDataStore } from "../db/datastore-provider.js";
import type { Memory, Reminder } from "../db/schema.js";
import { parseTimeString } from "../utils/time.js";
import { Cron } from "croner";

import { generateText, type LanguageModel } from "ai";
import { getModel } from "../services/model.service.js";
import { sendCriticalAlert } from "../services/alert.service.js";
import { checkAndIncrementUsage } from "../services/cost-tracker.service.js";

export const EMBEDDING_MODEL = "gemini-embedding-2";
const SUPERSEDE_THRESHOLD = 0.85;

/**
 * Verifies whether a new memory fact contradicts, replaces, or invalidates an existing memory fact.
 * Returns true if contradictory/superseding.
 * Returns false if complementary, distinct, or on failure (safe retention).
 */
export async function checkMemoryContradiction(
  existingFact: string,
  newFact: string,
  model?: LanguageModel
): Promise<boolean> {
  if (existingFact.trim().toLowerCase() === newFact.trim().toLowerCase()) {
    return true;
  }

  if (env().GEMINI_API_KEY === "mock_gemini_key" && !model) {
    return false;
  }

  try {
    const usageCheck = await checkAndIncrementUsage("llm");
    if (!usageCheck.allowed) {
      return false;
    }

    const activeModel = model ?? getModel();
    const prompt = `Determine if the NEW statement contradicts, invalidates, or replaces the EXISTING statement.
Existing: "${existingFact}"
New: "${newFact}"

Respond with CONTRADICT if the new statement replaces, invalidates, or directly conflicts with the existing statement (e.g. "User lives in New York" vs "User moved to London").
Respond with COMPATIBLE if both statements can be simultaneously true or are complementary preferences/details (e.g. "User likes coffee" and "User likes tea").
Respond with ONLY: CONTRADICT or COMPATIBLE.`;

    const result = await generateText({
      model: activeModel,
      prompt,
      maxSteps: 1,
    });
    return result.text.trim().toUpperCase().includes("CONTRADICT");
  } catch {
    return false;
  }
}

/**
 * Generates text embeddings using Google's gemini-embedding-2 model (768 dimensions).
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const { GEMINI_API_KEY, EMBEDDING_MODEL: configuredModel } = env();
  const activeModel = configuredModel || EMBEDDING_MODEL;

  const isExplicitlyMocked = typeof (globalThis.fetch as any)?.mock !== "undefined";
  if (GEMINI_API_KEY === "mock_gemini_key" && !isExplicitlyMocked) {
    return new Array(768).fill(0.01);
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:embedContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({
          model: `models/${activeModel}`,
          content: { parts: [{ text }] },
          outputDimensionality: 768,
        }),
      }
    );

    if (!response.ok) {
      const errorDetails = await response.text().catch(() => "");
      const safeDetails = GEMINI_API_KEY ? errorDetails.replaceAll(GEMINI_API_KEY, "[REDACTED]") : errorDetails;
      throw new Error(
        `Embedding API error (${response.status} ${response.statusText}): ${safeDetails}`
      );
    }

    const data = (await response.json()) as {
      embedding: { values: number[] };
    };
    return data.embedding.values;
  } catch (err) {
    if (GEMINI_API_KEY) {
      if (err instanceof Error) {
        if (err.message.includes(GEMINI_API_KEY)) {
          err.message = err.message.replaceAll(GEMINI_API_KEY, "[REDACTED]");
        }
        if (err.stack && err.stack.includes(GEMINI_API_KEY)) {
          err.stack = err.stack.replaceAll(GEMINI_API_KEY, "[REDACTED]");
        }
      } else if (typeof err === "string" && err.includes(GEMINI_API_KEY)) {
        throw new Error(err.replaceAll(GEMINI_API_KEY, "[REDACTED]"));
      }
    }
    throw err;
  }
}

// ─── Memory Actions ──────────────────────────────────────────────────────────

export async function rememberAction(
  content: string,
  tags: string[] = [],
  importance: number = 3,
  store: DataStore = getDataStore(),
  userId: number = env().TELEGRAM_ALLOWED_USER_ID,
  source: "user" | "web" | "system" = "user"
): Promise<Memory> {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Memory content cannot be empty.");
  }

  let embedding: number[] | null = null;
  try {
    embedding = await generateEmbedding(trimmed);
  } catch (err) {
    console.error("[actions:memory] CRITICAL: Failed to generate embedding for memory:", err);
    await sendCriticalAlert("embedding_failure", err, { action: "rememberAction", text: trimmed.slice(0, 100) });
    throw new Error(`Embedding generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Conflict detection and superseding (ADR-0004 + AUDIT-006)
  const supersededIds: string[] = [];
  if (embedding) {
    try {
      const candidates = await store.matchMemories(userId, embedding, SUPERSEDE_THRESHOLD, 3);
      for (const candidate of candidates) {
        const isContradiction = await checkMemoryContradiction(candidate.content, trimmed);
        if (isContradiction) {
          supersededIds.push(candidate.id);
        }
      }
      if (supersededIds.length > 0) {
        console.log(`[actions:memory] Verified contradiction; superseding ${supersededIds.length} conflicting memory(ies)`);
      }
    } catch (err) {
      console.warn("[actions:memory] Conflict detection failed, proceeding with insert:", err);
    }
  }

  const memory = await store.storeMemory(userId, trimmed, tags, importance, embedding, source);

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
  let matches: Memory[] = [];
  try {
    const embedding = await generateEmbedding(trimmed);
    matches = await store.matchMemories(userId, embedding, 0.7, limit);
    if (matches.length > 0) {
      return matches;
    }
  } catch (err) {
    console.error("[actions:memory] CRITICAL: Embedding failure during recall:", err);
    await sendCriticalAlert("embedding_failure", err, { action: "recallMemoriesAction", query: trimmed });
    throw new Error(`Embedding recall failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Fallback to keyword search only when semantic search succeeded but found 0 matches
  return store.searchMemoriesKeyword(userId, trimmed, limit);
}

// ─── Web Search Action ───────────────────────────────────────────────────────

export interface WebSearchOptions {
  maxResults?: number;
  topic?: "general" | "news";
  days?: number;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string | null;
}

export interface WebSearchResult {
  answer: string | null;
  results: WebSearchResultItem[];
}

export async function webSearchAction(
  query: string,
  optionsOrMaxResults: number | WebSearchOptions = 5
): Promise<WebSearchResult> {
  const { TAVILY_API_KEY } = env();
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("Search query cannot be empty.");
  }

  const usageCheck = await checkAndIncrementUsage("tavily");
  if (!usageCheck.allowed) {
    return {
      answer: usageCheck.error ?? "Daily web search limit reached. Search is paused until tomorrow.",
      results: [],
    };
  }

  const options: WebSearchOptions =
    typeof optionsOrMaxResults === "number"
      ? { maxResults: optionsOrMaxResults }
      : optionsOrMaxResults;

  const maxResults = options.maxResults ?? 5;
  const topic = options.topic ?? "general";
  const days = options.days ?? (topic === "news" ? 1 : undefined);

  const payload: Record<string, unknown> = {
    api_key: TAVILY_API_KEY,
    query: trimmed,
    max_results: maxResults,
    search_depth: "basic",
    include_answer: true,
    include_raw_content: false,
  };

  if (topic === "news") {
    payload.topic = "news";
    payload.days = days ?? 1;
  } else if (days !== undefined) {
    payload.days = days;
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TAVILY_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(
      `Tavily search failed (${response.status} ${response.statusText}): ${errBody}`
    );
  }

  const data = (await response.json()) as {
    answer?: string;
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      published_date?: string;
    }>;
  };

  return {
    answer: data.answer ?? null,
    results: (data.results ?? []).map((r) => ({
      title: r.title ?? "Untitled",
      url: r.url ?? "",
      snippet: r.content ? r.content.slice(0, 300) : "",
      publishedDate: r.published_date ?? null,
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
    lease_until: null,
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

  await store.updateReminder(reminderId, {
    is_cancelled: true,
    lease_until: null,
  });
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
