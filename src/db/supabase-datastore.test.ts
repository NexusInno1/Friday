import { describe, it, expect, vi } from "vitest";
import { SupabaseDataStore } from "./supabase-datastore.js";

describe("SupabaseDataStore - getOrCreateConversation", () => {
  it("returns existing active conversation if found within 24h", async () => {
    const existingId = "existing-conv-123";
    const mockQueryBuilder: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: existingId }, error: null }),
    };

    const mockClient: any = {
      from: vi.fn().mockReturnValue(mockQueryBuilder),
    };

    const store = new SupabaseDataStore(mockClient);
    const convId = await store.getOrCreateConversation(12345);

    expect(convId).toBe(existingId);
    expect(mockClient.from).toHaveBeenCalledWith("conversations");
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith("telegram_chat_id", 12345);
    expect(mockQueryBuilder.eq).toHaveBeenCalledWith("is_active", true);
  });

  it("archives stale active conversations and creates new one when none active in 24h", async () => {
    const newConvId = "new-conv-456";

    const mockFindBuilder: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const mockUpdateBuilder: any = {
      eq: vi.fn().mockReturnThis(),
      then: (resolve: any) => Promise.resolve({ error: null }).then(resolve),
    };

    const mockInsertBuilder: any = {
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: newConvId }, error: null }),
    };

    let callCount = 0;
    const mockClient: any = {
      from: vi.fn().mockImplementation((table: string) => {
        callCount++;
        if (callCount === 1) {
          return mockFindBuilder;
        }
        if (callCount === 2) {
          return {
            update: vi.fn().mockReturnValue(mockUpdateBuilder),
          };
        }
        return {
          insert: vi.fn().mockReturnValue(mockInsertBuilder),
        };
      }),
    };

    const store = new SupabaseDataStore(mockClient);
    const convId = await store.getOrCreateConversation(12345);

    expect(convId).toBe(newConvId);
    expect(mockClient.from).toHaveBeenCalledWith("conversations");
  });

  it("recovers gracefully from unique constraint 'oneactiveconv' violation and returns active conversation", async () => {
    const activeConvId = "concurrently-created-conv-789";

    const mockFindInitial: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const mockUpdateBuilder: any = {
      eq: vi.fn().mockReturnThis(),
      then: (resolve: any) => Promise.resolve({ error: null }).then(resolve),
    };

    // Simulate Postgres throwing unique constraint violation on insert
    const mockInsertBuilder: any = {
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: null,
        error: {
          code: "23505",
          message: 'duplicate key value violates unique constraint "oneactiveconv"',
        },
      }),
    };

    // Recovery query to fetch the currently active conversation
    const mockRecoveryBuilder: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: activeConvId }, error: null }),
    };

    let callCount = 0;
    const mockClient: any = {
      from: vi.fn().mockImplementation((table: string) => {
        callCount++;
        if (callCount === 1) return mockFindInitial;
        if (callCount === 2) return { update: vi.fn().mockReturnValue(mockUpdateBuilder) };
        if (callCount === 3) return { insert: vi.fn().mockReturnValue(mockInsertBuilder) };
        if (callCount === 4) return mockRecoveryBuilder;
        return mockFindInitial;
      }),
    };

    const store = new SupabaseDataStore(mockClient);
    const convId = await store.getOrCreateConversation(12345);

    expect(convId).toBe(activeConvId);
  });
});
