import { z } from "zod";
import { getDataStore } from "../db/datastore-provider.js";
import { rememberAction } from "../actions/actions.js";
import { getModel } from "./model.service.js";
import { generateText } from "ai";
import type { DataStore } from "../db/datastore.js";
import { checkAndIncrementUsage } from "./cost-tracker.service.js";

/**
 * ADR-0006: Rolling 30-Day Message Retention with Fact Compaction
 *
 * This service runs as a daily cron job to:
 * 1. Extract durable facts from conversations older than 30 days
 * 2. Store extracted facts as atomic memories
 * 3. Delete or soft-delete raw messages after compaction
 */

const RETENTION_DAYS = 30;
const COMPACTION_BATCH_SIZE = 50;
const MAX_EXTRACTION_FAILURES = 3;
const conversationFailureCounts = new Map<string, number>();

/** For testing or resetting quarantine state */
export function resetCompactionQuarantine(): void {
  conversationFailureCounts.clear();
}

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

export const FactItemSchema = z
  .object({
    content: z.string().optional(),
    fact: z.string().optional(),
    statement: z.string().optional(),
    importance: z.union([z.number(), z.string()]).nullish(),
    tags: z.union([z.array(z.string()), z.string()]).nullish(),
  })
  .transform((val, ctx) => {
    const content = (val.content ?? val.fact ?? val.statement)?.trim();
    if (!content) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Fact must have non-empty content",
      });
      return z.NEVER;
    }

    let parsedImportance = 3;
    if (val.importance !== undefined && val.importance !== null) {
      const num = typeof val.importance === "number" ? val.importance : parseFloat(val.importance);
      if (!isNaN(num)) {
        parsedImportance = Math.min(5, Math.max(1, Math.round(num)));
      }
    }

    let parsedTags: string[] = [];
    if (Array.isArray(val.tags)) {
      parsedTags = val.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    } else if (typeof val.tags === "string" && val.tags.trim().length > 0) {
      parsedTags = val.tags.split(",").map((t) => t.trim()).filter(Boolean);
    }

    return {
      content,
      importance: parsedImportance,
      tags: parsedTags,
    };
  });

export const FactExtractionResponseSchema = z.union([
  z.array(FactItemSchema),
  z
    .object({
      facts: z.array(FactItemSchema),
    })
    .transform((val) => val.facts),
]);

export type ExtractedFact = z.infer<typeof FactItemSchema>;

export type FactExtractor = (
  messages: Array<{ id: string; role: string; content: string; created_at: string }>
) => Promise<{
  success: boolean;
  facts: Array<{ content: string; importance: number; tags: string[] }>;
  abortedDueToQuota?: boolean;
}>;

export async function runFactCompaction(
  store: DataStore = getDataStore(),
  extractor: FactExtractor = extractFacts,
  options?: { softDelete?: boolean }
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
    const failureCount = conversationFailureCounts.get(conversationId) ?? 0;
    if (failureCount >= MAX_EXTRACTION_FAILURES) {
      console.warn(
        `[compaction] Skipping conversation ${conversationId}: quarantined after ${failureCount} extraction failures.`
      );
      continue;
    }

    try {
      const oldMessages = await store.getConversationMessagesBefore(
        conversationId,
        cutoffDate,
        COMPACTION_BATCH_SIZE
      );

      if (!oldMessages || oldMessages.length === 0) continue;

      const extraction = await extractor(oldMessages);

      if (extraction.abortedDueToQuota) {
        console.warn(
          `[compaction] Aborting compaction run: LLM usage limit reached while processing conversation ${conversationId}.`
        );
        break;
      }

      if (!extraction.success) {
        const nextFailures = (conversationFailureCounts.get(conversationId) ?? 0) + 1;
        conversationFailureCounts.set(conversationId, nextFailures);
        console.error(
          `[compaction] Skipping message deletion for conversation ${conversationId} due to extraction failure (attempt ${nextFailures}/${MAX_EXTRACTION_FAILURES}).`
        );
        continue;
      }

      // In hard-delete mode, if messages exist but 0 facts were extracted, abort deletion to prevent silent message loss.
      // In soft-delete mode, messages are preserved with compacted_at, so archiving them is non-destructive.
      if (!options?.softDelete && extraction.facts.length === 0 && oldMessages.length > 0) {
        console.warn(
          `[compaction] Aborting hard-deletion for conversation ${conversationId}: 0 facts extracted from ${oldMessages.length} existing messages to prevent permanent message loss.`
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

      // Never delete source messages when any fact write failed.
      if (!allFactsStored) {
        const nextFailures = (conversationFailureCounts.get(conversationId) ?? 0) + 1;
        conversationFailureCounts.set(conversationId, nextFailures);
        console.error(
          `[compaction] Retaining messages for conversation ${conversationId} because one or more facts could not be stored (attempt ${nextFailures}/${MAX_EXTRACTION_FAILURES}).`
        );
        continue;
      }

      // Safe batch deletion / soft-deletion: Delete ONLY the exact message IDs that were extracted and processed
      const extractedMessageIds = oldMessages.map((m) => m.id);
      let deletedCount = 0;
      if (options?.softDelete && typeof store.markMessagesCompacted === "function") {
        deletedCount = await store.markMessagesCompacted(extractedMessageIds);
      } else {
        deletedCount = await store.deleteMessagesByIds(extractedMessageIds);
      }

      totalDeleted += deletedCount;
      conversationsProcessed++;

      // Successfully processed: clear failure count
      conversationFailureCounts.delete(conversationId);
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
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  } else {
    // If no code fence, attempt to extract outermost JSON structure (honoring whichever opens first)
    const firstBracket = cleaned.indexOf("[");
    const firstBrace = cleaned.indexOf("{");
    if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
      const arrayMatch = cleaned.match(/(\[[\s\S]*\])/);
      if (arrayMatch) {
        cleaned = arrayMatch[1].trim();
      }
    } else if (firstBrace !== -1) {
      const objectMatch = cleaned.match(/(\{[\s\S]*\})/);
      if (objectMatch) {
        cleaned = objectMatch[1].trim();
      }
    }
  }
  return cleaned;
}

export async function extractFacts(
  messages: Array<{ id: string; role: string; content: string; created_at: string }>
): Promise<{
  success: boolean;
  facts: Array<{ content: string; importance: number; tags: string[] }>;
  abortedDueToQuota?: boolean;
}> {
  try {
    const usageCheck = await checkAndIncrementUsage("llm");
    if (!usageCheck.allowed) {
      console.warn("[compaction] Fact extraction aborted: LLM usage limit reached.");
      return { success: false, facts: [], abortedDueToQuota: true };
    }

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
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error("[compaction] Fact extraction returned invalid JSON text:", cleaned);
      return { success: false, facts: [] };
    }

    const parseResult = FactExtractionResponseSchema.safeParse(parsed);
    if (!parseResult.success) {
      console.error("[compaction] Fact extraction schema validation failed:", parseResult.error.format());
      return { success: false, facts: [] };
    }

    return { success: true, facts: parseResult.data };
  } catch (err) {
    console.error("[compaction] Fact extraction failed:", err);
    return { success: false, facts: [] };
  }
}
