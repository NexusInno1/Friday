# 1. Single-Owner Telegram Whitelist Architecture

We decided to restrict FRIDAY exclusively to a single authorized Telegram User ID (`TELEGRAM_ALLOWED_USER_ID`) with silent dropping of unauthorized updates.

## Context
Personal AI assistants handle sensitive personal data (preferences, server credentials, project notes, schedules). Standard Telegram bots are publicly discoverable by username, inviting unauthorized messages, spam, or prompt injection attempts.

## Decision
We enforce a strict single-owner whitelist at the outermost bot middleware layer (`authMiddleware`). Any incoming message from an unlisted Telegram user is dropped immediately without response or acknowledgement.

## Consequences
- Complete privacy and protection against unauthorized tool execution or memory extraction.
- The database schema does not require multi-tenant isolation or OAuth flows.
- If multi-user access is desired in the future, schema and middleware will require explicit migration.
