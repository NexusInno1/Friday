import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isLowQualityTitle,
  buildWhyItMatters,
  queryTavilyCategory,
  fetchCategoryNews,
  BRIEFING_CATEGORIES,
} from "./briefing.service.js";
import { env, setEnv } from "../config/env.js";

describe("Briefing Service - Quality & Sourcing Enhancements", () => {
  describe("isLowQualityTitle", () => {
    it("filters out SEC forms and crypto ETF filings", () => {
      expect(
        isLowQualityTitle("Form S-1/A CANARY STAKED INJ ETF For: 8 November", "https://in.investing.com/etf")
      ).toBe(true);
      expect(
        isLowQualityTitle("Form 10-K Annual Filing - SEC Filing", "https://sec.gov/filing")
      ).toBe(true);
      expect(
        isLowQualityTitle("Company files Form 8-K with regulators", "https://marketwatch.com/filing")
      ).toBe(true);
    });

    it("filters out weekly quotes, open mics, and retrospective blog posts", () => {
      expect(
        isLowQualityTitle("More quotes of the week - Homepaddock", "https://homepaddock.co.nz")
      ).toBe(true);
      expect(
        isLowQualityTitle("Open Mike 09/11/2026 – The Standard", "https://thestandard.org.nz")
      ).toBe(true);
      expect(
        isLowQualityTitle("Post 2026 Election Reflections – The Standard", "https://thestandard.org.nz")
      ).toBe(true);
    });

    it("allows genuine news headlines", () => {
      expect(
        isLowQualityTitle(
          "India and France sign major defense cooperation treaty in New Delhi",
          "https://thehindu.com/news/national/defense-treaty"
        )
      ).toBe(false);
      expect(
        isLowQualityTitle(
          "Supreme Court directs central government to notify new digital data rules",
          "https://indianexpress.com/article/india/data-rules"
        )
      ).toBe(false);
    });
  });

  describe("buildWhyItMatters", () => {
    it("strips CMS tag clouds with numbers and categories", () => {
      const rawContent =
        "Transformation,11,Diplomacy,15,Diplomatic Row,6,Disaster Management,4,Disinformation,3,Diversity & Inclusion,1,Divorce Law,2,Djibouti,3,Documentary,3,DOGE,1,Doklam,2. Russia and Ukraine delegates convened in Abu Dhabi to finalize postwar security protocols.";
      const summary = buildWhyItMatters(rawContent);
      expect(summary).not.toContain("Transformation,11");
      expect(summary).not.toContain("Diplomacy,15");
      expect(summary).toContain("Russia and Ukraine delegates");
    });

    it("strips CMS navigation text, editorial notices, and subscription prompts", () => {
      const rawContent =
        "Skip to content The Standard # Open Mike 09/11/2026 Written By: notices and features - Date published: - No comments Categories: open mike. The prime minister addressed Parliament regarding the fiscal deficit.";
      const summary = buildWhyItMatters(rawContent);
      expect(summary).not.toContain("Skip to content");
      expect(summary).not.toContain("Written By: notices");
      expect(summary).toContain("The prime minister addressed");
    });

    it("strips markdown entities that cause Telegram parse crashes", () => {
      const rawContent =
        "Economic [...] Beto O'Rourke met with officials. *Exclusive* reports confirm trade pact details.";
      const summary = buildWhyItMatters(rawContent);
      expect(summary).not.toContain("[...]");
      expect(summary).not.toContain("[");
      expect(summary).not.toContain("]");
      expect(summary).not.toContain("*");
      expect(summary).toContain("Economic ... Beto O'Rourke");
    });

    it("limits summary to max 25 words", () => {
      const rawContent =
        "Word one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven.";
      const summary = buildWhyItMatters(rawContent);
      const words = summary.replace(/\.\.\.$/, "").split(/\s+/);
      expect(words.length).toBeLessThanOrEqual(25);
    });
  });

  describe("queryTavilyCategory", () => {
    const originalFetch = globalThis.fetch;
    let currentEnv: ReturnType<typeof env>;

    beforeEach(() => {
      currentEnv = env();
      setEnv({ ...currentEnv, TAVILY_API_KEY: "test_key" });
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      setEnv(currentEnv);
    });

    it("passes include_domains to Tavily when specified", async () => {
      let capturedPayload: any = null;
      globalThis.fetch = vi.fn().mockImplementation(async (_url, opts) => {
        capturedPayload = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({ results: [] }),
        };
      });

      await queryTavilyCategory("test_key", "test query", 1, ["thehindu.com", "reuters.com"]);
      expect(capturedPayload).not.toBeNull();
      expect(capturedPayload.include_domains).toEqual(["thehindu.com", "reuters.com"]);
      expect(capturedPayload.topic).toBe("news");
      expect(capturedPayload.days).toBe(1);
    });
  });

  describe("fetchCategoryNews formatting", () => {
    const originalFetch = globalThis.fetch;
    let currentEnv: ReturnType<typeof env>;

    beforeEach(() => {
      currentEnv = env();
      setEnv({ ...currentEnv, TAVILY_API_KEY: "test_key" });
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      setEnv(currentEnv);
    });

    it("formats 'Why it matters:' strictly on a new line after the headline", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                title: "India and France sign defense pact - The Hindu",
                url: "https://thehindu.com/news/national/defense-pact",
                published_date: new Date().toISOString(),
                content: "Both nations agreed to strengthen naval logistics in the Indian Ocean region.",
                score: 0.95,
              },
            ],
          }),
        };
      });

      const category = BRIEFING_CATEGORIES.find((c) => c.category === "Regional (India)")!;
      const result = await fetchCategoryNews("test_key", category);

      expect(result).toContain("• India and France sign defense pact - The Hindu");
      expect(result).toMatch(/\n  Why it matters: Both nations agreed/);
      // Ensure 'Why it matters:' is NOT on the same line as the timestamp
      expect(result).not.toMatch(/IST[ \t]+Why it matters:/);
    });
  });
});
