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
  app.disable("x-powered-by");

  // OWASP Recommended Security Headers
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    next();
  });

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

  // Global boundary error handler for malformed request payloads
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && "status" in err && (err as any).status === 400) {
      res.status(400).json({
        error: {
          code: "MALFORMED_JSON",
          message: "Request body contains invalid JSON.",
        },
      });
      return;
    }
    next(err);
  });

  return app;
}

/**
 * Starts the HTTP server for Railway / cloud health checks.
 */
export function startHealthServer(options?: { store?: DataStore; port?: number }): express.Express {
  const app = createHealthApp(options?.store);
  const port = options?.port ?? env().HEALTH_PORT;

  const server = app.listen(port, () => {
    console.log(`🩺 Health check server listening on port ${port}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `⚠️ Port ${port} is already in use by another application. Please configure HEALTH_PORT in .env (e.g., HEALTH_PORT=8081).`
      );
    } else {
      console.error("Health server error:", err);
    }
  });

  return app;
}
