import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { ModelStore } from "../src/inspection/store.js";
import { createMcpServer } from "../src/server/mcp.js";

const cubePath = fileURLToPath(new URL("./fixtures/cube.3mf", import.meta.url));
const openClients: Client[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

const connect = async () => {
  const store = new ModelStore({ allowLocalPaths: true });
  const server = createMcpServer(store);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openClients.push(client);
  return client;
};

describe("MCP protocol", () => {
  it("advertises semantic 3MF tools and queries a loaded model", async () => {
    const client = await connect();
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "load_model",
        "inspect_model",
        "check_compliance",
        "list_objects",
        "inspect_object",
        "list_build_items",
        "validate_model",
        "inspect_slices",
        "inspect_beam_lattices",
        "review_model",
        "open_model_viewer",
        "control_model_viewer",
        "get_viewer_session",
        "get_viewer_result",
        "close_model_viewer",
      ]),
    );

    const loaded = await client.callTool({
      name: "load_model",
      arguments: { path: cubePath },
    });
    expect(loaded.isError).not.toBe(true);
    const modelId = (loaded.structuredContent as any).modelId as string;

    const summary = await client.callTool({
      name: "inspect_model",
      arguments: { model_id: modelId },
    });
    expect(summary.isError).not.toBe(true);
    expect((summary.structuredContent as any).counts.triangles).toBe(12);

    const review = await client.callTool({
      name: "review_model",
      arguments: { model_id: modelId, include_visuals: false },
    });
    expect(review.isError).not.toBe(true);
    expect(review.structuredContent).toMatchObject({
      modelId,
      status: "passed",
      findingCount: 0,
      objects: { total: 2 },
      buildItems: { total: 1 },
      visuals: { requested: false, completed: false },
    });

    const objects = await client.callTool({
      name: "list_objects",
      arguments: { model_id: modelId, offset: 0, limit: 1 },
    });
    expect(objects.isError).not.toBe(true);
    expect((objects.structuredContent as any).objects).toMatchObject({
      total: 2,
      offset: 0,
      limit: 1,
      nextOffset: 1,
    });
    expect((objects.structuredContent as any).objects.items).toHaveLength(1);

    const viewer = await client.callTool({
      name: "open_model_viewer",
      arguments: { model_id: modelId, preset: "isometric" },
    });
    expect(viewer.isError).not.toBe(true);
    const viewerSession = viewer.structuredContent as any;
    expect(viewerSession.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect((await fetch(viewerSession.url)).status).toBe(200);

    const capturePromise = client.callTool({
      name: "control_model_viewer",
      arguments: {
        viewer_session_id: viewerSession.viewerSessionId,
        command: "capture.png",
        arguments: {},
        wait_ms: 2_000,
      },
    });
    let captureCommand: any;
    for (let attempt = 0; attempt < 10 && !captureCommand; attempt += 1) {
      const pending = await fetch(new URL("commands", viewerSession.url)).then((response) =>
        response.json(),
      );
      captureCommand = pending.commands?.[0];
      if (!captureCommand) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(captureCommand.command).toBe("capture.png");
    const png = Buffer.from("fake-png");
    await fetch(new URL(`captures/${captureCommand.id}`, viewerSession.url), {
      method: "PUT",
      body: png,
    });
    await fetch(new URL(`results/${captureCommand.id}`, viewerSession.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, result: { captureUrl: "local" } }),
    });
    const captured = await capturePromise;
    expect(captured.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image",
          mimeType: "image/png",
          data: png.toString("base64"),
        }),
      ]),
    );

    const closedViewer = await client.callTool({
      name: "close_model_viewer",
      arguments: { viewer_session_id: viewerSession.viewerSessionId },
    });
    expect(closedViewer.structuredContent).toMatchObject({ closed: true });

    const compliance = await client.callTool({
      name: "check_compliance",
      arguments: {
        base64_data: Buffer.from("not a 3mf").toString("base64"),
        file_name: "invalid.3mf",
      },
    });
    expect(compliance.isError).not.toBe(true);
    expect(compliance.structuredContent).toMatchObject({
      parseable: false,
      validation: { compliant: false, preflightPassed: false },
    });

    for (const request of [
      { name: "list_models", arguments: {} },
      { name: "inspect_object", arguments: { model_id: modelId, resource_id: 1 } },
      { name: "list_build_items", arguments: { model_id: modelId } },
      { name: "validate_model", arguments: { model_id: modelId } },
      { name: "inspect_metadata", arguments: { model_id: modelId } },
      { name: "inspect_materials", arguments: { model_id: modelId } },
      { name: "inspect_package", arguments: { model_id: modelId } },
      { name: "inspect_slices", arguments: { model_id: modelId } },
      { name: "inspect_beam_lattices", arguments: { model_id: modelId } },
    ]) {
      const result = await client.callTool(request);
      expect(result.isError, request.name).not.toBe(true);
    }
  });
});
