import { env } from "../config/env.js";
import { checkAndIncrementUsage } from "./cost-tracker.service.js";

export interface WebSearchOptions {
  maxResults?: number;
  topic?: "general" | "news";
  days?: number;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string | null;
}

export interface WebSearchResult {
  answer: string | null;
  results: WebSearchResultItem[];
}

export async function webSearchAction(
  query: string,
  optionsOrMaxResults: number | WebSearchOptions = 5
): Promise<WebSearchResult> {
  const { TAVILY_API_KEY } = env();
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("Search query cannot be empty.");
  }

  const usageCheck = await checkAndIncrementUsage("tavily");
  if (!usageCheck.allowed) {
    return {
      answer: usageCheck.error ?? "Daily web search limit reached. Search is paused until tomorrow.",
      results: [],
    };
  }

  const options: WebSearchOptions =
    typeof optionsOrMaxResults === "number"
      ? { maxResults: optionsOrMaxResults }
      : optionsOrMaxResults;

  const maxResults = options.maxResults ?? 5;
  const topic = options.topic ?? "general";
  const days = options.days ?? (topic === "news" ? 1 : undefined);

  const payload: Record<string, unknown> = {
    api_key: TAVILY_API_KEY,
    query: trimmed,
    max_results: maxResults,
    search_depth: "basic",
    include_answer: true,
    include_raw_content: false,
  };

  if (topic === "news") {
    payload.topic = "news";
    payload.days = days ?? 1;
  } else if (days !== undefined) {
    payload.days = days;
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TAVILY_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    const safeErrBody = TAVILY_API_KEY ? errBody.replaceAll(TAVILY_API_KEY, "[REDACTED]") : errBody;
    throw new Error(
      `Tavily search failed (${response.status} ${response.statusText}): ${safeErrBody}`
    );
  }

  let data: any;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error(
      `Failed to parse Tavily search response: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const rawResults = Array.isArray(data?.results) ? data.results : [];

  return {
    answer: typeof data?.answer === "string" ? data.answer : null,
    results: rawResults.map((r: any) => ({
      title: typeof r?.title === "string" ? r.title : "Untitled",
      url: typeof r?.url === "string" ? r.url : "",
      snippet: typeof r?.content === "string" ? r.content.slice(0, 300) : "",
      publishedDate: typeof r?.published_date === "string" ? r.published_date : null,
    })),
  };
}

export const webSearch = webSearchAction;
