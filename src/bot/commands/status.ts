import type { Context } from "grammy";
import { env } from "../../config/env.js";
import { getSupabaseClient } from "../../db/supabase.js";
import { getCurrentBriefingTime } from "../../services/scheduler.service.js";

export async function handleStatus(ctx: Context): Promise<void> {
  const { DEFAULT_LLM_PROVIDER, USER_TIMEZONE, USER_NAME, NODE_ENV } = env();
  const db = getSupabaseClient();

  // Fetch memory count
  const { count: memoryCount } = await db
    .from("memories")
    .select("*", { count: "exact", head: true });

  // Fetch active reminder count
  const { count: reminderCount } = await db
    .from("reminders")
    .select("*", { count: "exact", head: true })
    .eq("is_completed", false)
    .eq("is_cancelled", false);

  const uptimeSeconds = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);

  const modelLabel = DEFAULT_LLM_PROVIDER === "openai" ? "gpt-4o" : "gemini-2.5-flash";
  const briefingTime = getCurrentBriefingTime();

  const statusText = `📊 **FRIDAY Telemetry & Status**

• **Status**: 🟢 All Systems Operational
• **AI Provider**: \`${DEFAULT_LLM_PROVIDER}\` (${modelLabel})
• **Environment**: \`${NODE_ENV}\`
• **User**: ${USER_NAME}
• **Timezone**: \`${USER_TIMEZONE}\`
• **Daily Briefing**: \`${briefingTime}\` (${USER_TIMEZONE})
• **Uptime**: \`${hours}h ${minutes}m\`
• **Stored Memories**: \`${memoryCount ?? 0}\`
• **Active Reminders**: \`${reminderCount ?? 0}\`
• **Node.js**: \`${process.version}\``;

  await ctx.reply(statusText, { parse_mode: "Markdown" });
}
