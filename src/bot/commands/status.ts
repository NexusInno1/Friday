import type { Context } from "grammy";
import { DEFAULT_GEMINI_MODEL, DEFAULT_GROQ_MODEL, env } from "../../config/env.js";
import { getDataStore } from "../../db/datastore-provider.js";
import { getCurrentBriefingTime } from "../../services/scheduler.service.js";

export async function handleStatus(ctx: Context): Promise<void> {
  const {
    DEFAULT_LLM_PROVIDER,
    GEMINI_MODEL,
    GROQ_MODEL,
    GROQ_API_KEY,
    OPENAI_API_KEY,
    USER_TIMEZONE,
    USER_NAME,
    NODE_ENV,
  } = env();
  const store = getDataStore();

  let dbStatus = "🟢 Connected";
  let overallStatus = "🟢 All Systems Operational";
  let memoryCountStr = "N/A";
  let reminderCountStr = "N/A";

  try {
    const memoryCount = await store.getMemoryCount();
    const reminderCount = await store.getActiveReminderCount();
    memoryCountStr = String(memoryCount);
    reminderCountStr = String(reminderCount);
  } catch (err) {
    dbStatus = `🔴 Disconnected (${err instanceof Error ? err.message : "Error"})`;
    overallStatus = "⚠️ Degraded (Database Unreachable)";
  }

  const uptimeSeconds = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);

  const modelLabel =
    DEFAULT_LLM_PROVIDER === "openai"
      ? "gpt-4o"
      : DEFAULT_LLM_PROVIDER === "groq"
        ? (GROQ_MODEL ?? DEFAULT_GROQ_MODEL)
        : (GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL);
  const briefingTime = getCurrentBriefingTime();

  const groqStatus = GROQ_API_KEY ? "Ready" : "Not Configured";
  const openaiStatus = OPENAI_API_KEY ? "Ready" : "Not Configured";

  const statusText = `📊 **FRIDAY Telemetry & Status**

• **Status**: ${overallStatus}
• **Database**: ${dbStatus}
• **AI Provider**: \`${DEFAULT_LLM_PROVIDER}\` (${modelLabel})
• **Fallbacks**: Groq (${groqStatus}), OpenAI (${openaiStatus})
• **Environment**: \`${NODE_ENV}\`
• **User**: ${USER_NAME}
• **Timezone**: \`${USER_TIMEZONE}\`
• **Daily Briefing**: \`${briefingTime}\` (${USER_TIMEZONE})
• **Uptime**: \`${hours}h ${minutes}m\`
• **Stored Memories**: \`${memoryCountStr}\`
• **Active Reminders**: \`${reminderCountStr}\`
• **Node.js**: \`${process.version}\``;

  await ctx
    .reply(statusText, { parse_mode: "Markdown" })
    .catch(async () => {
      await ctx.reply(statusText);
    });
}
