-- ============================================================
-- Migration: 005_enable_rls.sql
-- Enables Row Level Security (RLS) across all Supabase tables
-- while maintaining unrestricted service role access for FRIDAY backend.
-- Also ensures schema additions (scheduled_briefings, source, sent_at) exist.
-- ============================================================

-- 1. Ensure schema additions from architectural updates exist
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS source TEXT CHECK (source IN ('user', 'web', 'system')) DEFAULT 'user';

ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS scheduled_briefings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id BIGINT NOT NULL,
  briefing_date DATE NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  model_used TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_briefing_date UNIQUE (user_id, briefing_date)
);

CREATE INDEX IF NOT EXISTS idx_scheduled_briefings_lookup
  ON scheduled_briefings (user_id, briefing_date);

-- Update match_memories RPC to return source column (Item 4: Memory Poisoning Guard)
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

-- 2. Enable Row Level Security (RLS) on all application tables
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_briefings ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;

-- 3. Explicit Service Role Policies
-- Supabase service_role has BYPASSRLS, but explicit policies ensure defense-in-depth
-- and ensure no public/anon access is permitted through Supabase PostgREST API.

DROP POLICY IF EXISTS "service_role_all_user_profiles" ON user_profiles;
CREATE POLICY "service_role_all_user_profiles"
  ON user_profiles FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_conversations" ON conversations;
CREATE POLICY "service_role_all_conversations"
  ON conversations FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_messages" ON messages;
CREATE POLICY "service_role_all_messages"
  ON messages FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_memories" ON memories;
CREATE POLICY "service_role_all_memories"
  ON memories FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_reminders" ON reminders;
CREATE POLICY "service_role_all_reminders"
  ON reminders FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_scheduled_briefings" ON scheduled_briefings;
CREATE POLICY "service_role_all_scheduled_briefings"
  ON scheduled_briefings FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_activity_logs" ON activity_logs;
CREATE POLICY "service_role_all_activity_logs"
  ON activity_logs FOR ALL TO service_role
  USING (true) WITH CHECK (true);
