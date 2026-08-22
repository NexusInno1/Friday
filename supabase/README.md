# Supabase Database Setup Guide for FRIDAY

FRIDAY uses **Supabase** (PostgreSQL with `pgvector`) to store:
- Long-term memory facts & semantic vector embeddings
- Active & recurring reminders
- Conversation context history
- Activity & error logs
- User settings & profiles

---

## 1. Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a free account.
2. Click **"New project"**, choose a name (e.g., `friday-assistant`) and set a strong database password.
3. Choose your nearest region (e.g., Singapore, Mumbai, etc.).

---

## 2. Run the Database Migration

1. In your Supabase project dashboard, open the **SQL Editor** from the left navigation.
2. Click **"New query"**.
3. Copy the entire contents of [`supabase/schema.sql`](./schema.sql) and paste it into the editor.
4. Click **"Run"** (or press `Ctrl+Enter`).
5. You should see `Success. No rows returned`.

This will:
- Enable the `vector` and `uuid-ossp` extensions
- Create all 5 required tables (`user_profiles`, `conversations`, `messages`, `memories`, `reminders`, `activity_logs`)
- Create the HNSW index for sub-millisecond semantic search
- Create the `match_memories` PostgreSQL vector similarity function

---

## 3. Retrieve Your API Credentials

1. Go to **Project Settings** (gear icon) -> **API**.
2. Copy the following two values:
   - **Project URL** (`https://xxxxxxxxxxxxxxxx.supabase.co`) -> Set as `SUPABASE_URL` in your `.env`
   - **`service_role` Secret** (Click "Reveal" under Project API keys) -> Set as `SUPABASE_SERVICE_ROLE_KEY` in your `.env`

> ⚠️ **Important**: Never share your `service_role` key or commit it to GitHub. It has administrative bypass rights to your database.
