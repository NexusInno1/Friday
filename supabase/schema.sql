-- ============================================================
-- FRIDAY — Supabase Database Schema
-- Run this in the Supabase SQL Editor to initialize the database.
-- ============================================================

-- Enable pgvector for semantic memory search
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- USER PROFILES
-- ============================================================
CREATE TABLE IF NOT EXISTS user_profiles (
  id            BIGINT PRIMARY KEY,  -- Telegram user ID
  name          TEXT NOT NULL DEFAULT 'Boss',
  timezone      TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  briefing_time TEXT NOT NULL DEFAULT '07:00',  -- HH:MM in user's timezone
  custom_instructions TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- CONVERSATIONS & MESSAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  telegram_chat_id BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_chat_id ON conversations(telegram_chat_id);

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content         TEXT NOT NULL,
  tool_name       TEXT,
  tool_call_id    TEXT,
  tokens_used     INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);

-- ============================================================
-- MEMORIES (with pgvector for semantic search)
-- ============================================================
CREATE TABLE IF NOT EXISTS memories (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     BIGINT NOT NULL,
  content     TEXT NOT NULL,
  tags        TEXT[] NOT NULL DEFAULT '{}',
  embedding   vector(768),  -- Gemini text-embedding-004 dimensions
  importance  SMALLINT NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);

-- HNSW index for fast approximate nearest-neighbor search
CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories
  USING hnsw (embedding vector_cosine_ops);

-- Semantic similarity search function
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector(768),
  match_threshold FLOAT,
  match_count     INT,
  p_user_id       BIGINT
)
RETURNS TABLE (
  id          UUID,
  user_id     BIGINT,
  content     TEXT,
  tags        TEXT[],
  embedding   vector(768),
  importance  SMALLINT,
  created_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ,
  similarity  FLOAT
)
LANGUAGE SQL STABLE AS $$
  SELECT
    m.*,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memories m
  WHERE
    m.user_id = p_user_id
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ============================================================
-- REMINDERS
-- ============================================================
CREATE TABLE IF NOT EXISTS reminders (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          BIGINT NOT NULL,
  message          TEXT NOT NULL,
  trigger_at       TIMESTAMPTZ NOT NULL,
  cron_expression  TEXT,        -- NULL = one-shot reminder
  is_recurring     BOOLEAN NOT NULL DEFAULT FALSE,
  is_completed     BOOLEAN NOT NULL DEFAULT FALSE,
  is_cancelled     BOOLEAN NOT NULL DEFAULT FALSE,
  telegram_chat_id BIGINT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminders_user_id ON reminders(user_id);
CREATE INDEX IF NOT EXISTS idx_reminders_trigger_at ON reminders(trigger_at)
  WHERE is_completed = FALSE AND is_cancelled = FALSE;

-- ============================================================
-- ACTIVITY LOGS
-- ============================================================
CREATE TABLE IF NOT EXISTS activity_logs (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    BIGINT,
  event_type TEXT NOT NULL,
  payload    JSONB,
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);

-- ============================================================
-- AUTO-UPDATE updated_at TRIGGERS
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_memories_updated_at
  BEFORE UPDATE ON memories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
