import { getSupabaseClient } from "../db/supabase.js";
import { env } from "../config/env.js";
import type { Memory } from "../db/schema.js";

const EMBEDDING_MODEL = "gemini-embedding-001";

/**
 * Generates a text embedding using Google's Gemini embedding model.
 * Used for semantic similarity search in pgvector.
 */
async function generateEmbedding(text: string): Promise<number[]> {
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
    throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    embedding: { values: number[] };
  };
  return data.embedding.values;
}

/**
 * Formats a list of memory rows into formatted bullet points including importance and saved date.
 */
export function formatMemoryLines(
  memories: Array<Pick<Memory, "content" | "importance" | "created_at">>
): string {
  if (memories.length === 0) return "";
  return memories
    .map((m) => {
      const date = m.created_at ? m.created_at.slice(0, 10) : "";
      const dateSuffix = date ? ` (saved: ${date})` : "";
      return `- [importance: ${m.importance}] ${m.content}${dateSuffix}`;
    })
    .join("\n");
}

/**
 * Stores a memory fact about the user in Supabase.
 * Generates an embedding for future semantic search.
 */
export async function storeMemory(
  content: string,
  tags: string[] = [],
  importance: number = 3
): Promise<Memory> {
  const db = getSupabaseClient();
  const userId = env().TELEGRAM_ALLOWED_USER_ID;

  // Generate embedding (best-effort — don't fail if embedding API is down)
  let embedding: number[] | null = null;
  try {
    embedding = await generateEmbedding(content);
  } catch (err) {
    console.warn("[memory] Failed to generate embedding, storing without vector:", err);
  }

  const { data, error } = await db
    .from("memories")
    .insert({ user_id: userId, content, tags, embedding, importance })
    .select()
    .single();

  if (error) throw new Error(`Failed to store memory: ${error.message}`);
  return data;
}

/**
 * Searches memories using semantic similarity (pgvector) with keyword fallback.
 */
export async function searchMemories(
  query: string,
  limit = 5
): Promise<Memory[]> {
  const db = getSupabaseClient();
  const userId = env().TELEGRAM_ALLOWED_USER_ID;

  // Try semantic search first
  try {
    const embedding = await generateEmbedding(query);
    const { data, error } = await db.rpc("match_memories", {
      query_embedding: embedding,
      match_threshold: 0.7,
      match_count: limit,
      p_user_id: userId,
    });

    if (!error && data && data.length > 0) {
      return data as Memory[];
    }
  } catch {
    // Fall through to keyword search
  }

  // Keyword fallback
  const { data, error } = await db
    .from("memories")
    .select()
    .eq("user_id", userId)
    .ilike("content", `%${query}%`)
    .order("importance", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to search memories: ${error.message}`);
  return data ?? [];
}

/**
 * Lists all memories for the user, sorted by importance then recency.
 */
export async function listMemories(limit = 20): Promise<Memory[]> {
  const db = getSupabaseClient();
  const { data, error } = await db
    .from("memories")
    .select()
    .eq("user_id", env().TELEGRAM_ALLOWED_USER_ID)
    .order("importance", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to list memories: ${error.message}`);
  return data ?? [];
}

/**
 * Deletes a memory by ID.
 */
export async function deleteMemory(memoryId: string): Promise<void> {
  const db = getSupabaseClient();
  const { error } = await db.from("memories").delete().eq("id", memoryId);
  if (error) throw new Error(`Failed to delete memory: ${error.message}`);
}

/**
 * Builds a memory context string to inject into the LLM prompt.
 * Fetches recent and relevant memories to ground the response.
 */
export async function buildMemoryContext(
  userMessage: string
): Promise<string | null> {
  try {
    const memories = await searchMemories(userMessage, 5);
    if (memories.length === 0) return null;

    const lines = formatMemoryLines(memories);
    return `## Relevant memories about the user:\n${lines}`;
  } catch {
    return null; // Memory failure should never break the main response
  }
}
