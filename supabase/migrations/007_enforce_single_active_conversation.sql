-- ============================================================
-- Migration: 007_enforce_single_active_conversation.sql
-- Enforces at most one active conversation per telegram_chat_id.
-- Archives any duplicate active conversations preserving the latest updated one.
-- ============================================================

-- 1. Archive duplicate active conversations, keeping only the most recently updated one active
WITH ranked_active AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY telegram_chat_id ORDER BY updated_at DESC) AS rn
  FROM conversations
  WHERE is_active = true
)
UPDATE conversations
SET is_active = false
WHERE id IN (
  SELECT id FROM ranked_active WHERE rn > 1
);

-- 2. Partial unique index ensuring only one active conversation per chat
CREATE UNIQUE INDEX IF NOT EXISTS oneactiveconv
  ON conversations (telegram_chat_id)
  WHERE is_active = true;
