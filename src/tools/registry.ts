import { tool } from "ai";
import { z } from "zod";
import type { DataStore } from "../db/datastore.js";
import { getDataStore } from "../db/datastore-provider.js";
import { env } from "../config/env.js";
import {
  rememberAction,
  recallMemoriesAction,
  webSearchAction,
  createReminderAction,
  listRemindersAction,
  cancelReminderAction,
  snoozeReminderAction,
  updateBriefingTimeAction,
} from "../actions/actions.js";

// ─── Web Search Tool ─────────────────────────────────────────────────────────

export const webSearchTool = tool({
  description:
    "Search the web for real-time information, news, current events, facts, or research. " +
    "When searching for news, current events, or today's briefings, ALWAYS set topic='news' and days=1 to guarantee fresh coverage from the last 24 hours. " +
    "For comprehensive news requests, search across key pillars (International, Business, AI, and Regional). " +
    "Synthesize findings into an executive briefing with bold titles and structured bullet points. " +
    "Never dump raw snippets, unformatted lines, or conversational filler.",
  parameters: z.object({
    query: z.string().describe("The search query to look up"),
    topic: z
      .enum(["general", "news"])
      .optional()
      .describe(
        "Search topic mode. MUST use 'news' for current events, news headlines, and today's updates."
      ),
    days: z
      .number()
      .optional()
      .describe(
        "Days back to search. Set to 1 for today's current news to ensure results are strictly from the last 24 hours."
      ),
    max_results: z
      .number()
      .optional()
      .describe("Maximum number of results to return (defaults to 5)"),
  }),
  execute: async ({ query, topic, days, max_results }) => {
    return webSearchAction(query, {
      maxResults: max_results ?? 5,
      topic: topic ?? "general",
      days: days ?? (topic === "news" ? 1 : undefined),
    });
  },
});

// ─── Memory Tools ────────────────────────────────────────────────────────────

export const storeMemoryTool = tool({
  description:
    "Save an important fact, preference, decision, or note about the user for future reference. " +
    "Use this when the user shares personal information, preferences, goals, or important details they'd want remembered.",
  parameters: z.object({
    content: z
      .string()
      .describe("The fact or information to remember, written as a clear statement"),
    tags: z
      .array(z.string())
      .optional()
      .default([])
      .describe("Optional tags to categorize this memory (e.g. ['health', 'work', 'preference'])"),
    importance: z
      .number()
      .min(1)
      .max(5)
      .optional()
      .default(3)
      .describe("Importance level 1-5, where 5 is critical and 1 is minor"),
  }),
  execute: async ({ content, tags, importance }) => {
    await rememberAction(content, tags, importance);
    return { success: true, stored: content };
  },
});

export const recallMemoryTool = tool({
  description:
    "Search and retrieve memories and facts previously stored about the user. " +
    "Use this when context about the user's preferences, past decisions, or personal details would be helpful.",
  parameters: z.object({
    query: z.string().describe("What you want to look up or remember about the user"),
    limit: z
      .number()
      .optional()
      .default(5)
      .describe("Maximum number of memories to retrieve"),
  }),
  execute: async ({ query, limit }) => {
    const memories = await recallMemoriesAction(query, limit);
    if (memories.length === 0) {
      return { found: false, memories: [] };
    }
    return {
      found: true,
      memories: memories.map((m) => ({
        content: m.content,
        tags: m.tags,
        importance: m.importance,
        date: m.created_at,
      })),
    };
  },
});

// ─── Daily Briefing Settings Tool ────────────────────────────────────────────

export const setBriefingTimeTool = tool({
  description:
    "Set or change the daily morning briefing delivery time. " +
    "Use when the user asks to change, update, or set their morning briefing time (e.g., 'Change my briefing to 8:30 AM').",
  parameters: z.object({
    time: z
      .string()
      .describe("The time in 24-hour HH:MM or 12-hour format (e.g. '08:30', '8:30am', '7pm')"),
  }),
  execute: async ({ time }) => {
    const result = await updateBriefingTimeAction(time);
    return {
      success: true,
      new_briefing_time: result.time,
      timezone: env().USER_TIMEZONE,
      message: `Daily morning briefing time successfully updated to ${result.time} (${env().USER_TIMEZONE}).`,
    };
  },
});

import { registerPendingMemory } from "../services/memory-guard.service.js";

// ─── Scoped Tool Factory ─────────────────────────────────────────────────────

export interface ToolContext {
  chatId: number;
  userId?: number;
  store?: DataStore;
  dispatcher?: { sendMessage(chatId: number, text: string, options?: any): Promise<void> };
  turnState?: { usedWebSearch: boolean };
}

async function handleGuardedStoreMemory(
  content: string,
  tags: string[],
  importance: number,
  turnState: { usedWebSearch: boolean },
  targetUserId: number,
  targetChatId: number,
  store: DataStore,
  dispatcher?: { sendMessage(chatId: number, text: string, options?: any): Promise<void> }
) {
  if (turnState.usedWebSearch) {
    const pendingId = crypto.randomUUID();
    registerPendingMemory({
      id: pendingId,
      userId: targetUserId,
      chatId: targetChatId,
      content,
      tags: tags ?? [],
      importance: importance ?? 3,
      source: "web",
      createdAt: new Date().toISOString(),
    });

    if (dispatcher) {
      await dispatcher.sendMessage(
        targetChatId,
        `⚠️ **Memory Poisoning Guard: Confirmation Required**\n\nA web search occurred during this turn, and the assistant attempted to save a memory derived from web content:\n\n> "${content}"\n\nDo you want to permanently store this memory?`,
        {
          buttons: [
            { text: "✅ Save Memory", data: `confirm_mem:${pendingId}` },
            { text: "❌ Reject", data: `reject_mem:${pendingId}` },
          ],
        }
      );
    }

    return {
      success: false,
      pending_confirmation: true,
      pending_id: pendingId,
      message:
        "Guard Triggered: store_memory cannot be executed in the same turn as web_search without explicit owner confirmation. A confirmation prompt with interactive inline buttons has been dispatched to the owner on Telegram. The memory has NOT been saved permanently.",
    };
  }

  await rememberAction(content, tags, importance, store, targetUserId, "user");
  return { success: true, stored: content };
}

export function createTools(context?: ToolContext) {
  const targetChatId = context?.chatId ?? env().TELEGRAM_ALLOWED_USER_ID;
  const targetUserId = context?.userId ?? env().TELEGRAM_ALLOWED_USER_ID;
  const store = context?.store ?? getDataStore();
  const turnState = context?.turnState ?? { usedWebSearch: false };

  const createReminderScopedTool = tool({
    description:
      "Create a reminder to send the user a message at a specific date and time. " +
      "Use when the user asks to be reminded about something.",
    parameters: z.object({
      message: z.string().describe("The reminder message to send the user"),
      trigger_at: z
        .string()
        .describe(
          "ISO 8601 datetime string for when to send the reminder (e.g. 2025-06-01T09:00:00+05:30)"
        ),
      is_recurring: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether this is a recurring reminder"),
      cron_expression: z
        .string()
        .optional()
        .describe("Cron expression for recurring reminders (e.g. '0 9 * * 1' for every Monday at 9am)"),
    }),
    execute: async ({ message, trigger_at, is_recurring, cron_expression }) => {
      const data = await createReminderAction(
        {
          userId: targetUserId,
          chatId: targetChatId,
          message,
          triggerAt: trigger_at,
          isRecurring: is_recurring,
          cronExpression: cron_expression,
        },
        store
      );

      return {
        success: true,
        id: data.id,
        message: data.message,
        scheduled_for: data.trigger_at,
      };
    },
  });

  const listRemindersScopedTool = tool({
    description: "List all active (pending) reminders for the user.",
    parameters: z.object({}),
    execute: async () => {
      const reminders = await listRemindersAction(targetUserId, 20, store);
      return { reminders };
    },
  });

  const cancelReminderScopedTool = tool({
    description: "Cancel a specific reminder by its ID.",
    parameters: z.object({
      reminder_id: z.string().describe("The UUID or ID of the reminder to cancel"),
    }),
    execute: async ({ reminder_id }) => {
      const res = await cancelReminderAction(reminder_id, targetUserId, store);
      return { success: res.success, cancelled_id: res.cancelledId };
    },
  });

  const snoozeReminderScopedTool = tool({
    description: "Snooze a reminder by delaying it by a specified number of minutes.",
    parameters: z.object({
      reminder_id: z.string().describe("The UUID or ID of the reminder to snooze"),
      minutes: z.number().positive().describe("Number of minutes to delay the reminder"),
    }),
    execute: async ({ reminder_id, minutes }) => {
      const res = await snoozeReminderAction(reminder_id, minutes, targetUserId, store);
      return { success: true, new_trigger_at: res.newTriggerAt };
    },
  });

  const webSearchScopedTool = tool({
    description: webSearchTool.description,
    parameters: webSearchTool.parameters,
    execute: async ({ query, topic, days, max_results }) => {
      turnState.usedWebSearch = true;
      return webSearchAction(query, {
        maxResults: max_results ?? 5,
        topic: topic ?? "general",
        days: days ?? (topic === "news" ? 1 : undefined),
      });
    },
  });

  const storeMemoryScopedTool = tool({
    description: storeMemoryTool.description,
    parameters: storeMemoryTool.parameters,
    execute: async ({ content, tags, importance }) => {
      return handleGuardedStoreMemory(
        content,
        tags ?? [],
        importance ?? 3,
        turnState,
        targetUserId,
        targetChatId,
        store,
        context?.dispatcher
      );
    },
  });

  const recallMemoryScopedTool = tool({
    description: recallMemoryTool.description,
    parameters: recallMemoryTool.parameters,
    execute: async ({ query, limit }) => {
      const memories = await recallMemoriesAction(query, limit, store, targetUserId);
      if (memories.length === 0) {
        return { found: false, memories: [] };
      }
      return {
        found: true,
        memories: memories.map((m) => ({
          content: m.content,
          tags: m.tags,
          importance: m.importance,
          source: m.source ?? "user",
          date: m.created_at,
        })),
      };
    },
  });

  const setBriefingTimeScopedTool = tool({
    description: setBriefingTimeTool.description,
    parameters: setBriefingTimeTool.parameters,
    execute: async ({ time }) => {
      const result = await updateBriefingTimeAction(time, targetUserId, store);
      return {
        success: true,
        new_briefing_time: result.time,
        timezone: env().USER_TIMEZONE,
        message: `Daily morning briefing time successfully updated to ${result.time} (${env().USER_TIMEZONE}).`,
      };
    },
  });

  const searchConversationHistoryScopedTool = tool({
    description:
      "Search previous conversation history, past discussions, decisions, and chat transcripts with the user. " +
      "Use when the user asks about prior discussions, past topics, or previously discussed code, links, or plans.",
    parameters: z.object({
      query: z.string().describe("The topic, question, or keyword to look up in past conversations"),
      limit: z
        .number()
        .optional()
        .default(5)
        .describe("Maximum number of historical excerpts to retrieve"),
    }),
    execute: async ({ query, limit }) => {
      const results = await store.searchMessageHistory(targetChatId, query, { limit: limit ?? 5 });
      if (results.length === 0) {
        return { found: false, matches: [] };
      }
      return {
        found: true,
        matches: results.map((r) => ({
          session_title: r.sessionTitle ?? "Untitled Session",
          role: r.role,
          content: r.content,
          date: r.createdAt,
        })),
      };
    },
  });

  return {
    web_search: webSearchScopedTool,
    store_memory: storeMemoryScopedTool,
    recall_memory: recallMemoryScopedTool,
    create_reminder: createReminderScopedTool,
    list_reminders: listRemindersScopedTool,
    cancel_reminder: cancelReminderScopedTool,
    snooze_reminder: snoozeReminderScopedTool,
    set_briefing_time: setBriefingTimeScopedTool,
    search_conversation_history: searchConversationHistoryScopedTool,
  };
}

/**
 * Creates tools with streamlined, simplified schemas suitable for Llama (Groq) models
 * which struggle with verbose descriptions, optional-with-default nesting, or complex schemas.
 */
export function createSimplifiedTools(context?: ToolContext) {
  const targetChatId = context?.chatId ?? env().TELEGRAM_ALLOWED_USER_ID;
  const targetUserId = context?.userId ?? env().TELEGRAM_ALLOWED_USER_ID;
  const store = context?.store ?? getDataStore();
  const turnState = context?.turnState ?? { usedWebSearch: false };

  return {
    create_reminder: tool({
      description: "Create a reminder with message and ISO trigger datetime.",
      parameters: z.object({
        message: z.string().describe("Reminder message text"),
        trigger_at: z.string().describe("ISO datetime string"),
      }),
      execute: async ({ message, trigger_at }) => {
        const data = await createReminderAction(
          {
            userId: targetUserId,
            chatId: targetChatId,
            message,
            triggerAt: trigger_at,
          },
          store
        );
        return { success: true, id: data.id, message: data.message, scheduled_for: data.trigger_at };
      },
    }),
    list_reminders: tool({
      description: "List pending reminders.",
      parameters: z.object({}),
      execute: async () => {
        const reminders = await listRemindersAction(targetUserId, 20, store);
        return { reminders };
      },
    }),
    cancel_reminder: tool({
      description: "Cancel a reminder by ID.",
      parameters: z.object({
        reminder_id: z.string(),
      }),
      execute: async ({ reminder_id }) => {
        const res = await cancelReminderAction(reminder_id, targetUserId, store);
        return { success: res.success, cancelled_id: res.cancelledId };
      },
    }),
    snooze_reminder: tool({
      description: "Delay a reminder by minutes.",
      parameters: z.object({
        reminder_id: z.string(),
        minutes: z.number(),
      }),
      execute: async ({ reminder_id, minutes }) => {
        const res = await snoozeReminderAction(reminder_id, minutes, targetUserId, store);
        return { success: true, new_trigger_at: res.newTriggerAt };
      },
    }),
    web_search: tool({
      description: "Search web for current news or facts.",
      parameters: z.object({
        query: z.string(),
      }),
      execute: async ({ query }) => {
        turnState.usedWebSearch = true;
        return webSearchAction(query, { maxResults: 5 });
      },
    }),
    store_memory: tool({
      description: "Save a fact about the user.",
      parameters: z.object({
        content: z.string(),
      }),
      execute: async ({ content }) => {
        return handleGuardedStoreMemory(
          content,
          [],
          3,
          turnState,
          targetUserId,
          targetChatId,
          store,
          context?.dispatcher
        );
      },
    }),
    recall_memory: tool({
      description: "Retrieve stored memories about user.",
      parameters: z.object({
        query: z.string(),
      }),
      execute: async ({ query }) => {
        const memories = await recallMemoriesAction(query, 5, store, targetUserId);
        return {
          found: memories.length > 0,
          memories: memories.map((m) => ({
            content: m.content,
            source: m.source ?? "user",
          })),
        };
      },
    }),
    set_briefing_time: tool({
      description: "Set daily briefing time (HH:MM).",
      parameters: z.object({
        time: z.string(),
      }),
      execute: async ({ time }) => {
        const result = await updateBriefingTimeAction(time);
        return { success: true, new_briefing_time: result.time };
      },
    }),
    search_conversation_history: tool({
      description: "Search prior chat history.",
      parameters: z.object({
        query: z.string(),
      }),
      execute: async ({ query }) => {
        const results = await store.searchMessageHistory(targetChatId, query, { limit: 5 });
        return {
          found: results.length > 0,
          matches: results.map((r) => ({ role: r.role, content: r.content })),
        };
      },
    }),
  };
}
