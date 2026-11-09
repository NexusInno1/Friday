/**
 * Actions Facade (Backward-Compatible Re-Export Surface)
 *
 * This module preserves the public API for actions while delegating actual domain
 * logic to deep service modules:
 *  - Memory domain: `src/services/memory.service.ts`
 *  - Reminder domain: `src/services/reminder.service.ts`
 *  - Web Research domain: `src/services/research.service.ts`
 *  - Briefing domain: `src/services/briefing.service.ts`
 */

export * from "../services/memory.service.js";
export * from "../services/reminder.service.js";
export * from "../services/research.service.js";
export { updateBriefingTimeAction } from "../services/briefing.service.js";
