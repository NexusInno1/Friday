-- ============================================================
-- Migration: 002_fix_match_memories_rpc.sql
-- Fixes return signature of match_memories to prevent runtime RPC type mismatch
-- ============================================================

-- PostgreSQL cannot replace a function when its OUT/RETURNS TABLE columns
-- change. Drop the pre-migration signature before recreating the corrected one.
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
