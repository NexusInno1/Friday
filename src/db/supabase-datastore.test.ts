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

describe("SupabaseDataStore - listSessions", () => {
  it("uses exact HEAD count queries for message counts without downloading all message rows", async () => {
    const mockSessions = [
      {
        id: "conv-1",
        telegram_chat_id: 12345,
        title: "Session 1",
        summary: null,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const mockConvQuery: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: mockSessions, error: null }),
    };

    const mockCountQuery: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ count: 42, error: null }),
    };

    const mockClient: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "conversations") return mockConvQuery;
        if (table === "messages") return mockCountQuery;
        throw new Error(`Unexpected table: ${table}`);
      }),
    };

    const store = new SupabaseDataStore(mockClient);
    const sessions = await store.listSessions(12345);

    expect(sessions.length).toBe(1);
    expect(sessions[0].messageCount).toBe(42);
    expect(mockCountQuery.select).toHaveBeenCalledWith("id", { count: "exact", head: true });
    expect(mockCountQuery.eq).toHaveBeenCalledWith("conversation_id", "conv-1");
  });
});

describe("SupabaseDataStore - clearConversation", () => {
  it("logs conversation_cleared activity even when userId is omitted", async () => {
    const mockUpdateBuilder: any = {
      eq: vi.fn().mockReturnThis(),
      then: (resolve: any) => Promise.resolve({ error: null }).then(resolve),
    };

    const mockInsertBuilder: any = {
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const mockClient: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "conversations") {
          return {
            update: vi.fn().mockReturnValue(mockUpdateBuilder),
          };
        }
        if (table === "activity_logs") {
          return mockInsertBuilder;
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };

    const store = new SupabaseDataStore(mockClient);
    await store.clearConversation(98765);

    expect(mockClient.from).toHaveBeenCalledWith("conversations");
    expect(mockUpdateBuilder.eq).toHaveBeenCalledWith("telegram_chat_id", 98765);
    expect(mockUpdateBuilder.eq).toHaveBeenCalledWith("is_active", true);

    expect(mockClient.from).toHaveBeenCalledWith("activity_logs");
    expect(mockInsertBuilder.insert).toHaveBeenCalledWith({
      user_id: null,
      event_type: "conversation_cleared",
      payload: { chat_id: 98765 },
      error: null,
    });
  });

  it("logs conversation_cleared activity with userId when provided", async () => {
    const mockUpdateBuilder: any = {
      eq: vi.fn().mockReturnThis(),
      then: (resolve: any) => Promise.resolve({ error: null }).then(resolve),
    };

    const mockInsertBuilder: any = {
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    const mockClient: any = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "conversations") {
          return {
            update: vi.fn().mockReturnValue(mockUpdateBuilder),
          };
        }
        if (table === "activity_logs") {
          return mockInsertBuilder;
        }
        throw new Error(`Unexpected table: ${table}`);
      }),
    };

    const store = new SupabaseDataStore(mockClient);
    await store.clearConversation(98765, 42);

    expect(mockInsertBuilder.insert).toHaveBeenCalledWith({
      user_id: 42,
      event_type: "conversation_cleared",
      payload: { chat_id: 98765 },
      error: null,
    });
  });
});
