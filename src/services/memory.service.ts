import { getDataStore } from "../db/datastore-provider.js";
import { env } from "../config/env.js";
import type { Memory } from "../db/schema.js";
import {
  rememberAction,
  recallMemoriesAction,
  generateEmbedding,
} from "../actions/actions.js";

export { generateEmbedding };

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

export async function storeMemory(
  content: string,
  tags: string[] = [],
  importance: number = 3
): Promise<Memory> {
  return rememberAction(content, tags, importance);
}

export async function searchMemories(
  query: string,
  limit = 5
): Promise<Memory[]> {
  return recallMemoriesAction(query, limit);
}

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
