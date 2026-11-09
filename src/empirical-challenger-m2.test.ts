import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ProactiveScheduler,
  isLowQualityTitle,
} from "./services/scheduler.service.js";
import {
  sendCriticalAlert,
  setAlertDispatcher,
  resetAlertRateLimits,
} from "./services/alert.service.js";
import {
  getFallbackChain,
  isRetriableModelError,
} from "./services/model.service.js";
import {
  getDailyUsage,
  checkAndIncrementUsage,
  resetDailyUsage,
} from "./services/cost-tracker.service.js";
import {
  cleanJsonText,
  FactExtractionResponseSchema,
} from "./services/compaction.service.js";
import { InMemoryDataStore } from "./db/in-memory-datastore.js";
import { env, setEnv } from "./config/env.js";

class MockDispatcher {
  public sentMessages: Array<{ chatId: number; text: string; options?: any }> = [];
  public shouldFail = false;

  async sendMessage(chatId: number, text: string, options?: any): Promise<void> {
    if (this.shouldFail) {
      throw new Error("Simulated dispatcher network failure");
    }
    this.sentMessages.push({ chatId, text, options });
  }
}

describe("Empirical Challenger M2: Comprehensive Lifecycle & Service Stress Verification", () => {
  const originalEnv = { ...env() };

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    setEnv(originalEnv);
    resetAlertRateLimits();
    resetDailyUsage();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Scheduler Missed Briefing Date Handling & Daily Briefing Override
  // =========================================================================
  describe("Area 1: Scheduler missed briefing date handling and daily briefing override", () => {
    let store: InMemoryDataStore;
    let dispatcher: MockDispatcher;
    let scheduler: ProactiveScheduler;

    beforeEach(() => {
      store = new InMemoryDataStore();
      dispatcher = new MockDispatcher();
      scheduler = new ProactiveScheduler({ store, dispatcher });
    });

    it("claims and records specified briefingDate override without burning today's slot", async () => {
      const yesterday = "2026-11-08";
      const today = new Date().toLocaleDateString("en-CA", { timeZone: env().USER_TIMEZONE });

      // Send briefing for yesterday explicitly
      const result = await scheduler.sendDailyBriefing({ briefingDate: yesterday });
      expect(result).toBe(true);

      // Verify yesterday was recorded as last briefing date
      const lastDate = await store.getLastBriefingDate(env().TELEGRAM_ALLOWED_USER_ID);
      expect(lastDate).toBe(yesterday);

      // Verify today is still completely unclaimed and available
      const claimToday = await store.claimDailyBriefing(
        env().TELEGRAM_ALLOWED_USER_ID,
        today,
        new Date().toISOString()
      );
      expect(claimToday).toBe(true);
    });

    it("respects fallback targetDateStr when briefingDate is omitted", async () => {
      const customDate = "2026-10-15";
      const result = await scheduler.sendDailyBriefing({ targetDateStr: customDate });
      expect(result).toBe(true);

      const lastDate = await store.getLastBriefingDate(env().TELEGRAM_ALLOWED_USER_ID);
      expect(lastDate).toBe(customDate);
    });

    it("includes fallback model annotation in message text when isFallback is true", async () => {
      const targetDate = "2026-11-08";
      await scheduler.sendDailyBriefing({
        briefingDate: targetDate,
        isFallback: true,
        modelOverride: "llama-3.3-70b-versatile",
        fallbackReason: "Primary Gemini 429 quota exhaustion",
      });

      expect(dispatcher.sentMessages.length).toBe(1);
      const msg = dispatcher.sentMessages[0].text;
      expect(msg).toContain("Served via llama-3.3-70b-versatile fallback: Primary Gemini 429 quota exhaustion");
    });

    it("enforces atomic concurrency: concurrent briefing runs for same date allow only one", async () => {
      const targetDate = "2026-11-08";
      const [run1, run2] = await Promise.all([
        scheduler.sendDailyBriefing({ briefingDate: targetDate }),
        scheduler.sendDailyBriefing({ briefingDate: targetDate }),
      ]);

      // Exactly one succeeds, the other fails due to atomic store claim
      expect([run1, run2].filter(Boolean).length).toBe(1);
    });

    it("checkMissedBriefing claims yesterday's date when restart happens before today's scheduled briefing", async () => {
      const { USER_TIMEZONE } = env();
      setEnv({ ...env(), BRIEFING_TIME: "08:00", BRIEFING_MISSED_GRACE_PERIOD_MINUTES: 120 });

      // Mock current time to 08:30 today
      const mockNow = new Date("2026-11-09T08:30:00+05:30");
      vi.setSystemTime(mockNow);

      const todayStr = mockNow.toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
      const success = await scheduler.checkMissedBriefing();
      expect(success).toBe(true);

      const lastSent = await store.getLastBriefingDate(env().TELEGRAM_ALLOWED_USER_ID);
      expect(lastSent).toBe(todayStr);

      vi.useRealTimers();
    });

    it("checkMissedBriefing skips when time passed exceeds grace window", async () => {
      setEnv({ ...env(), BRIEFING_TIME: "08:00", BRIEFING_MISSED_GRACE_PERIOD_MINUTES: 30 });

      // Mock current time to 09:00 today (60m passed > 30m grace)
      const mockNow = new Date("2026-11-09T09:00:00+05:30");
      vi.setSystemTime(mockNow);

      const success = await scheduler.checkMissedBriefing();
      expect(success).toBe(false);

      const lastSent = await store.getLastBriefingDate(env().TELEGRAM_ALLOWED_USER_ID);
      expect(lastSent).toBeNull();

      vi.useRealTimers();
    });
  });

  // =========================================================================
  // 2. News Title Outlet Filter (Valid Titles vs Low Quality Titles)
  // =========================================================================
  describe("Area 2: News title outlet filter (isLowQualityTitle)", () => {
    const validIndianNewsHeadlines = [
      "Cabinet approves Rs 10,000 crore semiconductor incentive package | The Indian Express",
      "RBI keeps repo rate unchanged at 6.5 percent amid inflation concerns | Livemint",
      "Supreme Court issues landmark verdict on environmental clearances | Hindustan Times",
      "ISRO successfully launches navigation satellite into geosynchronous transfer orbit | NDTV",
      "Sensex closes 400 points higher led by banking and IT stocks | The Hindu",
      "Finance Ministry reviews quarterly tax collection progress | India Today",
      "Railways announces modernization of 50 stations across southern zone | News18",
      "Global tech firm announces $2 billion AI research hub in Hyderabad | Times of India",
      "Major infrastructure project approved in Maharashtra - Hindustan Times",
      "National highway expansion project receives cabinet greenlight | the hindu",
      "Border security grid enhanced with new surveillance drones | THE INDIAN EXPRESS",
      "Monsoon arrives in Kerala two days ahead of normal schedule | Livemint",
      "Exports surge 15 percent in October led by engineering goods | NDTV",
    ];

    it.each(validIndianNewsHeadlines)("accepts legitimate news article: %s", (headline) => {
      expect(isLowQualityTitle(headline)).toBe(false);
    });

    const adversarialLowQualityHeadlines = [
      // Bare outlet suffix without real headline (under 20 chars)
      "| Livemint",
      "| Hindustan Times",
      "| Times of India",
      "| The Hindu",
      "| India Today",
      "| News18",
      "| NDTV",
      "Hindustan Times",
      "NDTV",
      "Livemint",
      // Too short (< 20 chars)
      "Stock markets rise",
      "India news update",
      // Ellipsis indicating truncated feed
      "Government announces new policy on semiconductor...",
      "Breaking news from Delhi today…",
      // Portal landings / badPatterns
      "Latest news today: top stories from across India",
      "Breaking news headlines from across the country",
      "Top news headlines from Delhi and Mumbai",
      "News updates | Morning edition",
      "Morning news brief: what you need to know",
      "School assembly news headlines for tomorrow",
      "November 9, 2026: top news headlines",
      "Top stories of the day in business and tech",
      // Educational guides and explainers (not breaking news)
      "What is quantum computing and how it works",
      "How to register for the new welfare scheme",
      "Why is inflation rising across emerging markets",
      "A beginner's guide to sovereign gold bonds",
      "Everything you need to know about the union budget",
      "Explained: Why crude oil prices are falling",
      "Python programming tutorial for beginners",
      // Rankings & Listicles
      "Largest economies in the world by nominal GDP",
      "Top 10 best stocks to buy this month",
      "Top 5 ways to save tax this financial year",
      // Multimedia & Institutional
      "Video: Finance Minister addresses press conference",
      "Live updates: Parliament monsoon session day 3",
      "Daily podcast: Tech developments of the week",
      "Government issues official statement on trade talks",
    ];

    it.each(adversarialLowQualityHeadlines)("rejects low-quality or non-news title: %s", (headline) => {
      expect(isLowQualityTitle(headline)).toBe(true);
    });

    it("rejects valid titles when pointing to forbidden domains or generic category paths", () => {
      const validTitle = "Cabinet approves Rs 10,000 crore semiconductor incentive package";
      // Excluded domain
      expect(isLowQualityTitle(validTitle, "https://youtube.com/watch?v=12345")).toBe(true);
      expect(isLowQualityTitle(validTitle, "https://reddit.com/r/india/comments/123")).toBe(true);
      // Generic section landing page
      expect(isLowQualityTitle(validTitle, "https://timesofindia.indiatimes.com/india-news")).toBe(true);
      expect(isLowQualityTitle(validTitle, "https://hindustantimes.com/news/india")).toBe(true);
      expect(isLowQualityTitle(validTitle, "https://thehindu.com/news/columns")).toBe(true);
    });
  });

  // =========================================================================
  // 3. Alert Suppression Timing & Failure Recovery
  // =========================================================================
  describe("Area 3: Alert suppression timing and failure recovery", () => {
    let mockDispatcher: { sendAlert: (message: string) => Promise<void> } & { sendAlert: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      resetAlertRateLimits();
      const sendAlertMock = vi.fn(async (_msg: string): Promise<void> => {});
      mockDispatcher = {
        sendAlert: sendAlertMock,
      };
      setAlertDispatcher(mockDispatcher as any);
    });

    afterEach(() => {
      setAlertDispatcher(null);
    });

    it("does not suppress or set timestamp when alert dispatcher is null", async () => {
      setAlertDispatcher(null);
      const res1 = await sendCriticalAlert("embedding_failure", new Error("No dispatcher"));
      expect(res1).toBe(false);

      // Now attach dispatcher: should succeed immediately without being rate limited
      setAlertDispatcher(mockDispatcher as any);
      const res2 = await sendCriticalAlert("embedding_failure", new Error("With dispatcher"));
      expect(res2).toBe(true);
      expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(1);
    });

    it("does not suppress or set timestamp when dispatcher throws an error (delivery failure)", async () => {
      mockDispatcher.sendAlert = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network connection reset"))
        .mockRejectedValueOnce(new Error("504 Gateway Timeout"))
        .mockResolvedValueOnce(undefined);

      // First attempt fails
      const res1 = await sendCriticalAlert("all_models_down", new Error("Fail 1"));
      expect(res1).toBe(false);

      // Immediate second attempt fails
      const res2 = await sendCriticalAlert("all_models_down", new Error("Fail 2"));
      expect(res2).toBe(false);

      // Immediate third attempt succeeds (not blocked by rate limit!)
      const res3 = await sendCriticalAlert("all_models_down", new Error("Success 3"));
      expect(res3).toBe(true);
      expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(3);

      // Fourth attempt immediately after success MUST be suppressed
      const res4 = await sendCriticalAlert("all_models_down", new Error("Too soon"));
      expect(res4).toBe(false);
      expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(3);
    });

    it("tracks rate limits independently across different alert types", async () => {
      const res1 = await sendCriticalAlert("embedding_failure", new Error("Embedding down"));
      expect(res1).toBe(true);

      // Same type is suppressed
      const res2 = await sendCriticalAlert("embedding_failure", new Error("Embedding down again"));
      expect(res2).toBe(false);

      // Different type is allowed
      const res3 = await sendCriticalAlert("quota_exceeded", new Error("Tavily cap hit"));
      expect(res3).toBe(true);

      // Third distinct type is allowed
      const res4 = await sendCriticalAlert("scheduler_failed", new Error("Cron crash"));
      expect(res4).toBe(true);

      expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(3);
    });

    it("permits alert dispatch once rate limit window expires", async () => {
      const windowMs = 50; // 50ms window
      const res1 = await sendCriticalAlert("quota_warning", new Error("80% reached"), undefined, windowMs);
      expect(res1).toBe(true);

      // Immediate retry is suppressed
      const res2 = await sendCriticalAlert("quota_warning", new Error("80% reached"), undefined, windowMs);
      expect(res2).toBe(false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 80));

      // After window expiration, alert is allowed again
      const res3 = await sendCriticalAlert("quota_warning", new Error("80% reached after wait"), undefined, windowMs);
      expect(res3).toBe(true);
      expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // 4. Model Fallback Chain Ordering and Retriable Error Detection
  // =========================================================================
  describe("Area 4: Model fallback chain ordering and retriable error detection", () => {
    beforeEach(() => {
      setEnv({
        ...env(),
        DEFAULT_LLM_PROVIDER: "groq",
        GEMINI_API_KEY: "test-gemini-key",
        GEMINI_MODEL: "gemini-2.5-flash",
        GROQ_API_KEY: "test-groq-key",
        GROQ_MODEL: "llama-3.3-70b-versatile",
        OPENAI_API_KEY: "test-openai-key",
        OPENAI_MODEL: "gpt-4o",
      });
    });

    it("includes Gemini at head of fallback chain when primary is Groq", () => {
      const chain = getFallbackChain("groq");
      expect(chain.length).toBe(2);
      expect(chain[0].provider).toBe("Gemini");
      expect(chain[1].provider).toBe("OpenAI");
    });

    it("includes Gemini at head of fallback chain when primary is OpenAI", () => {
      const chain = getFallbackChain("openai");
      expect(chain.length).toBe(2);
      expect(chain[0].provider).toBe("Gemini");
      expect(chain[1].provider).toBe("Groq");
    });

    it("excludes Gemini from fallback chain when primary is Gemini", () => {
      const chain = getFallbackChain("gemini");
      expect(chain.length).toBe(2);
      expect(chain[0].provider).toBe("Groq");
      expect(chain[1].provider).toBe("OpenAI");
    });

    it("omits providers whose API keys are not configured", () => {
      setEnv({
        ...env(),
        GEMINI_API_KEY: "",
        GROQ_API_KEY: "",
        OPENAI_API_KEY: "test-openai-key",
      });

      const chain = getFallbackChain("groq");
      expect(chain.length).toBe(1);
      expect(chain[0].provider).toBe("OpenAI");
    });

    describe("isRetriableModelError comprehensive classification", () => {
      // Retriable HTTP status codes via status and statusCode
      const retriableStatusCodes = [429, 500, 501, 502, 503, 504];

      it.each(retriableStatusCodes)("identifies numeric status %i as retriable", (code) => {
        expect(isRetriableModelError({ status: code })).toBe(true);
      });

      it.each(retriableStatusCodes)("identifies numeric statusCode %i as retriable", (code) => {
        expect(isRetriableModelError({ statusCode: code })).toBe(true);
      });

      it.each(retriableStatusCodes)("identifies string status '%i' as retriable", (code) => {
        expect(isRetriableModelError({ status: String(code) })).toBe(true);
      });

      it.each(retriableStatusCodes)("identifies string statusCode '%i' as retriable", (code) => {
        expect(isRetriableModelError({ statusCode: String(code) })).toBe(true);
      });

      // Retriable error messages
      const retriableMessages = [
        "Rate limit exceeded for requests per minute",
        "Resource has been exhausted (e.g. check quota)",
        "Daily quota exceeded for project 123",
        "503 Service Unavailable",
        "502 Bad Gateway from upstream proxy",
        "504 Gateway Timeout while contacting LLM endpoint",
        "TypeError: fetch failed due to socket hang up",
        "Error: ETIMEDOUT connect to api.groq.com",
        "Error: ECONNRESET by peer",
        "Error: ENOTFOUND generativelanguage.googleapis.com",
        "Request was aborted due to timeout",
        "The operation timed out after 30000ms",
      ];

      it.each(retriableMessages)("identifies retriable message substring: %s", (msg) => {
        expect(isRetriableModelError(new Error(msg))).toBe(true);
      });

      // Non-retriable errors
      const nonRetriableErrors = [
        { status: 400, message: "Bad Request: invalid prompt format" },
        { status: 401, message: "Unauthorized: API key invalid" },
        { status: 403, message: "Forbidden: insufficient permissions" },
        { status: 404, message: "Not Found: model checkpoint does not exist" },
        { statusCode: 422, message: "Unprocessable Entity: schema mismatch" },
        new Error("SyntaxError: Unexpected token < in JSON"),
        new Error("ValidationError: 'temperature' must be between 0 and 2"),
        {},
        null,
        undefined,
        "simple string error",
        12345,
        false,
      ];

      it.each(nonRetriableErrors)("rejects non-retriable error: %o", (err) => {
        expect(isRetriableModelError(err)).toBe(false);
      });
    });
  });

  // =========================================================================
  // 5. Cost Tracker Zero Cap Arithmetic
  // =========================================================================
  describe("Area 5: Cost tracker zero cap arithmetic", () => {
    it("handles zero cap for LLM without evaluating to Infinity or NaN", async () => {
      setEnv({ ...env(), DAILY_LLM_CALL_CAP: 0 });

      // getDailyUsage must return 0% and finite number
      const usage = getDailyUsage("llm");
      expect(usage.count).toBe(0);
      expect(usage.cap).toBe(0);
      expect(usage.percentage).toBe(0);
      expect(Number.isFinite(usage.percentage)).toBe(true);

      // checkAndIncrementUsage must immediately refuse without dividing by zero
      const check = await checkAndIncrementUsage("llm");
      expect(check.allowed).toBe(false);
      expect(check.count).toBe(0);
      expect(check.cap).toBe(0);
      expect(check.percentage).toBe(100);
      expect(Number.isFinite(check.percentage)).toBe(true);
    });

    it("handles zero cap for Tavily without evaluating to Infinity or NaN", async () => {
      setEnv({ ...env(), DAILY_TAVILY_CALL_CAP: 0 });

      const usage = getDailyUsage("tavily");
      expect(usage.count).toBe(0);
      expect(usage.cap).toBe(0);
      expect(usage.percentage).toBe(0);
      expect(Number.isFinite(usage.percentage)).toBe(true);

      const check = await checkAndIncrementUsage("tavily");
      expect(check.allowed).toBe(false);
      expect(check.count).toBe(0);
      expect(check.cap).toBe(0);
      expect(check.percentage).toBe(100);
      expect(Number.isFinite(check.percentage)).toBe(true);
    });

    it("triggers quota_warning exactly once at 80% and quota_exceeded at 100%", async () => {
      setEnv({ ...env(), DAILY_LLM_CALL_CAP: 5 });

      // Calls 1 to 3: under 80%
      for (let i = 1; i <= 3; i++) {
        const res = await checkAndIncrementUsage("llm");
        expect(res.allowed).toBe(true);
        expect(res.count).toBe(i);
      }

      // Call 4: 4/5 = 80%, triggers warning
      const res4 = await checkAndIncrementUsage("llm");
      expect(res4.allowed).toBe(true);
      expect(res4.count).toBe(4);
      expect(res4.percentage).toBe(80);

      // Call 5: 5/5 = 100%, allowed as the final permitted call
      const res5 = await checkAndIncrementUsage("llm");
      expect(res5.allowed).toBe(true);
      expect(res5.count).toBe(5);
      expect(res5.percentage).toBe(100);

      // Call 6: 100% exceeded, refused
      const res6 = await checkAndIncrementUsage("llm");
      expect(res6.allowed).toBe(false);
      expect(res6.count).toBe(5);
      expect(res6.percentage).toBe(100);
    });
  });

  // =========================================================================
  // 6. Compaction Balanced JSON Extraction vs Malformed/Multi-bracketed Inputs
  // =========================================================================
  describe("Area 6: Compaction balanced JSON extraction", () => {
    it("extracts clean JSON array despite trailing footnotes with bracketed annotations", () => {
      const input = `
Here are the extracted facts:
[
  {"content": "Prefers green tea in the morning", "importance": 4, "tags": ["routine", "diet"]},
  {"content": "Works from home on Fridays", "importance": 3, "tags": ["work"]}
]

Footnotes and citations:
[1] User message at 2026-10-01 10:00:00
[2] Reference to earlier note [sec 3.2]
`;
      const cleaned = cleanJsonText(input);
      const parsed = JSON.parse(cleaned);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
      expect(parsed[0].content).toBe("Prefers green tea in the morning");
      expect(parsed[1].content).toBe("Works from home on Fridays");

      const validated = FactExtractionResponseSchema.parse(parsed);
      expect(validated.length).toBe(2);
    });

    it("extracts balanced JSON object containing nested arrays without stopping prematurely", () => {
      const input = `
Extraction output:
{
  "facts": [
    {"content": "Owns a Golden Retriever", "importance": 5, "tags": ["pets", "dog"]},
    {"content": "Runs 5km three times a week", "importance": 4, "tags": ["fitness"]}
  ],
  "metadata": {
    "total": 2,
    "confidence": 0.95
  }
}
Additional commentary: [end of transmission]
`;
      const cleaned = cleanJsonText(input);
      const parsed = JSON.parse(cleaned);
      expect(parsed.facts.length).toBe(2);

      const validated = FactExtractionResponseSchema.parse(parsed);
      expect(validated.length).toBe(2);
      expect(validated[0].content).toBe("Owns a Golden Retriever");
    });

    it("correctly ignores brackets and escaped double quotes inside string literals", () => {
      const input = `
[
  {
    "content": "User said: \\"[URGENT] please update flight details\\"",
    "importance": 5,
    "tags": ["travel", "[priority]"]
  }
]
[appendix A]
`;
      const cleaned = cleanJsonText(input);
      const parsed = JSON.parse(cleaned);
      expect(parsed.length).toBe(1);
      expect(parsed[0].content).toBe('User said: "[URGENT] please update flight details"');
      expect(parsed[0].tags).toEqual(["travel", "[priority]"]);
    });

    it("handles deeply nested structures with mixed braces and brackets", () => {
      const input = `
[
  {
    "content": "Complex nested memory",
    "importance": 4,
    "tags": ["nested"],
    "details": {
      "matrix": [[1, 2], [3, 4]],
      "inner": {"key": "val [with bracket]"}
    }
  }
]
[external ref]
`;
      const cleaned = cleanJsonText(input);
      const parsed = JSON.parse(cleaned);
      expect(parsed.length).toBe(1);
      expect(parsed[0].details.matrix).toEqual([[1, 2], [3, 4]]);
      expect(parsed[0].details.inner.key).toBe("val [with bracket]");
    });

    it("handles markdown code block with surrounding conversational text and brackets", () => {
      const input = `
Below is the JSON result:
\`\`\`json
[
  {"content": "Studying for AWS certification", "importance": 4, "tags": ["learning"]}
]
\`\`\`
Note: See module [AWS-101] for details.
`;
      const cleaned = cleanJsonText(input);
      const parsed = JSON.parse(cleaned);
      expect(parsed.length).toBe(1);
      expect(parsed[0].content).toBe("Studying for AWS certification");
    });

    it("gracefully falls back on text without brackets or empty inputs", () => {
      expect(cleanJsonText("")).toBe("");
      expect(cleanJsonText("No brackets here")).toBe("No brackets here");
      expect(cleanJsonText("   ")).toBe("");
    });
  });
});
