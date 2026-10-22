import express from "express";
import { env } from "./config/env.js";
import { getDataStore } from "./db/datastore-provider.js";
import type { DataStore } from "./db/datastore.js";

/**
 * Creates the Express app with liveness and readiness endpoints.
 * @param store Optional DataStore instance for dependency injection in tests.
 */
export function createHealthApp(store?: DataStore): express.Express {
  const app = express();
  app.use(express.json());

  // Fast liveness probe (200 OK)
  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "healthy",
      service: "friday-ai-assistant",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // Deep readiness probe verifying database connectivity
  app.get("/health/ready", async (_req, res) => {
    try {
      const activeStore = store ?? getDataStore();
      await activeStore.getMemoryCount();
      res.status(200).json({
        status: "ready",
        service: "friday-ai-assistant",
        database: "connected",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
    } catch (err) {
      console.error("[health] Database readiness check failed:", err);
      res.status(503).json({
        status: "unhealthy",
        service: "friday-ai-assistant",
        database: "disconnected",
        error: "Database check failed",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
    }
  });

  app.get("/", (_req, res) => {
    res.status(200).send("FRIDAY AI Assistant is running.");
  });

  return app;
}

/**
 * Starts the HTTP server for Railway / cloud health checks.
 */
export function startHealthServer(options?: { store?: DataStore; port?: number }): express.Express {
  const app = createHealthApp(options?.store);
  const port = options?.port ?? env().HEALTH_PORT;

  app.listen(port, () => {
    console.log(`🩺 Health check server listening on port ${port}`);
  });

  return app;
}
