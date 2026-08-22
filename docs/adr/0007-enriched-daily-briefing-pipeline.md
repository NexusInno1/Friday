# 7. Enriched Daily Briefing Pipeline

We decided to enrich the morning Daily Briefing with a live Tavily search summary (top tech/world news headline or weather) alongside today's scheduled reminders and agenda.

## Context
A static list of reminders feels like a basic alarm clock. A true AI executive assistant provides a proactive morning overview that equips the Owner for their day with both calendar context and relevant external information.

## Decision
The `sendDailyBriefing` routine queries Supabase for today's active Reminders, triggers a concise Tavily search query for current headlines or daily briefing context, and formats the output into a crisp executive overview in FRIDAY persona.

## Consequences
- Elevates the value of the daily morning broadcast from a simple ping to an executive intelligence summary.
- Requires one Tavily API search call per morning briefing.
- Falls back gracefully to reminders-only if external search is unreachable.
