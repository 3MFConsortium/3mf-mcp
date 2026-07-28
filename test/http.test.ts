import type { Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { runHttpServer } from "../src/server/http.js";

let listener: Server | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
  if (!listener) return;
  await new Promise<void>((resolve, reject) => {
    listener!.close((error) => (error ? reject(error) : resolve()));
  });
  listener = undefined;
});

describe("HTTP transport", () => {
  it("serves the health endpoint", async () => {
    listener = await runHttpServer({
      transport: "http",
      host: "127.0.0.1",
      port: 0,
      maxFileBytes: 1024 * 1024,
      maxModels: 1,
      ttlMs: 60_000,
      allowLocalPaths: false,
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", service: "3mf-mcp" });
  });

  it("completes an MCP initialize, upload, and inspect flow", async () => {
    listener = await runHttpServer({
      transport: "http",
      host: "127.0.0.1",
      port: 0,
      maxFileBytes: 1024 * 1024,
      maxModels: 1,
      ttlMs: 60_000,
      allowLocalPaths: false,
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");

    client = new Client({ name: "http-test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );
    await client.connect(transport);

    const bytes = await readFile(
      fileURLToPath(new URL("./fixtures/cube.3mf", import.meta.url)),
    );
    const loaded = await client.callTool({
      name: "load_model",
      arguments: {
        base64_data: bytes.toString("base64"),
        file_name: "cube.3mf",
      },
    });
    expect(loaded.isError).not.toBe(true);
    const modelId = (loaded.structuredContent as { modelId: string }).modelId;

    const inspected = await client.callTool({
      name: "inspect_model",
      arguments: { model_id: modelId },
    });
    expect(inspected.structuredContent).toMatchObject({
      counts: { triangles: 12 },
      buildBounds: { size: [130, 80, 110] },
    });
  });
});
