import { Cron } from "croner";
import { InlineKeyboard, type Bot } from "grammy";
import type { DataStore } from "../db/datastore.js";
import { getDataStore } from "../db/datastore-provider.js";
import { env } from "../config/env.js";
import { parseTimeString, getEndOfDayISO, getTargetTimeISO } from "../utils/time.js";
import { runFactCompaction } from "./compaction.service.js";
import {
  snoozeReminderAction,
  cancelReminderAction,
  updateBriefingTimeAction,
} from "../actions/actions.js";
import type { Reminder } from "../db/schema.js";
import { sendCriticalAlert } from "./alert.service.js";
import { checkAndIncrementUsage } from "./cost-tracker.service.js";

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

export interface BriefingSubQuery {
  query: string;
  count: number;
}

export interface BriefingCategory {
  category: string;
  label?: string;
  emoji: string;
  query?: string;
  count?: number;
  subQueries?: BriefingSubQuery[];
}

export type BriefingCategoryDefinition = BriefingCategory;

export const BRIEFING_CATEGORIES: BriefingCategory[] = [
  {
    category: "International",
    label: "International",
    emoji: "🌐",
    query:
      "world news international geopolitics diplomacy foreign affairs conflicts treaties today",
    count: 5,
  },
  {
    category: "Business & Economy",
    label: "Business & Economy",
    emoji: "💼",
    query:
      "global business economy financial markets central banks earnings trade inflation today",
    count: 4,
  },
  {
    category: "AI & Technology",
    label: "AI & Technology",
    emoji: "🤖",
    query:
      "artificial intelligence AI LLM model release Anthropic OpenAI Google Nvidia breakthrough funding today",
    count: 4,
  },
  {
    category: "Regional (India)",
    label: "Regional (India)",
    emoji: "🇮🇳",
    query:
      "India national news politics central government parliament Supreme Court economy policy decisions today",
    count: 5,
  },
];

export const BRIEFING_EXCLUDE_DOMAINS = [
  "youtube.com",
  "vimeo.com",
  "dailymotion.com",
  "tiktok.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "reddit.com",
  "pinterest.com",
  "quora.com",
  "medium.com",
  "linkedin.com",
];

const KNOWN_OUTLET_NAMES: Record<string, string> = {
  "qz.com": "Quartz",
  "globalbankingandfinance.com": "Global Banking & Finance",
  "timesofindia.indiatimes.com": "The Times of India",
  "economictimes.indiatimes.com": "The Economic Times",
  "thehindu.com": "The Hindu",
  "hindustantimes.com": "Hindustan Times",
  "indianexpress.com": "The Indian Express",
  "livemint.com": "Livemint",
  "reuters.com": "Reuters",
  "apnews.com": "AP News",
  "bloomberg.com": "Bloomberg",
  "techcrunch.com": "TechCrunch",
  "fortune.com": "Fortune",
  "aljazeera.com": "Al Jazeera",
  "cnn.com": "CNN",
  "bbc.com": "BBC",
  "ft.com": "Financial Times",
  "wsj.com": "The Wall Street Journal",
  "cnbc.com": "CNBC",
  "theverge.com": "The Verge",
  "wired.com": "Wired",
  "ndtv.com": "NDTV",
};

/** Verify whether an item's published date is within the allowed recency window. */
export function isValidRecentArticle(publishedDate?: string | null, maxAgeHours = 26): boolean {
  if (!publishedDate) return false;
  const time = new Date(publishedDate).getTime();
  if (isNaN(time)) return false;
  const now = Date.now();
  const ageMs = now - time;
  return ageMs >= -4 * 3600 * 1000 && ageMs <= maxAgeHours * 3600 * 1000;
}

/** Returns true if a result title or url is non-news, explainer, video, or generic landing page. */
export function isLowQualityTitle(title: string, url?: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length < 20) return true;
  if (trimmed.includes("...") || trimmed.includes("…")) return true;

  const coreHeadline = trimmed.replace(/\s+[-|]\s+[^|-]+$/, "").trim();
  if (coreHeadline.split(/\s+/).length < 4) return true;

  // Video / audio / podcast in title
  if (/\b(video|watch:|podcast|episode|listen:)\b/i.test(trimmed)) return true;

  // Live blogs & live coverage
  if (/\b(live\s*updates?|live\s*blog|live\s*coverage)\b/i.test(trimmed)) return true;

  // Institutional statements, speeches, press releases
  if (/\b(statement|speech|press\s*release|imfc\s*statement)\b/i.test(trimmed)) return true;

  // Newsletters & UPSC study digests
  if (/\b(newsletter|upsc\s*digest|study\s*digest)\b/i.test(trimmed)) return true;

  // URL checks
  if (url) {
    const cleanUrl = url.toLowerCase();
    if (BRIEFING_EXCLUDE_DOMAINS.some((d) => cleanUrl.includes(d))) return true;
    if (/\b(videos?|watch|podcasts?)\b/.test(cleanUrl)) return true;
    if (/\b(liveblog|live-updates?|live-news|live-coverage)\b/.test(cleanUrl)) return true;
    if (/\b(statements?|speeches|press-releases?)\b/.test(cleanUrl)) return true;
    if (/\b(newsletters?|upsc-)\b/.test(cleanUrl)) return true;

    const cleanPath = cleanUrl.split("?")[0].replace(/\/+$/, "");
    const genericPathSuffixes = [
      "/india-news",
      "/news",
      "/india",
      "/world",
      "/business",
      "/sports",
      "/tech",
      "/technology",
      "/section/india",
      "/news/india",
      "/columns",
    ];
    if (genericPathSuffixes.some((suffix) => cleanPath.endsWith(suffix))) {
      return true;
    }
  }

  // Reject generic portal landing pages, header titles, and catch-all meta tags
  const badPatterns = [
    /^latest news today/i,
    /^breaking news/i,
    /latest news from india/i,
    /top news headlines/i,
    /news updates \| /i,
    /^the hindu:/i,
    /^hindustan times:/i,
    /^india news,\s*latest/i,
    /^the times of india:/i,
    /morning news brief/i,
    /school assembly/i,
    /^\w+ \d{1,2}, \d{4}: top news/i,
    /breaking news headlines/i,
    /today's breaking news/i,
    /all the latest news/i,
    /top stories/i,
    // Tutorials, explainers, and educational guides (not breaking news)
    /^(what|how|why)\s+(is|are|to|it works)\b/i,
    /\b(how it works and why it matters)\b/i,
    /^(a\s+)?(beginner's\s+)?guide to\b/i,
    /^everything you need to know about\b/i,
    /^explained:\s*/i,
    /\btutorial\b/i,
    // Static rankings and listicles
    /^largest \w+ in the world/i,
    /by nominal gdp/i,
    /^top \d+ (best|tools|ways|reasons|stocks|economies)\b/i,
    /\|\s*(the indian express|hindustan times|times of india|ndtv|livemint|the hindu|india today|news18)\s*$/i,
  ];

  if (badPatterns.some((re) => re.test(trimmed))) {
    return true;
  }

  return false;
}

export function extractSourceFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (KNOWN_OUTLET_NAMES[host]) return KNOWN_OUTLET_NAMES[host];
    for (const [domain, name] of Object.entries(KNOWN_OUTLET_NAMES)) {
      if (host.endsWith(domain)) return name;
    }
    const mainPart = host.split(".")[0];
    return mainPart.charAt(0).toUpperCase() + mainPart.slice(1);
  } catch {
    return "News";
  }
}

export function extractSourceAndCleanHeadline(
  title: string,
  url?: string
): { headline: string; source: string } {
  let clean = title.trim();
  const delimiterMatch = clean.match(/\s+[-|]\s+([^|-]+)$/);
  let source = "";
  if (delimiterMatch) {
    source = delimiterMatch[1].trim();
    clean = clean.slice(0, delimiterMatch.index).trim();
  }

  if (!source && url) {
    source = extractSourceFromUrl(url);
  }
  if (!source) {
    source = "News";
  }
  return { headline: clean, source };
}

export function buildWhyItMatters(content?: string): string {
  if (!content || !content.trim()) return "";
  let text = content.replace(/[\r\n]+/g, " ").trim();
  text = text.replace(/^(published on|updated on|by|photo:).*?[:–-]\s*/i, "");
  const sentenceMatch = text.match(/^(.+?(?:[.?!](?=\s+[A-Z0-9]|$)))/);
  let firstSentence = sentenceMatch ? sentenceMatch[1].trim() : text;
  const words = firstSentence.split(/\s+/);
  if (words.length > 25) {
    return words.slice(0, 25).join(" ") + "...";
  }
  return firstSentence;
}

export function isAnalysisStory(title: string, content?: string): boolean {
  if (/\b\[analysis\]\b/i.test(title)) return true;
  if (/^(opinion|editorial|analysis|op-ed|perspective):/i.test(title)) return true;
  if (content && /^(in an analysis|opinion:|editorial:)/i.test(content.trim())) return true;
  return false;
}

export function extractAnalysisAndAuthor(
  title: string,
  content?: string
): { isAnalysis: boolean; label: string } {
  // Check for pre-existing tag in title
  const existingTag = title.match(/\[Analysis(?:,\s*opinion by\s+([^\]]+))?\]/i);
  if (existingTag) {
    const author = existingTag[1]?.trim();
    return {
      isAnalysis: true,
      label: author ? `[Analysis, opinion by ${author}] ` : `[Analysis] `,
    };
  }

  const isAnalysis = isAnalysisStory(title, content);
  if (!isAnalysis) return { isAnalysis: false, label: "" };

  const authorMatch =
    title.match(/\b(?:opinion|analysis|column)\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i) ||
    title.match(/\bby\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/i) ||
    (content && content.match(/\b(?:opinion|column|analysis)\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i));

  if (authorMatch) {
    const author = authorMatch[1].trim();
    return { isAnalysis: true, label: `[Analysis, opinion by ${author}] ` };
  }

  return { isAnalysis: true, label: `[Analysis] ` };
}

export function formatToIST(dateStr?: string | null): { formatted: string; isOlderThan24h: boolean } {
  if (!dateStr) return { formatted: "", isOlderThan24h: false };
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return { formatted: "", isOlderThan24h: false };

  const isOlderThan24h = Date.now() - date.getTime() > 24 * 3600 * 1000;

  const day = date.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", day: "numeric" });
  const month = date.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", month: "short" });
  const year = date.toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", year: "numeric" });
  const time = date.toLocaleTimeString("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  return {
    formatted: `${day} ${month} ${year}, ${time} IST`,
    isOlderThan24h,
  };
}

/** Check if two headlines represent the exact same story from different syndicates */
export function areHeadlinesSimilar(h1: string, h2: string): boolean {
  const getKeywords = (str: string) => {
    return new Set(
      str
        .toLowerCase()
        .replace(/['’]s\b/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .map((w) => (w.endsWith("s") && w.length > 4 ? w.slice(0, -1) : w))
        .filter((w) => w.length > 3)
    );
  };
  const set1 = getKeywords(h1);
  const set2 = getKeywords(h2);
  if (set1.size === 0 || set2.size === 0) return false;

  let common = 0;
  for (const w of set1) {
    if (set2.has(w)) common++;
  }
  if (common < 2) return false;
  const overlap = common / Math.min(set1.size, set2.size);
  return overlap >= 0.55;
}

export interface TavilyRawResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
  score?: number;
}

export interface ProcessedStory {
  headline: string;
  source: string;
  url: string;
  publishedDate?: string;
  istFormatted: string;
  isOlderThan24h: boolean;
  whyItMatters: string;
  isAnalysis: boolean;
  analysisLabel?: string;
  score: number;
}

async function queryTavilyCategory(
  apiKey: string,
  query: string,
  days: number
): Promise<TavilyRawResult[]> {
  try {
    const usageCheck = await checkAndIncrementUsage("tavily");
    if (!usageCheck.allowed) {
      console.warn("[scheduler:briefing] Daily Tavily call cap reached. Skipping category search:", usageCheck.error);
      return [];
    }

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        topic: "news",
        days,
        max_results: 12,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
        exclude_domains: BRIEFING_EXCLUDE_DOMAINS,
      }),
    });

    if (!response.ok) {
      console.warn(
        `[scheduler:briefing] Tavily search responded with status ${response.status} ${response.statusText}`
      );
      return [];
    }

    const data = (await response.json()) as { results?: TavilyRawResult[] };
    return data.results ?? [];
  } catch (err) {
    console.warn("[scheduler:briefing] Failed to fetch query bullets from Tavily:", err);
    return [];
  }
}

async function fetchCategoryNews(
  apiKey: string,
  category: BriefingCategory
): Promise<string> {
  const query = category.query ?? "";
  if (!query) return "Nothing significant today.";

  const seenHeadlines: string[] = [];

  const processCandidates = (
    rawResults: TavilyRawResult[],
    allowedHours: number,
    markOlder: boolean
  ): ProcessedStory[] => {
    const valid: ProcessedStory[] = [];
    for (const r of rawResults) {
      if (!r.title || !r.url) continue;
      if (!isValidRecentArticle(r.published_date, allowedHours)) continue;
      if (isLowQualityTitle(r.title, r.url)) continue;

      const { headline, source } = extractSourceAndCleanHeadline(r.title, r.url);
      const isDuplicate = seenHeadlines.some((seen) => areHeadlinesSimilar(seen, headline));
      if (isDuplicate) continue;

      seenHeadlines.push(headline);

      const whyItMatters = buildWhyItMatters(r.content);
      const { isAnalysis, label: analysisLabel } = extractAnalysisAndAuthor(r.title, r.content);
      const { formatted: istFormatted, isOlderThan24h } = formatToIST(r.published_date);

      valid.push({
        headline,
        source,
        url: r.url,
        publishedDate: r.published_date,
        istFormatted,
        isOlderThan24h: markOlder || isOlderThan24h,
        whyItMatters,
        isAnalysis,
        analysisLabel,
        score: r.score ?? 0.8,
      });
    }
    return valid;
  };

  // 1. Initial query with days = 1 (24h)
  const initialRaw = await queryTavilyCategory(apiKey, query, 1);
  let stories = processCandidates(initialRaw, 26, false);

  // 2. Fallback retry with days = 2 if fewer than 2 results found
  if (stories.length < 2) {
    const fallbackRaw = await queryTavilyCategory(apiKey, query, 2);
    const fallbackStories = processCandidates(fallbackRaw, 50, true);
    for (const fb of fallbackStories) {
      if (!stories.some((s) => areHeadlinesSimilar(s.headline, fb.headline))) {
        stories.push(fb);
      }
    }
  }

  if (stories.length === 0) {
    return "Nothing significant today.";
  }

  // Sort by score / significance descending
  stories.sort((a, b) => b.score - a.score);

  // Select up to target count (e.g. 5 for International & Regional, 4 for Business & AI)
  const targetCount = category.count ?? 4;
  const selected = stories.slice(0, targetCount);

  // Enforce max 1 [Analysis] item per category
  let analysisCount = 0;
  const bullets: string[] = [];

  for (const item of selected) {
    let headlinePrefix = "";
    if (item.isAnalysis) {
      if (analysisCount === 0) {
        headlinePrefix = item.analysisLabel ?? "[Analysis] ";
        analysisCount++;
      }
    }
    const cleanHeadline = item.headline.replace(/^\[Analysis(?:,[^\]]+)?\]\s*/i, "").trim();
    const tagOlderThan24h = item.isOlderThan24h ? " (older than 24h)" : "";
    const datePart = item.istFormatted ? ` - ${item.istFormatted}${tagOlderThan24h}` : "";
    const line1 = `• ${headlinePrefix}${cleanHeadline} - ${item.source}${datePart}`;
    const line2 = item.whyItMatters ? `  Why it matters: ${item.whyItMatters}` : "";

    // Keep URL and metadata logged for verification
    console.log(`[briefing:verified] ${cleanHeadline} | ${item.url} | ${item.publishedDate}`);

    bullets.push(line2 ? `${line1}\n${line2}` : line1);
  }

  if (selected.length < targetCount) {
    bullets.push(`Only ${selected.length} significant items today`);
  }

  return bullets.join("\n\n");
}

export async function fetchBriefingSnapshot(_ownerTimezone: string): Promise<string | null> {
  const { TAVILY_API_KEY } = env();
  if (!TAVILY_API_KEY || TAVILY_API_KEY === "mock_tavily_key") {
    return null;
  }

  const results = await Promise.allSettled(
    BRIEFING_CATEGORIES.map((cat) => fetchCategoryNews(TAVILY_API_KEY, cat))
  );

  const sections: string[] = [];
  for (let i = 0; i < BRIEFING_CATEGORIES.length; i++) {
    const cat = BRIEFING_CATEGORIES[i];
    const result = results[i];
    const bullets =
      result.status === "fulfilled" && result.value.trim() ? result.value.trim() : "Nothing significant today.";
    if (bullets && bullets !== "Nothing significant today.") {
      sections.push(`${cat.emoji} **${cat.label ?? cat.category}**\n${bullets}`);
    }
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
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
          return await this.sendDailyBriefing();
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

  async sendDailyBriefing(options: { modelOverride?: string; isFallback?: boolean; fallbackReason?: string } = {}): Promise<boolean> {
    if (!this.dispatcher) return false;
    const { TELEGRAM_ALLOWED_USER_ID, USER_NAME, USER_TIMEZONE } = env();

    const todayDateStr = new Date().toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
    const scheduledAtIso = new Date().toISOString();

    // 1. Atomic claim in database to prevent double-sending
    const claimed = await this.store.claimDailyBriefing(TELEGRAM_ALLOWED_USER_ID, todayDateStr, scheduledAtIso);
    if (!claimed) {
      console.log(`[scheduler] Daily briefing for ${todayDateStr} already claimed or sent by another instance. Skipping.`);
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
      await this.store.markDailyBriefingSent(TELEGRAM_ALLOWED_USER_ID, todayDateStr, options.modelOverride);
      return true;
    } catch (err) {
      console.error("[scheduler] Failed to send daily briefing:", err);
      await sendCriticalAlert("scheduler_failed", err, { job: "sendDailyBriefing", date: todayDateStr });
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
