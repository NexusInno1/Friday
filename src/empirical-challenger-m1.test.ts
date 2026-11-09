import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  computeSnoozedTime,
  createReminderAction,
  snoozeReminderAction,
} from "./actions/actions.js";
import { parseTimeString } from "./utils/time.js";
import { SupabaseDataStore } from "./db/supabase-datastore.js";
import { InMemoryDataStore } from "./db/in-memory-datastore.js";
import { reembedAllMemories } from "./scripts/re-embed-memories.js";
import type { Reminder } from "./db/schema.js";

describe("Challenger 2 Empirical Verification: Milestone 1 Boundary & Concurrency", () => {
  // ─── 1. Multiple Sequential Snoozes & Concurrency ──────────────────────────
  describe("Adversarial: Multiple Sequential Snoozes on the Same Reminder", () => {
    let store: InMemoryDataStore;

    beforeEach(() => {
      store = new InMemoryDataStore();
    });

    it("handles 5 sequential snoozes on an active future reminder deterministically advancing trigger time", async () => {
      const initialTime = Date.now() + 10 * 60 * 1000; // +10m
      const reminder = await createReminderAction(
        {
          userId: 1,
          chatId: 100,
          message: "Sequential snooze test",
          triggerAt: new Date(initialTime).toISOString(),
        },
        store
      );

      let currentReminder = reminder;
      let expectedTime = initialTime;

      // Perform 5 sequential snoozes of varying durations (10m, 15m, 5m, 30m, 60m)
      const snoozeMinutes = [10, 15, 5, 30, 60];
      for (const mins of snoozeMinutes) {
        expectedTime += mins * 60 * 1000;
        const res = await snoozeReminderAction(
          currentReminder.id,
          mins,
          1,
          store
        );
        expect(res.newTriggerAt).toBe(new Date(expectedTime).toISOString());
        expect(res.reminder.trigger_at).toBe(new Date(expectedTime).toISOString());
        expect(res.reminder.is_completed).toBe(false);
        currentReminder = res.reminder;
      }

      // Verify the reminder in datastore matches the cumulative time (+120m)
      const stored = await store.getReminder(reminder.id, 1);
      expect(stored?.trigger_at).toBe(new Date(initialTime + 120 * 60 * 1000).toISOString());
      expect(stored?.is_completed).toBe(false);
    });

    it("handles multiple sequential snoozes on a past-triggered reminder without past-time collapse", async () => {
      const pastTime = new Date(Date.now() - 3600 * 1000).toISOString(); // 1 hour ago
      const reminder = await createReminderAction(
        {
          userId: 1,
          chatId: 100,
          message: "Past triggered reminder",
          triggerAt: pastTime,
        },
        store
      );

      // Simulate reminder completion by scheduler
      await store.updateReminder(reminder.id, { is_completed: true, delivery_attempts: 1 });

      const t0 = Date.now();
      // First snooze: +15 minutes
      const snooze1 = await snoozeReminderAction(reminder.id, 15, 1, store);
      const t1 = new Date(snooze1.newTriggerAt).getTime();
      expect(t1).toBeGreaterThanOrEqual(t0 + 15 * 60 * 1000);
      expect(snooze1.reminder.is_completed).toBe(false);

      // Second snooze immediately after: +10 minutes
      // Since t1 is in the future (> now), snooze2 should build on t1 (or now, whichever is larger)
      const snooze2 = await snoozeReminderAction(reminder.id, 10, 1, store);
      const t2 = new Date(snooze2.newTriggerAt).getTime();
      expect(t2).toBeGreaterThanOrEqual(t1 + 10 * 60 * 1000 - 1000); // within tolerance
      expect(snooze2.reminder.is_completed).toBe(false);

      // Third snooze: +5 minutes
      const snooze3 = await snoozeReminderAction(reminder.id, 5, 1, store);
      const t3 = new Date(snooze3.newTriggerAt).getTime();
      expect(t3).toBeGreaterThanOrEqual(t2 + 5 * 60 * 1000 - 1000);
      expect(snooze3.reminder.is_completed).toBe(false);
    });

    it("handles concurrent snooze calls on the same reminder safely", async () => {
      const initialTime = Date.now() + 30 * 60 * 1000;
      const reminder = await createReminderAction(
        {
          userId: 1,
          chatId: 100,
          message: "Concurrent snooze target",
          triggerAt: new Date(initialTime).toISOString(),
        },
        store
      );

      // Fire 10 concurrent snoozes
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          snoozeReminderAction(reminder.id, (i + 1) * 5, 1, store)
        )
      );

      // All calls should resolve successfully
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBe(10);

      // Final reminder must be active and in the future
      const finalReminder = await store.getReminder(reminder.id, 1);
      expect(finalReminder).toBeDefined();
      expect(new Date(finalReminder!.trigger_at).getTime()).toBeGreaterThan(Date.now());
      expect(finalReminder!.is_completed).toBe(false);
    });

    it("rejects invalid snooze durations (<= 0, NaN, non-positive)", () => {
      const validIso = new Date().toISOString();
      expect(() => computeSnoozedTime(validIso, 0)).toThrow(
        "Snooze duration must be a positive number of minutes."
      );
      expect(() => computeSnoozedTime(validIso, -15)).toThrow(
        "Snooze duration must be a positive number of minutes."
      );
      expect(() => computeSnoozedTime("invalid-date-string", 15)).toThrow(
        "Invalid date string: invalid-date-string"
      );
    });

    it("evaluates snooze on an overdue reminder that has not yet been delivered by scheduler", async () => {
      // Reminder scheduled 2 hours ago, but scheduler had not delivered it yet (e.g. server downtime)
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      const reminder = await createReminderAction(
        {
          userId: 1,
          chatId: 100,
          message: "Overdue undelivered reminder",
          triggerAt: twoHoursAgo,
        },
        store
      );

      // Verify reminder state: is_completed = false, delivery_attempts = 0
      expect(reminder.is_completed).toBe(false);
      expect(reminder.delivery_attempts).toBe(0);

      // When snoozing for 15 minutes:
      const res = await snoozeReminderAction(reminder.id, 15, 1, store);
      const newTriggerTime = new Date(res.newTriggerAt).getTime();
      
      // EMPIRICAL CHALLENGE: The interface contract specifies snooze must calculate
      // relative to Math.max(Date.now(), date.getTime()), ensuring overdue reminders
      // are scheduled in the future.
      expect(newTriggerTime).toBeGreaterThan(Date.now());
    });
  });

  // ─── 2. Memory Migration Error Recovery Mid-Migration ──────────────────────
  describe("Adversarial: Memory Migration Error Recovery Mid-Migration", () => {
    const testStateFile = path.resolve("./.test-reembed-state.json");
    let store: InMemoryDataStore;

    beforeEach(() => {
      store = new InMemoryDataStore();
      if (fs.existsSync(testStateFile)) {
        fs.unlinkSync(testStateFile);
      }
    });

    afterEach(() => {
      if (fs.existsSync(testStateFile)) {
        fs.unlinkSync(testStateFile);
      }
    });

    it("resumes safely after embedder API throws mid-migration without duplicating progress", async () => {
      const userId = 1;
      // Seed 6 test memories
      const memories: string[] = [];
      for (let i = 1; i <= 6; i++) {
        const mem = await store.storeMemory(
          userId,
          `Memory ${i}: user preference data #${i}`,
          ["test"],
          5,
          [0.1, 0.2]
        );
        memories.push(mem.id);
      }

      // Run 1: Throw on memory 4 (simulating API network failure)
      let callCount = 0;
      const failingEmbedder = async (text: string): Promise<number[]> => {
        callCount++;
        if (text.includes("#4")) {
          throw new Error("Simulated API 503 Overloaded on memory #4");
        }
        return [0.9, 0.9, 0.9];
      };

      const result1 = await reembedAllMemories({
        store,
        userId,
        batchSize: 2,
        maxRetries: 2,
        retryDelayMs: 1, // minimal delay for test speed
        stateFilePath: testStateFile,
        embeddingGenerator: failingEmbedder,
        targetModel: "gemini-embedding-2",
      });

      // Memory #4 should have failed, others succeeded
      expect(result1.total).toBe(6);
      expect(result1.reembedded).toBe(5);
      expect(result1.failed).toBe(1);
      expect(result1.skipped).toBe(0);

      // Verify state file was retained because failed > 0
      expect(fs.existsSync(testStateFile)).toBe(true);
      const savedState1 = JSON.parse(fs.readFileSync(testStateFile, "utf-8"));
      expect(savedState1.targetModel).toBe("gemini-embedding-2");
      // Memory 4 failed, so it should NOT be in completedIds
      expect(savedState1.completedIds).not.toContain(memories[3]);
      // The 5 successful memories should be in completedIds
      expect(savedState1.completedIds.length).toBe(5);

      // Run 2: Re-run with working API to finish recovery
      const workingEmbedder = async (): Promise<number[]> => [0.99, 0.99];

      const result2 = await reembedAllMemories({
        store,
        userId,
        batchSize: 2,
        maxRetries: 2,
        retryDelayMs: 1,
        stateFilePath: testStateFile,
        embeddingGenerator: workingEmbedder,
        targetModel: "gemini-embedding-2",
      });

      // Exactly the 5 previously successful memories should be skipped, only #4 re-embedded
      expect(result2.total).toBe(6);
      expect(result2.skipped).toBe(5);
      expect(result2.reembedded).toBe(1);
      expect(result2.failed).toBe(0);

      // Upon 100% completion without failures, state file must be removed
      expect(fs.existsSync(testStateFile)).toBe(false);
    });

    it("resets and ignores corrupted or unparseable state file without crashing", async () => {
      const userId = 2;
      await store.storeMemory(userId, "Memory for corrupted state test", ["test"], 3, [0.1]);

      // Write corrupted JSON to state file
      fs.writeFileSync(testStateFile, "{ invalid_json_syntax: true,,,", "utf-8");

      const workingEmbedder = async () => [0.5, 0.5];
      const result = await reembedAllMemories({
        store,
        userId,
        batchSize: 2,
        maxRetries: 1,
        stateFilePath: testStateFile,
        embeddingGenerator: workingEmbedder,
        targetModel: "gemini-embedding-2",
      });

      expect(result.total).toBe(1);
      expect(result.reembedded).toBe(1);
      expect(result.failed).toBe(0);
      expect(fs.existsSync(testStateFile)).toBe(false);
    });

    it("nullifies vector when memory fails all retries to avoid mixed vector spaces", async () => {
      const userId = 3;
      const mem = await store.storeMemory(userId, "Permanent failure test", ["test"], 5, [0.1, 0.2, 0.3]);

      const alwaysFails = async () => {
        throw new Error("Fatal 404 Model Not Found");
      };

      const result = await reembedAllMemories({
        store,
        userId,
        batchSize: 1,
        maxRetries: 2,
        retryDelayMs: 1,
        stateFilePath: testStateFile,
        embeddingGenerator: alwaysFails,
      });

      expect(result.failed).toBe(1);
      const updatedMemories = await store.listMemories(userId, 10);
      const updated = updatedMemories.find((m) => m.id === mem.id);
      // Requirement: Vectors from different models cannot be compared, nullify old vector
      expect(updated?.embedding).toBeNull();
    });
  });

  // ─── 3. Time String Parsing Edge Cases ─────────────────────────────────────
  describe("Adversarial: Time String Parsing Edge Cases", () => {
    it("parses 24h formats with boundary seconds correctly", () => {
      expect(parseTimeString("00:00:00")).toBe("00:00");
      expect(parseTimeString("23:59:59")).toBe("23:59");
      expect(parseTimeString("12:00:01")).toBe("12:00");
      expect(parseTimeString("07:05:09")).toBe("07:05");
      expect(parseTimeString("7:05:30")).toBe("07:05");
      expect(parseTimeString("0:00:00")).toBe("00:00");
      expect(parseTimeString("18.45.12")).toBe("18:45");
      expect(parseTimeString("8.30.00")).toBe("08:30");
    });

    it("parses standard 12h formats and boundary cases", () => {
      expect(parseTimeString("12:00am")).toBe("00:00");
      expect(parseTimeString("12:00pm")).toBe("12:00");
      expect(parseTimeString("12:30 am")).toBe("00:30");
      expect(parseTimeString("12:45 pm")).toBe("12:45");
      expect(parseTimeString("1:00am")).toBe("01:00");
      expect(parseTimeString("11:59pm")).toBe("23:59");
      expect(parseTimeString("7pm")).toBe("19:00");
      expect(parseTimeString("7am")).toBe("07:00");
      expect(parseTimeString("8.30am")).toBe("08:30");
      expect(parseTimeString("8.30pm")).toBe("20:30");
    });

    it("rejects invalid hours, minutes, seconds, and malformed formats", () => {
      // Invalid 24h hours
      expect(() => parseTimeString("24:00")).toThrow();
      expect(() => parseTimeString("24:00:00")).toThrow();
      expect(() => parseTimeString("25:00")).toThrow();
      expect(() => parseTimeString("-1:00")).toThrow();

      // Invalid minutes
      expect(() => parseTimeString("12:60")).toThrow();
      expect(() => parseTimeString("12:60:00")).toThrow();
      expect(() => parseTimeString("12:99")).toThrow();

      // Invalid seconds
      expect(() => parseTimeString("12:00:60")).toThrow();
      expect(() => parseTimeString("12:00:99")).toThrow();

      // Invalid 12h hours
      expect(() => parseTimeString("0:00am")).toThrow();
      expect(() => parseTimeString("13:00pm")).toThrow();
      expect(() => parseTimeString("0am")).toThrow();

      // Malformed strings
      expect(() => parseTimeString("")).toThrow();
      expect(() => parseTimeString("   ")).toThrow();
      expect(() => parseTimeString("not-a-time")).toThrow();
      expect(() => parseTimeString("12")).toThrow();
      expect(() => parseTimeString("12:")).toThrow();
      expect(() => parseTimeString("12:00:00:00")).toThrow();
    });
  });

  // ─── 4. Supabase Datastore Activity Log Querying & Filtering ───────────────
  describe("Adversarial: Supabase Datastore Activity Log Querying & Filtering", () => {
    it("logs conversation_cleared activity unconditionally regardless of userId presence or 0", async () => {
      const recordedInserts: any[] = [];
      const mockDb = {
        from: vi.fn((table: string) => {
          if (table === "conversations") {
            return {
              update: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
            };
          }
          if (table === "activity_logs") {
            return {
              insert: vi.fn((payload) => {
                recordedInserts.push(payload);
                return Promise.resolve({ error: null });
              }),
            };
          }
          return {};
        }),
      };

      const datastore = new SupabaseDataStore(mockDb as any);

      // Call 1: userId undefined (omitted)
      await datastore.clearConversation(1001);
      expect(recordedInserts.length).toBe(1);
      expect(recordedInserts[0]).toEqual({
        user_id: null,
        event_type: "conversation_cleared",
        payload: { chat_id: 1001 },
        error: null,
      });

      // Call 2: userId = 0 (falsy number)
      await datastore.clearConversation(1002, 0);
      expect(recordedInserts.length).toBe(2);
      expect(recordedInserts[1]).toEqual({
        user_id: 0,
        event_type: "conversation_cleared",
        payload: { chat_id: 1002 },
        error: null,
      });

      // Call 3: userId = 42
      await datastore.clearConversation(1003, 42);
      expect(recordedInserts.length).toBe(3);
      expect(recordedInserts[2]).toEqual({
        user_id: 42,
        event_type: "conversation_cleared",
        payload: { chat_id: 1003 },
        error: null,
      });
    });

    it("verifies getContextMessages queries activity_logs with correct event_type, chat_id filter and descending order", async () => {
      const mockActivityQuery = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        contains: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { created_at: "2026-11-09T08:00:00.000Z" },
        }),
      };

      const mockDb = {
        from: vi.fn((table: string) => {
          if (table === "conversations") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              neq: vi.fn().mockReturnThis(),
              gte: vi.fn().mockReturnThis(),
              lte: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              limit: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { telegram_chat_id: 999, created_at: "2026-11-09T08:30:00.000Z", id: "prior-1" },
              }),
            };
          }
          if (table === "activity_logs") {
            return mockActivityQuery;
          }
          if (table === "messages") {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              is: vi.fn().mockReturnThis(),
              gt: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              limit: vi.fn().mockResolvedValue({
                data: [{ role: "user", content: "Post clear message" }],
              }),
            };
          }
          return {};
        }),
      };

      const datastore = new SupabaseDataStore(mockDb as any);
      const messages = await datastore.getContextMessages("conv-current", 10);

      // Verify activity_logs was queried for "conversation_cleared" with contains chat_id
      expect(mockDb.from).toHaveBeenCalledWith("activity_logs");
      expect(mockActivityQuery.eq).toHaveBeenCalledWith("event_type", "conversation_cleared");
      expect(mockActivityQuery.contains).toHaveBeenCalledWith("payload", { chat_id: 999 });
      expect(mockActivityQuery.order).toHaveBeenCalledWith("created_at", { ascending: false });
      expect(mockActivityQuery.limit).toHaveBeenCalledWith(1);
    });
  });
});
