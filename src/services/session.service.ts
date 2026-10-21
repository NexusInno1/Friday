import { generateText } from "ai";
import { getDataStore } from "../db/datastore-provider.js";
import type { DataStore } from "../db/datastore.js";
import { getModel } from "./model.service.js";
import type { ConversationSession, HistorySearchResult } from "../db/schema.js";

const TITLE_PROMPT = `You are a concise conversation titler. Given the first few messages of a dialogue between a user and their AI assistant, produce a brief 3 to 5 word topic title.
Rules:
- Be specific to the topic discussed (e.g. "Docker Deployment Setup", "Weekend Dinner Recipes", "TypeScript Type Errors").
- Do NOT use generic titles like "General Conversation" or "Chat with Assistant".
- Respond with ONLY the title. No quotes, no markdown, no punctuation.`;

/**
 * Automatically creates a 3-5 word descriptive title for an untitled conversation session
 * once it contains at least 2 messages.
 */
export async function maybeAutoTitleSession(
  conversationId: string,
  store: DataStore = getDataStore()
): Promise<string | null> {
  try {
    const messages = await store.getSessionMessages(conversationId, 6);
    if (messages.length < 2) {
      return null;
    }

    const transcript = messages
      .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 300)}`)
      .join("\n");

    const result = await generateText({
      model: getModel(),
      system: TITLE_PROMPT,
      prompt: `Dialogue:\n${transcript}\n\nTitle:`,
      maxTokens: 20,
    });

    const cleanedTitle = result.text.replace(/["'`*]/g, "").trim();
    if (cleanedTitle && cleanedTitle.length > 2) {
      await store.updateSessionTitle(conversationId, cleanedTitle);
      return cleanedTitle;
    }
  } catch (err) {
    console.warn(`[session.service] Auto-titling failed for ${conversationId}:`, err);
  }
  return null;
}

export async function listRecentSessions(
  chatId: number,
  limit = 10,
  store: DataStore = getDataStore()
): Promise<ConversationSession[]> {
  return store.listSessions(chatId, limit);
}

export async function getActiveSession(
  chatId: number,
  store: DataStore = getDataStore()
): Promise<ConversationSession | null> {
  return store.getActiveSession(chatId);
}

export async function switchSession(
  chatId: number,
  conversationId: string,
  store: DataStore = getDataStore()
): Promise<ConversationSession> {
  return store.switchActiveSession(chatId, conversationId);
}

export async function archiveActiveSession(
  chatId: number,
  store: DataStore = getDataStore()
): Promise<void> {
  return store.archiveSession(chatId);
}

export async function deleteSession(
  conversationId: string,
  store: DataStore = getDataStore()
): Promise<void> {
  return store.deleteSession(conversationId);
}

export async function searchChatHistory(
  chatId: number,
  query: string,
  limit = 10,
  store: DataStore = getDataStore()
): Promise<HistorySearchResult[]> {
  return store.searchMessageHistory(chatId, query, { limit });
}
