import type { Context } from "grammy";
import { webSearchTool } from "../../tools/registry.js";

export async function handleSearch(ctx: Context): Promise<void> {
  const query = ctx.match;

  if (!query || typeof query !== "string" || query.trim().length === 0) {
    await ctx.reply(
      "💡 **Usage**: `/search <query>`\n\nExample: `/search Next.js 15 breaking changes`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  await ctx.replyWithChatAction("typing");

  try {
    const result = await webSearchTool.execute(
      { query: query.trim(), max_results: 3 },
      { toolCallId: "direct_search", messages: [] }
    );

    let response = `🔍 **Search Results for:** _${query.trim()}_\n\n`;

    if (result.answer) {
      response += `**Summary**: ${result.answer}\n\n`;
    }

    if (result.results.length > 0) {
      response += `**Sources**:\n`;
      for (const item of result.results) {
        response += `• [${item.title}](${item.url})\n  ${item.snippet}\n\n`;
      }
    } else {
      response += "No direct results found.";
    }

    await ctx.reply(response, {
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    await ctx.reply(
      `⚠️ Search failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}
