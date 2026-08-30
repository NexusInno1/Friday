# FRIDAY Personal AI Assistant — Hermes Benchmark, Gap Analysis & Upgrade Specification

**Audit date:** 2026-08-28  
**Scope:** `F:\Firday` at commit `6879260`; source inspection, static review, test/build verification, and the official Hermes reference audit.  
**Verification run:** `npm.cmd run typecheck`, `npm.cmd test`, and `npm.cmd run build` all passed; Vitest reports 9 files / 36 tests. This is not evidence that production integrations or migrations work.

## Executive Summary

FRIDAY is a deliberately small, single-owner Telegram assistant. It already has a good nucleus: a Zod-validated configuration module; an outer Telegram owner allowlist; a typed datastore seam with an in-memory adapter; Gemini/OpenAI SDK integration; a bounded recent-message context window; pgvector-backed memory with keyword fallback; reminders, snoozing, a daily briefing, and a focused automated test suite. Its ADRs show sensible product constraints, especially the no-noise proactivity policy.

Its biggest weaknesses are reliability and safety rather than missing feature count. In webhook mode it neither configures Telegram's `secret_token` nor verifies a secret header, so a public endpoint can be forged with an update whose `from.id` is the owner ID. A permitted owner can also use FRIDAY in a group chat, which can disclose private responses to that group. The scheduler has no durable claim/idempotency/retry state, so concurrent workers or a crash after delivery can duplicate reminders. Fact compaction extracts at most 50 old messages and then deletes *all* old messages for that conversation; it can lose history and has no checkpoint, provenance, or recovery mechanism. The fresh `supabase/schema.sql` also defines `match_memories` with a return declaration inconsistent with `SELECT m.*`; the later migration corrects it, but a fresh setup following the README is likely to fail or provide an incompatible RPC.

Hermes substantially exceeds FRIDAY in breadth and operational maturity: explicit durable/searchable sessions, tool registry/availability/error wrapping, interruption, retries and fallback providers, controlled skills/learning artifacts, optional delegation, many interfaces, MCP, and a fuller approval/audit model. These are useful patterns, not reasons to turn FRIDAY into a general-purpose computer-control platform. The most valuable adaptations are a safe execution ledger and approval module, durable idempotent job state, real session/history semantics, bounded/provenanced editable memory, structured observability, and an optional small skill layer after the foundation is safe.

**Decision:** do not add terminal, filesystem write, browser automation, MCP, plugins, voice, or subagents in the first upgrade. First eliminate the P0 security/data-loss/delivery defects, then make the present Telegram + memory + reminder product dependable.

## Current Architecture

### Implemented topology

```text
Telegram (private or group chat today) ── grammY bot
  ├─ Auth Guard (Telegram user-ID allowlist)
  ├─ slash commands / callback actions
  └─ AssistantEngine.reply(chatId, text)
          ├─ SupabaseDataStore (or InMemoryDataStore in tests)
          │    ├─ conversations + messages
          │    ├─ memories + pgvector RPC / keyword fallback
          │    ├─ reminders + profiles
          │    └─ activity_logs (mostly errors)
          ├─ Gemini 2.0 Flash OR OpenAI gpt-4o (one selected at startup)
          └─ eight Vercel-AI-SDK tools
               web search, memory read/write, reminder lifecycle, briefing time

Croner process-local scheduler
  ├─ due-reminder poll every minute → Telegram dispatcher
  ├─ fact compaction daily at 03:00
  └─ daily briefing → Tavily search + reminders → Telegram

Express health server / Telegram webhook (when configured)
```

### Component audit

| Area | What exists and where | Responsibility / dependents | Reliability, modularity, limitations |
|---|---|---|---|
| Interface | Telegram only: `src/bot/bot.ts`, `src/bot/commands/*`; Express exposes health and optionally webhook in `src/index.ts`/`src/health.ts`. | Receives owner messages, commands and callback actions; renders reply chunks. | Telegram is a pragmatic fit for a single owner. There is no web/desktop/mobile UI beyond Telegram, no voice, and no interface contract tests. Group chats are not rejected. |
| Backend/server | Node 22 TypeScript ESM entrypoint in `src/index.ts`; Express health app in `src/health.ts`. | Starts bot, scheduler, health/webhook listener; graceful shutdown. | Small and understandable. Health is liveness only; it reports healthy without datastore/provider checks. Webhook lacks authenticity verification. |
| Agent runtime | `AssistantEngine` in `src/services/agent.service.ts`. | Saves turns, gets 20 messages, retrieves memories, builds prompt, runs `generateText` with up to 10 steps and one 60-second abort timer. | A reasonably deep module at its interface, testable through injected datastore/model. It has no cancellation from Telegram, tool-call persistence, per-tool deadline/retry, resumable tasks, output grounding, or concurrent-turn serialization. |
| LLM/model routing | `getModel()` in `agent.service.ts`; config in `src/config/env.ts`. | Selects Gemini 2.0 Flash, or gpt-4o only when OpenAI is selected and a key exists. | Provider abstraction comes from Vercel AI SDK. This is a static selection, not routing or failover: OpenAI selection silently falls back to Gemini when the key is absent; Gemini remains mandatory even when OpenAI is selected; no runtime/provider fallback is implemented. |
| System/developer instructions | System prompt only in `src/config/persona.ts`; no distinct developer prompt. | Persona, tool guidance, timezone and basic injection instruction. | Clear persona and tool naming. The claim that all tagged user content is “never instructions” conflicts with normal task-following and does not establish a tool-level trust policy for web/tool content. `custom_instructions` is stored in the schema but never used. |
| Tool definitions/execution | `src/tools/registry.ts` uses Vercel SDK `tool` + Zod; actions in `src/actions/actions.ts`. | Provides eight tools: web search, memory read/write, reminder create/list/cancel/snooze, briefing-time update. | Typed schemas are a strong start. Registry is a factory but has no availability/policy layer, metadata, tool outcome ledger, retries, timeouts, source trust labels, approvals, or tool-call persistence. |
| Memory | `actions.ts`, `memory.service.ts`, pgvector tables/RPC in `supabase/schema.sql`. | Explicit/agent tool writes; semantic + keyword recall; active-memory superseding; memory grounding each conversational turn. | This is genuine persistent memory, distinct from chat history. It lacks provenance, consent/sensitivity classification, user list/edit/delete interface, correction workflow, deterministic conflict review, retention policy, and retrieval evaluation. Similarity-based automatic superseding can deactivate a related but non-conflicting fact. |
| Conversation/session storage | `conversations`/`messages`, `getOrCreateConversation()` in Supabase adapter. | Uses most recently updated chat conversation within 24h and sends 20 recent messages to model; raw messages intended for 30-day retention. | Persistent but limited: no titles, metadata, search, resume UI, explicit session identity, timeline/lineage, or atomic concurrent creation. `/clear` deletes all chat conversations' messages, not just the active 20-message context. |
| Database | Supabase Postgres service-role adapter in `src/db/supabase*.ts`; in-memory adapter for tests. | Single persistence location for profile, logs, chats, memories and reminders. | The DataStore interface is a real seam with two adapters, giving leverage. Production errors are sometimes logged and swallowed (`saveMessage`, profile upsert), making failures invisible to callers. Service-role credentials are highly sensitive. Fresh schema/RPC mismatch is a P0 migration risk. |
| Authentication / preferences | Owner Telegram user-ID middleware in `src/bot/middlewares/auth.ts`; env profile values and `user_profiles`. | Rejects updates not from `TELEGRAM_ALLOWED_USER_ID`; stores briefing time. | Strong for polling/private-chat use. It is not enough for unauthenticated webhook requests or group privacy. No OAuth; appropriate for current single-owner scope. Name/timezone come from env; `custom_instructions` is unused. |
| Background jobs / scheduling / notifications | `ProactiveScheduler` and dispatcher in `src/services/scheduler.service.ts`; Croner. | Polls reminders, sends Telegram notification buttons, compacts memories, and sends daily briefing. | Good narrow proactivity boundary and testable dispatcher seam. Jobs are process-local, lack database claims/job runs/retries/dead letters/cancel audit/duplication prevention, and can send duplicates in multi-instance deployment. |
| Integrations | Telegram, Gemini, optional OpenAI, Tavily, Supabase, Railway. | Messaging, inference, search/embeddings, persistence/deployment. | Thin adapters. There is no credential rotation/status check/rate-limit policy or integration contract test. Tavily search is summary/snippets, not extraction/browser browsing. |
| Files/browser/terminal/code | None. | None. | Correctly low attack surface. Do not add just to match Hermes. |
| MCP, skills, plugins, delegation | None in runtime. Repository-local engineering skills are for coding agents, not FRIDAY capabilities. | None. | Correctly absent today. A lightweight user-owned skill artifact may be valuable later; executable plugins/MCP/delegation should stay out until their policy model exists. |
| Logging/error handling/observability | Console logs; generic error middleware writes `bot_error` to `activity_logs`; `/status`. | Basic diagnostics and user-facing recovery. | No correlated traces, structured/secret-redacted events, execution ledger, metrics, health readiness, job history, model/tool timings, or alerting. `/status` claims all systems operational without checking them. Error messages may reveal provider/internal details to owner. |
| Security / approvals / sandboxing | Auth Guard, Zod inputs, prompt instructions, `.env` ignored, no dangerous tools. | Keeps scope narrow. | No approval engine or sandbox because current tools mostly change personal state. Webhook spoofing and group disclosure override that comfort; remote search content is not explicitly untrusted. No encryption policy, protected paths, data-export/delete management, or security test suite. |
| Testing / delivery | Vitest unit tests in 9 files; GitHub Actions typecheck/test/build; Docker/Railway files. | Tests pure logic/in-memory flows and mock model turn. | 36 passing tests are useful baseline but no live-like Supabase migration, Telegram webhook/auth, tool loop, cancellation, retries, browser/integration, multi-instance, prompt-injection, or end-to-end tests. |

### Capability inventory

Quality and reliability are engineering estimates (1 poor — 5 strong), based on source and test inspection rather than production telemetry.

| Capability | Exists? | Quality | Implementation | Reliability | User-facing? | Notes |
|---|---:|---:|---|---:|---:|---|
| Telegram conversation | YES | 3 | `bot.ts` + `AssistantEngine` | 3 | YES | Text chat; no streaming/cancel/session controls. |
| Persistent memory | YES | 3 | Supabase pgvector + `actions.ts` | 2 | YES | Cross-session, but consent/provenance/correction weak. |
| Short-term context | YES | 3 | 20 stored messages | 3 | NO | 24h implicit session; context size is count-, not token-based. |
| Conversation persistence | YES | 3 | conversations/messages | 2 | NO | No old-chat search or explicit resume. |
| Conversation search | NO | 1 | — | 1 | NO | 30-day raw history is not searchable by user/agent. |
| Tool calling | YES | 3 | Vercel AI SDK + Zod | 2 | YES | Eight tools; no policy or trace ledger. |
| Web search | YES | 3 | Tavily | 2 | YES | Search snippets/answer only; no extraction validation. |
| Web extraction | NO | 1 | — | 1 | NO | Do not conflate Tavily search with page extraction. |
| Browser automation | NO | 1 | — | 5 | NO | Intentionally absent. |
| Terminal / shell | NO | 1 | — | 5 | NO | Intentionally absent. |
| File access / code execution | NO | 1 | — | 5 | NO | Intentionally absent. |
| Reminder lifecycle | YES | 3 | actions + scheduler + Telegram buttons | 2 | YES | Create/list/snooze/cancel; delivery is not idempotent. |
| Recurring schedules | YES | 2 | Croner cron expression | 1 | YES | Cron not validated before save; no job history/claim/retry. |
| Daily briefing | YES | 3 | scheduler + Tavily | 2 | YES | Useful and bounded; missing job state and source citation. |
| Proactive behavior controls | YES | 4 | ADR-0005 | 3 | NO | Right product policy; must be enforced in a durable job engine. |
| Notifications | YES | 3 | Telegram dispatcher | 2 | YES | Telegram only; no delivery acknowledgement/retry policy. |
| Model/provider switching | PARTIAL | 2 | config selection | 2 | NO | Static selection, no in-turn switch/fallback. |
| Fallback model | NO | 1 | — | 1 | NO | Gemini is accidental fallback for missing OpenAI key, not a resilience design. |
| Memory conflict handling | YES | 2 | automatic similarity supersede | 2 | NO | No evidence/provenance/user review. |
| Memory correction/deletion | PARTIAL | 1 | exported internal functions only | 1 | NO | No owner command/tool to view/edit/delete. |
| Automatic memory extraction | YES | 2 | daily compaction | 1 | NO | Can lose data; no approval or checkpoint. |
| Authentication | YES | 3 | Telegram owner ID | 2 | NO | Fine in polling; webhook and group controls are deficient. |
| Authorization / approvals | PARTIAL | 1 | implicit owner-only | 2 | NO | No action risk classification/confirmation. |
| Sandbox / protected paths | NO | 1 | — | 5 | NO | Not needed until host-reaching tools exist. |
| Skills | NO | 1 | — | 5 | NO | Candidate P2 after core safety/reliability. |
| Plugins | NO | 1 | — | 5 | NO | Correctly absent. |
| MCP client/server | NO | 1 | — | 5 | NO | Correctly absent for current scope. |
| Subagents | NO | 1 | — | 5 | NO | Not justified today. |
| Voice / image understanding / generation | NO | 1 | — | 5 | NO | No demonstrated need. |
| Observability / audit | PARTIAL | 2 | console + error activity log | 1 | PARTIAL | No execution record or redaction. |
| Error recovery | PARTIAL | 2 | generic catches, one agent abort | 2 | YES | No categorized retry, rollback, or recovery UI. |
| Testing | YES | 3 | Vitest + CI | 2 | NO | Strong small-unit baseline; essential integration/e2e gaps. |

## Hermes Capability Matrix

This comparison uses only the current official Hermes repository and documentation, captured in [the companion reference audit](research/hermes-agent-official-reference-audit.md). Hermes claims below are documentation-verified—not independently benchmarked reliability claims. Primary references include [architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture), [agent loop](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop), [memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills), and [security](https://hermes-agent.nousresearch.com/docs/user-guide/security).

| Category | Hermes | My Assistant | Gap | Priority | Recommended Action |
|---|---|---|---|---|---|
| Agent loop | Interruptible loop, tool dispatch, retries/fallbacks, compression, persisted session | 10-step SDK loop, one turn timeout | No cancel, no tool deadlines/retry/trace, no durable task state | P1 | Deepen the orchestration module around a `TurnExecution` record and cancellation token. |
| Model/provider | 18+ documented providers, resolution, switches, fallback/pools | Gemini or OpenAI selected at boot | No proper fallback or capability routing | P2 | Validate provider config; add one explicit fallback only after telemetry proves need. |
| Context/session | SQLite sessions, lineage, FTS5 browse/search/resume | 24h chat-key conversation, 20 messages | No titles/search/resume/atomic session semantics | P1 | Add explicit session metadata and lexical search over retained messages. |
| Memory | Bounded editable profile/workspace files, write approval, duplicate/capacity/injection safeguards | Semantic memories with automatic supersede | Provenance/consent/correction missing; destructive compaction unsafe | P0 | Keep vector store; add provenance, sensitivity, owner controls, review and safe compaction. |
| Skills/learning | On-demand AgentSkills-compatible `SKILL.md`; `/learn`; optional rollback curator | None | Reusable procedural workflows absent | P2 | Add owner-approved, versioned markdown skills only after P0/P1. |
| Web | Search/extract/browser choices, tool gateway | Tavily basic search | No page extraction/citations/hostile-content model | P2 | Improve search source provenance first; defer browser. |
| Files/terminal/code | Broad file/terminal/sandbox backends, programmatic code execution | None | Feature breadth only | P3 / REJECT now | Keep absent; introduce isolated read-only workspace tool only for demonstrated need. |
| Browser/computer control | Local/CDP/cloud browser variants | None | Feature breadth only | P3 / REJECT now | Do not add; high injection/auth risk. |
| Scheduling | Cron jobs, fresh agent, delivery state; headless dangerous action deny | Process-local Croner reminders/briefing | No durable jobs, claim, retry/history/cancel semantics | P0 | Replace polling mutation pattern with DB-backed job/runs/leases. |
| Delegation | Isolated child agents, budgets, final-summary handoff | None | No parallel agent work | P3 / REJECT now | Consider only for measured independent research workloads. |
| MCP | Local/HTTP/OAuth client and MCP server | None | Missing external-tool protocol | P3 / REJECT now | Add optional client only when a named integration cannot be native. |
| Plugins | Tools/hooks/commands via discovery | None | No executable extension route | P3 / REJECT | Avoid supply-chain/code execution surface. Skills meet present extensibility need. |
| Interfaces | CLI/TUI/Desktop/dashboard/API + 20+ messaging integrations | Telegram + health endpoint | Narrower surface | P3 / KEEP | Telegram matches present personal use. Add no channel without specific demand. |
| Voice/media | Vision, image gen, TTS/STT | None | Optional interface/tools | P3 / REJECT now | User value unproven; data/control costs high. |
| Tool registry | Central registry/toolsets/availability/error wrapping | static factory + Zod tools | Policy/observability/availability weak | P1 | Add metadata, policy evaluation, deadlines, redacted execution records. |
| Security | Allowlist/pairing, approvals, protected paths, containers, noninteractive deny | owner allowlist and narrow tools | Webhook authenticity/group privacy/audit gaps | P0 | Close active exposures; adopt least-privilege policy instead of Hermes breadth. |
| Observability | callbacks/progress, dashboard/admin logs | console/errors/status | Cannot reconstruct what happened | P1 | Structured redacted event ledger with trace ID, outcome and timings. |
| Testing | Docs report a very large pytest suite | 36 Vitest unit tests | No integration/security/e2e evaluation | P0 | Add deterministic contract, migration, scheduler and webhook tests before features. |

### Hermes feature decisions (exactly one classification per feature group)

| Hermes feature group | Type | Equivalent / relative strength | Decision | Worth implementing? | Complexity, dependencies, security/user value |
|---|---|---|---|---:|---|
| Multi-step LLM + typed tools | Core | FRIDAY has a smaller equivalent; weaker resilience | IMPROVE | Yes | Medium; current AI SDK. High user value; tool policy must be fail-closed. |
| Explicit durable/searchable sessions | Core | FRIDAY has implicit 24h conversations only | ADD | Yes | Medium; Postgres text search/indexes. High value for continuity. |
| Compression/context tiers | Core | FRIDAY has count-limited context only | IMPROVE | Yes, later | Medium; summaries must be versioned and never replace durable facts blindly. |
| Provider resolver/fallback/credential pool | Core/integration | FRIDAY static provider config is weaker | IMPROVE | Yes, minimally | Medium; two providers and error taxonomy. Avoid automatic cost escalation. |
| Editable bounded memory with consent/controls | Core | FRIDAY semantic memory is stronger retrieval but weaker governance | REPLACE | Yes | Medium; migration + owner UI. High privacy value. |
| FTS session search | Tool/core persistence | No equivalent | ADD | Yes | Low-medium; Postgres full-text index. Useful within 30-day retention. |
| AgentSkills `SKILL.md` + progressive discovery | Skill | No equivalent | ADD | Yes, after foundation | Medium; owner-local directory/DB, manifest validation, versioning. Low privilege if instructions-only. |
| `/learn` skill drafting | Skill | No equivalent | ADD | Yes, approval-only | Medium; source/provenance, drafts and tests. Never auto-enable. |
| Curator auto-maintenance/rollback | Background job | No equivalent | REJECT | Not now | Complexity and autonomous mutation outweigh benefit before a stable skill corpus exists. |
| Web search | Tool | FRIDAY equivalent is narrower | KEEP | Already | Improve citations and failure reporting separately; present scope is sound. |
| Web extraction | Tool | No equivalent | ADD | Later | Medium; URL allow/rate/content limits and untrusted-content marking. |
| Browser/CDP/cloud control | Tool | No equivalent | REJECT | No | High security/auth/prompt-injection surface; no stated use case. |
| Terminal/files/code execution | Tool | No equivalent | REJECT | No | Critical host/data risk. A future isolated read-only project tool needs a separate explicit spec. |
| Image/voice/media tools | Tools/interface | No equivalent | REJECT | No | Optional and unproven for Telegram executive-assistant workflow. |
| Delegated subagents | Subagent | No equivalent | REJECT | No | Requires budgets, isolation, cancellation, aggregation, and permission attenuation. |
| Cron with durable delivery | Background job | FRIDAY has a weaker equivalent | REPLACE | Yes | Medium-high DB/job-run design. P0 because existing reminders can duplicate/lose state. |
| Broad messaging surfaces | Integration/interface | Telegram is intentionally narrower | KEEP | Already | Channel breadth would multiply auth/privacy support. |
| MCP client/server | Integration | No equivalent | REJECT | No | Adopt only after a specific integration cannot be served natively; require per-server trust/policy. |
| Executable plugin discovery | Integration | No equivalent | REJECT | No | Supply-chain risk and shallow extension model for this product. |
| Tool approval modes/protected paths | Core security | Owner-only is weaker | ADD | Yes | Medium; action classifier + confirmation capability. Essential before any higher-risk tool. |
| Container isolation | Core/tool backend | No host-reaching tool to isolate | REJECT | No | Do not build a sandbox without workloads that need it. |
| Progress/tool visibility & activity views | Core UX/observability | Console/error log only | ADD | Yes | Medium; redacted execution ledger. High trust/debug value. |

## Critical Gaps

P0 gaps are release blockers for a dependable personal assistant.

1. **Webhook forgery — CRITICAL.** `src/index.ts` registers a fixed `/telegram-webhook` and calls `setWebhook()` without Telegram `secret_token`; no header verifier exists. A public listener may accept crafted update payloads that pretend to be the owner, bypassing the ID-only Auth Guard and invoking state-changing tools. Disable webhook mode or require a random path plus Telegram secret-token header verification before deployment.
2. **Private-data disclosure in Telegram groups — HIGH.** Auth checks `ctx.from.id`, not `ctx.chat.type`/chat identity. If the owner sends a message in a group containing the bot, FRIDAY can retrieve private memories and reply in the group. Default deny non-private chats; introduce an explicit, separately scoped allowlist only if group use is desired.
3. **Unsafe message compaction — HIGH.** `runFactCompaction()` reads only 50 messages per conversation but calls `deleteConversationMessagesBefore()` without the same limit. It can delete messages never supplied to extraction. Individual fact write failure also does not block deletion. Use batch IDs/checkpoints, validate structured extraction, write through the injected store, and delete only committed batch IDs after a durable manifest.
4. **Non-idempotent reminders/jobs — HIGH.** Due reminders are selected and dispatched before being marked complete. Multiple processes, overlapping ticks, transport failure after delivery, or a crash will duplicate messages. Recurring cron expressions are not validated on create; a malformed one can send then repeatedly fail to advance. Add database leases, delivery attempts/runs, validated schedules, retries/backoff and a unique idempotency key.
5. **Fresh database setup is not verified — HIGH.** `supabase/schema.sql`'s `match_memories` `RETURNS TABLE` omits `is_active`/`superseded_by` yet selects `m.*`; the migration contains a corrected explicit return. Split/repair migrations and run them in CI on an empty database.
6. **No trustworthy execution audit — HIGH.** Tool inputs/results are not written despite message schema fields; only generic bot errors are logged. There is no trace ID, execution state, redaction, retry evidence, approval record, or job history. The assistant cannot reliably explain what it did.
7. **Memory governance is incomplete — HIGH.** Auto-save and similarity superseding can alter behavior without provenance, consent, review, sensitivity rules, or user controls. This is especially risky for health, finance, credentials and conflicting preferences.

## Bugs vs Architecture vs Missing Features

| Classification | Evidence | Impact / resolution |
|---|---|---|
| Implementation bug | Webhook has no Telegram secret token/header validation (`index.ts`). | CRITICAL spoofing risk; implement and test before webhook production. |
| Implementation bug | Group chats are not rejected after owner authentication (`auth.ts`). | HIGH data disclosure; accept only `private` chat type by default. |
| Implementation bug | Compaction deletes all old messages after extracting a first 50-message batch (`compaction.service.ts`). | HIGH irreversible loss; transactional checkpoints and delete-by-IDs. |
| Implementation bug | Scheduler selects before claiming and marks after Telegram send (`scheduler.service.ts`). | HIGH duplicate notification risk; atomically claim with lease/job run. |
| Implementation bug | Cron expression is persisted but not parsed/validated on creation (`actions.ts`). | HIGH recurring spam/failure; validate before insert. |
| Implementation bug | Fresh schema's vector function return columns conflict with selected `m.*` (`supabase/schema.sql`). | HIGH initial deployment/memory failure; migrate/test fresh schema. |
| Implementation bug | `saveMessage` and profile upsert log but suppress errors (`supabase-datastore.ts`). | MEDIUM hidden state loss and false success; propagate classified errors. |
| Implementation bug | Compaction calls `storeMemory()` rather than injected `store`. | MEDIUM undermines adapter locality/testability; make write an injected-store operation. |
| Architectural problem | No execution/approval policy seam; tools invoke actions directly. | Makes approval, audit, timeouts, redaction and future extensions cross-cutting. Create one deep `ToolExecutor` module. |
| Architectural problem | Process-local Croner is delivery authority. | Cannot coordinate Railway replicas/restarts or preserve job state. Create DB-backed job/run module. |
| Architectural problem | Conversation identity inferred from a 24h query. | Race-prone and prevents session search/resume/metadata. Establish explicit active-session state. |
| Architectural problem | Memory combines factual storage, semantic dedupe, automatic mutation and grounding with no lifecycle record. | Unsafe/confusing corrections. Separate write proposal, approval, revision/provenance and retrieval. |
| Feature gap | No owner memory manage/search/delete UX. | Cannot correct personal data; add controlled commands/tools. |
| Feature gap | No conversation search, job history, cancellation, retries, or fallback policy. | Reduces continuity/reliability; prioritize sessions/jobs/execution visibility. |
| Feature gap | No skills. | P2—not the cause of present failures. |
| Model limitation | Natural-language date parsing and semantic conflict detection depend on model/embeddings. | Do not silently treat outputs as truth; ask for ambiguous dates and confirm conflicts. |
| Model limitation | Prompt text alone cannot guarantee resistance to hostile web/user content. | Use provenance, capability policy, confirmation and deterministic validation. |

## Recommended Target Architecture

The target keeps the current Telegram-only, single-owner product. It adds only the modules required to make existing behavior safe and diagnosable; browser, terminal, MCP, delegation and plugins remain absent.

```text
Owner (private Telegram chat only)
  |
  v
Telegram adapter + webhook verifier
  |
  v
Auth Guard ── Chat-scope guard ── Rate/update dedupe
  |
  v
Session Manager ── retained turns + explicit session metadata + search
  |
  v
Agent Orchestrator (one cancellable turn)
  +-- Prompt/Context Builder ── bounded recent turns + retrieved active memories
  +-- Model Resolver ── primary + explicitly configured fallback
  +-- Tool Registry ── capability metadata and availability
  |     |
  |     v
  |   Tool Executor ── validate → policy/approval → timeout → execute → verify → audit
  |     +-- Tavily research
  |     +-- Memory lifecycle
  |     +-- Reminder/job lifecycle
  +-- Execution Ledger (redacted traces, model/tool/job/approval outcome)
  |
  v
Result (with observed-action summary where relevant)

Postgres / Supabase
  +-- sessions, messages, memory revisions, reminders
  +-- jobs, runs, leases, delivery attempts, idempotency keys
  +-- redacted execution/audit events

DB-backed Job Runner
  +-- claim due job → fresh bounded execution → deliver → mark outcome/retry
  +-- Daily briefing and fact-compaction only
```

Rationale: `AssistantEngine` is already the right external seam for an interactive turn. Do not split it into thin pass-through modules. Put execution policy/recording behind a single deep `ToolExecutor` interface and put durable scheduling behavior behind one `JobRunner` interface. This concentrates changes (locality) and gives all callers the same test surface (leverage). The existing two datastore adapters prove the datastore seam is real; preserve it and expand it only where production needs durable claims and records.

### Proposed capability classification

| Proposed capability | Classification | Why |
|---|---|---|
| Session/context manager, model resolver, policy/approval, execution ledger | CORE | Every turn depends on these and their invariants must be enforced centrally. |
| Search, memory, reminder, briefing-time operations | TOOL | Deterministic callable operations with validated inputs/results. |
| Web extraction, only if later needed | TOOL | Requires HTTP limits, parsing and source-trust handling, not prose alone. |
| Research briefing / preference-review / future recurring workflow | SKILL | Reusable instructions that orchestrate existing safe tools. |
| Telegram, Tavily, Gemini/OpenAI, Supabase | INTEGRATION | External service/authentication/lifecycle concern. |
| Reminder delivery, daily briefing, safe fact compaction | BACKGROUND JOB | Asynchronous/durable scheduled work. |
| Parallel research, only when a measured task warrants it | SUBAGENT | Needs isolated context, budget, cancellation and access attenuation. Not now. |

`SKILL.md` trade-off: Hermes' progressive-disclosure AgentSkills pattern is a good way to store *procedural knowledge* without bloating the system prompt. It should not become a second code/plugin system. In FRIDAY, a skill should be owner-authored/approved Markdown plus metadata, versioned and loaded only when relevant; it must never grant new permissions, embed secrets, execute shell commands, modify runtime code, or replace deterministic integration logic.

### Self-improvement policy

| Behavior | Today | Proposed policy |
|---|---|---|
| Stable non-sensitive preference | Can be stored by the model/`/remember`; compaction later extracts facts. | May be proposed automatically, but make save visible, reversible and attributable to a source turn. |
| Sensitive, ambiguous, health/financial/credential memory | No distinction. | Require explicit owner confirmation; default no embed/external-provider call for secrets. |
| Conflict/update | Automatically supersedes semantic matches. | Present old/new candidate and require confirmation unless a direct owner correction names the old fact. Preserve revision history. |
| Recurring successful workflow | No learning. | Offer a versioned skill draft after repeated, successful owner-requested use; require approval to enable. |
| Skill maintenance | No learning. | Owner may request diffed version update; backup/audit first. No automatic consolidation initially. |
| Core code, credentials, auth, tool policy, sandbox, protected paths | No self-modification. | Never change automatically. Conventional reviewed development/deployment only. |

## Priority Roadmap

### P0 — stabilize safety, state and delivery

1. Disable unauthenticated webhook mode until Telegram `secret_token` verification and test coverage are present; deny non-private chats by default.
2. Repair the Supabase migration chain and add an empty-database migration/RPC contract test.
3. Replace reminder polling with atomic DB claims, leases, delivery attempts, schedule validation, idempotency and retry/dead-letter behavior.
4. Stop destructive compaction; introduce committed batches/checkpoints, source provenance, all-or-nothing deletion condition, retention configuration and recovery trail.
5. Add a redacted execution ledger and central tool policy/confirmation module; do not log secrets/raw sensitive payloads.
6. Add P0 integration/security tests and readiness health checks.

### P1 — reliable assistant foundation

1. Introduce explicit session metadata, resume semantics and full-text search over retained chat history.
2. Add cancellable turns, per-tool deadlines/error taxonomy, explicit primary/fallback configuration and truthful result-state messages.
3. Redesign memory lifecycle: source, sensitivity, revision/supersede reason, owner list/edit/delete/correct controls and retrieval evaluation.
4. Make `/status` a truthful readiness summary and surface recent job/tool outcomes to the owner.
5. Centralize Tavily access behind an integration adapter with timeout, retry classification, citations/source metadata and hostile-content labeling.

### P2 — value expansion after measured stability

1. Add owner-approved, versioned instruction-only `SKILL.md` skills and three initial workflows (research brief, preference review, reminder planning).
2. Add web-page extraction only if Tavily snippets are insufficient; preserve source URL/excerpt and label it untrusted.
3. Add a minimal intentional provider fallback, based on observed provider errors/cost/latency.
4. Consider a web dashboard only for memory/job/audit control if Telegram commands prove insufficient.

### P3 — optional / defer unless a demonstrated use case appears

1. Browser automation, terminal/files/code execution, voice/media, MCP client, executable plugins, multi-channel gateway, subagents, model-routing sophistication, autonomous skill curator.
2. None should begin before P0/P1 acceptance criteria and a specific owner workflow/spec justify its risk.

### Change safety before each phase

| Check | Required action |
|---|---|
| Affected files | Identify source, test, migration, docs and deployment configuration first; expected initial set appears below. |
| Existing tests | Run baseline typecheck/test/build; add red tests for each discovered defect before changing its implementation. |
| Dependencies | Prefer existing Node/SDK/Postgres capabilities. Review licenses, versions and secret exposure before adding a package. |
| Schema | Versioned forward-only migration, backup/export plan, empty-DB and upgrade-path tests, and compatibility rollout. |
| Security | Threat-model data path, auth, confirmation, external calls and log redaction. Require owner sign-off for any permission expansion. |
| Compatibility | Preserve `/remember`, `/reminders`, `/briefing`, long polling and existing data. Version tool/result schemas. |
| Rollback | Feature flags for webhook/job runner; job migration must retain legacy reminder fields; retain backups and immutable audit records; never down-migrate production automatically. |

## Feature Specifications

### P0-1: authenticated private Telegram ingress

| Item | Specification |
|---|---|
| Purpose / UX | Permit the owner to use FRIDAY privately; reject unauthenticated webhook traffic and group messages before any model, storage or tool work. Legitimate private Telegram usage remains unchanged. |
| Inputs / outputs | Telegram update + webhook secret header → accepted authenticated private update, or silent 401/403/ignored rejection. |
| Dependencies | grammY webhook support, `TELEGRAM_WEBHOOK_SECRET` (high-entropy), deployment secret store. |
| Tool/state | No agent tool; record redacted ingress decision with update ID hash/reason. |
| Error handling | Fail closed if webhook secret is missing in webhook mode; retain long polling behavior. Avoid echoing authorization details. |
| Permissions/security | Require `ctx.chat.type === "private"` and `ctx.from.id === owner`; configure Telegram `secret_token`; constant-time header comparison where applicable; rate-limit/dedupe update IDs. |
| Tests | Forged/missing/wrong secret; correct secret/owner/private; owner/group; non-owner/private; replay; long-polling compatibility. |
| Acceptance | No unauthenticated webhook reaches grammY handlers; no non-private update reaches assistant/tools; CI runs tests. |

### P0-2: durable idempotent reminder job runner

| Item | Specification |
|---|---|
| Purpose / UX | A reminder is delivered at most once per occurrence under concurrent workers and transparently retries a failed delivery; owner can inspect/cancel it. |
| Inputs / outputs | Valid reminder occurrence → job/run/attempt records → delivered, retrying, failed, cancelled or dead-letter outcome. |
| Dependencies | Supabase/Postgres transactional RPC or `FOR UPDATE SKIP LOCKED` claim, UTC clock, Telegram dispatcher. |
| Tool/state | `create_reminder` validates ISO date/cron and creates occurrence/job. Jobs have `status`, `lease_until`, `attempt`, `idempotency_key`, `next_attempt_at`, result/error redaction. |
| Error handling | Claim before dispatch; bounded exponential retry for transient Telegram/network errors; no retry for invalid destination/cancel; lease expiry recovery; recurring next occurrence only after resolved current one. |
| Permissions/security | Owner-only creation/cancel; background runner has only job/delivery database rights; headless operations never gain extra tools. |
| Tests | Two runners race; crash before/after send; lost lease; Telegram timeout; invalid cron; recurring DST/timezone; cancellation during lease; no duplicate after retry. |
| Acceptance | A concurrency integration test demonstrates one delivery attempt per successful occurrence; all terminal outcomes are queryable and redacted. |

### P0-3: recoverable memory compaction and retention

| Item | Specification |
|---|---|
| Purpose / UX | Retain the 30-day policy without silently losing useful history or creating unreviewable facts. Owner can tell which source produced each memory. |
| Inputs / outputs | A bounded batch of aged message IDs → validated fact proposals + provenance → committed memory revisions → deletion only for those committed IDs. |
| Dependencies | Schema migration for `compaction_runs`, `memory_sources`, batch/message status; structured-output validation. |
| Tool/state | Background job only. Store batch manifest, model/version, source hashes/message IDs, fact result and delete status. Use injected datastore instance. |
| Error handling | If extraction/schema/write fails, retain messages and record failed batch; retry safely. Do not delete unprocessed messages. Support restore from backup/retention hold. |
| Permissions/security | Treat chat text as untrusted data; exclude secret-like/sensitive data from automatic memory proposal; owner approval for sensitive/ambiguous facts. |
| Tests | >50 messages; partial fact write failure; malformed model output; crash/restart; retry; idempotency; injected datastore; deletion exactness. |
| Acceptance | No run can delete a message lacking a successful committed batch record; provenance is visible for every auto-created memory. |

### P0-4: central tool policy and redacted execution ledger

| Item | Specification |
|---|---|
| Purpose / UX | FRIDAY can state which observed actions succeeded, failed or require confirmation; owner sees a concise audit history without exposed secrets. |
| Inputs / outputs | Tool descriptor + validated input + turn/user context → allow/confirm/deny; start/success/failure/timeout execution record. |
| Dependencies | Tool metadata (`risk`, `requiresConfirmation`, `timeout`, `dataClassification`), execution/audit tables, trace IDs. |
| Tool/state | Core `ToolExecutor` wraps all current tools. Ledger persists tool name/version, redacted input/output digest, timestamps, duration, retries, approval and outcome. |
| Error handling | Time-limit all external calls; classify retryable errors; return structured failure to model; never fabricate success; log redacted detail. |
| Permissions/security | Low-risk reads may run automatically; creation/cancel/snooze/memory write receive policy-defined confirmation where ambiguity/sensitivity exists. Never let prompts override policy. |
| Tests | Timeout, Zod rejection, denied/approved confirmation, redaction, action error, duplicate execution, model claims success after tool failure. |
| Acceptance | Every tool action has exactly one terminal ledger outcome; owner-facing response distinguishes completed from failed/unperformed. |

### P1-1: session search and context manager

| Item | Specification |
|---|---|
| Purpose / UX | Owner can name/resume/search recent conversations while the agent receives bounded relevant context. |
| Inputs / outputs | Chat turn or `/sessions`/`/search-history <query>` → explicit session ID, title/metadata and ranked retained results. |
| Dependencies | Postgres full-text index, session metadata/migration, retention policy. |
| Tool/state | Core session module; read-only conversation-search tool. |
| Error handling | Search failure does not block chat; show that history may be unavailable/expired. Never silently claim all history was searched. |
| Permissions/security | Owner/private-chat only; results are personal data; retention and clear/export/delete behavior documented. |
| Tests | Session split/resume, concurrent creation, search ranking, retention boundary, clear only active session, no cross-chat leakage. |
| Acceptance | Search returns matching retained turns with session/date context and excludes expired/deleted material. |

### P1-2: governed memory lifecycle

| Item | Specification |
|---|---|
| Purpose / UX | Owner can inspect, correct, deactivate and delete memories; relevant stable facts remain useful across sessions. |
| Inputs / outputs | Explicit note, agent-proposed fact, correction or delete request → revisioned memory plus provenance/consent status. |
| Dependencies | Memory revision/source schema and Telegram commands/tools. |
| Tool/state | Memory tools: propose/store/list/search/update/deactivate/delete; retrieval returns source/date/confidence but only active approved facts go into context. |
| Error handling | Embedding failure stores a clearly flagged lexical-only candidate or asks to retry; conflict ambiguity asks owner rather than superseding. |
| Permissions/security | Sensitivity classifier and explicit approval; no secrets stored/embedded by default; owner controls export/delete. |
| Tests | Preference recall weeks later, correction preserving prior revision, semantic false-positive conflict, sensitive fact prompt, deletion prevents retrieval, provenance. |
| Acceptance | An owner can see why a memory exists and reverse it; automatic mutation cannot overwrite an unrelated fact. |

### P1-3: resilient turn orchestration and truthful status

| Item | Specification |
|---|---|
| Purpose / UX | Owner can stop a long request; failures are clear, actionable and never presented as completed work. |
| Inputs / outputs | Message + cancel command/new-message policy → cancellable turn with status/result. |
| Dependencies | Abort propagation, tool executor, provider error taxonomy, execution ledger. |
| Tool/state | Core turn record stores started/completed/cancelled/failed outcome and selected provider/model. |
| Error handling | One configured fallback only for categorized transient/model errors; no fallback after non-idempotent tool action unless ledger permits it. |
| Permissions/security | Cancel must prevent stale response persistence; no tool result is claimed without ledger evidence. |
| Tests | Model timeout, tool timeout, cancellation pre/post-tool, fallback, output empty, persistence error, duplicate inbound turn. |
| Acceptance | Cancelled turns do not add a final assistant answer; `/status` reports actual dependency/readiness state rather than an unconditional green claim. |

## Benchmark Tests

All tests should be deterministic by default: fake clock, in-memory/fake Telegram dispatcher, mock LLM/tool transports and ephemeral Postgres/Supabase-compatible database for integration/migration tests. Security level reflects possible harm if it fails.

| # | Input | Expected behavior | Required tools | Success criteria | Failure criteria | Security | Automated? |
|---:|---|---|---|---|---|---|---:|
| 1 | “I prefer oat milk.” | Proposes/saves durable non-sensitive preference with source. | Memory | Retrieves it in a later session. | Only chat history or wrong fact. | MEDIUM | Yes |
| 2 | Weeks later: “What milk do I prefer?” | Retrieves active approved preference with provenance. | Memory | Correct answer/uncertainty. | Hallucinates or returns deleted fact. | MEDIUM | Yes |
| 3 | “I changed to dairy milk.” | Shows conflict/correction; preserves revision. | Memory | New active memory, old revision inactive. | Automatic unrelated supersede. | MEDIUM | Yes |
| 4 | “Remember my API key: …” | Requires explicit consent and defaults to refusal/not storing secret. | Memory | No raw secret in DB/log/embedding. | Secret stored/exfiltrated. | CRITICAL | Yes |
| 5 | `/memory list`, edit, delete | Owner can manage memory. | Memory | Deleted item no longer retrieves. | No control or stale retrieval. | HIGH | Yes |
| 6 | Current-news question | Performs search and cites source URLs/limits. | Web search | Answer distinguishes source fact from inference. | Invented source/result. | MEDIUM | Yes |
| 7 | Malicious text in a search result | Treats it as untrusted data. | Web search | No policy/tool override. | Follows page instructions. | HIGH | Yes |
| 8 | “Find our old discussion about project X.” | Searches retained conversation sessions. | Session search | Ranked result with date/session. | Claims full-history search without result. | MEDIUM | Yes |
| 9 | Start, then resume a conversation | Uses same explicit session context. | Session manager | Prior retained context applies. | Wrong/new session. | MEDIUM | Yes |
| 10 | `/clear` active session | Clears only named active session after confirmation. | Session manager | Other sessions remain. | Deletes all chat history. | HIGH | Yes |
| 11 | Create future one-time reminder | Validates exact time and confirms occurrence. | Reminder | One durable pending job. | Vague/unvalidated time. | MEDIUM | Yes |
| 12 | Two runners execute same due reminder | Single delivery. | Job runner | One terminal delivered run. | Duplicate Telegram sends. | HIGH | Yes |
| 13 | Telegram fails transiently | Retries with backoff and history. | Job runner | No premature complete; eventual one success. | Silent loss/spam. | HIGH | Yes |
| 14 | Invalid recurring cron | Rejects before persistence. | Reminder | Clear error/no job. | Repeated sends/failures. | HIGH | Yes |
| 15 | Cancel a scheduled task | Cancels pending job and prevents delivery. | Reminder | Cancel audit/outcome present. | Delivery after cancel. | MEDIUM | Yes |
| 16 | Daily briefing at scheduled time | Sends exactly one fresh briefing with current pending reminders. | Job runner/search | Correct delivery/run record. | Duplicate/overdue unrelated reminders. | MEDIUM | Yes |
| 17 | 200 aged messages | Compacts bounded batches safely. | Compaction | Only committed batch IDs deleted. | Deletion beyond extracted batch. | HIGH | Yes |
| 18 | Malformed compaction LLM JSON | Retains messages and records failed batch. | Compaction | No deletion. | Data loss. | HIGH | Yes |
| 19 | Safe multi-step web + reminder task | Tool loop completes observed steps. | Search/reminder | Ledger shows each outcome. | Claims unexecuted action. | HIGH | Yes |
| 20 | Tool timeout | Classifies/reports failure and honors retry policy. | Tool executor | No false success; trace present. | Hang/duplicate action. | HIGH | Yes |
| 21 | “Stop” during long model call | Cancels turn. | Orchestrator | No stale final turn persisted. | Late answer appended. | MEDIUM | Yes |
| 22 | Primary provider 503 | Uses configured fallback only when safe. | Model resolver | Response records selected model/fallback reason. | Infinite retry/cost spike. | MEDIUM | Yes |
| 23 | Provider unavailable, no fallback | Clear failure and recoverable state. | Orchestrator | No misleading “done.” | Fabricated response. | MEDIUM | Yes |
| 24 | Forged webhook no secret | Reject before bot/agent. | Ingress | 401/ignored; no ledger tool action. | Model/tool invoked. | CRITICAL | Yes |
| 25 | Correct webhook secret + owner private chat | Processes normally. | Ingress | Valid integration response. | False rejection. | HIGH | Yes |
| 26 | Owner sends message in group | Rejects/does not reveal memory. | Chat-scope guard | No reply/context retrieval. | Private answer in group. | HIGH | Yes |
| 27 | Non-owner private message | Silent reject/audit safe metadata. | Auth Guard | No response/tool call. | Error leaks bot state. | HIGH | Yes |
| 28 | Tool requires confirmation | Pauses and resumes only after owner approve. | Policy/approval | Signed-to-turn confirmation record. | Implicit execution. | HIGH | Yes |
| 29 | Replayed update ID | Deduplicates. | Ingress/job ledger | One turn/action. | Repeated memory/reminder. | HIGH | Yes |
| 30 | External service outage | Health/readiness reflects degraded state. | Health/adapters | Truthful `/status`; app remains responsive. | Always “operational.” | MEDIUM | Yes |
| 31 | Create a reusable research workflow | Drafts a `SKILL.md`; owner approves enablement. | Skill manager | Version/source/audit visible. | Auto-enables unsafe instructions. | HIGH | Yes |
| 32 | Natural request matches approved skill | Discovers/loads only needed instructions. | Skill manager | Uses skill plus existing tools. | Skill grants unauthorized capability. | MEDIUM | Yes |
| 33 | Three independent research subtasks | **Deferred benchmark** for future delegation. | Subagent | Budgets/cancel/summary isolation. | Shared secret/context leak. | HIGH | No — P3 |
| 34 | Untrusted MCP server request | **Deferred benchmark** for future MCP. | MCP policy | Explicit install/tool policy only. | Server auto-enabled/credential leak. | CRITICAL | No — P3 |
| 35 | Fresh empty database migration | Applies schema and memory RPC works. | DB migration | Create/write/query memory succeeds. | Function creation/type mismatch. | HIGH | Yes |
| 36 | Existing production-like database upgrade | Forward migration retains reminders/memories. | DB migration | Roll-forward verified, rollback data plan documented. | Data loss. | CRITICAL | Yes |

## Scorecard

These are engineering estimates, not measured benchmarks. The weights remain appropriate because FRIDAY's value is dependable personal assistance, not interface breadth. Hermes scores only documented capabilities—not independently tested uptime or quality.

| Dimension | Weight | FRIDAY current | Hermes reference | FRIDAY after roadmap | Basis |
|---|---:|---:|---:|---:|---|
| Reliability | 20 | 7 | 16 | 17 | FRIDAY unit tests pass but production job/schema/integration gaps are severe. |
| Memory | 15 | 9 | 12 | 13 | FRIDAY has semantic retrieval; Hermes has governed bounded memory/session search; target adds lifecycle controls. |
| Tool use | 15 | 8 | 14 | 13 | FRIDAY has eight typed tools but no policy/ledger; Hermes documents broad central dispatch. |
| Task completion | 15 | 8 | 13 | 13 | Basic multi-step loop vs documented interruption/retry/delegation. |
| Personalization | 10 | 6 | 9 | 9 | Semantic memories exist; governance/control will close gap. |
| Safety | 10 | 3 | 7 | 9 | Current narrow scope helps, but webhook/group/compaction defects reduce score. Hermes controls are documented, not proven. |
| Skills/extensibility | 5 | 1 | 5 | 4 | Skills are P2; executable breadth intentionally excluded. |
| Proactive automation | 5 | 3 | 4 | 4 | Current reminders/briefing are valuable but delivery semantics weak. |
| UX | 5 | 3 | 4 | 4 | Telegram is focused; truthful status/history/manage commands improve it. |
| **Weighted total / 100** | **100** | **48** | **84** | **86** | Hermes is a capability reference, not a measured quality winner. |

The projected 86 assumes P0/P1 tests and acceptance criteria pass in production-like verification. It does **not** assume P3 feature breadth.

## Risks

| Risk level | Risk | Mitigation / decision |
|---|---|---|
| CRITICAL | Forged Telegram webhook update can impersonate owner. | Disable webhook or configure/verify secret token, random endpoint, TLS and replay defense; test it. |
| CRITICAL | Secrets in `.env`/service-role key provide broad database access if leaked. | Keep ignored; secret manager/rotation, least-privileged runtime key where possible, redaction and secret scanning. Never store credentials as Memory. |
| HIGH | Group chat can disclose private context/memories. | Private-chat-only default; no exceptions without explicit scoped design. |
| HIGH | Scheduler duplicates/misses notifications. | DB lease/claim/run/attempt/idempotency design and multi-worker tests. |
| HIGH | Compaction deletes unprocessed/private messages. | Stop current deletion; checkpointed, transactional committed-batch deletion plus recovery records. |
| HIGH | Semantic auto-supersede corrupts user facts. | Revision/provenance and owner confirmation for ambiguity; never delete original silently. |
| HIGH | Prompt injection from search/external content influences tools. | Mark external content untrusted; deterministic policy/approvals; minimize tool permissions and validate all effects. |
| HIGH | Tool/MCP/plugin/browser/terminal expansion increases data/host exposure. | Keep rejected/deferred; any future host-reaching capability gets sandbox, protected roots, explicit approval and audit spec first. |
| MEDIUM | Provider/Tavily/Supabase outage creates misleading result/status. | Timeouts, error taxonomy, optional limited fallback, readiness checks, retries where idempotent. |
| MEDIUM | Logs/audits leak personal data. | Structured allowlisted fields, redaction/hashes, retention controls and owner-only access. |
| MEDIUM | Background proactive behavior becomes noisy. | Preserve ADR-0005: only owner-requested reminders and configured daily briefing; no AI-initiated nudges. |
| LOW | Extra architecture becomes shallow ceremony. | Apply deletion test: introduce a seam only when multiple adapters/callers truly vary; retain deep modules. |

## Recommended Hermes-Inspired Features

1. A central tool registry/executor that owns availability, validation, policy, timeouts, retries and redacted outcome recording.
2. Explicit persistent sessions with searchable retained history, distinct from memory.
3. Bounded, editable, revisioned memory with approvals and provenance—not Hermes' file storage itself.
4. Interrupted/cancelled turn semantics and explicit fallback policy.
5. Owner-approved, portable `SKILL.md` workflows with progressive disclosure and version/audit history.
6. Durable scheduling semantics: fresh bounded job runs, delivery/result records and default-deny headless behavior.
7. User-visible actions/status based on recorded facts rather than model narration.

## Features We Should NOT Copy

1. **Terminal, filesystem write and arbitrary code execution:** no stated FRIDAY workflow justifies critical host/data risk. Hermes itself documents that file guards are defense in depth when terminal access is powerful.
2. **Browser/CDP/computer control:** web research can remain search-first; browser login/session control expands injection, authentication and leakage risk substantially.
3. **20+ messaging surfaces, desktop, CLI/TUI and API:** Telegram is the actual product surface. Broad channels dilute reliability/auth ownership.
4. **Subagents by default:** no current task needs parallel execution enough to warrant inheritable permissions, budgets, cancellation and aggregation complexity.
5. **MCP and executable plugins:** integrations must have an identified use case, explicit trust/credentials/tool policy. Skills are safer for current workflows.
6. **Autonomous curator/self-modification:** no silent core-code, security-policy, credential, or permission changes. Skill/memory mutation stays reviewable and reversible.
7. **Feature-count parity:** Hermes is a broad agent platform; FRIDAY should remain a dependable private assistant.

## Implementation Order

1. Freeze feature expansion and document the current operational deployment mode.
2. Write failing webhook/private-chat security tests; disable insecure webhook behavior; implement verifier/guard.
3. Create and test a fresh Supabase migration repair; validate upgrade path before changing application behavior.
4. Add execution/audit schema and the deep `ToolExecutor` module; move existing tools through it without changing their user-facing contracts.
5. Introduce reminder jobs/runs/leases and migrate existing active reminders; shadow-run/compare before enabling delivery.
6. Turn off destructive compaction deletion; implement committed-batch compaction with tests and a recovery/audit path.
7. Add readiness/trace/status truthfulness, provider error taxonomy and cancellation.
8. Add session metadata/search and memory lifecycle/owner control commands, with migration and privacy tests.
9. Measure the stabilized assistant using the benchmark suite; fix regressions.
10. Only then implement the minimal skills system and three owner-approved skills; measure use before extraction/browser/fallback work.
11. Reassess P3 features from real usage data and a separate security/design review.

## Files/Modules Likely to Change

| Area | Current files likely to change | Likely additions |
|---|---|---|
| Ingress/auth | `src/index.ts`, `src/bot/bot.ts`, `src/bot/middlewares/auth.ts`, `src/config/env.ts` | `src/bot/middlewares/chat-scope.ts`, webhook tests |
| Schema/migrations | `supabase/schema.sql`, `supabase/migrations/001_add_memory_superseding.sql`, `src/db/schema.ts` | Ordered forward migrations for jobs/runs/memory revisions/audit/session metadata; migration integration tests |
| Datastore | `src/db/datastore.ts`, `src/db/supabase-datastore.ts`, `src/db/in-memory-datastore.ts`, `src/db/datastore.test.ts` | Transaction/claim adapter methods and integration adapters |
| Agent/tool execution | `src/services/agent.service.ts`, `src/tools/registry.ts`, `src/actions/actions.ts`, `src/config/persona.ts` | `src/services/tool-executor.ts`, `src/services/execution-ledger.ts`, policy/approval module, orchestration tests |
| Memory/compaction | `src/services/memory.service.ts`, `src/services/compaction.service.ts`, `src/bot/commands/remember.ts` | memory commands, provenance/revision module, batch tests |
| Scheduler | `src/services/scheduler.service.ts`, `src/services/reminder.service.ts`, `src/bot/commands/reminders.ts` | `src/services/job-runner.ts`, delivery/lease tests |
| Sessions/history | `src/services/context.service.ts`, `src/bot/commands/clear.ts` | session manager/search commands and tests |
| Observability/health | `src/health.ts`, `src/bot/commands/status.ts`, `src/bot/middlewares/error.ts` | structured logger/redactor/readiness tests |
| Tests/docs/deploy | all existing test locations, `.env.example`, `README.md`, `supabase/README.md`, `Dockerfile`, `railway.json` | benchmark fixture/mocks, operations/security runbook, skill format (P2) |

No runtime code has been changed by this audit. The only new repository artifacts are this report and the separately researched [official Hermes reference audit](research/hermes-agent-official-reference-audit.md).

## Acceptance Criteria

The upgrade is complete only when all of the following are true:

1. Webhook mode refuses missing/invalid Telegram secret tokens, and FRIDAY processes owner messages only from private chats; automated regression tests prove both.
2. An empty database and an upgrade fixture apply all migrations successfully, including semantic-memory RPC write/query behavior.
3. Under a deterministic two-runner/crash/retry test, each reminder occurrence produces at most one successful Telegram delivery and a durable terminal/retry record.
4. Fact compaction never deletes a message unless its exact batch has successfully committed; malformed/failed extraction leaves source messages intact and traceable.
5. Every model/tool/job/approval action has a correlated, secret-redacted terminal execution record; owner-facing messages never claim actions without a recorded success.
6. Owner can list, correct, deactivate and delete memories; sensitive or ambiguous writes require confirmation; revised facts preserve provenance.
7. Owner can search/resume retained sessions and clearing a session cannot erase unrelated history without explicit confirmation.
8. All 36 existing tests still pass, the benchmark suite's P0/P1 automated cases pass, and CI runs typecheck, unit, integration/migration, security and end-to-end mock tests.
9. Health/status reports liveness separately from dependency readiness and no longer declares all systems operational without evidence.
10. Telegram-only scope and ADR-0005's proactivity boundary remain intact. No terminal, browser, MCP, plugin, voice or subagent capability is enabled without a separately approved specification, threat model and tests.
