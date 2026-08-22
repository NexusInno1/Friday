import type { Context } from "grammy";
import { env } from "../../config/env.js";

export async function handleStart(ctx: Context): Promise<void> {
  const { USER_NAME } = env();

  const welcomeMessage = `👋 **Online and ready, ${USER_NAME}.**

I am **FRIDAY**, your personal AI assistant.

Here is what I can do for you:
• **🧠 Long-Term Memory**: I remember your preferences, project details, and notes.
• **🔍 Web Search & Research**: Live factual lookups powered by Tavily AI Search.
• **⏰ Smart Reminders**: Natural language reminder scheduling and minute-by-minute alerts.
• **📅 Daily Briefing**: Morning briefings with your agenda and reminders.

### Quick Commands:
• \`/briefing [HH:MM]\` — View or set morning briefing delivery time
• \`/reminders\` — View and manage active reminders
• \`/remember <fact>\` — Save a personal note or preference
• \`/search <query>\` — Perform instant live web search
• \`/clear\` — Reset active conversation context
• \`/status\` — View system telemetry and health
• \`/help\` — Detailed commands guide

Or simply type any message or question, Boss!`;

  await ctx.reply(welcomeMessage, { parse_mode: "Markdown" });
}
