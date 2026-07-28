import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ModelStore } from "../src/inspection/store.js";

const cubePath = fileURLToPath(new URL("./fixtures/cube.3mf", import.meta.url));

describe("ModelStore", () => {
  it("loads paths only when enabled and evicts old reports", async () => {
    const disabled = new ModelStore({ allowLocalPaths: false });
    await expect(disabled.loadPath(cubePath)).rejects.toThrow("disabled");

    const store = new ModelStore({ allowLocalPaths: true, maxModels: 1 });
    const first = await store.loadPath(cubePath);
    const second = await store.loadPath(cubePath);

    expect(store.list()).toHaveLength(1);
    expect(() => store.get(first.id)).toThrow("Unknown or expired");
    expect(store.get(second.id).report.counts.triangles).toBe(12);
  });

  it("enforces the file size limit before parsing", async () => {
    const bytes = await readFile(cubePath);
    const store = new ModelStore({ maxFileBytes: bytes.byteLength - 1 });
    await expect(store.loadBytes(bytes, "cube.3mf")).rejects.toThrow("configured limit");
  });

  it("rejects malformed base64 before parsing", async () => {
    const store = new ModelStore();
    await expect(store.loadBase64("not base64!", "cube.3mf")).rejects.toThrow("valid, padded base64");
  });

  it("accepts padded base64 exactly at the decoded size limit", async () => {
    const bytes = await readFile(cubePath);
    const store = new ModelStore({ maxFileBytes: bytes.byteLength });
    const model = await store.loadBase64(bytes.toString("base64"), "cube.3mf");

    expect(model.report.file.byteLength).toBe(bytes.byteLength);
  });
});
