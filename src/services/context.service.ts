import { getSupabaseClient } from "../db/supabase.js";
import { env } from "../config/env.js";
import type { Message } from "../db/schema.js";

const MAX_CONTEXT_MESSAGES = 20;

/**
 * Gets or creates the active conversation for a Telegram chat.
 */
export async function getOrCreateConversation(chatId: number): Promise<string> {
  const db = getSupabaseClient();

  // Look for recent conversation (last 24h)
  const { data: existing } = await db
    .from("conversations")
    .select("id")
    .eq("telegram_chat_id", chatId)
    .gte("updated_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) return existing.id;

  // Create new conversation
  const { data, error } = await db
    .from("conversations")
    .insert({ telegram_chat_id: chatId })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to create conversation: ${error.message}`);
  return data.id;
}

/**
 * Saves a message to the conversation history.
 * Optionally reuses an already-resolved conversationId to avoid extra DB lookups.
 */
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
  const db = getSupabaseClient();
  const conversationId =
    typeof chatIdOrConversationId === "string"
      ? chatIdOrConversationId
      : options.conversationId ?? (await getOrCreateConversation(chatIdOrConversationId));

  const { error } = await db.from("messages").insert({
    conversation_id: conversationId,
    role,
    content,
    tool_name: options.toolName ?? null,
    tool_call_id: options.toolCallId ?? null,
    tokens_used: options.tokensUsed ?? null,
  });

  if (error) console.error("[context] Failed to save message:", error.message);

  // Touch updated_at on conversation
  await db
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}

/**
 * Retrieves the last N messages for building the LLM context window.
 * Applies a sliding window to stay within token budget.
 */
export async function getContextMessages(
  chatIdOrConversationId: number | string,
  limit = MAX_CONTEXT_MESSAGES
): Promise<Array<{ role: Message["role"]; content: string }>> {
  const db = getSupabaseClient();
  const conversationId =
    typeof chatIdOrConversationId === "string"
      ? chatIdOrConversationId
      : await getOrCreateConversation(chatIdOrConversationId);

  const { data, error } = await db
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[context] Failed to fetch messages:", error.message);
    return [];
  }

  // Reverse to chronological order
  return (data ?? []).reverse();
}

/**
 * Clears all messages in the active conversation (for /clear command).
 */
export async function clearConversation(chatId: number): Promise<void> {
  const db = getSupabaseClient();
  const allowedOwnerId = env().TELEGRAM_ALLOWED_USER_ID;

  const { data: convs } = await db
    .from("conversations")
    .select("id")
    .eq("telegram_chat_id", chatId);

  if (!convs?.length) return;

  for (const conv of convs) {
    await db.from("messages").delete().eq("conversation_id", conv.id);
  }

  // Log event
  await db.from("activity_logs").insert({
    user_id: allowedOwnerId,
    event_type: "conversation_cleared",
    payload: { chat_id: chatId },
  });
}
