import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import { ModelStore } from "../inspection/store.js";
import { createMcpServer } from "./mcp.js";

export const runHttpServer = async (config: AppConfig): Promise<Server> => {
  const app = express();
  const bodyLimit = Math.ceil((config.maxFileBytes * 4) / 3) + 1024 * 1024;
  app.use(express.json({ limit: bodyLimit }));

  const store = new ModelStore(config);
  const maxSessions = 100;
  const sessionTtlMs = 30 * 60 * 1000;
  const transports = new Map<
    string,
    { transport: StreamableHTTPServerTransport; lastSeen: number }
  >();

  const pruneSessions = () => {
    const cutoff = Date.now() - sessionTtlMs;
    for (const [id, session] of transports) {
      if (session.lastSeen <= cutoff) {
        transports.delete(id);
        void session.transport.close();
      }
    }
  };
  const cleanupTimer = setInterval(pruneSessions, 60_000);
  cleanupTimer.unref();

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "3mf-mcp" });
  });

  app.post("/mcp", async (request: Request, response: Response) => {
    try {
      const sessionId = request.headers["mcp-session-id"];
      pruneSessions();
      const session = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
      let transport = session?.transport;
      if (session) session.lastSeen = Date.now();

      if (!transport && isInitializeRequest(request.body)) {
        if (transports.size >= maxSessions) {
          response.status(503).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Maximum MCP session count reached." },
            id: null,
          });
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id) => {
            transports.set(id, { transport: transport!, lastSeen: Date.now() });
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) transports.delete(transport.sessionId);
        };
        // SDK 1.x's HTTP transport and generic transport declarations disagree
        // under exactOptionalPropertyTypes even though the runtime contract matches.
        await createMcpServer(store, {
          viewerModeByDefault: config.viewerMode,
          ...(config.chromePath ? { chromePath: config.chromePath } : {}),
        }).connect(transport as any);
      }

      if (!transport) {
        response.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Missing or invalid MCP session." },
          id: null,
        });
        return;
      }
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
          id: null,
        });
      }
    }
  });

  const handleSessionRequest = async (request: Request, response: Response) => {
    const sessionId = request.headers["mcp-session-id"];
    pruneSessions();
    const session = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
    if (!session) {
      response.status(400).send("Missing or invalid MCP session.");
      return;
    }
    session.lastSeen = Date.now();
    await session.transport.handleRequest(request, response);
  };
  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  return new Promise<Server>((resolve, reject) => {
    const listener = app.listen(config.port, config.host, () => {
      const address = listener.address();
      const port = typeof address === "object" && address ? address.port : config.port;
      console.error(`3mf-mcp listening on http://${config.host}:${port}/mcp`);
      resolve(listener);
    });
    listener.once("error", reject);
    listener.once("close", () => {
      clearInterval(cleanupTimer);
      for (const session of transports.values()) void session.transport.close();
      transports.clear();
    });
  });
};
