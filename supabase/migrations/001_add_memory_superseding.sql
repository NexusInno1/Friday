-- ============================================================
-- FRIDAY — Migration: ADR-0004 + ADR-0006 Schema Updates
-- Run this in the Supabase SQL Editor on existing deployments.
-- ============================================================

-- ADR-0004: Add superseding columns to memories table
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES memories(id) ON DELETE SET NULL;

-- Partial index for active-only queries
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(user_id)
  WHERE is_active = TRUE;

-- Update match_memories to filter by is_active
-- Drop first because return type changed (new columns: is_active, superseded_by)
DROP FUNCTION IF EXISTS match_memories(vector, double precision, integer, bigint);

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
  is_active   BOOLEAN,
  superseded_by UUID,
  created_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ,
  similarity  FLOAT
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
