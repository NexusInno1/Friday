import type { Context } from "grammy";
import { webSearchTool } from "../../tools/registry.js";

function escapeMarkdownText(text: string): string {
  return text.replace(/([_*[\]`])/g, "\\$1");
}

function cleanTitle(title: string): string {
  return title.replace(/[[\]]/g, "").trim();
}

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

    const safeQuery = escapeMarkdownText(query.trim());
    let response = `🔍 **Search Results for:** _${safeQuery}_\n\n`;

    if (result.answer) {
      response += `**Summary**: ${escapeMarkdownText(result.answer)}\n\n`;
    }

    if (result.results.length > 0) {
      response += `**Sources**:\n`;
      for (const item of result.results) {
        const title = cleanTitle(item.title) || "Source";
        const snippet = escapeMarkdownText(item.snippet);
        response += `• [${title}](${item.url})\n  ${snippet}\n\n`;
      }
    } else {
      response += "No direct results found.";
    }

    await ctx
      .reply(response, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
      })
      .catch(async () => {
        await ctx.reply(response, {
          link_preview_options: { is_disabled: true },
        });
      });
  } catch (error) {
    await ctx.reply(
      `⚠️ Search failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}
