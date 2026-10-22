-- ============================================================
-- Migration: 006_lockdown_rls_and_session_index.sql
-- Locks down public/anon access to all tables and functions,
-- prevents session proliferation with a partial unique index,
-- and adds compacted_at timestamp to messages for soft-deletion.
-- ============================================================

-- 1. Ensure messages has compacted_at column for compaction soft-deletion
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS compacted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_compacted_at
  ON messages (conversation_id, created_at)
  WHERE compacted_at IS NULL;

-- 2. Partial unique index to enforce at most one active session per Telegram chat
-- Resolve any pre-existing multiple active conversations by keeping only the most recently updated one active
UPDATE conversations c
SET is_active = FALSE
WHERE is_active = TRUE
  AND c.id NOT IN (
    SELECT DISTINCT ON (telegram_chat_id) id
    FROM conversations
    WHERE is_active = TRUE
    ORDER BY telegram_chat_id, updated_at DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS one_active_conv
  ON conversations (telegram_chat_id)
  WHERE is_active = TRUE;

-- 3. Revoke all table and routine privileges from anon and authenticated roles in public schema
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM anon, authenticated;

-- Ensure future created objects also do not leak privileges to anon or authenticated
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM anon, authenticated;

-- Explicitly revoke execute on match_memories from public, anon, and authenticated
REVOKE EXECUTE ON FUNCTION match_memories(vector, double precision, integer, bigint) FROM PUBLIC, anon, authenticated;

-- Explicitly grant full permissions to service_role
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO service_role;
GRANT EXECUTE ON FUNCTION match_memories(vector, double precision, integer, bigint) TO service_role;
