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
import { getScheduler } from "../services/scheduler.service.js";
import { registerPendingMemory } from "../services/memory-guard.service.js";

// ─── Shared Schemas ──────────────────────────────────────────────────────────

export const webSearchStandardParams = z.object({
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
});

export const webSearchSimplifiedParams = z.object({
  query: z.string().describe("The search query to look up"),
});

export const storeMemoryStandardParams = z.object({
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
});

export const storeMemorySimplifiedParams = z.object({
  content: z.string().describe("The fact or information to remember"),
});

export const recallMemoryStandardParams = z.object({
  query: z.string().describe("What you want to look up or remember about the user"),
  limit: z
    .number()
    .optional()
    .default(5)
    .describe("Maximum number of memories to retrieve"),
});

export const recallMemorySimplifiedParams = z.object({
  query: z.string().describe("What you want to look up or remember about the user"),
});

export const createReminderStandardParams = z.object({
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
});

export const createReminderSimplifiedParams = z.object({
  message: z.string().describe("Reminder message text"),
  trigger_at: z.string().describe("ISO datetime string"),
});

export const setBriefingTimeParams = z.object({
  time: z
    .string()
    .describe("The time in 24-hour HH:MM or 12-hour format (e.g. '08:30', '8:30am', '7pm')"),
});

export const cancelReminderParams = z.object({
  reminder_id: z.string().describe("The UUID or ID of the reminder to cancel"),
});

export const snoozeReminderStandardParams = z.object({
  reminder_id: z.string().describe("The UUID or ID of the reminder to snooze"),
  minutes: z.number().positive().describe("Number of minutes to delay the reminder"),
});

export const snoozeReminderSimplifiedParams = z.object({
  reminder_id: z.string().describe("The UUID or ID of the reminder to snooze"),
  minutes: z.number().describe("Number of minutes to delay the reminder"),
});

export const searchHistoryStandardParams = z.object({
  query: z.string().describe("The topic, question, or keyword to look up in past conversations"),
  limit: z
    .number()
    .optional()
    .default(5)
    .describe("Maximum number of historical excerpts to retrieve"),
});

export const searchHistorySimplifiedParams = z.object({
  query: z.string().describe("The topic, question, or keyword to look up in past conversations"),
});

// ─── Scoped Tool Context & Guard ─────────────────────────────────────────────

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

// ─── Core Tool Builder (Single Source of Truth) ──────────────────────────────

function buildStandardTools(context?: ToolContext) {
  const targetChatId = context?.chatId ?? env().TELEGRAM_ALLOWED_USER_ID;
  const targetUserId = context?.userId ?? env().TELEGRAM_ALLOWED_USER_ID;
  const store = context?.store ?? getDataStore();
  const turnState = context?.turnState ?? { usedWebSearch: false };

  const webSearch = tool({
    description:
      "Search the web for real-time information, news, current events, facts, or research. " +
      "When searching for news, current events, or today's briefings, ALWAYS set topic='news' and days=1 to guarantee fresh coverage from the last 24 hours. " +
      "For comprehensive news requests, search across key pillars (International, Business, AI, and Regional). " +
      "Synthesize findings into an executive briefing with bold titles and structured bullet points. " +
      "Never dump raw snippets, unformatted lines, or conversational filler.",
    parameters: webSearchStandardParams,
    execute: async ({ query, topic, days, max_results }) => {
      turnState.usedWebSearch = true;
      return webSearchAction(query, {
        maxResults: max_results ?? 5,
        topic: topic ?? "general",
        days: days ?? (topic === "news" ? 1 : undefined),
      });
    },
  });

  const storeMemory = tool({
    description:
      "Save an important fact, preference, decision, or note about the user for future reference. " +
      "Use this when the user shares personal information, preferences, goals, or important details they'd want remembered.",
    parameters: storeMemoryStandardParams,
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

  const recallMemory = tool({
    description:
      "Search and retrieve memories and facts previously stored about the user. " +
      "Use this when context about the user's preferences, past decisions, or personal details would be helpful.",
    parameters: recallMemoryStandardParams,
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

  const createReminder = tool({
    description:
      "Create a reminder to send the user a message at a specific date and time. " +
      "Use when the user asks to be reminded about something.",
    parameters: createReminderStandardParams,
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

  const listReminders = tool({
    description: "List all active (pending) reminders for the user.",
    parameters: z.object({}),
    execute: async () => {
      const reminders = await listRemindersAction(targetUserId, 20, store);
      return { reminders };
    },
  });

  const cancelReminder = tool({
    description: "Cancel a specific reminder by its ID.",
    parameters: cancelReminderParams,
    execute: async ({ reminder_id }) => {
      const res = await cancelReminderAction(reminder_id, targetUserId, store);
      return { success: res.success, cancelled_id: res.cancelledId };
    },
  });

  const snoozeReminder = tool({
    description: "Snooze a reminder by delaying it by a specified number of minutes.",
    parameters: snoozeReminderStandardParams,
    execute: async ({ reminder_id, minutes }) => {
      const res = await snoozeReminderAction(reminder_id, minutes, targetUserId, store);
      return { success: true, new_trigger_at: res.newTriggerAt };
    },
  });

  const setBriefingTime = tool({
    description:
      "Set or change the daily morning briefing delivery time. " +
      "Use when the user asks to change, update, or set their morning briefing time (e.g., 'Change my briefing to 8:30 AM').",
    parameters: setBriefingTimeParams,
    execute: async ({ time }) => {
      const result = await updateBriefingTimeAction(time, targetUserId, store);
      try {
        getScheduler().scheduleBriefingCron(result.time);
      } catch {
        // In isolated environments or test runners where scheduler is not initialized
      }
      return {
        success: true,
        new_briefing_time: result.time,
        timezone: env().USER_TIMEZONE,
        message: `Daily morning briefing time successfully updated to ${result.time} (${env().USER_TIMEZONE}).`,
      };
    },
  });

  const searchConversationHistory = tool({
    description:
      "Search previous conversation history, past discussions, decisions, and chat transcripts with the user. " +
      "Use when the user asks about prior discussions, past topics, or previously discussed code, links, or plans.",
    parameters: searchHistoryStandardParams,
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
    web_search: webSearch,
    store_memory: storeMemory,
    recall_memory: recallMemory,
    create_reminder: createReminder,
    list_reminders: listReminders,
    cancel_reminder: cancelReminder,
    snooze_reminder: snoozeReminder,
    set_briefing_time: setBriefingTime,
    search_conversation_history: searchConversationHistory,
  };
}

export function createTools(context?: ToolContext) {
  return buildStandardTools(context);
}

// ─── Exported Standalone Tools ───────────────────────────────────────────────

const defaultTools = buildStandardTools();
export const webSearchTool = defaultTools.web_search;
export const storeMemoryTool = defaultTools.store_memory;
export const recallMemoryTool = defaultTools.recall_memory;
export const setBriefingTimeTool = defaultTools.set_briefing_time;

// ─── Simplified Tool Suite (Groq / Llama Adapters) ───────────────────────────

export function createSimplifiedTools(context?: ToolContext) {
  const tools = buildStandardTools(context);

  return {
    create_reminder: tool({
      description: "Create a reminder with message and ISO trigger datetime.",
      parameters: createReminderSimplifiedParams,
      execute: async ({ message, trigger_at }) => {
        return tools.create_reminder.execute(
          { message, trigger_at, is_recurring: false, cron_expression: undefined },
          { toolCallId: "sim_cr", messages: [] }
        );
      },
    }),
    list_reminders: tools.list_reminders,
    cancel_reminder: tools.cancel_reminder,
    snooze_reminder: tool({
      description: "Delay a reminder by minutes.",
      parameters: snoozeReminderSimplifiedParams,
      execute: async ({ reminder_id, minutes }) => {
        return tools.snooze_reminder.execute(
          { reminder_id, minutes },
          { toolCallId: "sim_sr", messages: [] }
        );
      },
    }),
    web_search: tool({
      description: "Search web for current news or facts.",
      parameters: webSearchSimplifiedParams,
      execute: async ({ query }) => {
        return tools.web_search.execute(
          { query, topic: "general", max_results: 5 },
          { toolCallId: "sim_ws", messages: [] }
        );
      },
    }),
    store_memory: tool({
      description: "Save a fact about the user.",
      parameters: storeMemorySimplifiedParams,
      execute: async ({ content }) => {
        return tools.store_memory.execute(
          { content, tags: [], importance: 3 },
          { toolCallId: "sim_sm", messages: [] }
        );
      },
    }),
    recall_memory: tool({
      description: "Retrieve stored memories about user.",
      parameters: recallMemorySimplifiedParams,
      execute: async ({ query }) => {
        const res = await tools.recall_memory.execute(
          { query, limit: 5 },
          { toolCallId: "sim_rm", messages: [] }
        );
        return {
          found: res.found,
          memories: res.memories.map((m: any) => ({
            content: m.content,
            source: m.source ?? "user",
          })),
        };
      },
    }),
    set_briefing_time: tool({
      description: "Set daily briefing time (HH:MM).",
      parameters: setBriefingTimeParams,
      execute: async ({ time }) => {
        const res = await tools.set_briefing_time.execute(
          { time },
          { toolCallId: "sim_sbt", messages: [] }
        );
        return { success: true, new_briefing_time: res.new_briefing_time };
      },
    }),
    search_conversation_history: tool({
      description: "Search prior chat history.",
      parameters: searchHistorySimplifiedParams,
      execute: async ({ query }) => {
        const res = await tools.search_conversation_history.execute(
          { query, limit: 5 },
          { toolCallId: "sim_sch", messages: [] }
        );
        return {
          found: res.found,
          matches: (res.matches ?? []).map((r: any) => ({ role: r.role, content: r.content })),
        };
      },
    }),
  };
}
