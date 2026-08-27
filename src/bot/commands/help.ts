import type { Context } from "grammy";

export async function handleHelp(ctx: Context): Promise<void> {
  const helpText = `📖 **FRIDAY User Guide & Commands**

### 💬 Conversational Intelligence
Simply send any natural language message:
• *"What are the latest updates on TypeScript 5.8?"* (auto web search)
• *"Remember that my server IP is 192.168.1.100"* (auto memory store)
• *"Remind me tomorrow at 9 AM to review the pull request"* (auto reminder)

### ⚡ Direct Slash Commands
• \`/start\` — Initialize and display status
• \`/briefing [HH:MM]\` — View or customize daily morning briefing time
• \`/reminders\` — List all active reminders with Snooze / Cancel buttons
• \`/remember <note>\` — Explicitly store a memory or fact
• \`/search <query>\` — Instant web search with citations
• \`/clear\` — Clear current conversation context window
• \`/status\` — View model, provider, timezone, and memory stats
• \`/help\` — Display this guide

### 🔒 Security
FRIDAY is locked to your Telegram User ID. Unauthorized messages are dropped silently.`;

  await ctx
    .reply(helpText, { parse_mode: "Markdown" })
    .catch(async () => {
      await ctx.reply(helpText);
    });
}
