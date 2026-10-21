-- ============================================================
-- Migration: 004_add_session_metadata_and_search.sql
-- Adds title, summary, and is_active columns to conversations table,
-- and full-text search indexes on messages table for conversational history.
-- ============================================================

-- 1. Extend conversations table with session metadata
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS embedding vector(768);

-- 2. Index for active session resolution
CREATE INDEX IF NOT EXISTS idx_conversations_active_lookup
  ON conversations(telegram_chat_id, is_active, updated_at DESC);

-- 3. Full-text search index on messages content for fast keyword and phrase queries
CREATE INDEX IF NOT EXISTS idx_messages_content_fts
  ON messages USING gin(to_tsvector('english', content));
