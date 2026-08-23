import { Cron } from "croner";
import { InlineKeyboard } from "grammy";
import { getSupabaseClient } from "../db/supabase.js";
import { env } from "../config/env.js";
import { parseTimeString, getEndOfDayISO } from "../utils/time.js";
import { runFactCompaction } from "./compaction.service.js";
import type { Bot } from "grammy";

/** Fetches a brief live briefing snapshot via Tavily for morning context. */
async function fetchBriefingSnapshot(userTimezone: string): Promise<string | null> {
  const { TAVILY_API_KEY } = env();
  const dayStr = new Date().toLocaleDateString("en-IN", { timeZone: userTimezone, weekday: "long" });
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAVILY_API_KEY}` },
      body: JSON.stringify({
        query: `top tech and world news headlines for ${dayStr}`,
        max_results: 3,
        search_depth: "basic",
        include_answer: true,
        include_raw_content: false,
      }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { answer?: string; results: Array<{ title: string; url: string }> };
    if (data.answer) return data.answer;
    if (data.results.length > 0) {
      return data.results.map((r) => `• ${r.title}`).join("\n");
    }
    return null;
  } catch {
    return null; // Live search failure must never break the morning briefing
  }
}

let bot: Bot | null = null;
let briefingCronJob: Cron | null = null;
let currentBriefingTime: string = "07:00";

export async function initScheduler(telegramBot: Bot): Promise<void> {
  bot = telegramBot;

  // Poll for due reminders every minute
  new Cron("* * * * *", () => void checkDueReminders());

  // ADR-0006: Daily fact compaction at 3 AM (user timezone)
  new Cron("0 3 * * *", { timezone: env().USER_TIMEZONE }, () => {
    console.log("[scheduler] Starting daily fact compaction...");
    void runFactCompaction().catch((err) =>
      console.error("[scheduler] Fact compaction failed:", err)
    );
  });

  // Fetch saved briefing time from database or fallback to env
  const savedTime = await fetchSavedBriefingTime();
  scheduleDailyBriefing(savedTime);

  console.log("✅ Scheduler started");
}

/**
 * Fetches the user's customized briefing time from Supabase user_profiles,
 * falling back to the BRIEFING_TIME env var.
 */
async function fetchSavedBriefingTime(): Promise<string> {
  const { TELEGRAM_ALLOWED_USER_ID, BRIEFING_TIME } = env();
  try {
    const db = getSupabaseClient();
    const { data: profile } = await db
      .from("user_profiles")
      .select("briefing_time")
      .eq("id", TELEGRAM_ALLOWED_USER_ID)
      .single();

    if (profile?.briefing_time) {
      return parseTimeString(profile.briefing_time);
    }
  } catch (err) {
    console.warn("[scheduler] Could not fetch saved briefing time, using default:", err);
  }
  return parseTimeString(BRIEFING_TIME);
}

/**
 * Dynamically updates the daily briefing time at runtime and persists it to Supabase.
 * Can be invoked via AI tool call during chat or via /briefing command.
 */
export async function updateBriefingTime(newTimeInput: string): Promise<{ success: boolean; time: string }> {
  // Normalize time input (supports 24-hr and 12-hr AM/PM)
  const normalizedTime = parseTimeString(newTimeInput);

  const { TELEGRAM_ALLOWED_USER_ID, USER_NAME, USER_TIMEZONE } = env();
  const db = getSupabaseClient();

  // 1. Persist to user_profiles table in Supabase
  const { error } = await db
    .from("user_profiles")
    .upsert(
      {
        id: TELEGRAM_ALLOWED_USER_ID,
        name: USER_NAME,
        timezone: USER_TIMEZONE,
        briefing_time: normalizedTime,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );

  if (error) {
    console.error("[scheduler] Failed to save briefing time to DB:", error.message);
  }

  // 2. Reschedule the in-memory cron job
  scheduleDailyBriefing(normalizedTime);

  return { success: true, time: normalizedTime };
}

export function getCurrentBriefingTime(): string {
  return currentBriefingTime;
}

function scheduleDailyBriefing(timeStr: string): void {
  const { USER_TIMEZONE } = env();
  currentBriefingTime = timeStr;

  const [hour, minute] = timeStr.split(":").map(Number);
  const cronExpression = `${minute} ${hour} * * *`;

  // Stop previous cron job if one was running
  if (briefingCronJob) {
    briefingCronJob.stop();
  }

  briefingCronJob = new Cron(cronExpression, { timezone: USER_TIMEZONE }, () =>
    void sendDailyBriefing()
  );

  console.log(`📅 Daily briefing scheduled at ${timeStr} (${USER_TIMEZONE})`);
}

async function checkDueReminders(): Promise<void> {
  if (!bot) return;
  const db = getSupabaseClient();
  const now = new Date().toISOString();

  const { data: dueReminders, error } = await db
    .from("reminders")
    .select()
    .lte("trigger_at", now)
    .eq("is_completed", false)
    .eq("is_cancelled", false);

  if (error) {
    console.error("[scheduler] Error fetching reminders:", error.message);
    return;
  }

  for (const reminder of dueReminders ?? []) {
    try {
      // Build inline action buttons for immediate snooze/cancel
      const keyboard = new InlineKeyboard()
        .text("⏰ +15m", `snooze:${reminder.id}:15`)
        .text("⏰ +1h", `snooze:${reminder.id}:60`)
        .text("❌ Cancel", `cancel:${reminder.id}`);

      await bot.api.sendMessage(
        reminder.telegram_chat_id,
        `⏰ **Reminder**\n\n${reminder.message}`,
        { parse_mode: "Markdown", reply_markup: keyboard }
      );

      if (reminder.is_recurring && reminder.cron_expression) {
        // Calculate next trigger for recurring reminders
        const nextRun = new Cron(reminder.cron_expression).nextRun();
        if (nextRun) {
          await db
            .from("reminders")
            .update({ trigger_at: nextRun.toISOString() })
            .eq("id", reminder.id);
        }
      } else {
        // Mark one-shot reminder as completed
        await db
          .from("reminders")
          .update({ is_completed: true })
          .eq("id", reminder.id);
      }
    } catch (err) {
      console.error("[scheduler] Failed to send reminder:", reminder.id, err);
    }
  }
}

async function sendDailyBriefing(): Promise<void> {
  if (!bot) return;
  const { TELEGRAM_ALLOWED_USER_ID, USER_NAME, USER_TIMEZONE } = env();
  const db = getSupabaseClient();

  try {
    // Calculate end of day in the configured USER_TIMEZONE
    const endOfDayIso = getEndOfDayISO(USER_TIMEZONE);

    const { data: todayReminders } = await db
      .from("reminders")
      .select()
      .eq("user_id", TELEGRAM_ALLOWED_USER_ID)
      .eq("is_completed", false)
      .eq("is_cancelled", false)
      .lte("trigger_at", endOfDayIso)
      .order("trigger_at", { ascending: true });

    const now = new Date().toLocaleString("en-IN", {
      timeZone: USER_TIMEZONE,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    // Fetch live briefing snapshot (best-effort — never blocks delivery)
    const liveSnapshot = await fetchBriefingSnapshot(USER_TIMEZONE);

    let briefing = `☀️ **Good Morning, ${USER_NAME}!**\n_${now}_\n\n`;

    if (liveSnapshot) {
      briefing += `📰 **Today's Quick Briefing:**\n${liveSnapshot}\n\n`;
    }

    if (todayReminders && todayReminders.length > 0) {
      briefing += `📋 **Today's Reminders (${todayReminders.length})**\n`;
      for (const r of todayReminders) {
        const time = new Date(r.trigger_at).toLocaleTimeString("en-IN", {
          timeZone: USER_TIMEZONE,
          hour: "2-digit",
          minute: "2-digit",
        });
        briefing += `  • ${time} — ${r.message}\n`;
      }
    } else {
      briefing += `📋 **No reminders scheduled for today.** Clear agenda!\n`;
    }

    briefing += `\nOnline and ready, ${USER_NAME}. What's on the agenda?`;

    await bot.api.sendMessage(TELEGRAM_ALLOWED_USER_ID, briefing, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error("[scheduler] Failed to send daily briefing:", err);
  }
}
