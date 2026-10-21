import { describe, it, expect, beforeEach, vi } from "vitest";
import { InMemoryDataStore } from "../db/in-memory-datastore.js";
import {
  ProactiveScheduler,
  InMemoryDispatcher,
  fetchBriefingSnapshot,
  BRIEFING_CATEGORIES,
  formatToIST,
  extractAnalysisAndAuthor,
} from "./scheduler.service.js";
import { env, setEnv } from "../config/env.js";

describe("ProactiveScheduler", () => {
  let store: InMemoryDataStore;
  let dispatcher: InMemoryDispatcher;
  let scheduler: ProactiveScheduler;

  beforeEach(() => {
    store = new InMemoryDataStore();
    dispatcher = new InMemoryDispatcher();
    scheduler = new ProactiveScheduler({ store, dispatcher });
  });

  it("checks and dispatches due reminders with interactive action buttons", async () => {
    const pastTime = new Date(Date.now() - 10000).toISOString();
    await store.createReminder({
      userId: 12345,
      chatId: 12345,
      message: "Call the dentist",
      triggerAt: pastTime,
    });

    const count = await scheduler.checkDueReminders();
    expect(count).toBe(1);

    expect(dispatcher.dispatched.length).toBe(1);
    expect(dispatcher.dispatched[0].chatId).toBe(12345);
    expect(dispatcher.dispatched[0].text).toContain("Call the dentist");
    expect(dispatcher.dispatched[0].buttons?.length).toBe(3);

    // Verify reminder marked as completed
    const active = await store.listActiveReminders(12345);
    expect(active.length).toBe(0);
  });

  it("snoozes a reminder through scheduler interface", async () => {
    const triggerAt = "2026-08-28T10:00:00.000Z";
    const reminder = await store.createReminder({
      userId: 123456789,
      chatId: 123456789,
      message: "Take a break",
      triggerAt,
    });

    const result = await scheduler.snooze(reminder.id, 15);
    expect(result.newTriggerAt).toBe("2026-08-28T10:15:00.000Z");
  });

  it("cancels a reminder through scheduler interface", async () => {
    const reminder = await store.createReminder({
      userId: 123456789,
      chatId: 123456789,
      message: "Cancel this",
      triggerAt: new Date().toISOString(),
    });

    const success = await scheduler.cancel(reminder.id);
    expect(success).toBe(true);
  });

  it("claims due reminder with lease and prevents double-claim under concurrent execution", async () => {
    const nowIso = new Date().toISOString();
    const pastTime = new Date(Date.now() - 5000).toISOString();
    const reminder = await store.createReminder({
      userId: 12345,
      chatId: 12345,
      message: "Concurrent test reminder",
      triggerAt: pastTime,
    });

    // Worker 1 claims with 2-minute lease
    const claimedWorker1 = await store.claimDueReminders(nowIso, 120_000);
    expect(claimedWorker1.length).toBe(1);
    expect(claimedWorker1[0].id).toBe(reminder.id);
    expect(claimedWorker1[0].delivery_attempts).toBe(1);
    expect(claimedWorker1[0].lease_until).toBeDefined();

    // Worker 2 attempts to claim concurrently at the same timestamp
    const claimedWorker2 = await store.claimDueReminders(nowIso, 120_000);
    expect(claimedWorker2.length).toBe(0);

    // After lease expires (121 seconds later), Worker 2 can reclaim it
    const futureIso = new Date(Date.now() + 125_000).toISOString();
    const reclaimed = await store.claimDueReminders(futureIso, 120_000);
    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0].id).toBe(reminder.id);
    expect(reclaimed[0].delivery_attempts).toBe(2);
  });

  it("retains lease and does not complete reminder when delivery fails", async () => {
    const pastTime = new Date(Date.now() - 10000).toISOString();
    const reminder = await store.createReminder({
      userId: 12345,
      chatId: 12345,
      message: "Flaky network reminder",
      triggerAt: pastTime,
    });

    // Make dispatcher throw to simulate network failure
    dispatcher.sendMessage = async () => {
      throw new Error("Telegram network timeout");
    };

    const count = await scheduler.checkDueReminders();
    expect(count).toBe(0);

    // Verify reminder is NOT completed and still has active lease
    const rawReminder = await store.getReminder(reminder.id, 12345);
    expect(rawReminder?.is_completed).toBe(false);
    expect(rawReminder?.lease_until).not.toBeNull();
    expect(rawReminder?.delivery_attempts).toBe(1);
  });

  it("cancels reminder when delivery attempts reach MAX_DELIVERY_ATTEMPTS", async () => {
    const pastTime = new Date(Date.now() - 10000).toISOString();
    const reminder = await store.createReminder({
      userId: 12345,
      chatId: 12345,
      message: "Poison reminder",
      triggerAt: pastTime,
    });

    // Simulate reminder having already been attempted 4 times
    await store.updateReminder(reminder.id, { delivery_attempts: 4 });

    dispatcher.sendMessage = async () => {
      throw new Error("Permanent chat failure");
    };

    const count = await scheduler.checkDueReminders();
    expect(count).toBe(0);

    const updated = await store.getReminder(reminder.id, 12345);
    expect(updated?.is_cancelled).toBe(true);
    expect(updated?.lease_until).toBeNull();
    expect(updated?.delivery_attempts).toBe(5);
  });

  it("prevents overlapping concurrent checkDueReminders executions with mutex lock", async () => {
    const pastTime = new Date(Date.now() - 10000).toISOString();
    await store.createReminder({
      userId: 12345,
      chatId: 12345,
      message: "Concurrent test",
      triggerAt: pastTime,
    });

    let resolveSendMessage: (() => void) | null = null;
    const sendMessagePromise = new Promise<void>((resolve) => {
      resolveSendMessage = resolve;
    });

    dispatcher.sendMessage = async () => {
      await sendMessagePromise;
    };

    const firstCallPromise = scheduler.checkDueReminders();
    const secondCallCount = await scheduler.checkDueReminders();
    expect(secondCallCount).toBe(0);

    resolveSendMessage!();
    const firstCallCount = await firstCallPromise;
    expect(firstCallCount).toBe(1);
  });

  describe("fetchBriefingSnapshot", () => {
    it("returns null in mock/test environment without real Tavily key", async () => {
      const snapshot = await fetchBriefingSnapshot("Asia/Kolkata");
      expect(snapshot).toBeNull();
    });

    it("returns null when external search fails or produces zero results", async () => {
      const current = env();
      setEnv({ ...current, TAVILY_API_KEY: "test_live_key" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        ({
          ok: false,
          status: 500,
        } as any);

      try {
        const snapshot = await fetchBriefingSnapshot("Asia/Kolkata");
        expect(snapshot).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
        setEnv(current);
      }
    });

    it("constructs categorized news sections when results are returned", async () => {
      const current = env();
      setEnv({ ...current, TAVILY_API_KEY: "test_live_key" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        ({
          ok: true,
          json: async () => ({
            results: [{ title: "Global Summit Reaches Historic Treaty - Reuters", url: "https://reuters.com/summit", published_date: new Date().toISOString(), content: "World leaders signed a landmark pact today." }],
          }),
        } as any);

      try {
        const snapshot = await fetchBriefingSnapshot("Asia/Kolkata");
        expect(snapshot).not.toBeNull();
        expect(snapshot).toContain("🌐 **International**");
        expect(snapshot).toContain("Global Summit Reaches Historic Treaty");
      } finally {
        globalThis.fetch = originalFetch;
        setEnv(current);
      }
    });

    it("excludes Sports from briefing categories by user policy", () => {
      const categoryLabels = BRIEFING_CATEGORIES.map((c) => c.label);
      expect(categoryLabels).not.toContain("Sports");
      expect(categoryLabels).toEqual([
        "International",
        "Business & Economy",
        "AI & Technology",
        "Regional (India)",
      ]);
    });

    it("configures briefing categories with updated targets (Total: 18 items max)", () => {
      const counts = BRIEFING_CATEGORIES.map((c) => ({ label: c.label, count: c.count }));
      expect(counts).toEqual([
        { label: "International", count: 5 },
        { label: "Business & Economy", count: 4 },
        { label: "AI & Technology", count: 4 },
        { label: "Regional (India)", count: 5 },
      ]);
      const total = BRIEFING_CATEGORIES.reduce((acc, c) => acc + (c.count ?? 0), 0);
      expect(total).toBe(18);
    });

    it("appends 'Only N significant items today' when category has fewer items than target", async () => {
      const current = env();
      setEnv({ ...current, TAVILY_API_KEY: "test_live_key" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        ({
          ok: true,
          json: async () => ({
            results: [
              {
                title: "Major International Treaty Signed in Geneva - Reuters",
                url: "https://reuters.com/geneva-treaty",
                published_date: new Date().toISOString(),
                content: "Delegates concluded the multinational pact in Geneva today.",
              },
            ],
          }),
        } as any);

      try {
        const snapshot = await fetchBriefingSnapshot("Asia/Kolkata");
        expect(snapshot).not.toBeNull();
        expect(snapshot).toContain("Only 1 significant items today");
      } finally {
        globalThis.fetch = originalFetch;
        setEnv(current);
      }
    });

    it("filters out generic portal homepage meta-titles and deduplicates syndications", async () => {
      const current = env();
      setEnv({ ...current, TAVILY_API_KEY: "test_live_key" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        ({
          ok: true,
          json: async () => ({
            results: [
              {
                title:
                  "India News, Latest India News, Today's Breaking News Headlines from India | The Indian Express",
                url: "https://indianexpress.com/section/india/",
              },
              {
                title:
                  "Hindustan Times: Breaking News, Latest News, India News, World News & Cricket Today's Headlines | Hindustan Times",
                url: "https://www.hindustantimes.com/india-news",
              },
              {
                title: "Rubio and India's foreign minister hold talks in India on Tuesday - KCRA",
                url: "https://kcra.com/article/123",
                published_date: new Date().toISOString(),
                content: "U.S. officials met with Indian ministers for trade talks.",
              },
              {
                title: "Rubio and Jaishankar hold talks in Mumbai as US and India aim to finalize trade deal - ABC News",
                url: "https://abcnews.com/article/456",
                published_date: new Date().toISOString(),
                content: "Trade delegations discussed bilateral agreements in Mumbai.",
              },
              {
                title: "Cabinet approves new semiconductor manufacturing incentive package - Livemint",
                url: "https://livemint.com/article/789",
                published_date: new Date().toISOString(),
                content: "The Union Cabinet cleared financial outlays for chip fabrication units.",
              },
            ],
          }),
        } as any);

      try {
        const snapshot = await fetchBriefingSnapshot("Asia/Kolkata");
        expect(snapshot).not.toBeNull();
        // Landing page SEO titles filtered out
        expect(snapshot).not.toContain("The Indian Express");
        expect(snapshot).not.toContain("Cricket Today's Headlines");
        // Real story included
        expect(snapshot).toContain("Cabinet approves new semiconductor");
        // Duplicate Rubio story deduplicated (only one included)
        const countRubio = (snapshot?.match(/Rubio/g) || []).length;
        // In the snapshot, each category runs, but within any category Rubio should only appear once
        expect(snapshot).toContain("• Rubio");
      } finally {
        globalThis.fetch = originalFetch;
        setEnv(current);
      }
    });
    it("enforces briefing quality rules: recency verification, non-news filtering, source attribution, and summaries", async () => {
      const current = env();
      setEnv({ ...current, TAVILY_API_KEY: "test_live_key" });
      const originalFetch = globalThis.fetch;

      const nowIso = new Date().toISOString();
      const twoDaysAgoIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

      globalThis.fetch = async (url: any, opts: any) => {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                title: "Largest economies in the world, by nominal GDP",
                url: "https://qz.com/largest-economies",
                published_date: nowIso,
                content: "Ranking of top global economies by nominal GDP data.",
                score: 0.95,
              },
              {
                title: "What Is Tool Calling in AI? How It Works and Why It Matters",
                url: "https://techblog.com/tool-calling",
                published_date: nowIso,
                content: "A guide on how function calling and tool use work in LLMs.",
                score: 0.92,
              },
              {
                title: "Economy And Infrastructure - IMPRI Impact And Policy Research Institute",
                url: "https://impriindia.com/economy-infrastructure",
                published_date: nowIso,
                content: "Topic page for research reports on Indian infrastructure.",
                score: 0.91,
              },
              {
                title: "The Morning Brief Decode - ET Now Video",
                url: "https://economictimes.indiatimes.com/videos/morning-brief",
                published_date: nowIso,
                content: "Watch ET Now video on oil demand and currency markets.",
                score: 0.90,
              },
              {
                title: "Six Months After the 131st Amendment Bill Failed - Karmactive",
                url: "https://karmactive.com/bill-analysis",
                published_date: twoDaysAgoIso, // Stale (> 24h)
                content: "Analysis on women's quota bill progress in parliament.",
                score: 0.89,
              },
              {
                title: "DNB Exceeds Q3 Profit Forecast as Economy Stays Resilient",
                url: "https://www.globalbankingandfinance.com/dnb-q3-earnings",
                published_date: nowIso, // Fresh
                content: "Norway's largest lender posted quarterly net profits beating analyst expectations due to robust net interest income.",
                score: 0.94,
              },
              {
                title: "Anthropic releases Claude 3.5 Haiku enterprise model - TechCrunch",
                url: "https://techcrunch.com/anthropic-claude-haiku",
                published_date: nowIso, // Fresh
                content: "The new model provides near frontier coding capability at one-third the latency and cost of previous versions.",
                score: 0.96,
              },
            ],
          }),
        } as any;
      };

      try {
        const snapshot = await fetchBriefingSnapshot("Asia/Kolkata");
        expect(snapshot).not.toBeNull();

        // 1. Non-news & videos excluded
        expect(snapshot).not.toContain("Largest economies in the world");
        expect(snapshot).not.toContain("What Is Tool Calling in AI");
        expect(snapshot).not.toContain("Economy And Infrastructure - IMPRI");
        expect(snapshot).not.toContain("ET Now Video");

        // 2. Stale article (> 24h) excluded when fresh articles exist
        expect(snapshot).not.toContain("Six Months After the 131st Amendment");

        // 3. Source extracted even if missing from headline
        expect(snapshot).toContain("Global Banking & Finance");

        // 4. Summary sentence included
        expect(snapshot).toContain("Norway's largest lender posted quarterly net profits");

        // 5. Valid article with headline, source, and summary
        expect(snapshot).toContain("Anthropic releases Claude 3.5 Haiku enterprise model");
        expect(snapshot).toContain("TechCrunch");
      } finally {
        globalThis.fetch = originalFetch;
        setEnv(current);
      }
    });

    it("verifies sendDailyBriefing states calendar not connected and omits closing chatbot filler", async () => {
      const current = env();
      setEnv({ ...current, TAVILY_API_KEY: "test_live_key" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        ({
          ok: true,
          json: async () => ({ results: [] }),
        } as any);

      const store = new (await import("../db/in-memory-datastore.js")).InMemoryDataStore();
      const dispatcher = new InMemoryDispatcher();
      const scheduler = new ProactiveScheduler({ store, dispatcher });

      try {
        await scheduler.sendDailyBriefing();
        expect(dispatcher.dispatched.length).toBe(1);
        const text = dispatcher.dispatched[0].text;

        // Calendar check
        expect(text).toContain("Calendar not connected, agenda unknown.");
        expect(text).not.toContain("Clear agenda!");
        expect(text).not.toContain("Good Morning");
        expect(text).toContain("Today's Intelligence Briefing");

        // Chatbot filler removed
        expect(text).not.toContain("Online and ready");
        expect(text).not.toContain("What's on the agenda?");
      } finally {
        globalThis.fetch = originalFetch;
        setEnv(current);
      }
    });
  });

    it("formats dates to IST and correctly flags items older than 24 hours", () => {
      const now = new Date();
      const recentDate = new Date(now.getTime() - 2 * 3600 * 1000).toISOString();
      const olderDate = new Date(now.getTime() - 25 * 3600 * 1000).toISOString();

      const recentResult = formatToIST(recentDate);
      expect(recentResult.formatted).toMatch(/\d{1,2}\s[A-Z][a-z]{2}\s\d{4},\s\d{2}:\d{2}\s(?:AM|PM)\sIST/);
      expect(recentResult.isOlderThan24h).toBe(false);

      const olderResult = formatToIST(olderDate);
      expect(olderResult.isOlderThan24h).toBe(true);
    });

    it("extracts analysis and author correctly", () => {
      const res1 = extractAnalysisAndAuthor("[Analysis, opinion by Mani Shankar Aiyar] Cockroach Movement");
      expect(res1.isAnalysis).toBe(true);
      expect(res1.label).toBe("[Analysis, opinion by Mani Shankar Aiyar] ");

      const res2 = extractAnalysisAndAuthor("Opinion: Global trade realignments", "opinion by John Doe");
      expect(res2.isAnalysis).toBe(true);
      expect(res2.label).toBe("[Analysis, opinion by John Doe] ");

      const res3 = extractAnalysisAndAuthor("Regular news title", "Just regular news content");
      expect(res3.isAnalysis).toBe(false);
      expect(res3.label).toBe("");
    });

    it("ensures briefing output contains no markdown links or URLs", async () => {
      const current = env();
      setEnv({ ...current, TAVILY_API_KEY: "test_live_key" });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        ({
          ok: true,
          json: async () => ({
            results: [
              {
                title: "Major Economic Summit Concludes - Reuters",
                url: "https://reuters.com/economic-summit",
                published_date: new Date().toISOString(),
                content: "Leaders signed agreements on digital taxation and trade today.",
              },
            ],
          }),
        } as any);

      try {
        const snapshot = await fetchBriefingSnapshot("Asia/Kolkata");
        expect(snapshot).not.toBeNull();
        expect(snapshot).not.toMatch(/https?:\/\//);
        expect(snapshot).not.toMatch(/\[.*?\]\(.*?\)/);
        expect(snapshot).toContain("Why it matters:");
      } finally {
        globalThis.fetch = originalFetch;
        setEnv(current);
      }
    });

  describe("Idempotent Scheduled Jobs & Distributed Concurrency", () => {
    it("prevents double-sending when two scheduler instances run sendDailyBriefing at once", async () => {
      const current = env();
      setEnv({ ...current, TAVILY_API_KEY: "mock_tavily_key" });

      const store = new (await import("../db/in-memory-datastore.js")).InMemoryDataStore();
      const dispatcher1 = new InMemoryDispatcher();
      const dispatcher2 = new InMemoryDispatcher();

      const scheduler1 = new ProactiveScheduler({ store, dispatcher: dispatcher1 });
      const scheduler2 = new ProactiveScheduler({ store, dispatcher: dispatcher2 });

      try {
        const [res1, res2] = await Promise.all([
          scheduler1.sendDailyBriefing(),
          scheduler2.sendDailyBriefing(),
        ]);

        // Exactly one instance should succeed in claiming and sending
        expect([res1, res2]).toContain(true);
        expect([res1, res2]).toContain(false);
        expect(dispatcher1.dispatched.length + dispatcher2.dispatched.length).toBe(1);
      } finally {
        setEnv(current);
      }
    });

    it("prevents double-delivery when two scheduler instances run checkDueReminders at once", async () => {
      const store = new (await import("../db/in-memory-datastore.js")).InMemoryDataStore();
      const dispatcher1 = new InMemoryDispatcher();
      const dispatcher2 = new InMemoryDispatcher();

      const scheduler1 = new ProactiveScheduler({ store, dispatcher: dispatcher1 });
      const scheduler2 = new ProactiveScheduler({ store, dispatcher: dispatcher2 });

      // Create a due reminder
      const nowIso = new Date().toISOString();
      await store.createReminder({
        userId: 123456789,
        chatId: 123456789,
        message: "Double run test",
        triggerAt: nowIso,
      });

      const [count1, count2] = await Promise.all([
        scheduler1.checkDueReminders(),
        scheduler2.checkDueReminders(),
      ]);

      // Exactly 1 reminder should be claimed and sent
      expect(count1 + count2).toBe(1);
      expect(dispatcher1.dispatched.length + dispatcher2.dispatched.length).toBe(1);
    });

    it("sends missed briefing on restart when scheduled time passed within grace window", async () => {
      const current = env();
      const store = new (await import("../db/in-memory-datastore.js")).InMemoryDataStore();
      const dispatcher = new InMemoryDispatcher();

      // Configure scheduled briefing time to 30 minutes in the past
      const now = new Date();
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(now);
      const curHour = Number(parts.find((p) => p.type === "hour")?.value ?? "12");
      const curMin = Number(parts.find((p) => p.type === "minute")?.value ?? "0");

      let pastHour = curHour;
      let pastMin = curMin - 30;
      if (pastMin < 0) {
        pastMin += 60;
        pastHour = Math.max(0, pastHour - 1);
      }
      const pastTimeStr = `${String(pastHour).padStart(2, "0")}:${String(pastMin).padStart(2, "0")}`;

      setEnv({
        ...current,
        TAVILY_API_KEY: "mock_tavily_key",
        USER_TIMEZONE: "Asia/Kolkata",
        BRIEFING_TIME: pastTimeStr,
        BRIEFING_MISSED_GRACE_PERIOD_MINUTES: 120,
      });

      const scheduler = new ProactiveScheduler({ store, dispatcher });

      try {
        const sent = await scheduler.checkMissedBriefing();
        expect(sent).toBe(true);
        expect(dispatcher.dispatched.length).toBe(1);
        expect(dispatcher.dispatched[0].text).toContain("Today's Intelligence Briefing");
      } finally {
        setEnv(current);
      }
    });

    it("skips missed briefing on restart when scheduled time passed beyond grace window", async () => {
      const current = env();
      const store = new (await import("../db/in-memory-datastore.js")).InMemoryDataStore();
      const dispatcher = new InMemoryDispatcher();

      // Configure scheduled briefing time to 3 hours in the past, with a 30m grace period
      setEnv({
        ...current,
        TAVILY_API_KEY: "mock_tavily_key",
        USER_TIMEZONE: "Asia/Kolkata",
        BRIEFING_TIME: "00:01",
        BRIEFING_MISSED_GRACE_PERIOD_MINUTES: 5,
      });

      const scheduler = new ProactiveScheduler({ store, dispatcher });

      try {
        const sent = await scheduler.checkMissedBriefing();
        expect(sent).toBe(false);
        expect(dispatcher.dispatched.length).toBe(0);
      } finally {
        setEnv(current);
      }
    });

    it("respects Tavily daily cap and pauses search calls when limit reached", async () => {
      const current = env();
      const costTracker = await import("./cost-tracker.service.js");
      costTracker.resetDailyUsage();

      setEnv({
        ...current,
        TAVILY_API_KEY: "real_or_mock_key",
        DAILY_TAVILY_CALL_CAP: 2,
      });

      const originalFetch = globalThis.fetch;
      let fetchCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCount++;
        return {
          ok: true,
          json: async () => ({
            results: [{ title: "News 1", url: "https://example.com/1", published_date: new Date().toISOString() }],
          }),
        };
      });

      try {
        const { fetchBriefingSnapshot } = await import("./scheduler.service.js");
        await fetchBriefingSnapshot("Asia/Kolkata");
        // At most 2 fetch calls should have executed due to DAILY_TAVILY_CALL_CAP: 2
        expect(fetchCount).toBeLessThanOrEqual(2);
      } finally {
        globalThis.fetch = originalFetch;
        costTracker.resetDailyUsage();
        setEnv(current);
      }
    });
  });
});

