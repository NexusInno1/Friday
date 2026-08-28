import { getDataStore } from "../db/datastore-provider.js";
import { env } from "../config/env.js";
import type { Message } from "../db/schema.js";

const MAX_CONTEXT_MESSAGES = 20;

export async function getOrCreateConversation(chatId: number): Promise<string> {
  const store = getDataStore();
  return store.getOrCreateConversation(chatId);
}

export async function saveMessage(
  chatIdOrConversationId: number | string,
  role: Message["role"],
  content: string,
  options: {
    toolName?: string;
    toolCallId?: string;
    tokensUsed?: number;
    conversationId?: string;
  } = {}
): Promise<void> {
  const store = getDataStore();
  const conversationId =
    typeof chatIdOrConversationId === "string"
      ? chatIdOrConversationId
      : options.conversationId ?? (await store.getOrCreateConversation(chatIdOrConversationId));

  await store.saveMessage(conversationId, role, content, options);
}

export async function getContextMessages(
  chatIdOrConversationId: number | string,
  limit = MAX_CONTEXT_MESSAGES
): Promise<Array<{ role: Message["role"]; content: string }>> {
  const store = getDataStore();
  const conversationId =
    typeof chatIdOrConversationId === "string"
      ? chatIdOrConversationId
      : await store.getOrCreateConversation(chatIdOrConversationId);

  return store.getContextMessages(conversationId, limit);
}

export async function clearConversation(chatId: number): Promise<void> {
  const store = getDataStore();
  const allowedOwnerId = env().TELEGRAM_ALLOWED_USER_ID;
  await store.clearConversation(chatId, allowedOwnerId);
}
