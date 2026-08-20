import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AppConfig } from "../config.js";
import { ModelStore } from "../inspection/store.js";
import { createMcpServer } from "./mcp.js";

export const runStdioServer = async (config: AppConfig): Promise<void> => {
  const store = new ModelStore(config);
  const server = createMcpServer(store, {
    viewerModeByDefault: config.viewerMode,
    ...(config.chromePath ? { chromePath: config.chromePath } : {}),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("3mf-mcp running over stdio");
};
