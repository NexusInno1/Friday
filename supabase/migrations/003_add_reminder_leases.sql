-- ============================================================
-- Migration: 003_add_reminder_leases.sql
-- Adds lease_until and delivery_attempts columns to reminders table
-- for distributed scheduler concurrency and at-least-once delivery.
-- ============================================================

ALTER TABLE reminders ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS delivery_attempts INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_reminders_lease ON reminders(trigger_at)
  WHERE is_completed = FALSE AND is_cancelled = FALSE;
