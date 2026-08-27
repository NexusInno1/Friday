import { tool } from "ai";
import { z } from "zod";
import { storeMemory, searchMemories } from "../services/memory.service.js";
import { updateBriefingTime } from "../services/scheduler.service.js";
import {
  createReminder,
  listActiveReminders,
  cancelReminder,
  snoozeReminder,
} from "../services/reminder.service.js";
import { env } from "../config/env.js";

// ─── Web Search ─────────────────────────────────────────────────────────────

export const webSearchTool = tool({
  description:
    "Search the web for real-time information, news, current events, facts, or research. " +
    "Use this when the user asks about something that may have changed recently or requires live data.",
  parameters: z.object({
    query: z.string().describe("The search query to look up"),
    max_results: z
      .number()
      .optional()
      .default(5)
      .describe("Maximum number of results to return"),
  }),
  execute: async ({ query, max_results }) => {
    const { TAVILY_API_KEY } = env();

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        max_results: max_results ?? 5,
        search_depth: "basic",
        include_answer: true,
        include_raw_content: false,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(
        `Tavily search failed (${response.status} ${response.statusText}): ${errBody}`
      );
    }

    const data = (await response.json()) as {
      answer?: string;
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };

    return {
      answer: data.answer ?? null,
      results: (data.results ?? []).map((r) => ({
        title: r.title ?? "Untitled",
        url: r.url ?? "",
        snippet: r.content ? r.content.slice(0, 300) : "",
      })),
    };
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
    await storeMemory(content, tags, importance);
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
    const memories = await searchMemories(query, limit);
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
    const result = await updateBriefingTime(time);
    return {
      success: true,
      new_briefing_time: result.time,
      timezone: env().USER_TIMEZONE,
      message: `Daily morning briefing time successfully updated to ${result.time} (${env().USER_TIMEZONE}).`,
    };
  },
});

// ─── Scoped Tool Factory ─────────────────────────────────────────────────────

export interface ToolContext {
  chatId: number;
  userId?: number;
}

export function createTools(context?: ToolContext) {
  const targetChatId = context?.chatId ?? env().TELEGRAM_ALLOWED_USER_ID;
  const targetUserId = context?.userId ?? env().TELEGRAM_ALLOWED_USER_ID;

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
      const data = await createReminder({
        userId: targetUserId,
        chatId: targetChatId,
        message,
        triggerAt: trigger_at,
        isRecurring: is_recurring,
        cronExpression: cron_expression,
      });

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
      const reminders = await listActiveReminders(targetUserId);
      return { reminders };
    },
  });

  const cancelReminderScopedTool = tool({
    description: "Cancel a specific reminder by its ID.",
    parameters: z.object({
      reminder_id: z.string().uuid().describe("The UUID of the reminder to cancel"),
    }),
    execute: async ({ reminder_id }) => {
      const res = await cancelReminder(reminder_id, targetUserId);
      return { success: res.success, cancelled_id: res.cancelledId };
    },
  });

  const snoozeReminderScopedTool = tool({
    description: "Snooze a reminder by delaying it by a specified number of minutes.",
    parameters: z.object({
      reminder_id: z.string().uuid().describe("The UUID of the reminder to snooze"),
      minutes: z.number().positive().describe("Number of minutes to delay the reminder"),
    }),
    execute: async ({ reminder_id, minutes }) => {
      const res = await snoozeReminder(reminder_id, minutes, targetUserId);
      return { success: true, new_trigger_at: res.newTriggerAt };
    },
  });

  return {
    web_search: webSearchTool,
    store_memory: storeMemoryTool,
    recall_memory: recallMemoryTool,
    create_reminder: createReminderScopedTool,
    list_reminders: listRemindersScopedTool,
    cancel_reminder: cancelReminderScopedTool,
    snooze_reminder: snoozeReminderScopedTool,
    set_briefing_time: setBriefingTimeTool,
  };
}

