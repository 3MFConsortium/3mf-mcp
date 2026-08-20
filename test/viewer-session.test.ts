import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ModelStore } from "../src/inspection/store.js";
import { ViewerSessionManager } from "../src/viewer/sessionManager.js";

const cubePath = fileURLToPath(new URL("./fixtures/cube.3mf", import.meta.url));

describe("ViewerSessionManager", () => {
  it("serves a loaded model and relays viewer commands and captures", async () => {
    const store = new ModelStore({ allowLocalPaths: true });
    const model = await store.loadPath(cubePath);
    const manager = new ViewerSessionManager(store);
    const session = await manager.open(model.id, { viewerUrl: "https://3mfviewer.com" });
    expect(session.mode).toBe("url");

    const page = await fetch(session.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ThreeMFViewerEmbed.create");

    await fetch(new URL("status", session.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        progress: { stage: "building-meshes", triangles: 12, totalTriangles: 24 },
      }),
    });
    expect(manager.status(session.viewerSessionId).loadProgress).toEqual({
      stage: "building-meshes",
      triangles: 12,
      totalTriangles: 24,
    });

    const modelResponse = await fetch(new URL("model", session.url));
    expect(modelResponse.headers.get("content-type")).toBe("model/3mf");
    expect((await modelResponse.arrayBuffer()).byteLength).toBe(model.report.file.byteLength);

    const pending = await manager.command(
      session.viewerSessionId,
      "camera.setPreset",
      { preset: "top" },
      0,
    );
    expect(pending).toMatchObject({ pending: true });
    const commandId = (pending as { commandId: string }).commandId;

    const commands = await fetch(new URL("commands", session.url)).then((response) => response.json());
    expect(commands.commands[0]).toMatchObject({
      id: commandId,
      command: "camera.setPreset",
      arguments: { preset: "top" },
    });
    await fetch(new URL(`results/${commandId}`, session.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, result: { position: [0, 10, 0] } }),
    });
    expect(manager.result(session.viewerSessionId, commandId)).toMatchObject({
      ok: true,
      result: { position: [0, 10, 0] },
    });

    const capture = Buffer.from("png-data");
    await fetch(new URL(`captures/${commandId}`, session.url), { method: "PUT", body: capture });
    const downloaded = await fetch(new URL(`captures/${commandId}`, session.url));
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(capture);
    expect(manager.close(session.viewerSessionId)).toBe(true);
  });
});
