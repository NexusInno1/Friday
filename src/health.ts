import express from "express";
import { env } from "./config/env.js";

/**
 * Starts a lightweight HTTP server for Railway / cloud health checks.
 * Returns 200 OK on GET /health.
 */
export function startHealthServer(): express.Express {
  const app = express();
  const { HEALTH_PORT } = env();

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "healthy",
      service: "friday-ai-assistant",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  app.get("/", (_req, res) => {
    res.status(200).send("FRIDAY AI Assistant is running.");
  });

  app.listen(HEALTH_PORT, () => {
    console.log(`🩺 Health check server listening on port ${HEALTH_PORT}`);
  });

  return app;
}
