import { Cron } from "croner";
import { InlineKeyboard, type Bot } from "grammy";
import type { DataStore } from "../db/datastore.js";
import { getDataStore } from "../db/datastore-provider.js";
import { env } from "../config/env.js";
import { parseTimeString, getEndOfDayISO } from "../utils/time.js";
import { runFactCompaction } from "./compaction.service.js";
import {
  snoozeReminderAction,
  cancelReminderAction,
  updateBriefingTimeAction,
} from "../actions/actions.js";
import type { Reminder } from "../db/schema.js";

// ─── Notification Dispatcher Seam ────────────────────────────────────────────

export interface NotificationButton {
  text: string;
  data: string;
}

export interface NotificationDispatcher {
  sendMessage(
    chatId: number,
    text: string,
    options?: { buttons?: NotificationButton[] }
  ): Promise<void>;
}

export class TelegramDispatcher implements NotificationDispatcher {
  constructor(private bot: Bot) {}

  async sendMessage(
    chatId: number,
    text: string,
    options?: { buttons?: NotificationButton[] }
  ): Promise<void> {
    let replyMarkup: InlineKeyboard | undefined;
    if (options?.buttons && options.buttons.length > 0) {
      replyMarkup = new InlineKeyboard();
      for (const btn of options.buttons) {
        replyMarkup.text(btn.text, btn.data);
      }
    }

    try {
      await this.bot.api.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: replyMarkup,
      });
    } catch {
      // Fallback without Markdown parsing if special characters fail
      await this.bot.api.sendMessage(chatId, text, {
        reply_markup: replyMarkup,
      });
    }
  }
}

export class InMemoryDispatcher implements NotificationDispatcher {
  public dispatched: Array<{
    chatId: number;
    text: string;
    buttons?: NotificationButton[];
  }> = [];

  async sendMessage(
    chatId: number,
    text: string,
    options?: { buttons?: NotificationButton[] }
  ): Promise<void> {
    this.dispatched.push({
      chatId,
      text,
      buttons: options?.buttons,
    });
  }

  clear(): void {
    this.dispatched = [];
  }
}

// ─── Live Briefing Snapshot ──────────────────────────────────────────────────

export interface BriefingCategoryDefinition {
  category: string;
  emoji: string;
  query: string;
}

export const BRIEFING_CATEGORIES: BriefingCategoryDefinition[] = [
  { category: "International", emoji: "🌐", query: "breaking world news international developments" },
  { category: "Business & Economy", emoji: "💼", query: "stock markets global economy finance business news" },
  { category: "Sports", emoji: "⚽", query: "major sports breaking news matches tournaments" },
  { category: "AI & Technology", emoji: "🤖", query: "artificial intelligence AI tech breakthroughs industry news" },
  { category: "Regional (India)", emoji: "🇮🇳", query: "India latest breaking news politics economy Delhi Mumbai" },
];

export async function fetchBriefingSnapshot(userTimezone: string): Promise<string | null> {
  const { TAVILY_API_KEY } = env();
  if (!TAVILY_API_KEY || TAVILY_API_KEY === "mock_tavily_key") {
    return null;
  }

  try {
    const results = await Promise.allSettled(
      BRIEFING_CATEGORIES.map(async (cat) => {
        const response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TAVILY_API_KEY}`,
          },
          body: JSON.stringify({
            api_key: TAVILY_API_KEY,
            query: cat.query,
            topic: "news",
            days: 1,
            max_results: 5,
            search_depth: "basic",
            include_answer: false,
          }),
        });

        if (!response.ok) return null;
        const data = (await response.json()) as {
          results?: Array<{ title?: string }>;
        };

        const items = (data.results ?? [])
          .filter(
            (r) =>
              r.title &&
              !r.title.toLowerCase().includes("school assembly")
          )
          .slice(0, 2)
          .map((r) => r.title?.trim())
          .filter(Boolean) as string[];

        return {
          ...cat,
          items,
        };
      })
    );

    const sections: string[] = [];
    for (const r of results) {
      if (r.status === "fulfilled" && r.value && r.value.items.length > 0) {
        const cat = r.value;
        const bullets = cat.items.map((title) => `  • ${title}`).join("\n");
        sections.push(`${cat.emoji} **${cat.category}**\n${bullets}`);
      }
    }

    return sections.length > 0 ? sections.join("\n\n") : null;
  } catch {
    return null;
  }
}

// ─── Deep Module: ProactiveScheduler ─────────────────────────────────────────

export const MAX_DELIVERY_ATTEMPTS = 5;

export interface ProactiveSchedulerOptions {
  store?: DataStore;
  dispatcher?: NotificationDispatcher;
}

export class ProactiveScheduler {
  private store: DataStore;
  private dispatcher: NotificationDispatcher | null = null;
  private reminderCron: Cron | null = null;
  private compactionCron: Cron | null = null;
  private briefingCron: Cron | null = null;
  private currentBriefingTime: string = "07:00";

  constructor(options: ProactiveSchedulerOptions = {}) {
    this.store = options.store ?? getDataStore();
    this.dispatcher = options.dispatcher ?? null;
  }

  setDispatcher(dispatcher: NotificationDispatcher): void {
    this.dispatcher = dispatcher;
  }

  async start(): Promise<void> {
    const timezone = env().USER_TIMEZONE;

    // 1. Minute-by-minute reminder poller
    this.reminderCron = new Cron("* * * * *", () => void this.checkDueReminders());

    // 2. Daily fact compaction at 3 AM (ADR-0006)
    this.compactionCron = new Cron("0 3 * * *", { timezone }, () => {
      console.log("[scheduler] Starting daily fact compaction...");
      void runFactCompaction(this.store).catch((err) =>
        console.error("[scheduler] Fact compaction failed:", err)
      );
    });

    // 3. Daily morning briefing cron (ADR-0007)
    const savedTime = await this.fetchSavedBriefingTime();
    this.scheduleBriefingCron(savedTime);

    console.log("✅ Proactive Scheduler running");
  }

  stop(): void {
    if (this.reminderCron) this.reminderCron.stop();
    if (this.compactionCron) this.compactionCron.stop();
    if (this.briefingCron) this.briefingCron.stop();
  }

  async checkDueReminders(): Promise<number> {
    if (!this.dispatcher) return 0;
    const now = new Date().toISOString();
    const claimed = await this.store.claimDueReminders(now, 120_000);

    let processed = 0;
    for (const reminder of claimed) {
      try {
        await this.dispatcher.sendMessage(
          reminder.telegram_chat_id,
          `⏰ **Reminder**\n\n${reminder.message}`,
          {
            buttons: [
              { text: "⏰ +15m", data: `snooze:${reminder.id}:15` },
              { text: "⏰ +1h", data: `snooze:${reminder.id}:60` },
              { text: "❌ Cancel", data: `cancel:${reminder.id}` },
            ],
          }
        );

        if (reminder.is_recurring && reminder.cron_expression) {
          const nextRun = new Cron(reminder.cron_expression, {
            timezone: env().USER_TIMEZONE,
          }).nextRun();

          if (nextRun) {
            await this.store.updateReminder(reminder.id, {
              trigger_at: nextRun.toISOString(),
              lease_until: null,
            });
          } else {
            await this.store.updateReminder(reminder.id, {
              is_completed: true,
              lease_until: null,
            });
          }
        } else {
          await this.store.updateReminder(reminder.id, {
            is_completed: true,
            lease_until: null,
          });
        }
        processed++;
      } catch (err) {
        console.error("[scheduler] Failed to deliver reminder:", reminder.id, err);
        const attempts = reminder.delivery_attempts ?? 1;
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          console.warn(
            `[scheduler] Reminder ${reminder.id} exceeded maximum delivery attempts (${MAX_DELIVERY_ATTEMPTS}). Marking as cancelled.`
          );
          try {
            await this.store.updateReminder(reminder.id, {
              is_cancelled: true,
              lease_until: null,
            });
          } catch (cancelErr) {
            console.error(
              `[scheduler] Failed to cancel permanently failing reminder ${reminder.id}:`,
              cancelErr
            );
          }
        }
        // Otherwise: keep lease_until intact so it will retry after lease expires
      }
    }
    return processed;
  }

  async sendDailyBriefing(): Promise<void> {
    if (!this.dispatcher) return;
    const { TELEGRAM_ALLOWED_USER_ID, USER_NAME, USER_TIMEZONE } = env();

    try {
      const endOfDayIso = getEndOfDayISO(USER_TIMEZONE);
      const todayReminders = await this.store.getTodayReminders(
        TELEGRAM_ALLOWED_USER_ID,
        endOfDayIso
      );

      const now = new Date().toLocaleString("en-IN", {
        timeZone: USER_TIMEZONE,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      const liveSnapshot = await fetchBriefingSnapshot(USER_TIMEZONE);

      let briefing = `☀️ **Good Morning, ${USER_NAME}!**\n_${now}_\n\n`;

      if (liveSnapshot) {
        briefing += `📰 **Today's Intelligence Briefing:**\n\n${liveSnapshot}\n\n`;
      }

      if (todayReminders.length > 0) {
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

      await this.dispatcher.sendMessage(TELEGRAM_ALLOWED_USER_ID, briefing);
    } catch (err) {
      console.error("[scheduler] Failed to send daily briefing:", err);
    }
  }

  async updateBriefingTime(newTimeInput: string): Promise<{ success: boolean; time: string }> {
    const result = await updateBriefingTimeAction(
      newTimeInput,
      env().TELEGRAM_ALLOWED_USER_ID,
      this.store
    );

    this.scheduleBriefingCron(result.time);
    return result;
  }

  getBriefingTime(): string {
    return this.currentBriefingTime;
  }

  async snooze(
    reminderId: string,
    minutes: number
  ): Promise<{ reminder: Reminder; newTriggerAt: string }> {
    return snoozeReminderAction(
      reminderId,
      minutes,
      env().TELEGRAM_ALLOWED_USER_ID,
      this.store
    );
  }

  async cancel(reminderId: string): Promise<boolean> {
    const res = await cancelReminderAction(
      reminderId,
      env().TELEGRAM_ALLOWED_USER_ID,
      this.store
    );
    return res.success;
  }

  private async fetchSavedBriefingTime(): Promise<string> {
    const { TELEGRAM_ALLOWED_USER_ID, BRIEFING_TIME } = env();
    try {
      const profile = await this.store.getUserProfile(TELEGRAM_ALLOWED_USER_ID);
      if (profile?.briefing_time) {
        return parseTimeString(profile.briefing_time);
      }
    } catch (err) {
      console.warn("[scheduler] Could not fetch saved briefing time, using default:", err);
    }
    return parseTimeString(BRIEFING_TIME);
  }

  private scheduleBriefingCron(timeStr: string): void {
    const { USER_TIMEZONE } = env();
    this.currentBriefingTime = timeStr;

    const [hour, minute] = timeStr.split(":").map(Number);
    const cronExpression = `${minute} ${hour} * * *`;

    if (this.briefingCron) {
      this.briefingCron.stop();
    }

    this.briefingCron = new Cron(cronExpression, { timezone: USER_TIMEZONE }, () =>
      void this.sendDailyBriefing()
    );

    console.log(`📅 Daily briefing scheduled at ${timeStr} (${USER_TIMEZONE})`);
  }
}

// ─── Singleton & Backward-Compatibility Exports ─────────────────────────────

let _defaultScheduler: ProactiveScheduler | null = null;

export function getScheduler(): ProactiveScheduler {
  if (!_defaultScheduler) {
    _defaultScheduler = new ProactiveScheduler();
  }
  return _defaultScheduler;
}

export function setScheduler(scheduler: ProactiveScheduler): void {
  _defaultScheduler = scheduler;
}

export async function initScheduler(telegramBot: Bot): Promise<ProactiveScheduler> {
  const scheduler = getScheduler();
  scheduler.setDispatcher(new TelegramDispatcher(telegramBot));
  await scheduler.start();
  return scheduler;
}

export function getCurrentBriefingTime(): string {
  return getScheduler().getBriefingTime();
}

export async function updateBriefingTime(
  rawTime: string
): Promise<{ success: boolean; time: string }> {
  return getScheduler().updateBriefingTime(rawTime);
}
