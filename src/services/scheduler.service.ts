import { Cron } from "croner";
import { InlineKeyboard, type Bot } from "grammy";
import type { DataStore } from "../db/datastore.js";
import { getDataStore } from "../db/datastore-provider.js";
import { env } from "../config/env.js";
import { parseTimeString, getEndOfDayISO, getTargetTimeISO } from "../utils/time.js";
import { chunkMessage } from "../utils/chunk.js";
import { runFactCompaction } from "./compaction.service.js";
import {
  snoozeReminderAction,
  cancelReminderAction,
  updateBriefingTimeAction,
} from "../actions/actions.js";
import type { Reminder } from "../db/schema.js";
import { sendCriticalAlert } from "./alert.service.js";

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

    const chunks = chunkMessage(text, 4000);
    const messageChunks = chunks.length > 0 ? chunks : [text];

    for (let i = 0; i < messageChunks.length; i++) {
      const chunk = messageChunks[i];
      const isLastChunk = i === messageChunks.length - 1;
      const currentMarkup = isLastChunk ? replyMarkup : undefined;

      try {
        await this.bot.api.sendMessage(chatId, chunk, {
          parse_mode: "Markdown",
          reply_markup: currentMarkup,
        });
      } catch {
        // Fallback without Markdown parsing if special characters fail
        await this.bot.api.sendMessage(chatId, chunk, {
          reply_markup: currentMarkup,
        });
      }
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

// ─── Live Briefing Pipeline (Delegated to briefing.service) ───────────────
export * from "./briefing.service.js";
import { fetchBriefingSnapshot } from "./briefing.service.js";

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
  private isCheckingReminders = false;

  constructor(options: ProactiveSchedulerOptions = {}) {
    this.store = options.store ?? getDataStore();
    this.dispatcher = options.dispatcher ?? null;
  }

  setDispatcher(dispatcher: NotificationDispatcher): void {
    this.dispatcher = dispatcher;
  }

  async start(): Promise<void> {
    const timezone = env().USER_TIMEZONE;

    // 1. Minute-by-minute reminder poller with explicit timezone
    this.reminderCron = new Cron("* * * * *", { timezone }, () => void this.checkDueReminders());

    // 2. Daily fact compaction at 3 AM (ADR-0006)
    this.compactionCron = new Cron("0 3 * * *", { timezone }, () => {
      console.log("[scheduler] Starting daily fact compaction...");
      void runFactCompaction(this.store, undefined, { softDelete: true }).catch((err) =>
        console.error("[scheduler] Fact compaction failed:", err)
      );
    });

    // 3. Daily morning briefing cron (ADR-0007)
    const savedTime = await this.fetchSavedBriefingTime();
    this.scheduleBriefingCron(savedTime);

    // 4. On startup: check if today's briefing was missed within grace period
    try {
      await this.checkMissedBriefing();
    } catch (missedErr) {
      console.error("[scheduler] Error during startup missed briefing check:", missedErr);
    }

    console.log("✅ Proactive Scheduler running");
  }

  /**
   * Checks if today's briefing was missed due to downtime / restart,
   * and sends it if the scheduled time passed less than BRIEFING_MISSED_GRACE_PERIOD_MINUTES ago.
   */
  async checkMissedBriefing(): Promise<boolean> {
    const { TELEGRAM_ALLOWED_USER_ID, USER_TIMEZONE, BRIEFING_MISSED_GRACE_PERIOD_MINUTES } = env();
    const savedTime = await this.fetchSavedBriefingTime();

    const now = new Date();
    const todayDateStr = now.toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });

    // Check today's scheduled run time in owner timezone
    const todayScheduledIso = getTargetTimeISO(savedTime, USER_TIMEZONE, now);
    const todayScheduledMs = new Date(todayScheduledIso).getTime();
    let minutesPassed = (now.getTime() - todayScheduledMs) / (60 * 1000);
    let targetDateStr = todayDateStr;

    // If today's scheduled time is in the future (e.g. restart early morning), check yesterday's scheduled run
    if (minutesPassed < 0) {
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const yesterdayScheduledIso = getTargetTimeISO(savedTime, USER_TIMEZONE, yesterday);
      const yesterdayMinutesPassed = (now.getTime() - new Date(yesterdayScheduledIso).getTime()) / (60 * 1000);
      if (yesterdayMinutesPassed >= 0 && yesterdayMinutesPassed <= BRIEFING_MISSED_GRACE_PERIOD_MINUTES) {
        minutesPassed = yesterdayMinutesPassed;
        targetDateStr = yesterday.toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
      }
    }

    if (minutesPassed >= 0) {
      if (minutesPassed <= BRIEFING_MISSED_GRACE_PERIOD_MINUTES) {
        const lastSentDate = await this.store.getLastBriefingDate(TELEGRAM_ALLOWED_USER_ID);
        if (lastSentDate !== targetDateStr) {
          console.log(
            `[scheduler] Missed briefing detected on startup (${Math.round(minutesPassed)}m ago, grace: ${BRIEFING_MISSED_GRACE_PERIOD_MINUTES}m). Sending now...`
          );
          return await this.sendDailyBriefing({ briefingDate: targetDateStr });
        }
      } else {
        console.log(
          `[scheduler] Missed briefing for ${targetDateStr} was ${Math.round(minutesPassed)}m ago (exceeds ${BRIEFING_MISSED_GRACE_PERIOD_MINUTES}m grace window). Skipping.`
        );
      }
    }
    return false;
  }

  stop(): void {
    if (this.reminderCron) this.reminderCron.stop();
    if (this.compactionCron) this.compactionCron.stop();
    if (this.briefingCron) this.briefingCron.stop();
  }

  async checkDueReminders(): Promise<number> {
    if (!this.dispatcher || this.isCheckingReminders) return 0;
    this.isCheckingReminders = true;

    try {
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
    } finally {
      this.isCheckingReminders = false;
    }
  }

  async sendDailyBriefing(options: {
    briefingDate?: string;
    targetDateStr?: string;
    modelOverride?: string;
    isFallback?: boolean;
    fallbackReason?: string;
  } = {}): Promise<boolean> {
    if (!this.dispatcher) return false;
    const { TELEGRAM_ALLOWED_USER_ID, USER_NAME, USER_TIMEZONE } = env();

    const targetDateStr =
      options.briefingDate ??
      options.targetDateStr ??
      new Date().toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
    const scheduledAtIso = new Date().toISOString();

    // 1. Atomic claim in database to prevent double-sending
    const claimed = await this.store.claimDailyBriefing(TELEGRAM_ALLOWED_USER_ID, targetDateStr, scheduledAtIso);
    if (!claimed) {
      console.log(`[scheduler] Daily briefing for ${targetDateStr} already claimed or sent by another instance. Skipping.`);
      return false;
    }

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

      let briefing = `☀️ ${now}\n\n📰 **Today's Intelligence Briefing**\n\n`;

      if (liveSnapshot) {
        briefing += `${liveSnapshot}\n\n`;
      }

      // Reminders section (formerly Agenda - renamed per Item 8)
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
        briefing += `\n(Calendar not connected, agenda unknown beyond scheduled reminders)\n`;
      } else {
        briefing += `📋 **Reminders:** Calendar not connected, agenda unknown.\n`;
      }

      // If scheduled briefing used a fallback model, add a note at the end (Item 5)
      if (options.isFallback) {
        const fallbackNote = options.modelOverride
          ? `\n_(⚡ Served via ${options.modelOverride} fallback${options.fallbackReason ? `: ${options.fallbackReason}` : ""})_`
          : `\n_(⚡ Served via fallback model)_`;
        briefing += `\n${fallbackNote}`;
      }

      await this.dispatcher.sendMessage(TELEGRAM_ALLOWED_USER_ID, briefing.trim());
      await this.store.markDailyBriefingSent(TELEGRAM_ALLOWED_USER_ID, targetDateStr, options.modelOverride);
      return true;
    } catch (err) {
      console.error("[scheduler] Failed to send daily briefing:", err);
      await sendCriticalAlert("scheduler_failed", err, { job: "sendDailyBriefing", date: targetDateStr });
      return false;
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

  scheduleBriefingCron(timeStr: string): void {
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
