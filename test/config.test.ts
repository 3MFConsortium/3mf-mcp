import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("configuration", () => {
  it("uses safe transport defaults", () => {
    expect(readConfig([])).toMatchObject({
      transport: "stdio",
      host: "127.0.0.1",
      port: 3000,
      allowLocalPaths: true,
    });
  });

  it("disables HTTP local paths unless explicitly enabled", () => {
    expect(readConfig(["--http"])).toMatchObject({
      transport: "http",
      allowLocalPaths: false,
    });

    vi.stubEnv("MCP_ALLOW_LOCAL_PATHS", "true");
    expect(readConfig(["--http"]).allowLocalPaths).toBe(true);
  });
});
