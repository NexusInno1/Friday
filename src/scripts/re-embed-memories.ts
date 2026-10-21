import fs from "fs";
import { getDataStore } from "../db/datastore-provider.js";
import type { DataStore } from "../db/datastore.js";
import { generateEmbedding } from "../actions/actions.js";
import { env } from "../config/env.js";

export interface ReembedOptions {
  store?: DataStore;
  userId?: number;
  batchSize?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  stateFilePath?: string;
  initialCompletedIds?: Set<string>;
  embeddingGenerator?: (text: string) => Promise<number[]>;
}

export interface ReembedResult {
  total: number;
  reembedded: number;
  skipped: number;
  failed: number;
}

const BACKUP_BANNER = `
================================================================================
⚠️  CRITICAL REMINDER: BACK UP YOUR SUPABASE DATABASE BEFORE PROCEEDING!
--------------------------------------------------------------------------------
Vectors from different models cannot be compared. All memories will be
re-embedded with gemini-embedding-2 (768 dimensions). Ensure you have taken
a manual backup or verified automated backups in Supabase Dashboard before running.
================================================================================
`;

export function printBackupReminder(): void {
  console.log(BACKUP_BANNER);
}

/**
 * Re-embeds all memories in batches with retry and state resumption.
 */
export async function reembedAllMemories(options: ReembedOptions = {}): Promise<ReembedResult> {
  const store = options.store ?? getDataStore();
  const userId = options.userId ?? env().TELEGRAM_ALLOWED_USER_ID;
  const batchSize = options.batchSize ?? 20;
  const maxRetries = options.maxRetries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const stateFilePath = options.stateFilePath ?? ".reembed-migration-state.json";
  const embedder = options.embeddingGenerator ?? generateEmbedding;

  printBackupReminder();

  // Load completed IDs from state file if present
  const completedIds = new Set<string>(options.initialCompletedIds);
  if (stateFilePath !== ":memory:" && fs.existsSync(stateFilePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(stateFilePath, "utf-8"));
      if (Array.isArray(data.completedIds)) {
        for (const id of data.completedIds) {
          completedIds.add(id);
        }
      }
    } catch (e) {
      console.warn("[migration] Could not read existing state file, starting fresh:", e);
    }
  }

  const totalCount = await store.getMemoryCount(userId);
  const allMemories = await store.listMemories(userId, Math.max(totalCount + 100, 5000));

  const result: ReembedResult = {
    total: allMemories.length,
    reembedded: 0,
    skipped: 0,
    failed: 0,
  };

  const toProcess = allMemories.filter((m) => {
    if (completedIds.has(m.id)) {
      result.skipped++;
      return false;
    }
    return true;
  });

  console.log(`[migration] Found ${allMemories.length} total memories. ${result.skipped} already processed, ${toProcess.length} remaining.`);

  // Process in batches
  for (let i = 0; i < toProcess.length; i += batchSize) {
    const batch = toProcess.slice(i, i + batchSize);
    console.log(`[migration] Processing batch ${Math.floor(i / batchSize) + 1} (${batch.length} memories)...`);

    for (const memory of batch) {
      let attempts = 0;
      let success = false;
      let lastError: unknown = null;

      while (attempts < maxRetries && !success) {
        attempts++;
        try {
          const newEmbedding = await embedder(memory.content);
          await store.updateMemoryEmbedding(memory.id, newEmbedding);
          completedIds.add(memory.id);
          result.reembedded++;
          success = true;
        } catch (err) {
          lastError = err;
          console.warn(`[migration] Memory ${memory.id} attempt ${attempts}/${maxRetries} failed:`, err);
          if (attempts < maxRetries && retryDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs * Math.pow(2, attempts - 1)));
          }
        }
      }

      if (!success) {
        result.failed++;
        console.error(`[migration] Permanently failed to re-embed memory ${memory.id}:`, lastError);
        // Requirement: Vectors from different models cannot be compared, so no old vectors may remain.
        // Nullify the old vector so it does not corrupt cosine similarity searches with the new model.
        await store.updateMemoryEmbedding(memory.id, null);
      }
    }

    // Persist progress to state file
    if (stateFilePath !== ":memory:") {
      try {
        fs.writeFileSync(
          stateFilePath,
          JSON.stringify({ completedIds: Array.from(completedIds), updatedAt: new Date().toISOString() }, null, 2),
          "utf-8"
        );
      } catch (err) {
        console.warn("[migration] Failed to save state file:", err);
      }
    }
  }

  console.log(`\n[migration:done] Re-embedding complete. Total: ${result.total}, Re-embedded: ${result.reembedded}, Skipped: ${result.skipped}, Failed: ${result.failed}\n`);
  return result;
}

// CLI runner
if (process.argv[1]?.endsWith("re-embed-memories.ts") || process.argv[1]?.endsWith("re-embed-memories.js")) {
  reembedAllMemories()
    .then((res) => {
      console.log("Migration finished successfully:", res);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration fatal error:", err);
      process.exit(1);
    });
}
