# 7. Enriched Daily Briefing Pipeline

We decided to enrich the morning Daily Briefing with a multi-pillar live Tavily search summary (covering international, business, AI, and regional headlines) alongside today's scheduled reminders and agenda, governed by daily search volume budgeting.

## Context
A static list of reminders feels like a basic alarm clock. A true AI executive assistant provides a proactive morning overview that equips the Owner for their day with both calendar context and relevant external information. However, unconstrained web searches could quickly deplete monthly API quotas or incur unexpected costs.

## Decision
The `sendDailyBriefing` routine queries Supabase for today's active Reminders, executes targeted Tavily search queries across 4 structured categories (International, Business, AI, Regional) with `max_results: 12`, `topic: 'news'`, and strict 24-hour freshness filters (with automatic 48-hour fallback if fresh stories are sparse). Daily search volume is tracked and governed by `DAILY_TAVILY_CALL_CAP` (default 50 calls/day) via `cost-tracker.service.ts`. The output is synthesized into a crisp executive overview in FRIDAY persona.

## Consequences
- Elevates the value of the daily morning broadcast from a simple ping to an executive intelligence summary.
- Executes 4–8 Tavily API search calls per morning briefing (depending on 24h/48h retries), well within the 50-call daily budget.
- Proactively alerts the Owner when reaching 80% and 100% of the daily Tavily cap.
- Falls back gracefully to reminders-only if external search is unreachable or the daily quota is exhausted.
