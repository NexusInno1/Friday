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
  title           TEXT,
  summary         TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_chat_id ON conversations(telegram_chat_id);
CREATE INDEX IF NOT EXISTS idx_conversations_active_lookup ON conversations(telegram_chat_id, is_active, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS oneactiveconv ON conversations(telegram_chat_id) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content         TEXT NOT NULL,
  tool_name       TEXT,
  tool_call_id    TEXT,
  tokens_used     INTEGER,
  compacted_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_compacted_at ON messages (conversation_id, created_at) WHERE compacted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_content_fts ON messages USING gin(to_tsvector('english', content));

-- ============================================================
-- MEMORIES (with pgvector for semantic search)
-- ============================================================
CREATE TABLE IF NOT EXISTS memories (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     BIGINT NOT NULL,
  content     TEXT NOT NULL,
  tags        TEXT[] NOT NULL DEFAULT '{}',
  embedding   vector(768),  -- gemini-embedding-2 dimensions (768)
  importance  SMALLINT NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  superseded_by UUID REFERENCES memories(id) ON DELETE SET NULL,
  source      TEXT NOT NULL CHECK (source IN ('user', 'web', 'system')) DEFAULT 'user',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);

-- HNSW index for fast approximate nearest-neighbor search
CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories
  USING hnsw (embedding vector_cosine_ops);

-- Partial index for active-only memory queries (ADR-0004: superseding)
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(user_id)
  WHERE is_active = TRUE;

-- Semantic similarity search function
DROP FUNCTION IF EXISTS match_memories(vector, double precision, integer, bigint);

CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector(768),
  match_threshold FLOAT,
  match_count     INT,
  p_user_id       BIGINT
)
RETURNS TABLE (
  id            UUID,
  user_id       BIGINT,
  content       TEXT,
  tags          TEXT[],
  embedding     vector(768),
  importance    SMALLINT,
  is_active     BOOLEAN,
  superseded_by UUID,
  source        TEXT,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ,
  similarity    FLOAT
)
LANGUAGE SQL STABLE AS $$
  SELECT
    m.id,
    m.user_id,
    m.content,
    m.tags,
    m.embedding,
    m.importance,
    m.is_active,
    m.superseded_by,
    m.source,
    m.created_at,
    m.updated_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memories m
  WHERE
    m.user_id = p_user_id
    AND m.is_active = TRUE
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
  lease_until      TIMESTAMPTZ,
  delivery_attempts INT NOT NULL DEFAULT 0,
  telegram_chat_id BIGINT NOT NULL,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminders_user_id ON reminders(user_id);
CREATE INDEX IF NOT EXISTS idx_reminders_trigger_at ON reminders(trigger_at)
  WHERE is_completed = FALSE AND is_cancelled = FALSE;

-- ============================================================
-- SCHEDULED BRIEFINGS (concurrency-safe daily digest claims)
-- ============================================================
CREATE TABLE IF NOT EXISTS scheduled_briefings (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       BIGINT NOT NULL,
  briefing_date DATE NOT NULL,
  scheduled_at  TIMESTAMPTZ NOT NULL,
  claimed_at    TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  model_used    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_briefing_date UNIQUE (user_id, briefing_date)
);

CREATE INDEX IF NOT EXISTS idx_scheduled_briefings_lookup
  ON scheduled_briefings (user_id, briefing_date);

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

-- ============================================================
-- ROW LEVEL SECURITY (RLS) & PRIVILEGE LOCKDOWN
-- ============================================================
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_briefings ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all_user_profiles" ON user_profiles;
CREATE POLICY "service_role_all_user_profiles" ON user_profiles FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_conversations" ON conversations;
CREATE POLICY "service_role_all_conversations" ON conversations FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_messages" ON messages;
CREATE POLICY "service_role_all_messages" ON messages FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_memories" ON memories;
CREATE POLICY "service_role_all_memories" ON memories FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_reminders" ON reminders;
CREATE POLICY "service_role_all_reminders" ON reminders FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_scheduled_briefings" ON scheduled_briefings;
CREATE POLICY "service_role_all_scheduled_briefings" ON scheduled_briefings FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_activity_logs" ON activity_logs;
CREATE POLICY "service_role_all_activity_logs" ON activity_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION match_memories(vector, double precision, integer, bigint) FROM PUBLIC, anon, authenticated;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO service_role;
GRANT EXECUTE ON FUNCTION match_memories(vector, double precision, integer, bigint) TO service_role;
