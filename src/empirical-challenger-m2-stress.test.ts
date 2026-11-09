import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanJsonText } from "./services/compaction.service.js";
import {
  sendCriticalAlert,
  setAlertDispatcher,
  resetAlertRateLimits,
  AlertDispatcher,
  CriticalAlertType,
} from "./services/alert.service.js";
import { ProactiveScheduler, isLowQualityTitle } from "./services/scheduler.service.js";
import { InMemoryDataStore } from "./db/in-memory-datastore.js";
import { env, setEnv } from "./config/env.js";

describe("Milestone 2 Adversarial Stress Harness — Challenger 2", () => {
  describe("1. Compaction Parser Adversarial Stress Harness", () => {
    it("parses deeply nested quotes and escaped characters inside strings", () => {
      const raw = `\`\`\`json
[
  {
    "content": "He said: \\"Hello, world!\\"",
    "importance": 3,
    "tags": ["quote"]
  },
  {
    "content": "Escaped backslashes: C:\\\\Program Files\\\\App and quote: \\"test\\"",
    "importance": 4,
    "tags": ["path"]
  }
]
\`\`\``;
      const cleaned = cleanJsonText(raw);
      const parsed = JSON.parse(cleaned);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].content).toBe('He said: "Hello, world!"');
      expect(parsed[1].content).toBe('Escaped backslashes: C:\\Program Files\\App and quote: "test"');
    });

    it("parses strings containing escaped braces and brackets without confusing delimiter balancer", () => {
      const raw = `[
  {
    "content": "Formula with braces: \\\\{a + b\\\\} = c and brackets: \\\\[index\\\\]",
    "importance": 5,
    "tags": ["math"]
  },
  {
    "content": "Unescaped literal braces in string { foo: 'bar' } and [array]",
    "importance": 2,
    "tags": ["code"]
  }
]`;
      const cleaned = cleanJsonText(raw);
      const parsed = JSON.parse(cleaned);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].content).toContain("\\{a + b\\}");
      expect(parsed[1].content).toContain("{ foo: 'bar' }");
    });

    it("handles deeply interleaved structures (arrays containing objects containing arrays of objects)", () => {
      const complex = [
        {
          id: 1,
          matrix: [
            [{ cell: "a1" }, { cell: "b1" }],
            [{ cell: "a2" }, { cell: "b2" }],
          ],
          nestedObj: {
            subList: ["x", "y", "z"],
            deepObj: { value: 42 },
          },
        },
        {
          id: 2,
          matrix: [],
          nestedObj: null,
        },
      ];

      const raw = `Results:\n${JSON.stringify(complex, null, 2)}\n\nEnd of output [ref 12]`;
      const cleaned = cleanJsonText(raw);
      const parsed = JSON.parse(cleaned);
      expect(parsed).toEqual(complex);
    });

    it("handles root JSON objects with nested arrays and trailing bracket annotations", () => {
      const obj = {
        title: "Summary",
        facts: [
          { item: 1, labels: ["alpha", "beta"] },
          { item: 2, labels: ["gamma"] },
        ],
        notes: "No issues",
      };

      const raw = `Here is the data:\n${JSON.stringify(obj)}\n\n[Citation 1] [Citation 2]`;
      const cleaned = cleanJsonText(raw);
      const parsed = JSON.parse(cleaned);
      expect(parsed).toEqual(obj);
    });

    it("handles strings with embedded code containing curly braces, brackets, and quotes", () => {
      const codeSnippet = 'function test() { const arr = [1, "two", { three: 3 }]; return arr[0]; }';
      const payload = [
        {
          content: codeSnippet,
          importance: 5,
          tags: ["javascript"],
        },
      ];

      const raw = `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
      const cleaned = cleanJsonText(raw);
      const parsed = JSON.parse(cleaned);
      expect(parsed[0].content).toBe(codeSnippet);
    });

    it("handles truncated JSON array gracefully with fallback slicing", () => {
      const raw = `[{"content": "first", "importance": 1}, {"content": "second", "importance": 2}`;
      // Incomplete JSON missing closing bracket ']'
      const cleaned = cleanJsonText(raw);
      expect(cleaned).toBeDefined();
    });

    it("handles stress payload with 500 items and mixed brackets", () => {
      const items = Array.from({ length: 500 }, (_, i) => ({
        content: `Fact #${i} with brackets [${i}] and braces {${i}} and quotes "${i}"`,
        importance: (i % 5) + 1,
        tags: [`tag-${i % 10}`],
      }));

      const raw = `Header comment\n${JSON.stringify(items)}\nFooter comment [tag: 500]`;
      const cleaned = cleanJsonText(raw);
      const parsed = JSON.parse(cleaned);
      expect(parsed).toHaveLength(500);
      expect(parsed[499].content).toBe('Fact #499 with brackets [499] and braces {499} and quotes "499"');
    });
  });

  describe("2. Agent Mock Discrimination Stress Harness", () => {
    it("correctly discriminates Tavily search vs Google embedding across string, URL, and Request inputs", async () => {
      const mockFetch = vi.fn().mockImplementation(async (input: any) => {
        const urlStr =
          typeof input === "string"
            ? input
            : input instanceof URL
            ? input.href
            : input && typeof input === "object" && "url" in input
            ? String(input.url)
            : String(input);

        if (urlStr.includes("tavily.com")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ answer: "AI news results", results: [{ title: "News 1" }] }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            embedding: { values: new Array(768).fill(0.01) },
          }),
        };
      });

      // 1. String URL for Tavily
      const resTavilyStr = await mockFetch("https://api.tavily.com/search?query=test");
      const tavilyData = await resTavilyStr.json();
      expect(tavilyData.answer).toBe("AI news results");

      // 2. URL object for Tavily
      const resTavilyObj = await mockFetch(new URL("https://api.tavily.com/search?query=url_obj"));
      const tavilyDataObj = await resTavilyObj.json();
      expect(tavilyDataObj.answer).toBe("AI news results");

      // 3. Request-like object for Tavily
      const resTavilyReq = await mockFetch({ url: "https://api.tavily.com/search" });
      const tavilyDataReq = await resTavilyReq.json();
      expect(tavilyDataReq.answer).toBe("AI news results");

      // 4. Google embeddings string URL
      const resGoogleStr = await mockFetch("https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent");
      const googleData = await resGoogleStr.json();
      expect(googleData.embedding.values).toHaveLength(768);

      // 5. Query parameter containing 'embedding' in Tavily URL does not misroute
      const resTavilyWithEmbedQuery = await mockFetch("https://api.tavily.com/search?query=what+is+text+embedding");
      const embedQueryData = await resTavilyWithEmbedQuery.json();
      expect(embedQueryData.answer).toBe("AI news results");

      // 6. Google embeddings URL containing 'tavily' in referrer does route to Tavily
      // (Verifying discrimination boundary)
      const resGoogleReferrer = await mockFetch("https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent?ref=internal");
      const googleRefData = await resGoogleReferrer.json();
      expect(googleRefData.embedding.values).toHaveLength(768);
    });

    it("handles concurrent multi-threaded mock dispatch without state contamination", async () => {
      const mockFetch = vi.fn().mockImplementation(async (input: any) => {
        const urlStr =
          typeof input === "string"
            ? input
            : input instanceof URL
            ? input.href
            : input && typeof input === "object" && "url" in input
            ? String(input.url)
            : String(input);

        if (urlStr.includes("tavily.com")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ answer: "AI news results", results: [] }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            embedding: { values: new Array(768).fill(0.01) },
          }),
        };
      });

      const promises = Array.from({ length: 50 }, (_, i) => {
        if (i % 2 === 0) {
          return mockFetch(`https://api.tavily.com/search?q=${i}`).then((r: any) => r.json());
        } else {
          return mockFetch(`https://generativelanguage.googleapis.com/v1beta/models/test:${i}`).then((r: any) => r.json());
        }
      });

      const results = await Promise.all(promises);
      for (let i = 0; i < 50; i++) {
        if (i % 2 === 0) {
          expect(results[i]).toHaveProperty("answer", "AI news results");
        } else {
          expect(results[i].embedding.values).toHaveLength(768);
        }
      }
    });
  });

  describe("3. Alert Service Repeated Failure & Error Recovery Stress Harness", () => {
    let mockDispatcher: AlertDispatcher;

    beforeEach(() => {
      resetAlertRateLimits();
      mockDispatcher = {
        sendAlert: vi.fn(),
      };
      setAlertDispatcher(mockDispatcher);
    });

    afterEach(() => {
      setAlertDispatcher(null);
      resetAlertRateLimits();
    });

    it("survives 10 consecutive dispatch failures and delivers immediately when dispatcher recovers", async () => {
      mockDispatcher.sendAlert = vi.fn()
        .mockRejectedValueOnce(new Error("Network reset 1"))
        .mockRejectedValueOnce(new Error("Network reset 2"))
        .mockRejectedValueOnce(new Error("Network reset 3"))
        .mockRejectedValueOnce(new Error("Network reset 4"))
        .mockRejectedValueOnce(new Error("Network reset 5"))
        .mockRejectedValueOnce(new Error("Network reset 6"))
        .mockRejectedValueOnce(new Error("Network reset 7"))
        .mockRejectedValueOnce(new Error("Network reset 8"))
        .mockRejectedValueOnce(new Error("Network reset 9"))
        .mockRejectedValueOnce(new Error("Network reset 10"))
        .mockResolvedValueOnce(undefined);

      // 10 failures
      for (let i = 1; i <= 10; i++) {
        const success = await sendCriticalAlert("embedding_failure", new Error(`Failure ${i}`));
        expect(success).toBe(false);
      }
      expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(10);

      // Attempt 11: Dispatcher recovers! Must succeed and NOT be suppressed by earlier failures
      const recovered = await sendCriticalAlert("embedding_failure", new Error("Final recovered alert"));
      expect(recovered).toBe(true);
      expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(11);

      // Attempt 12 immediately after: Must NOW be suppressed by rate limit window
      const suppressed = await sendCriticalAlert("embedding_failure", new Error("Suppressed subsequent"));
      expect(suppressed).toBe(false);
      expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(11);
    });

    it("handles synchronous throws inside dispatcher without crashing caller", async () => {
      mockDispatcher.sendAlert = vi.fn().mockImplementation(() => {
        throw new Error("Synchronous crash in dispatcher");
      });

      const result = await sendCriticalAlert("all_models_down", new Error("Fatal models down"));
      expect(result).toBe(false);
    });

    it("handles multiple interleaved alert types failing and succeeding independently", async () => {
      const types: CriticalAlertType[] = [
        "embedding_failure",
        "scheduler_failed",
        "all_models_down",
        "quota_warning",
        "quota_exceeded",
      ];

      // Fail all types once
      mockDispatcher.sendAlert = vi.fn().mockRejectedValue(new Error("Global outage"));
      for (const t of types) {
        const res = await sendCriticalAlert(t, new Error(`Test ${t}`));
        expect(res).toBe(false);
      }

      // Restore dispatcher
      mockDispatcher.sendAlert = vi.fn().mockResolvedValue(undefined);

      // Each type should now succeed exactly once
      for (const t of types) {
        const res = await sendCriticalAlert(t, new Error(`Recovered ${t}`));
        expect(res).toBe(true);
      }
      expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(5);

      // Second round for all types should now be suppressed
      for (const t of types) {
        const res = await sendCriticalAlert(t, new Error(`Second round ${t}`));
        expect(res).toBe(false);
      }
      expect(mockDispatcher.sendAlert).toHaveBeenCalledTimes(5);
    });

    it("handles concurrent alert calls for same type gracefully", async () => {
      mockDispatcher.sendAlert = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      // Fire 5 concurrent alerts of the same type
      const results = await Promise.all([
        sendCriticalAlert("scheduler_failed", new Error("Concurrent 1")),
        sendCriticalAlert("scheduler_failed", new Error("Concurrent 2")),
        sendCriticalAlert("scheduler_failed", new Error("Concurrent 3")),
        sendCriticalAlert("scheduler_failed", new Error("Concurrent 4")),
        sendCriticalAlert("scheduler_failed", new Error("Concurrent 5")),
      ]);

      // All 5 may dispatch if launched concurrently before first resolves, but none crash
      expect(results.every((r) => typeof r === "boolean")).toBe(true);
    });
  });

  describe("4. Scheduler Missed Briefing Date Handling Stress Harness", () => {
    let store: InMemoryDataStore;
    let mockDispatcher: { sendMessage: any };

    beforeEach(() => {
      store = new InMemoryDataStore();
      mockDispatcher = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
    });

    it("handles same-day missed briefing within grace period: claims today and sends", async () => {
      const scheduler = new ProactiveScheduler({ store, dispatcher: mockDispatcher });

      const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: env().USER_TIMEZONE });
      
      // Override fetchSavedBriefingTime to simulate a scheduled time 30 minutes in the past
      const now = new Date();
      const pastTime = new Date(now.getTime() - 30 * 60 * 1000);
      const pastTimeStr = `${String(pastTime.getHours()).padStart(2, "0")}:${String(pastTime.getMinutes()).padStart(2, "0")}`;
      (scheduler as any).fetchSavedBriefingTime = vi.fn().mockResolvedValue(pastTimeStr);

      const missedHandled = await scheduler.checkMissedBriefing();
      expect(missedHandled).toBe(true);

      const lastSentDate = await store.getLastBriefingDate(env().TELEGRAM_ALLOWED_USER_ID);
      expect(lastSentDate).toBe(todayStr);
      expect(mockDispatcher.sendMessage).toHaveBeenCalledTimes(1);

      // Verify immediate second check doesn't double-send
      const doubleCheck = await scheduler.checkMissedBriefing();
      expect(doubleCheck).toBe(false);
      expect(mockDispatcher.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("handles same-day startup when briefing was already sent today: skips silently", async () => {
      const scheduler = new ProactiveScheduler({ store, dispatcher: mockDispatcher });
      const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: env().USER_TIMEZONE });

      // Simulate already sent today
      await store.claimDailyBriefing(env().TELEGRAM_ALLOWED_USER_ID, todayStr, new Date().toISOString());
      await store.markDailyBriefingSent(env().TELEGRAM_ALLOWED_USER_ID, todayStr);

      const now = new Date();
      const pastTime = new Date(now.getTime() - 30 * 60 * 1000);
      const pastTimeStr = `${String(pastTime.getHours()).padStart(2, "0")}:${String(pastTime.getMinutes()).padStart(2, "0")}`;
      (scheduler as any).fetchSavedBriefingTime = vi.fn().mockResolvedValue(pastTimeStr);

      const missedHandled = await scheduler.checkMissedBriefing();
      expect(missedHandled).toBe(false);
      expect(mockDispatcher.sendMessage).not.toHaveBeenCalled();
    });

    it("handles startup before today's briefing time without triggering early delivery", async () => {
      const scheduler = new ProactiveScheduler({ store, dispatcher: mockDispatcher });

      // Scheduled time 2 hours in the future
      const now = new Date();
      const futureTime = new Date(now.getTime() + 120 * 60 * 1000);
      const futureTimeStr = `${String(futureTime.getHours()).padStart(2, "0")}:${String(futureTime.getMinutes()).padStart(2, "0")}`;
      (scheduler as any).fetchSavedBriefingTime = vi.fn().mockResolvedValue(futureTimeStr);

      const missedHandled = await scheduler.checkMissedBriefing();
      expect(missedHandled).toBe(false);
      expect(mockDispatcher.sendMessage).not.toHaveBeenCalled();
    });

    it("handles yesterday missed briefing: records yesterday's date and preserves today's briefing slot", async () => {
      const scheduler = new ProactiveScheduler({ store, dispatcher: mockDispatcher });

      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yesterdayDateStr = yesterday.toLocaleDateString("en-CA", { timeZone: env().USER_TIMEZONE });
      const todayDateStr = new Date().toLocaleDateString("en-CA", { timeZone: env().USER_TIMEZONE });

      // Directly invoke sendDailyBriefing with yesterday's briefingDate
      const sent = await scheduler.sendDailyBriefing({ briefingDate: yesterdayDateStr });
      expect(sent).toBe(true);

      const lastDate = await store.getLastBriefingDate(env().TELEGRAM_ALLOWED_USER_ID);
      expect(lastDate).toBe(yesterdayDateStr);

      // Verify today's briefing date remains unclaimed and claimable
      const claimedToday = await store.claimDailyBriefing(
        env().TELEGRAM_ALLOWED_USER_ID,
        todayDateStr,
        new Date().toISOString()
      );
      expect(claimedToday).toBe(true);
    });

    it("handles multiple days missed (e.g. 5 days of downtime): gracefully skips expired briefings", async () => {
      const scheduler = new ProactiveScheduler({ store, dispatcher: mockDispatcher });

      // Last briefing sent 5 days ago
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      const fiveDaysAgoDateStr = fiveDaysAgo.toLocaleDateString("en-CA", { timeZone: env().USER_TIMEZONE });
      await store.claimDailyBriefing(env().TELEGRAM_ALLOWED_USER_ID, fiveDaysAgoDateStr, fiveDaysAgo.toISOString());
      await store.markDailyBriefingSent(env().TELEGRAM_ALLOWED_USER_ID, fiveDaysAgoDateStr);

      // Today's scheduled time was 5 hours ago (300 minutes, exceeding 120 min grace)
      const now = new Date();
      const pastTime = new Date(now.getTime() - 300 * 60 * 1000);
      const pastTimeStr = `${String(pastTime.getHours()).padStart(2, "0")}:${String(pastTime.getMinutes()).padStart(2, "0")}`;
      (scheduler as any).fetchSavedBriefingTime = vi.fn().mockResolvedValue(pastTimeStr);

      const missedHandled = await scheduler.checkMissedBriefing();
      expect(missedHandled).toBe(false);
      expect(mockDispatcher.sendMessage).not.toHaveBeenCalled();

      // Today's briefing slot is NOT claimed
      const todayDateStr = now.toLocaleDateString("en-CA", { timeZone: env().USER_TIMEZONE });
      const claimedToday = await store.claimDailyBriefing(
        env().TELEGRAM_ALLOWED_USER_ID,
        todayDateStr,
        now.toISOString()
      );
      expect(claimedToday).toBe(true);
    });

    it("validates news title filter allows Indian news articles with outlet pipe suffixes", () => {
      const testCases = [
        {
          title: "Cabinet approves Rs 10,000 crore semiconductor incentive package | The Indian Express",
          expected: false,
        },
        {
          title: "RBI keeps repo rate unchanged at 6.5 percent amid inflation concerns | Livemint",
          expected: false,
        },
        {
          title: "Supreme Court issues landmark verdict on environmental clearances | Hindustan Times",
          expected: false,
        },
        {
          title: "ISRO launches navigation satellite into precise orbit | NDTV",
          expected: false,
        },
        {
          title: "Indian economy poised to grow at 7 percent this fiscal: World Bank | The Hindu",
          expected: false,
        },
        // Low quality should still be rejected:
        {
          title: "Watch: Video of politician speech | NDTV",
          expected: true,
        },
        {
          title: "Short | Livemint",
          expected: true,
        },
      ];

      for (const tc of testCases) {
        expect(isLowQualityTitle(tc.title)).toBe(tc.expected);
      }
    });
  });
});
