import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("stdio transport", () => {
  it("launches the CLI and inspects a local file", async () => {
    const client = new Client({ name: "stdio-test-client", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: resolve("node_modules/.bin/tsx"),
      args: ["src/cli.ts"],
      cwd: process.cwd(),
      stderr: "pipe",
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === "check_compliance")).toBe(true);

      const loaded = await client.callTool({
        name: "load_model",
        arguments: {
          path: fileURLToPath(new URL("./fixtures/cube.3mf", import.meta.url)),
        },
      });
      expect(loaded.isError).not.toBe(true);
      expect(loaded.structuredContent).toMatchObject({
        summary: { buildBounds: { size: [130, 80, 110] } },
      });
    } finally {
      await client.close();
    }
  }, 20_000);
});
