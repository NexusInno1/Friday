import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryDataStore } from "../db/in-memory-datastore.js";
import { reembedAllMemories, type ReembedOptions } from "./re-embed-memories.js";

describe("reembedAllMemories Migration", () => {
  let store: InMemoryDataStore;

  beforeEach(async () => {
    store = new InMemoryDataStore();
    // Pre-populate with 5 memories having old/dummy embeddings
    for (let i = 1; i <= 5; i++) {
      await store.storeMemory(100, `Memory content ${i}`, ["test"], 3, [0.1, 0.2, 0.3]);
    }
  });

  it("re-embeds all memories in batches using new embedding generator", async () => {
    const mockEmbedder = vi.fn().mockResolvedValue([0.9, 0.8, 0.7]);

    const result = await reembedAllMemories({
      store,
      userId: 100,
      batchSize: 2,
      maxRetries: 2,
      embeddingGenerator: mockEmbedder,
      stateFilePath: ":memory:",
    });

    expect(result.total).toBe(5);
    expect(result.reembedded).toBe(5);
    expect(result.failed).toBe(0);
    expect(mockEmbedder).toHaveBeenCalledTimes(5);

    // Verify all memories now have the new embedding
    const all = await store.listMemories(100, 10);
    for (const mem of all) {
      expect(mem.embedding).toEqual([0.9, 0.8, 0.7]);
    }
  });

  it("retries on transient embedding failure and succeeds", async () => {
    let callCount = 0;
    const flakyEmbedder = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Temporary 503 Quota Exceeded");
      }
      return [0.5, 0.5, 0.5];
    });

    const result = await reembedAllMemories({
      store,
      userId: 100,
      batchSize: 5,
      maxRetries: 3,
      retryDelayMs: 1,
      embeddingGenerator: flakyEmbedder,
      stateFilePath: ":memory:",
    });

    expect(result.reembedded).toBe(5);
    expect(result.failed).toBe(0);
  });

  it("resumes from last state when previously completed IDs are supplied", async () => {
    const all = await store.listMemories(100, 10);
    const completedIds = new Set([all[0].id, all[1].id]);

    const mockEmbedder = vi.fn().mockResolvedValue([0.9, 0.9, 0.9]);

    const result = await reembedAllMemories({
      store,
      userId: 100,
      batchSize: 2,
      embeddingGenerator: mockEmbedder,
      initialCompletedIds: completedIds,
      stateFilePath: ":memory:",
    });

    // Should only have re-embedded the remaining 3 memories
    expect(result.reembedded).toBe(3);
    expect(result.skipped).toBe(2);
    expect(mockEmbedder).toHaveBeenCalledTimes(3);
  });

  it("nullifies old embedding if memory permanently fails all retries, ensuring no old vectors remain", async () => {
    const failingEmbedder = vi.fn().mockRejectedValue(new Error("Permanent API Failure"));

    const result = await reembedAllMemories({
      store,
      userId: 100,
      batchSize: 5,
      maxRetries: 2,
      retryDelayMs: 1,
      embeddingGenerator: failingEmbedder,
      stateFilePath: ":memory:",
    });

    expect(result.failed).toBe(5);
    expect(result.reembedded).toBe(0);

    // Old vectors MUST be nullified so incompatible vectors do not corrupt searches
    const all = await store.listMemories(100, 10);
    for (const mem of all) {
      expect(mem.embedding).toBeNull();
    }
  });
});
