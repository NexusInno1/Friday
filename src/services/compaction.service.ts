import { getSupabaseClient } from "../db/supabase.js";
import { env } from "../config/env.js";
import { storeMemory } from "./memory.service.js";
import { getModel } from "./agent.service.js";
import { generateText } from "ai";

/**
 * ADR-0006: Rolling 30-Day Message Retention with Fact Compaction
 *
 * This service runs as a daily cron job to:
 * 1. Extract durable facts from conversations older than 30 days
 * 2. Store extracted facts as atomic memories
 * 3. Delete the raw messages after compaction
 *
 * Fact Compaction is the automated extraction and crystallization of
 * enduring preferences from ephemeral conversation turns into
 * Long-Term Memory before raw logs age out. (CONTEXT.md)
 */

const RETENTION_DAYS = 30;
const COMPACTION_BATCH_SIZE = 50;

/**
 * The LLM prompt used to extract durable facts from conversation messages.
 * Returns a JSON array of fact objects.
 */
const EXTRACTION_PROMPT = `You are a fact extraction engine. Given a batch of conversation messages between a user and their AI assistant, extract any durable personal facts, preferences, decisions, or important information worth remembering long-term.

Rules:
- Extract ONLY facts that would be useful weeks or months from now
- Ignore transient chitchat, greetings, and ephemeral questions
- Each fact should be a clear, standalone statement
- Include an importance rating (1-5): 5 = critical life fact, 1 = minor preference
- Include relevant tags for categorization
- If no durable facts exist in the messages, return an empty array

Respond with ONLY a JSON array, no markdown fencing:
[{"content": "fact statement", "importance": 3, "tags": ["category"]}]`;

/**
 * Main compaction entry point. Called by the scheduler once daily.
 *
 * 1. Finds conversations with messages older than RETENTION_DAYS
 * 2. Extracts facts from those messages via LLM
 * 3. Stores extracted facts as memories
 * 4. Deletes the old messages
 */
export async function runFactCompaction(): Promise<{
  conversationsProcessed: number;
  factsExtracted: number;
  messagesDeleted: number;
}> {
  const db = getSupabaseClient();
  const cutoffDate = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  let totalFacts = 0;
  let totalDeleted = 0;
  let conversationsProcessed = 0;

  // Find conversations with old messages
  const { data: oldConversations, error: convError } = await db
    .from("messages")
    .select("conversation_id")
    .lt("created_at", cutoffDate)
    .limit(100);

  if (convError) {
    console.error("[compaction] Failed to find old conversations:", convError.message);
    return { conversationsProcessed: 0, factsExtracted: 0, messagesDeleted: 0 };
  }

  // Deduplicate conversation IDs
  const uniqueConvIds = [
    ...new Set((oldConversations ?? []).map((m) => m.conversation_id)),
  ];

  for (const conversationId of uniqueConvIds) {
    try {
      // Fetch old messages for this conversation
      const { data: oldMessages, error: msgError } = await db
        .from("messages")
        .select("role, content, created_at")
        .eq("conversation_id", conversationId)
        .lt("created_at", cutoffDate)
        .order("created_at", { ascending: true })
        .limit(COMPACTION_BATCH_SIZE);

      if (msgError || !oldMessages || oldMessages.length === 0) continue;

      // Extract facts via LLM
      const facts = await extractFacts(oldMessages);

      // Store each extracted fact as a memory
      for (const fact of facts) {
        try {
          await storeMemory(
            fact.content,
            [...(fact.tags ?? []), "compacted"],
            fact.importance ?? 3
          );
          totalFacts++;
        } catch (err) {
          console.warn("[compaction] Failed to store extracted fact:", err);
        }
      }

      // Delete the compacted messages
      const { count, error: deleteError } = await db
        .from("messages")
        .delete({ count: "exact" })
        .eq("conversation_id", conversationId)
        .lt("created_at", cutoffDate);

      if (deleteError) {
        console.error("[compaction] Failed to delete old messages:", deleteError.message);
      } else {
        totalDeleted += count ?? 0;
      }

      conversationsProcessed++;
    } catch (err) {
      console.error(`[compaction] Error processing conversation ${conversationId}:`, err);
    }
  }

  console.log(
    `[compaction] Complete: ${conversationsProcessed} conversations, ` +
      `${totalFacts} facts extracted, ${totalDeleted} messages deleted`
  );

  return {
    conversationsProcessed,
    factsExtracted: totalFacts,
    messagesDeleted: totalDeleted,
  };
}

/**
 * Uses the LLM to extract durable facts from a batch of messages.
 * Falls back to an empty array on any failure.
 */
async function extractFacts(
  messages: Array<{ role: string; content: string; created_at: string }>
): Promise<Array<{ content: string; importance: number; tags: string[] }>> {
  try {
    const conversationText = messages
      .map((m) => `[${m.role}] ${m.content}`)
      .join("\n");

    const result = await generateText({
      model: getModel(),
      system: EXTRACTION_PROMPT,
      messages: [{ role: "user", content: conversationText }],
      maxSteps: 1,
    });

    const parsed = JSON.parse(result.text);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (f: unknown): f is { content: string; importance: number; tags: string[] } =>
        typeof f === "object" &&
        f !== null &&
        "content" in f &&
        typeof (f as { content: unknown }).content === "string"
    );
  } catch (err) {
    console.warn("[compaction] Fact extraction failed, skipping batch:", err);
    return [];
  }
}
