import { validateEnv } from "./config/env.js";
import { createBot } from "./bot/bot.js";
import { initScheduler } from "./services/scheduler.service.js";
import { startHealthServer } from "./health.js";
import { webhookCallback } from "grammy";

async function main() {
  console.log("🚀 Initializing FRIDAY AI Assistant...");

  // 1. Validate environment configuration (fail fast)
  const envConfig = validateEnv();

  // 2. Initialize Telegram Bot
  const bot = createBot();

  // 4. Initialize background scheduler (reminders & daily briefing)
  const scheduler = await initScheduler(bot);

  // Graceful shutdown handler
  let isShuttingDown = false;
  const handleShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n🛑 Received ${signal}. Shutting down FRIDAY gracefully...`);
    try {
      scheduler.stop();
      if (!envConfig.WEBHOOK_URL) {
        await bot.stop();
      }
      console.log("👋 FRIDAY shut down safely.");
      process.exit(0);
    } catch (err) {
      console.error("Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void handleShutdown("SIGINT"));
  process.on("SIGTERM", () => void handleShutdown("SIGTERM"));

  // 5. Start health check server
  const healthApp = startHealthServer();

  // 6. Start bot in Webhook or Long Polling mode
  if (envConfig.WEBHOOK_URL) {
    console.log(`🌐 Configuring Webhook mode with URL: ${envConfig.WEBHOOK_URL}`);
    const webhookPath = "/telegram-webhook";

    const webhookSecret = envConfig.TELEGRAM_WEBHOOK_SECRET;
    healthApp.use(
      webhookPath,
      webhookCallback(bot, "express", {
        secretToken: webhookSecret,
      })
    );

    await bot.api.setWebhook(`${envConfig.WEBHOOK_URL}${webhookPath}`, {
      allowed_updates: ["message", "callback_query"],
      secret_token: webhookSecret,
    });

    console.log(`✅ Webhook set to: ${envConfig.WEBHOOK_URL}${webhookPath}`);
  } else {
    console.log("⚡ Starting FRIDAY in Long Polling mode (dev / standalone)...");
    await bot.start({
      allowed_updates: ["message", "callback_query"],
      onStart: (botInfo) => {
        console.log(`✅ FRIDAY (@${botInfo.username}) is live and listening!`);
      },
    });
  }
}

main().catch((err) => {
  console.error("💥 Fatal error during FRIDAY startup:", err);
  process.exit(1);
});
