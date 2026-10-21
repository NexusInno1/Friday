import type { DataStore } from "../db/datastore.js";
import type { Memory } from "../db/schema.js";
import { rememberAction } from "../actions/actions.js";

export interface PendingMemory {
  id: string;
  userId: number;
  chatId: number;
  content: string;
  tags: string[];
  importance: number;
  source: "web";
  createdAt: string;
}

export const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const _pendingMemories = new Map<string, PendingMemory>();

function pruneExpiredMemories(): void {
  const now = Date.now();
  for (const [id, pending] of _pendingMemories.entries()) {
    const age = now - new Date(pending.createdAt).getTime();
    if (age > PENDING_TTL_MS) {
      _pendingMemories.delete(id);
    }
  }
}

export function registerPendingMemory(pending: PendingMemory): void {
  pruneExpiredMemories();
  _pendingMemories.set(pending.id, pending);
}

export function getPendingMemory(id: string): PendingMemory | undefined {
  const pending = _pendingMemories.get(id);
  if (!pending) return undefined;

  const age = Date.now() - new Date(pending.createdAt).getTime();
  if (age > PENDING_TTL_MS) {
    _pendingMemories.delete(id);
    return undefined;
  }

  return pending;
}

export function clearPendingMemories(): void {
  _pendingMemories.clear();
}

export async function confirmPendingMemory(
  id: string,
  store: DataStore
): Promise<Memory | null> {
  const pending = getPendingMemory(id);
  if (!pending) return null;

  _pendingMemories.delete(id);
  return rememberAction(
    pending.content,
    pending.tags,
    pending.importance,
    store,
    pending.userId,
    "web"
  );
}

export function rejectPendingMemory(id: string): boolean {
  return _pendingMemories.delete(id);
}
