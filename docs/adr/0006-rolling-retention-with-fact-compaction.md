# 6. Rolling 30-Day Message Retention with Fact Compaction

We decided to retain raw chat message logs in Supabase for 30 days while continuously extracting and persisting durable facts into Long-Term Memory (`memories` table) before conversation logs are pruned.

## Context
Raw conversation turns consume database storage, table indexing overhead, and token context. Storing thousands of conversational filler messages indefinitely adds cost and complexity without delivering long-term intelligence value.

## Decision
Raw messages in the `messages` table are subject to a rolling 30-day retention window. Key facts, preferences, decisions, and instructions are extracted and stored as atomic records in the `memories` table. Long-term reasoning is driven by semantic memory retrieval rather than unbounded message history.

## Consequences
- Database size and index footprints remain lean and performant.
- Preserves long-term memory across months and years while keeping conversational logs bounded.
- The sliding context window remains fast and cost-effective.
