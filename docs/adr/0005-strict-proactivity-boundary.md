# 5. Strict Proactivity Boundary

We decided to bound FRIDAY's unsolicited messaging strictly to the Daily Morning Briefing and user-scheduled due Reminders, rejecting open-ended background suggestions or chatter.

## Context
AI assistants that message users autonomously with unrequested suggestions, tips, or reminders quickly become noisy and intrusive. As an executive assistant, FRIDAY should be attentive when addressed and quiet when not.

## Decision
The background `Scheduler` only pushes messages across the Telegram boundary for:
1. Scheduled Reminders when their `trigger_at` timestamp is reached.
2. The Daily Briefing at the Owner's configured `briefing_time`.
No spontaneous suggestions, nudges, or unrequested alerts are permitted.

## Consequences
- Predictable, non-intrusive user experience.
- Simplifies the scheduler architecture and eliminates complex state machines for heuristic nudge evaluation.
