import type { Context } from "grammy";
import { updateBriefingTime, getCurrentBriefingTime } from "../../services/scheduler.service.js";
import { env } from "../../config/env.js";

export async function handleBriefing(ctx: Context): Promise<void> {
  const text = ctx.match;
  const { USER_TIMEZONE } = env();

  // If no argument provided, show current briefing time
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    const current = getCurrentBriefingTime();
    await ctx.reply(
      `📅 **Daily Morning Briefing Status**\n\n• **Current Time**: \`${current}\` (${USER_TIMEZONE})\n\n💡 To change it, type:\n\`/briefing HH:MM\` or \`/briefing 8:30am\` or simply tell me in chat: *"Change my daily briefing to 8:30 AM"*`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  const rawTime = text.trim();

  try {
    const result = await updateBriefingTime(rawTime);
    await ctx
      .reply(
        `✓ **Daily Briefing Updated!**\n\nI will now deliver your morning briefing every day at \`${result.time}\` (${USER_TIMEZONE}), Boss.`,
        { parse_mode: "Markdown" }
      )
      .catch(async () => {
        await ctx.reply(
          `✓ Daily Briefing Updated!\n\nI will now deliver your morning briefing every day at ${result.time} (${USER_TIMEZONE}), Boss.`
        );
      });
  } catch (error) {
    await ctx.reply(
      `⚠️ **Invalid Time Format**: ${error instanceof Error ? error.message : "Please use HH:MM (e.g. /briefing 08:30 or /briefing 8:30am)"}`,
      { parse_mode: "Markdown" }
    ).catch(async () => {
      await ctx.reply(
        `⚠️ Invalid Time Format: ${error instanceof Error ? error.message : "Please use HH:MM (e.g. /briefing 08:30 or /briefing 8:30am)"}`
      );
    });
  }
}
