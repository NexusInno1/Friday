import { describe, it, expect } from "vitest";
import { createHealthApp } from "./health.js";
import { InMemoryDataStore } from "./db/in-memory-datastore.js";
import type { Express } from "express";

function invokeApp(app: Express, method: string, url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    let responseBody: any = null;

    const req = {
      method,
      url,
      headers: {},
      get(header: string) {
        return (this.headers as Record<string, string>)[header.toLowerCase()];
      },
      header(header: string) {
        return this.get(header);
      },
    };

    const res = {
      statusCode: 200,
      status(code: number) {
        statusCode = code;
        this.statusCode = code;
        return this;
      },
      json(body: any) {
        responseBody = body;
        resolve({ status: statusCode, body: responseBody });
        return this;
      },
      send(text: string) {
        responseBody = text;
        resolve({ status: statusCode, body: responseBody });
        return this;
      },
      setHeader() {
        return this;
      },
      end() {
        resolve({ status: statusCode, body: responseBody });
        return this;
      },
    };

    try {
      (app as any).handle(req as any, res as any, (err: any) => {
        if (err) reject(err);
        else resolve({ status: statusCode, body: responseBody });
      });
    } catch (err) {
      reject(err);
    }
  });
}

describe("Health Server Endpoints", () => {
  it("GET /health returns 200 and healthy status (liveness)", async () => {
    const store = new InMemoryDataStore();
    const app = createHealthApp(store);

    const { status, body } = await invokeApp(app, "GET", "/health");
    expect(status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.service).toBe("friday-ai-assistant");
    expect(typeof body.uptime).toBe("number");
  });

  it("GET /health/ready returns 200 and database connected when store is healthy", async () => {
    const store = new InMemoryDataStore();
    const app = createHealthApp(store);

    const { status, body } = await invokeApp(app, "GET", "/health/ready");
    expect(status).toBe(200);
    expect(body.status).toBe("ready");
    expect(body.database).toBe("connected");
  });

  it("GET /health/ready returns 503 and database disconnected when store query throws", async () => {
    const store = new InMemoryDataStore();
    // Simulate broken database connection
    store.getMemoryCount = async () => {
      throw new Error("Connection pool timeout");
    };

    const app = createHealthApp(store);

    const { status, body } = await invokeApp(app, "GET", "/health/ready");
    expect(status).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect(body.database).toBe("disconnected");
    expect(body.error).toBe("Database check failed");
    expect(body.error).not.toContain("Connection pool timeout");
  });

  it("GET / returns 200 with service description", async () => {
    const app = createHealthApp(new InMemoryDataStore());

    const { status, body } = await invokeApp(app, "GET", "/");
    expect(status).toBe(200);
    expect(body).toContain("FRIDAY AI Assistant is running");
  });
});
