import { describe, it, expect, vi, beforeEach } from "vitest";
import { maybeAutoTitleSession, getSession } from "./session.service.js";
import { InMemoryDataStore } from "../db/in-memory-datastore.js";
import { setEnv, env } from "../config/env.js";
import * as costTracker from "./cost-tracker.service.js";

vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({ text: "Test Project Title" })),
}));

describe("session.service maybeAutoTitleSession", () => {
  let store: InMemoryDataStore;

  beforeEach(() => {
    store = new InMemoryDataStore();
    costTracker.resetDailyUsage();
  });

  it("skips titling if conversation has fewer than 2 messages", async () => {
    const convId = await store.getOrCreateConversation(123);
    await store.saveMessage(convId, "user", "Hello");

    const result = await maybeAutoTitleSession(convId, store);
    expect(result).toBeNull();
  });

  it("returns existing title without calling LLM if conversation already has a title", async () => {
    const convId = await store.getOrCreateConversation(123);
    await store.saveMessage(convId, "user", "Hello");
    await store.saveMessage(convId, "assistant", "Hi there!");
    await store.updateSessionTitle(convId, "Existing Title");

    const result = await maybeAutoTitleSession(convId, store);
    expect(result).toBe("Existing Title");
  });

  it("skips titling and enforces quota check when daily LLM quota is reached", async () => {
    const convId = await store.getOrCreateConversation(123);
    await store.saveMessage(convId, "user", "What is Vite?");
    await store.saveMessage(convId, "assistant", "Vite is a build tool.");

    const current = env();
    setEnv({ ...current, DAILY_LLM_CALL_CAP: 0 });

    try {
      const result = await maybeAutoTitleSession(convId, store);
      expect(result).toBeNull();
    } finally {
      setEnv(current);
    }
  });

  it("generates and saves title when conversation is untitled and quota allows", async () => {
    const convId = await store.getOrCreateConversation(123);
    await store.saveMessage(convId, "user", "Can you explain Docker containers?");
    await store.saveMessage(convId, "assistant", "Docker packages applications into containers.");

    const result = await maybeAutoTitleSession(convId, store);
    expect(result).toBe("Test Project Title");

    const session = await getSession(convId, store);
    expect(session?.title).toBe("Test Project Title");
  });
});
