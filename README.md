# 🤖 FRIDAY — Personalized Telegram AI Assistant

[![CI](https://github.com/NexusInno1/Friday/actions/workflows/ci.yml/badge.svg)](https://github.com/NexusInno1/Friday/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**FRIDAY** is an intelligent, personalized Telegram-based AI assistant inspired by Marvel's FRIDAY. Built with **TypeScript / Node.js**, powered by **Google Gemini 2.5 Flash** via the **Vercel AI SDK**, backed by **Supabase (pgvector)**, and equipped with **Tavily AI Web Search**, tiered multi-provider outage failover (**Groq** & **OpenAI**), and automated **minute-by-minute reminders & daily morning briefings**.

---

## ✨ Features

- 🧠 **Long-Term Semantic Memory**: Stores facts, preferences, and project notes using **pgvector** embeddings (`text-embedding-004`) with cosine similarity recall.
- 🔍 **Live Web Search & Research**: Real-time factual queries, news summaries, and URL extractions powered by **Tavily AI Search API**.
- ⏰ **Smart Reminders & Scheduler**: Natural language reminder scheduling (`/remind`), minute-by-minute alert notifications, and interactive inline **Snooze / Cancel** buttons.
- ☀️ **Proactive Daily Briefing**: Timezone-aware morning briefing sent straight to your Telegram at your configured time.
- 🛡️ **Tiered Model Outage Failover**: Zero-downtime resilience cascading from Google Gemini 2.5 Flash ➔ Groq (`llama-3.3-70b-versatile`) ➔ OpenAI (`gpt-4o`).
- 🔒 **Single-Owner Whitelist Security**: Strict Telegram User ID verification drops unauthorized messages silently.
- ⚡ **Dual-Mode Startup**: Long Polling mode for zero-setup local dev; Webhook mode ready for cloud production.
- 🐳 **Docker & 1-Click Railway Deployment**: Multi-stage `Dockerfile` and `docker-compose.yml` with HTTP health check probe ready for 24/7 hosting.

---

## 🛠️ Tech Stack

- **Runtime**: Node.js 22+ (TypeScript ESM, strict mode)
- **Telegram Framework**: [grammY](https://grammy.dev)
- **AI Engine**: [Vercel AI SDK](https://sdk.vercel.ai) (`ai`, `@ai-sdk/google`, `@ai-sdk/openai`)
- **Primary LLM**: Google Gemini 2.5 Flash (with Groq and OpenAI automated tiered fallbacks)
- **Vector Database**: [Supabase](https://supabase.com) (PostgreSQL + `pgvector` + HNSW indexing)
- **Web Search**: [Tavily AI Search API](https://tavily.com)
- **Scheduler**: [Croner](https://github.com/Hexagon/croner)
- **Configuration**: Zod validation with fail-fast startup

---

## 🚀 Quick Start (Local Development)

### 1. Prerequisites
- [Node.js 22+](https://nodejs.org)
- A Telegram Bot Token from [@BotFather](https://t.me/BotFather)
- Your Telegram User ID from [@userinfobot](https://t.me/userinfobot)
- A free [Google AI Studio API Key](https://aistudio.google.com/app/apikey)
- A free [Tavily Search API Key](https://tavily.com)
- A free [Supabase Project](https://supabase.com)

### 2. Clone & Install
```bash
git clone https://github.com/NexusInno1/Friday.git
cd friday
npm install
```

### 3. Initialize Database
Follow the instructions in [`supabase/README.md`](./supabase/README.md) to run `supabase/schema.sql` in your Supabase SQL Editor.

### 4. Configure Environment
```bash
cp .env.example .env
```
Fill in your credentials in `.env`:
```env
TELEGRAM_BOT_TOKEN="your-bot-token-from-botfather"
TELEGRAM_ALLOWED_USER_ID="your-numeric-user-id"
GEMINI_API_KEY="your-gemini-api-key"
GEMINI_MODEL="gemini-3.6-flash"
TAVILY_API_KEY="your-tavily-api-key"
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
USER_TIMEZONE="Asia/Kolkata"
USER_NAME="Boss"
```

### 5. Run Locally
```bash
# Start with hot-reloading
npm run dev

# Or build and start production bundle
npm run build
npm run start
```
Open Telegram, message your bot `/start`, and FRIDAY is live!

---

## 📱 Telegram Commands

| Command | Description |
| :--- | :--- |
| `/start` | Initialize FRIDAY and view system overview |
| `/briefing [HH:MM]` | View or customize daily morning briefing time |
| `/reminders` | View active reminders with interactive Snooze/Cancel buttons |
| `/remember <fact>` | Explicitly save a memory or preference |
| `/memories [query]` | View and manage stored long-term memories with delete buttons |
| `/search <query>` | Instant web search with cited sources |
| `/status` | View system telemetry, uptime, memory count, fallback readiness, and health |
| `/sessions` | View, manage, and switch between conversation threads |
| `/history [query]` | Search past conversations, transcripts, and decisions |
| `/clear` | Archive current session and start a fresh conversation thread |
| `/help` | Detailed guide with examples |

---

## 🐳 Running with Docker & Docker Compose

FRIDAY is fully containerized with a production-hardened, multi-stage `Dockerfile` and `docker-compose.yml`.

### Option A: Using Docker Compose (Recommended)

1. Ensure `.env` is created and populated with your API keys:
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

2. Start FRIDAY in detached mode:
   ```bash
   docker compose up -d --build
   ```

3. Inspect live logs:
   ```bash
   docker compose logs -f
   ```

4. Check health status:
   ```bash
   curl http://localhost:8080/health
   # For deep database readiness check:
   curl http://localhost:8080/health/ready
   ```

5. Stop FRIDAY:
   ```bash
   docker compose down
   ```

### Option B: Using Standalone Docker CLI

1. Build the Docker image:
   ```bash
   docker build -t friday-ai-assistant .
   ```

2. Run the container:
   ```bash
   docker run -d \
     --name friday \
     --restart unless-stopped \
     --env-file .env \
     -p 8080:8080 \
     friday-ai-assistant
   ```

---

## ☁️ Deploying to Railway (24/7 Hosting)

1. Push your code to a **GitHub repository**.
2. Go to [railway.com](https://railway.com) and click **"New Project" -> "Deploy from GitHub repo"**.
3. Select your repository.
4. Add all environment variables from `.env.example` in Railway under **Variables**.
5. Railway will automatically detect the `Dockerfile` and `railway.json`, run the health check, and keep FRIDAY running 24/7!

---

## 🧪 Verification & Typechecking

```bash
# Run TypeScript type check
npm run typecheck

# Run production build
npm run build
```

---

## 📄 License
MIT License. Created with ❤️ for personal productivity.
