import type { Context } from "grammy";
import { env } from "../../config/env.js";
import { getDataStore } from "../../db/datastore-provider.js";
import { getCurrentBriefingTime } from "../../services/scheduler.service.js";

export async function handleStatus(ctx: Context): Promise<void> {
  const { DEFAULT_LLM_PROVIDER, USER_TIMEZONE, USER_NAME, NODE_ENV } = env();
  const store = getDataStore();

  const memoryCount = await store.getMemoryCount();
  const reminderCount = await store.getActiveReminderCount();

  const uptimeSeconds = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);

  const modelLabel = DEFAULT_LLM_PROVIDER === "openai" ? "gpt-4o" : "gemini-2.0-flash";
  const briefingTime = getCurrentBriefingTime();

  const statusText = `📊 **FRIDAY Telemetry & Status**

• **Status**: 🟢 All Systems Operational
• **AI Provider**: \`${DEFAULT_LLM_PROVIDER}\` (${modelLabel})
• **Environment**: \`${NODE_ENV}\`
• **User**: ${USER_NAME}
• **Timezone**: \`${USER_TIMEZONE}\`
• **Daily Briefing**: \`${briefingTime}\` (${USER_TIMEZONE})
• **Uptime**: \`${hours}h ${minutes}m\`
• **Stored Memories**: \`${memoryCount}\`
• **Active Reminders**: \`${reminderCount}\`
• **Node.js**: \`${process.version}\``;

  await ctx
    .reply(statusText, { parse_mode: "Markdown" })
    .catch(async () => {
      await ctx.reply(statusText);
    });
}
