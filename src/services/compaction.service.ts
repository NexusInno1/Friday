import { getDataStore } from "../db/datastore-provider.js";
import { rememberAction } from "../actions/actions.js";
import { getModel } from "./agent.service.js";
import { generateText } from "ai";
import type { DataStore } from "../db/datastore.js";

/**
 * ADR-0006: Rolling 30-Day Message Retention with Fact Compaction
 *
 * This service runs as a daily cron job to:
 * 1. Extract durable facts from conversations older than 30 days
 * 2. Store extracted facts as atomic memories
 * 3. Delete the raw messages after compaction
 */

const RETENTION_DAYS = 30;
const COMPACTION_BATCH_SIZE = 50;

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

export async function runFactCompaction(
  store: DataStore = getDataStore()
): Promise<{
  conversationsProcessed: number;
  factsExtracted: number;
  messagesDeleted: number;
}> {
  const cutoffDate = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  let totalFacts = 0;
  let totalDeleted = 0;
  let conversationsProcessed = 0;

  const oldConversations = await store.getOldMessages(cutoffDate, 100);

  const uniqueConvIds = [
    ...new Set(oldConversations.map((m) => m.conversation_id)),
  ];

  for (const conversationId of uniqueConvIds) {
    try {
      const oldMessages = await store.getConversationMessagesBefore(
        conversationId,
        cutoffDate,
        COMPACTION_BATCH_SIZE
      );

      if (!oldMessages || oldMessages.length === 0) continue;

      const extraction = await extractFacts(oldMessages);

      if (!extraction.success) {
        console.error(
          `[compaction] Skipping message deletion for conversation ${conversationId} due to extraction failure.`
        );
        continue;
      }

      let allFactsStored = true;
      for (const fact of extraction.facts) {
        try {
          await rememberAction(
            fact.content,
            [...(fact.tags ?? []), "compacted"],
            fact.importance ?? 3,
            store
          );
          totalFacts++;
        } catch (err) {
          allFactsStored = false;
          console.warn("[compaction] Failed to store extracted fact:", err);
        }
      }

      // Never delete source messages when a fact write failed. The batch will be
      // retried while the source remains available (later deduplication/provenance
      // can make successful partial writes idempotent).
      if (!allFactsStored) {
        console.error(
          `[compaction] Retaining messages for conversation ${conversationId} because one or more facts could not be stored.`
        );
        continue;
      }

      // Safe batch deletion: Delete ONLY the exact message IDs that were extracted and processed
      const extractedMessageIds = oldMessages.map((m) => m.id);
      const deletedCount = await store.deleteMessagesByIds(extractedMessageIds);
      totalDeleted += deletedCount;
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

export function cleanJsonText(rawText: string): string {
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  return cleaned;
}

async function extractFacts(
  messages: Array<{ role: string; content: string; created_at: string }>
): Promise<{
  success: boolean;
  facts: Array<{ content: string; importance: number; tags: string[] }>;
}> {
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

    const cleaned = cleanJsonText(result.text);
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      return { success: true, facts: [] };
    }

    const facts = parsed.filter(
      (f: unknown): f is { content: string; importance: number; tags: string[] } =>
        typeof f === "object" &&
        f !== null &&
        "content" in f &&
        typeof (f as { content: unknown }).content === "string"
    );

    return { success: true, facts };
  } catch (err) {
    console.error("[compaction] Fact extraction failed:", err);
    return { success: false, facts: [] };
  }
}
