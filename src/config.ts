const integerEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

export interface AppConfig {
  transport: "stdio" | "http";
  port: number;
  host: string;
  maxFileBytes: number;
  maxModels: number;
  ttlMs: number;
  allowLocalPaths: boolean;
  viewerMode: "url" | "system" | "headless";
  chromePath?: string;
}

export const readConfig = (argv = process.argv.slice(2)): AppConfig => {
  const transport =
    argv.includes("--http") || process.env.MCP_TRANSPORT === "http" ? "http" : "stdio";
  const configuredViewerMode = process.env.MCP_VIEWER_MODE?.trim().toLowerCase();
  const viewerMode = ["url", "system", "headless"].includes(configuredViewerMode || "")
    ? (configuredViewerMode as AppConfig["viewerMode"])
    : "url";
  return {
    transport,
    port: integerEnv("PORT", 3000),
    host: process.env.HOST?.trim() || "127.0.0.1",
    maxFileBytes: integerEnv("MCP_MAX_FILE_BYTES", 100 * 1024 * 1024),
    maxModels: integerEnv("MCP_MAX_MODELS", 4),
    ttlMs: integerEnv("MCP_MODEL_TTL_MS", 30 * 60 * 1000),
    allowLocalPaths:
      transport === "stdio" || process.env.MCP_ALLOW_LOCAL_PATHS?.toLowerCase() === "true",
    viewerMode,
    ...(process.env.MCP_CHROME_PATH?.trim()
      ? { chromePath: process.env.MCP_CHROME_PATH.trim() }
      : {}),
  };
};
