# Hermes Agent: Official Reference Audit

**Research date:** 2026-08-28  
**Scope:** Current Hermes Agent information from Nous Research's official repository and official documentation only. This is a reference audit, not an endorsement to copy its design.

## Canonical sources and version boundary

- **Canonical source repository:** [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), a public MIT-licensed repository maintained by Nous Research. Its README directs users to the official docs.
- **Canonical documentation:** [Hermes Agent documentation](https://hermes-agent.nousresearch.com/docs/). Its machine-readable [documentation index](https://hermes-agent.nousresearch.com/docs/llms.txt) identifies both the official repo and current feature pages.
- Claims below are limited to documented behavior. Where a capability is not explicitly evidenced, it is marked **not verified**, rather than inferred from marketing or a directory name.

## Verified architecture

The official [architecture guide](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture) describes a platform-agnostic `AIAgent` core (`run_agent.py`) used by the CLI, gateway, ACP adapter, batch runner, API server, and Python library. Its main internal collaborators are prompt building, runtime-provider resolution, context compression/caching, and centralized tool dispatch.

```text
CLI / TUI / Desktop / Messaging Gateway / ACP / API / Batch
                         |
                         v
                   AIAgent core
       +-----------------+--------------------+
       |                 |                    |
 prompt assembly   provider resolution   tool registry/dispatch
       |                 |                    |
 context/memory    provider API mode       tools + MCP/backends
       |
 SQLite session store (FTS5) / profile state
       |
 cron scheduler, plugins, gateway delivery
```

Verified implementation seams from that guide:

| Subsystem | Officially documented implementation/pattern | Engineering implication / limit |
| --- | --- | --- |
| Agent loop | Synchronous `AIAgent`; prompt assembly, provider selection, tool dispatch, retries, fallbacks, callbacks, compression, and persistence are concentrated there. | It is a strong full-stack reference, but the guide explicitly calls `run_agent.py` a large file; do not adopt its monolith wholesale. |
| Prompt/context | Ordered stable/context/volatile prompt tiers; context compression summarizes middle turns after pressure thresholds; Anthropic prefix caching is supported. | Compression is lossy by design; important facts should be persisted separately. |
| Providers | Shared resolver maps provider/model to API mode, key, and base URL. Three verified modes: OpenAI-compatible chat completions, Codex Responses, and Anthropic Messages. 18+ providers, OAuth, credentials pools, aliases are documented. | Model routing/fallback is configuration-led, not evidence of semantic task-based model selection. |
| Tool runtime | Central registry self-registers tool modules; schema collection, availability checks, dispatch, and error wrapping. Documentation reports 70+ tools and about 28 toolsets. | Broad tool availability increases prompt/tool-selection cost and attack surface; toolsets and dynamic discovery matter. |
| Sessions | SQLite + FTS5, atomic writes/contention handling, lineage through compression, and per-platform isolation. | Full-text search is documented; semantic cross-session retrieval is not intrinsic to the default store. |
| Plugins | User directory, project directory, and Python entry points can register tools, hooks, and CLI commands. Memory/context-engine plugins are single-select. | Plugin code is an execution/supply-chain boundary and needs trust/permission policy. |
| Test infrastructure | Architecture guide reports roughly 25,000 pytest tests across roughly 1,250 files. | This signals serious test investment, not a comparable measured reliability score. |

Sources: [architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture), [agent-loop internals](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop), [provider runtime](https://hermes-agent.nousresearch.com/docs/developer-guide/provider-runtime), [documentation index](https://hermes-agent.nousresearch.com/docs/llms.txt).

## Capability reference matrix

| Area / feature | What Hermes officially documents | Type / maturity | Design and security notes |
| --- | --- | --- | --- |
| Multi-step agent runtime | Turn loop appends the user message, builds/reuses the prompt, checks compression, makes an interruptible model call, executes tool calls, then loops until text output; tool calls can run concurrently except interactive calls. | Core | Each loop tracks iteration budget across parent/child agents; still requires bounded budgets and tested tool error paths. [Source](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop) |
| Interruption and continuation | New message, `/stop`, or signal interrupts the request; discarded partial response is not added to history. Sessions persist/resume and the CLI advertises interrupt-and-redirect. | Core / interface | This is a useful reliability benchmark: cancellation must prevent stale output from entering state. [Source](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop) |
| Retries/fallback | The loop handles retries and fallback-model switching; fallback providers and credential pools have dedicated documented configuration. | Core / integration | Verify per-error policy in any adoption; the documentation does not establish universal recovery guarantees. [Fallback providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/fallback-providers), [credential pools](https://hermes-agent.nousresearch.com/docs/user-guide/features/credential-pools) |
| Model/provider switching | Provider resolver supports three API modes and provider/model settings; `hermes model` is a shared CLI/gateway switching path. | Core | Useful if multiple providers are actually configured; otherwise it is needless operational complexity. [Source](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop) |
| Persistent memory | Bounded `MEMORY.md` (agent/workspace facts) and `USER.md` (user profile), persisted per profile and injected as a frozen system-prompt snapshot at a new session. Agent memory tool supports add/replace/remove. | Core | Default limits are 2,200 and 1,375 chars. Automatic writes are documented, while `memory.write_approval` can require consent. Snapshot semantics mean same-session writes are not prompt-visible. [Source](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) |
| Memory quality controls | Duplicate entries are rejected; writes over capacity fail rather than silently compact; memory entry scanning blocks stated injection/exfiltration patterns and invisible Unicode. User can edit/delete through Journey. | Core | Memory conflict resolution is substring replacement/removal plus human editing; no default semantic provenance/conflict graph is documented. [Source](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) |
| Cross-session conversation recall | `session_search` uses SQLite FTS5 over CLI and messaging sessions; it returns stored messages and supports scrolling/browsing. | Tool/core persistence | Distinct from memory. This is concrete evidence that Hermes can find older conversation text, but FTS is lexical rather than verified semantic retrieval. [Source](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) |
| Session intelligence | SQLite sessions have lineage, platform isolation, persistence, resume/list/search paths; one agent is created with session history per gateway message. | Core | Good reference for explicit session keys and atomic write handling. [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture), [sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions) |
| Skills | `SKILL.md` on-demand instructional documents using progressive disclosure: list metadata, load a skill, then optionally load specific references. Compatible with agentskills.io; metadata includes version, platform/tool requirements, tags/category. | Skill system | This is procedural knowledge, not executable code. It is appropriate for reusable workflows; native integrations remain tools. [Source](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) |
| Skill discovery/activation | Skills can be slash-invoked, requested in natural language, restricted by platform, and conditionally shown based on tool availability. Up to five leading slash skills can be stacked. | Skill system | Descriptions must be high-signal to avoid bad selection; tool-dependent hiding reduces invalid execution. [Source](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) |
| Skill authoring and learning | `/learn` turns a conversation, local/docs source, or described workflow into a `SKILL.md`; large sources become a lean index plus on-demand references. It saves through `skill_manage`, so write approval can gate it. | Controlled self-improvement | Strongly relevant pattern: learning writes a reversible user-visible artifact, not core application code. Output quality still depends on the agent and source trust. [Source](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) |
| Skill maintenance | Curator tracks usage/staleness, can archive/consolidate, has dry run/pause/pin/archive/restore, snapshots before mutations, an audit ledger, and rollback. | Optional background maintenance | Suitable only after core skills are trustworthy. Do not enable autonomous consolidation without backups/audit. [Source](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator) |
| Browser/web | Built-in web search/extraction, browser automation with local/CDP or cloud options; official tool gateway bundles search, browser, image generation and TTS. | Tools / integration | Untrusted page content must be treated as data; the security guide's project-context scanning does not prove full browser-content injection prevention. [Tools](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools), [browser](https://hermes-agent.nousresearch.com/docs/user-guide/features/browser), [web search](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search) |
| Terminal/files/code | Documented terminal orchestration has local, Docker, SSH, Daytona, Modal, Singularity and Vercel Sandbox backends; file tools include read/write/patch/search; `execute_code` is a sandboxed programmatic Python/RPC workflow. | Tools | These are high-risk capabilities. A personal agent needs explicit workspace scoping, approval, result verification and audit trails before breadth. [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture), [code execution](https://hermes-agent.nousresearch.com/docs/user-guide/features/code-execution) |
| Documents/media | Official docs cover document extraction, vision, image generation, TTS, and real-time voice/transcription. | Tools / interfaces | These are optional: introduce only for actual user workflow and clear data-retention policy. [Docs index](https://hermes-agent.nousresearch.com/docs/llms.txt) |
| Delegation | `delegate_task` creates isolated child `AIAgent` instances with inherited tools, fresh context, separate terminal sessions, and only final summary returned to parent. | Subagent tool | Use for parallelizable independent work. Inherited access means no automatic security reduction; budgets/cancellation and aggregation must be tested. [Source](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation) |
| Scheduling/proactivity | `cronjob` manages one-time/recurrent work in natural language or cron expressions. Jobs can attach skills; architecture documents fresh agent/no history, delivery to target platform, state/next-run update. Heartbeats, recurring loops and hooks are separately documented. | Background jobs | Headless dangerous-command behavior defaults to deny. Differentiate requested automation from unsolicited proactive behavior. [Cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron), [architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture), [heartbeat](https://hermes-agent.nousresearch.com/docs/user-guide/features/heartbeat) |
| Messaging/interfaces | CLI/TUI, Desktop, dashboard, gateway and API; desktop shares agent state with CLI/gateway. Gateway supports a wide set of messaging channels; ACP serves VS Code, Zed and JetBrains. | Interfaces / integrations | More channels multiply authentication, authorization, notification and data-leakage work. They are not a foundation requirement. [Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop), [messaging](https://hermes-agent.nousresearch.com/docs/user-guide/messaging), [architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture) |
| MCP client/server | MCP supports local stdio and remote HTTP/OAuth servers; OAuth uses discovery/PKCE/token refresh and stores tokens with 0600 permissions. Tool names are prefixed and resource/prompt utilities are capability-gated. Hermes can also serve messaging tools as an MCP server. | Optional integration | Each MCP server is an untrusted capability/dependency. Tool filtering, credentials isolation, explicit installs and per-tool permissions are material requirements. [Source](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) |
| Plugin system | Plugins can add tools, hooks, integrations and commands from user/project/entry-point discovery locations. | Optional extension | Code plugins should be reviewed/pinned; a skill is safer when instructions + existing tools are sufficient. [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture), [plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins) |
| Observability | Architecture states tool calls are visible via callbacks/progress. Desktop/dashboard docs list logs, analytics, sessions, cron and skills administration. | Core UX/operations | Documentation establishes visibility, not a formal redaction/retention standard. Any implementation needs structured redacted traces. [Architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture), [dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard) |

## Hermes self-improvement model: adoption boundary

Verified mechanisms are **memory updates**, **agent-created procedural skills**, **`/learn`**, and an optional **curator**. Hermes documents proactive memory saving by default and an optional memory write-approval setting. It also documents backups, archival, a mutation ledger and rollback for curator-driven skill changes.

Recommended interpretation for a dependable personal assistant:

| Behavior | Recommended automation policy | Why |
| --- | --- | --- |
| Save compact, non-sensitive stable preference | Optional automatic save, with transparent confirmation/history and delete/edit controls | This improves continuity and is reversible. |
| Save sensitive personal, credential, health/financial, or ambiguous information | Require explicit approval | Memory is injected into prompt/context and may affect future behavior. |
| Draft a skill from a successful, recurring workflow | Create as a visible draft or require approval to enable | Skill text can alter tool use; source/provenance and tests are needed. |
| Modify/curate a user-approved skill | Require versioning, backup, diff, audit record; automatic archival only with opt-in | Hermes' snapshot/ledger pattern is the appropriate minimum. |
| Change core application code, tool permissions, approval rules, auth settings, protected paths, or secret configuration | Never silently automate | This crosses the security boundary and needs a conventional reviewed deployment process. |

## Security reference and risks to retain in the comparison

The official [security guide](https://hermes-agent.nousresearch.com/docs/user-guide/security) documents defense in depth: gateway allowlists/DM pairing, dangerous-command approval, write safety, hardened container backends, MCP credential filtering, context-file injection scanning, session isolation, and terminal working-directory validation.

| Risk level | Hermes capability / control verified | Takeaway for comparison |
| --- | --- | --- |
| **CRITICAL** | Terminal can execute host commands; `--yolo`/approval-off exist, though an always-on hardline blocklist rejects certain catastrophic commands. | Do not treat regex approval alone as a sandbox. Default to least privilege and isolated execution; never offer unrestricted autonomy by default. |
| **HIGH** | File writes have protected-path denylist and optional `HERMES_WRITE_SAFE_ROOT`; docs explicitly state terminal access can still bypass file-tool guards. | Enforce protected paths at every host-reaching capability, log writes, and use an actual sandbox for hostile content. |
| **HIGH** | Messaging gateway authorizes by default deny, allowlists and DM pairing; pairing has cryptographic codes, TTL, limits and revocation. | Any remote interface must authenticate before agents/tools run; user identity must be carried into approvals and audit logs. |
| **HIGH** | MCP runs subprocesses or reaches remote services, with credential filtering/token storage and tool prefixes. | Require explicit server install/enablement, credential scoping and tool-level policy. |
| **HIGH** | Memory and project context are prompt-injected; memory scan and context scanning are documented. | Provenance/untrusted-content labels and injection-resistant tool policies remain necessary; scan is a mitigation, not proof of safety. |
| **MEDIUM** | Cron can run without an interactive approver; its documented default for dangerous commands is deny. | Background tasks must fail closed, have deduplication/idempotency, audit history, retries and an explicit delivery target. |
| **MEDIUM** | Agent-created skills/third-party Skills Hub content can influence tool use. | Use signatures/lockfiles or trust review; do not run arbitrary skill-supplied executable content automatically. |
| **LOW–MEDIUM** | Sessions and logs preserve history for search and debugging. | Apply retention, access control, redaction, export/delete and per-user isolation policies. |

Particularly useful safety patterns to benchmark: smart/manual/off approval modes with a fail-closed timeout; unoverrideable catastrophic-command blocklist; protected credentials/secrets paths; sandbox write root; noninteractive cron denial; pairing/default-deny; curator dry-run/backups/ledger/rollback. Source: [security guide](https://hermes-agent.nousresearch.com/docs/user-guide/security).

## Reference conclusions for the parent gap analysis

1. **Adopt patterns, not feature count.** Hermes is a broad agent platform. The strongest generally transferable patterns are explicit durable sessions, bounded editable memory distinct from chat history, safe tool registry/availability checks, cancellation, failure handling, and auditability.
2. **`SKILL.md` is valuable only when workflows recur.** It keeps procedural instructions separate from deterministic tools and uses progressive disclosure. It should not substitute for authenticated integrations, binary/media handling, scheduling primitives, or approval enforcement.
3. **Self-improvement should be artifact-based and reversible.** Prefer auditable memory and versioned skill drafts over automatic edits to runtime code or security policy. Hermes' curator only becomes justified after the assistant reliably creates useful skills and users opt in.
4. **Subagents and massive channel breadth are not foundation work.** Delegation is worth considering only for independent, measurable parallel workloads and only after child budgets, cancellation, permissions and result aggregation are implemented. New messaging/voice/browser surfaces should follow demonstrated user need.
5. **Hermes's own security docs warn about the boundary.** File-tool deny rules are defense-in-depth rather than protection against hostile terminal access; use isolation/least privilege rather than assuming approval classifiers provide containment.

## Non-claims / questions the source audit does not settle

- No quantitative uptime, latency, task-success, retrieval precision, hallucination rate, or security efficacy measurement was located in the cited official documentation; no score should be presented as objective from this research alone.
- The documentation does not establish that default memory uses vector/semantic retrieval, conflict provenance, or automatic truth validation; its default persistent memory is bounded files and cross-session search is FTS5.
- The source audit does not establish that every listed provider/tool/integration is equally mature on every platform. Compare only features actually exercised in the target assistant's environment.
- The official docs describe protections, not a guarantee that third-party MCP servers, plugins, web pages, skills, models, or host terminals are safe.

