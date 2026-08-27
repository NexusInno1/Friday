import { getSupabaseClient } from "../db/supabase.js";
import { env } from "../config/env.js";
import type { Memory } from "../db/schema.js";

const EMBEDDING_MODEL = "text-embedding-004";

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
 * Similarity threshold above which a new memory is considered a
 * direct update/contradiction of an existing one (ADR-0004).
 */
const SUPERSEDE_THRESHOLD = 0.85;

/**
 * Stores a memory fact about the user in Supabase.
 * Generates an embedding for future semantic search.
 *
 * ADR-0004: Before inserting, checks for semantically similar active memories.
 * If a near-duplicate is found (similarity > SUPERSEDE_THRESHOLD), the old
 * memory is marked inactive and linked via `superseded_by` to the new one.
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

  // ADR-0004: Detect and supersede conflicting memories
  const supersededIds: string[] = [];
  if (embedding) {
    try {
      const { data: conflicts } = await db.rpc("match_memories", {
        query_embedding: embedding,
        match_threshold: SUPERSEDE_THRESHOLD,
        match_count: 3,
        p_user_id: userId,
      });

      if (conflicts && conflicts.length > 0) {
        for (const conflict of conflicts) {
          supersededIds.push(conflict.id);
        }
        console.log(
          `[memory] Superseding ${supersededIds.length} conflicting memor${supersededIds.length === 1 ? "y" : "ies"}`
        );
      }
    } catch (err) {
      console.warn("[memory] Conflict detection failed, inserting without supersede:", err);
    }
  }

  // Insert the new memory
  const { data, error } = await db
    .from("memories")
    .insert({ user_id: userId, content, tags, embedding, importance })
    .select()
    .single();

  if (error) throw new Error(`Failed to store memory: ${error.message}`);

  // Mark superseded memories as inactive and link to the new one
  if (supersededIds.length > 0 && data) {
    try {
      await db
        .from("memories")
        .update({ is_active: false, superseded_by: data.id })
        .in("id", supersededIds);
    } catch (err) {
      console.warn("[memory] Failed to mark superseded memories:", err);
    }
  }

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

    if (error) {
      console.warn("[memory] match_memories RPC error, falling back to keyword search:", error.message);
    } else if (data && data.length > 0) {
      return data as Memory[];
    }
  } catch (err) {
    console.warn("[memory] Semantic search failed, falling back to keyword search:", err);
  }

  // Keyword fallback
  const { data, error } = await db
    .from("memories")
    .select()
    .eq("user_id", userId)
    .eq("is_active", true)
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
    .eq("is_active", true)
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
  } catch (err) {
    console.warn("[memory] buildMemoryContext failed:", err);
    return null; // Memory failure should never break the main response
  }
}
