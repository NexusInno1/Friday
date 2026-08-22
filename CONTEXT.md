# FRIDAY Domain Model

FRIDAY is a personalized, single-owner AI executive assistant operating over Telegram, providing conversational intelligence, semantic long-term memory, real-time web research, and scheduled notifications.

## Language

### Core Identity & Security
**Assistant**:
The autonomous AI agent persona (FRIDAY) that executes reasoning loops, tool calls, and proactive routines.
_Avoid_: Bot, chatbot, LLM wrapper

**Owner**:
The single authorized human user identified by their Telegram User ID who has exclusive command of the assistant.
_Avoid_: User, client, account, customer

**Auth Guard**:
The whitelist security boundary that silently discards any incoming update from non-owner IDs.
_Avoid_: Login, auth token, session check

### Memory & Context
**Memory**:
An atomic, persistent fact or preference about the Owner stored with semantic vector embeddings for retrieval.
_Avoid_: Note, document, record, log

**Context Window**:
The sliding chronological window of recent conversation messages passed to the model to maintain short-term dialogue continuity.
_Avoid_: History, conversation buffer, thread

**Fact Compaction**:
The automated extraction and crystallization of enduring preferences from ephemeral conversation turns into Long-Term Memory before raw logs age out.
_Avoid_: Chat summarization, conversation archive

**Importance**:
A numerical rating (1–5) assigned to a Memory to prioritize critical life facts over ephemeral details.
_Avoid_: Priority, weight, rank

**Superseded Memory**:
An older Memory fact that has been updated or invalidated by a newer conflicting preference, marked as inactive or overwritten.
_Avoid_: Deleted note, obsolete log

### Scheduling & Proactivity
**Reminder**:
A user-requested notification scheduled to trigger at a specific future timestamp (one-shot) or on a recurring cron interval.
_Avoid_: Alarm, timer, calendar event

**Daily Briefing**:
A proactive, morning intelligence summary generated at a user-configured time containing agenda, reminders, live briefings, and daily status.
_Avoid_: Digest, morning report, notification

**Briefing Scope**:
The curated bundle of morning content (personalized greeting, live search briefing snapshot, and today's pending reminders) delivered at the scheduled briefing time.
_Avoid_: Report template, notification payload

**Proactivity Boundary**:
The strict constraint that the Assistant never initiates unprompted messages outside the Daily Briefing and due Reminders.
_Avoid_: Notification filter, quiet hours

**Scheduler**:
The in-memory, timezone-aware background cron runner that polls due Reminders and delivers proactive broadcasts.
_Avoid_: Background worker, queue, daemon

### Tools & Research
**Tool**:
A discrete, executable function exposed to the Assistant's reasoning loop with Zod-validated input schemas.
_Avoid_: Plugin, skill, command, function

**Web Research**:
Real-time web search and content extraction performed on-demand to answer queries requiring live external data.
_Avoid_: Google search, web scraping, browsing
