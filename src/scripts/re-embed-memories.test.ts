import fs from "fs";
import path from "path";
import os from "os";
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

  it("cleans up state file when migration finishes 100%", async () => {
    const tmpDir = os.tmpdir();
    const stateFile = path.join(tmpDir, `test-state-${Date.now()}-1.json`);
    const mockEmbedder = vi.fn().mockResolvedValue([0.9, 0.9, 0.9]);

    try {
      const result = await reembedAllMemories({
        store,
        userId: 100,
        batchSize: 2,
        embeddingGenerator: mockEmbedder,
        stateFilePath: stateFile,
      });

      expect(result.total).toBe(5);
      expect(result.reembedded).toBe(5);
      expect(result.failed).toBe(0);
      expect(fs.existsSync(stateFile)).toBe(false);
    } finally {
      if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    }
  });

  it("retains state file with targetModel and completedIds when some memories fail", async () => {
    const tmpDir = os.tmpdir();
    const stateFile = path.join(tmpDir, `test-state-${Date.now()}-2.json`);
    let count = 0;
    const partialEmbedder = vi.fn().mockImplementation(async () => {
      count++;
      if (count > 2) throw new Error("API Limit");
      return [0.7, 0.7, 0.7];
    });

    try {
      const result = await reembedAllMemories({
        store,
        userId: 100,
        batchSize: 2,
        maxRetries: 1,
        retryDelayMs: 0,
        embeddingGenerator: partialEmbedder,
        stateFilePath: stateFile,
        targetModel: "test-model-v1",
      });

      expect(result.failed).toBeGreaterThan(0);
      expect(fs.existsSync(stateFile)).toBe(true);

      const stateContent = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(stateContent.targetModel).toBe("test-model-v1");
      expect(stateContent.completedIds.length).toBe(2);
    } finally {
      if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    }
  });

  it("starts fresh when target model differs from the model in existing state file", async () => {
    const tmpDir = os.tmpdir();
    const stateFile = path.join(tmpDir, `test-state-${Date.now()}-3.json`);
    const all = await store.listMemories(100, 10);

    // Write state file with old model
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        targetModel: "old-model-v1",
        completedIds: [all[0].id, all[1].id],
        updatedAt: new Date().toISOString(),
      }),
      "utf-8"
    );

    const mockEmbedder = vi.fn().mockResolvedValue([0.8, 0.8, 0.8]);

    try {
      // Re-embed with a new model
      const result = await reembedAllMemories({
        store,
        userId: 100,
        batchSize: 5,
        embeddingGenerator: mockEmbedder,
        stateFilePath: stateFile,
        targetModel: "new-model-v2",
      });

      // Does not skip old completed IDs because model changed!
      expect(result.skipped).toBe(0);
      expect(result.reembedded).toBe(5);
    } finally {
      if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    }
  });
});
