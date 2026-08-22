# 2. Hybrid Semantic Memory with Supabase pgvector

We decided to use Supabase PostgreSQL with the `pgvector` extension and HNSW cosine similarity index for long-term memory storage and retrieval, with full-text keyword fallback.

## Context
A personal assistant needs to recall facts across weeks of interaction ("what was my gym plan?", "what's my friend's birthday?"). Pure relational text search (`LIKE`/`ILIKE`) fails on conceptual queries, while standalone vector databases (Pinecone, Qdrant) add operational overhead and separate state from relational tables (reminders, logs).

## Decision
We use PostgreSQL `vector(768)` columns with `text-embedding-004` embeddings generated via Gemini API, indexed with HNSW (`vector_cosine_ops`), and queried via a stored procedure (`match_memories`). If semantic lookup yields no matches, the system falls back to `ILIKE` keyword search.

## Consequences
- Single unified database for relational entities (reminders, logs) and semantic embeddings.
- Zero local disk state required; cloud deployment on Railway connects seamlessly to Supabase.
- Embedding generation incurs an API call on memory writes and searches (handled gracefully with fallback if embedding API is unreachable).
