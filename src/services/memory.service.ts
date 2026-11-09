import { generateText, type LanguageModel } from "ai";
import { env } from "../config/env.js";
import type { DataStore } from "../db/datastore.js";
import { getDataStore } from "../db/datastore-provider.js";
import type { Memory } from "../db/schema.js";
import { getModel } from "./model.service.js";
import { sendCriticalAlert } from "./alert.service.js";
import { checkAndIncrementUsage } from "./cost-tracker.service.js";

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

    let data: any;
    try {
      data = await response.json();
    } catch (parseErr) {
      throw new Error(
        `Failed to parse embedding API response (${response.status}): ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
      );
    }

    if (!data?.embedding?.values || !Array.isArray(data.embedding.values)) {
      throw new Error(
        `Invalid embedding response format: expected embedding.values array, received ${JSON.stringify(data).slice(0, 200)}`
      );
    }

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

// ─── Memory Core Actions ─────────────────────────────────────────────────────

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

// ─── Ergonomic Facade Functions ──────────────────────────────────────────────

export function formatMemoryLines(
  memories: Array<Pick<Memory, "content" | "importance" | "created_at" | "source">>
): string {
  if (memories.length === 0) return "";
  return memories
    .map((m) => {
      const date = m.created_at ? m.created_at.slice(0, 10) : "";
      const dateSuffix = date ? ` (saved: ${date})` : "";
      const sourceLabel = m.source === "web" ? " [Source: Web (Untrusted)]" : "";
      return `- [importance: ${m.importance}]${sourceLabel} ${m.content}${dateSuffix}`;
    })
    .join("\n");
}

export const storeMemory = rememberAction;
export const searchMemories = recallMemoriesAction;

export async function listMemories(limit = 20): Promise<Memory[]> {
  const store = getDataStore();
  return store.listMemories(env().TELEGRAM_ALLOWED_USER_ID, limit);
}

export async function deleteMemory(memoryId: string): Promise<void> {
  const store = getDataStore();
  return store.deleteMemory(memoryId);
}

export async function buildMemoryContext(
  userMessage: string
): Promise<string | null> {
  try {
    const memories = await searchMemories(userMessage, 5);
    if (memories.length === 0) return null;

    const lines = formatMemoryLines(memories);
    return `## Relevant memories about the user:\n${lines}`;
  } catch (err) {
    console.warn("[memory] buildMemoryContext failed:", err);
    return null;
  }
}
