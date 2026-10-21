# Database Backup and Disaster Recovery Runbook

This document details the backup, export, verification, and restore procedures for FRIDAY's PostgreSQL database hosted on Supabase (including `pgvector` embeddings and relational tables).

---

## 1. Database Architecture Summary

FRIDAY stores operational and conversational state in Supabase:
- **`user_profiles`**: User preferences, timezone, custom persona instructions, and daily briefing schedule.
- **`conversations`**: Active and archived chat sessions with titles and summaries.
- **`messages`**: Full conversational history with full-text search indexes (`gin(to_tsvector)`).
- **`memories`**: Long-term semantic facts with 768-dimensional `gemini-embedding-2` vector embeddings and an `HNSW` index (`vector_cosine_ops`), plus source provenance (`user`, `web`, `system`).
- **`reminders`**: One-shot and recurring reminders with delivery locks (`lease_until`) and execution stamps (`sent_at`).
- **`scheduled_briefings`**: Daily morning briefing dispatch logs preventing double-sends.
- **`activity_logs`**: System audit events and error traces.

---

## 2. Automated Backups (Supabase Native)

- **Daily Backups**: Supabase Pro projects automatically maintain daily logical backups retained for 7 to 30 days.
- **Point-in-Time Recovery (PITR)**: If PITR is enabled in Supabase project settings, you can restore to any specific second within the retention window.
- **Accessing Backups**:
  1. Open the [Supabase Dashboard](https://supabase.com/dashboard).
  2. Navigate to **Project Settings** > **Database** > **Backups**.
  3. Select **Download** for the desired daily backup snapshot or trigger a restore.

---

## 3. Manual Backup Procedure (`pg_dump`)

Always create a manual snapshot prior to running schema migrations or data modification scripts (such as `re-embed-memories.ts`).

### Prerequisites
- Install PostgreSQL client utilities (`pg_dump` and `psql` v15+).
- Retrieve your Supabase direct connection string from **Project Settings** > **Database** > **Connection string** > **URI** (Mode: Session, Port: 5432).

### Complete Backup (Schema + Data)
Run `pg_dump` with custom directory or compressed archive format:

```bash
# Set your connection URI (replace with your actual DB credentials)
export DATABASE_URL="postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres"

# Create timestamped backup file
export BACKUP_DATE=$(date +%Y%m%d_%H%M%S)
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="friday_backup_${BACKUP_DATE}.dump"
```

### Table-Specific Backup (Memories and Reminders Only)
If you only need to snapshot user memories and scheduled reminders:

```bash
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --table=public.memories \
  --table=public.reminders \
  --table=public.user_profiles \
  --file="friday_core_data_${BACKUP_DATE}.dump"
```

### Plaintext SQL Backup (for easy inspection)
```bash
pg_dump "$DATABASE_URL" \
  --format=plain \
  --no-owner \
  --no-privileges \
  --file="friday_backup_${BACKUP_DATE}.sql"
```

---

## 4. Disaster Recovery & Restore Procedure

### Restoring to a Fresh or Existing Database

1. **Verify Extensions First**:
   Connect via `psql` to ensure required extensions (`vector` and `uuid-ossp`) are installed:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   ```

2. **Restore from Compressed Archive (`.dump`)**:
   ```bash
   pg_restore \
     --dbname="$DATABASE_URL" \
     --clean \
     --if-exists \
     --no-owner \
     --no-privileges \
     "friday_backup_${BACKUP_DATE}.dump"
   ```

3. **Restore from Plaintext SQL (`.sql`)**:
   ```bash
   psql "$DATABASE_URL" -f "friday_backup_${BACKUP_DATE}.sql"
   ```

---

## 5. Post-Restore Verification Checklist

After restoring, run the following queries in the Supabase SQL editor or via `psql` to verify database health:

```sql
-- 1. Check table record counts
SELECT 'memories' AS table_name, count(*) AS total_rows FROM memories
UNION ALL
SELECT 'reminders', count(*) FROM reminders
UNION ALL
SELECT 'user_profiles', count(*) FROM user_profiles
UNION ALL
SELECT 'conversations', count(*) FROM conversations
UNION ALL
SELECT 'messages', count(*) FROM messages;

-- 2. Verify vector index integrity
SELECT indexrelid::regclass, indisvalid
FROM pg_index
WHERE indexrelid = 'idx_memories_embedding'::regclass;

-- 3. Test semantic vector search RPC
SELECT id, content, similarity
FROM match_memories(
  (SELECT embedding FROM memories WHERE embedding IS NOT NULL LIMIT 1),
  0.1,
  5,
  (SELECT user_id FROM memories LIMIT 1)
);

-- 4. Verify RLS is active
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public';
```

---

## 6. Pre-Migration Safety Checklist

Before executing any script that alters memory embeddings or database structure:
1. Run a manual `pg_dump` snapshot as shown above.
2. Store the `.dump` file in secure off-instance storage.
3. Verify that Railway environment variables (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) are set to the target database.
4. Execute migrations in order: `001` -> `002` -> `003` -> `004` -> `005`.
