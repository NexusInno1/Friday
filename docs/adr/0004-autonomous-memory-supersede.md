# 4. Autonomous Memory Conflict Resolution and Superseding

We decided to allow FRIDAY to autonomously detect conflicting facts about the Owner and update/supersede outdated memories rather than accumulating contradictory records or blocking the Owner with confirmation dialogues.

## Context
Over time, personal preferences change (e.g., tech stacks, routines, locations). An append-only memory store creates semantic ambiguity when retrieval fetches conflicting facts ("Owner uses Next.js" vs "Owner switched to SvelteKit"). Asking the Owner to resolve every minor conflict degrades the seamless executive assistant persona.

## Decision
When storing a new memory that directly contradicts or updates an existing memory, the Assistant updates the existing record or archives the superseded fact. The retrieval pipeline only injects active, current memories into the context window.

## Consequences
- Clean, non-contradictory context is provided to the LLM.
- Reduces context window bloat and eliminates hallucinated reasoning based on obsolete preferences.
- Requires semantic search on writes when evaluating updates to existing topics.
