import { parseTimeString } from "../utils/time.js";
import type { DataStore } from "../db/datastore.js";
import { getDataStore } from "../db/datastore-provider.js";
import { env } from "../config/env.js";
import { checkAndIncrementUsage } from "./cost-tracker.service.js";

// ─── Live Briefing Types & Definitions ───────────────────────────────────────

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
  includeDomains?: string[];
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
    includeDomains: [
      "reuters.com",
      "apnews.com",
      "bloomberg.com",
      "bbc.com",
      "ft.com",
      "wsj.com",
      "aljazeera.com",
      "theguardian.com",
    ],
  },
  {
    category: "AI & Technology",
    label: "AI & Technology",
    emoji: "🤖",
    query:
      "artificial intelligence AI LLM model release Anthropic OpenAI Google Nvidia breakthrough funding today",
    count: 4,
    includeDomains: [
      "techcrunch.com",
      "theverge.com",
      "wired.com",
      "venturebeat.com",
      "arstechnica.com",
      "reuters.com",
      "bloomberg.com",
      "technologyreview.com",
      "cnbc.com",
    ],
  },
  {
    category: "Regional (India)",
    label: "Regional (India)",
    emoji: "🇮🇳",
    query:
      "India national news politics central government parliament Supreme Court economy policy decisions today",
    count: 5,
    includeDomains: [
      "thehindu.com",
      "indianexpress.com",
      "hindustantimes.com",
      "livemint.com",
      "economictimes.indiatimes.com",
      "timesofindia.indiatimes.com",
      "ndtv.com",
      "reuters.com",
    ],
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

export const KNOWN_OUTLET_NAMES: Record<string, string> = {
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
  "theguardian.com": "The Guardian",
  "technologyreview.com": "MIT Tech Review",
  "venturebeat.com": "VentureBeat",
  "arstechnica.com": "Ars Technica",
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
  const outletStripped = title.replace(/\s*\|\s*(the indian express|hindustan times|times of india|ndtv|livemint|the hindu|india today|news18)\s*$/i, "").trim();
  const trimmed = outletStripped || title.trim();
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
    // Regulatory filings, SEC documents, and crypto/etf prospectus spam
    /\bForm\s+(S-1|10-K|10-Q|8-K|S-1\/A|6-K)\b/i,
    /\b(CANARY STAKED|ETF For:)\b/i,
    /\bSEC Filing\b/i,
    // Weekly quotes roundups, generic open mics, and retrospective blogs
    /\bquotes of the week\b/i,
    /\bopen mike\b/i,
    /\bpost \d{4} election reflections\b/i,
  ];

  if (badPatterns.some((re) => re.test(trimmed) || re.test(coreHeadline))) {
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

  // Strip tag clouds (e.g. "Transformation,11,Diplomacy,15,Diplomatic Row,6...")
  text = text.replace(/(?:[A-Za-z0-9\s&/'-]+,\s*\d+,\s*){2,}[A-Za-z0-9\s&/'-]+,\s*\d+/g, "");

  // Strip common CMS navigation, editorial notices, and subscription prompts
  text = text.replace(
    /(?:skip to (?:content|main)|open mike|written by:\s*notices|categories:\s*open mike|become a member|subscribe to your choice|sign up for free)[^.]*[.?!]?/gi,
    ""
  );

  // Strip markdown images and inline link brackets: ![...](...) or [text](url) or Image 7 Image 8
  text = text.replace(/!\[.*?\]\(.*?\)/g, "");
  text = text.replace(/\[(.*?)\]\(.*?\)/g, "$1");
  text = text.replace(/Image \d+\s*(Image \d+\s*)*/gi, "");

  // Replace bracketed ellipses [...] or […] with ...
  text = text.replace(/\[\s*(?:\.{3}|…)\s*\]/g, "...");

  // Strip remaining markdown formatting characters that can break Telegram entity parsing
  text = text.replace(/[[\]*`_~]/g, "");

  text = text.replace(/\s+/g, " ").trim();
  if (!text) return "";

  const sentenceMatch = text.match(/^(.+?(?:(?<!\.)[.?!](?!\.)(?=\s+[A-Z0-9]|$)))/);
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

export async function queryTavilyCategory(
  apiKey: string,
  query: string,
  days: number,
  includeDomains?: string[]
): Promise<TavilyRawResult[]> {
  try {
    const usageCheck = await checkAndIncrementUsage("tavily");
    if (!usageCheck.allowed) {
      console.warn("[scheduler:briefing] Daily Tavily call cap reached. Skipping category search:", usageCheck.error);
      return [];
    }

    const payload: Record<string, any> = {
      api_key: apiKey,
      query,
      topic: "news",
      days,
      max_results: 12,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
      exclude_domains: BRIEFING_EXCLUDE_DOMAINS,
    };

    if (includeDomains && includeDomains.length > 0) {
      payload.include_domains = includeDomains;
    }

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.warn(
        `[scheduler:briefing] Tavily search responded with status ${response.status} ${response.statusText}`
      );
      return [];
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      console.warn("[scheduler:briefing] Failed to parse Tavily search JSON response");
      return [];
    }
    return Array.isArray(data?.results) ? data.results : [];
  } catch (err) {
    console.warn("[scheduler:briefing] Failed to fetch query bullets from Tavily:", err);
    return [];
  }
}

export async function fetchCategoryNews(
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
  const initialRaw = await queryTavilyCategory(apiKey, query, 1, category.includeDomains);
  let stories = processCandidates(initialRaw, 26, false);

  // 2. Fallback retry with days = 2 if fewer than 2 results found
  if (stories.length < 2) {
    const fallbackRaw = await queryTavilyCategory(apiKey, query, 2, category.includeDomains);
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

// ─── Daily Briefing Settings Action ──────────────────────────────────────────

export async function updateBriefingTimeAction(
  rawTime: string,
  userId: number = env().TELEGRAM_ALLOWED_USER_ID,
  store: DataStore = getDataStore()
): Promise<{ success: boolean; time: string }> {
  const normalizedTime = parseTimeString(rawTime);
  const { USER_NAME, USER_TIMEZONE } = env();

  await store.upsertUserProfile({
    id: userId,
    name: USER_NAME,
    timezone: USER_TIMEZONE,
    briefing_time: normalizedTime,
  });

  return { success: true, time: normalizedTime };
}
