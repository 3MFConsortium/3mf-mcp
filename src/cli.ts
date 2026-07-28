#!/usr/bin/env node
import { readConfig } from "./config.js";
import { runHttpServer } from "./server/http.js";
import { runStdioServer } from "./server/stdio.js";

const config = readConfig();

try {
  if (config.transport === "http") {
    await runHttpServer(config);
  } else {
    await runStdioServer(config);
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
