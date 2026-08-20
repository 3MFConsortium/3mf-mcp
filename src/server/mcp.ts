import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InspectionReport, ObjectSummary, StoredModel } from "../inspection/types.js";
import { ModelStore, summaryView } from "../inspection/store.js";
import { ViewerSessionManager } from "../viewer/sessionManager.js";
import type { ViewerMode } from "../viewer/sessionManager.js";

const success = (value: unknown) => {
  const structuredContent =
    value && typeof value === "object" ? (value as Record<string, unknown>) : { value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
};

const failure = (error: unknown) => ({
  isError: true,
  content: [
    {
      type: "text" as const,
      text: error instanceof Error ? error.message : String(error),
    },
  ],
});

const imageSuccess = (value: Record<string, unknown>, png: Buffer) => ({
  content: [
    { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
    { type: "text" as const, text: JSON.stringify(value, null, 2) },
  ],
  structuredContent: value,
});

interface LabeledImage {
  label: string;
  png: Buffer;
}

const reviewSuccess = (value: Record<string, unknown>, images: LabeledImage[]) => {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: "image/png" }
  > = [{ type: "text", text: JSON.stringify(value, null, 2) }];
  for (const image of images) {
    content.push(
      { type: "text", text: `Review view: ${image.label}` },
      { type: "image", data: image.png.toString("base64"), mimeType: "image/png" },
    );
  }
  return { content, structuredContent: value };
};

const reviewFindings = (report: InspectionReport) => {
  const findings = [
    ...report.validation.findings.map((finding) => ({ source: "preflight", ...finding })),
    ...report.validation.strict.errors.map((diagnostic) => ({
      source: "strict",
      severity: "error" as const,
      ...diagnostic,
    })),
    ...report.validation.strict.warnings.map((diagnostic) => ({
      source: "strict",
      severity: "warning" as const,
      ...diagnostic,
    })),
    ...report.validation.nonStrict.errors.map((diagnostic) => ({
      source: "non-strict",
      severity: "error" as const,
      ...diagnostic,
    })),
    ...report.validation.nonStrict.warnings.map((diagnostic) => ({
      source: "non-strict",
      severity: "warning" as const,
      ...diagnostic,
    })),
  ];
  return {
    total: findings.length,
    errorCount: findings.filter((finding) => finding.severity === "error").length,
    warningCount: findings.filter((finding) => finding.severity === "warning").length,
    items: findings.slice(0, 50),
    omitted: Math.max(0, findings.length - 50),
  };
};

const loadedView = (model: StoredModel) => ({
  modelId: model.id,
  loadedAt: model.loadedAt,
  expiresAt: model.expiresAt,
  summary: summaryView(model.report),
});

const complianceView = (report: InspectionReport) => ({
  file: report.file,
  parseable: true,
  extensions: report.extensions,
  validation: report.validation,
});

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

const page = <T>(items: readonly T[], offset: number, limit: number) => {
  const result = items.slice(offset, offset + limit);
  const nextOffset = offset + result.length;
  return {
    total: items.length,
    offset,
    limit,
    items: result,
    nextOffset: nextOffset < items.length ? nextOffset : null,
  };
};

const paginationSchema = {
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
};

const objectView = (report: InspectionReport, resourceId?: number) =>
  resourceId === undefined
    ? report.objects
    : report.objects.filter((object) => object.resourceId === resourceId);

const objectSummaryView = (object: ObjectSummary) => ({
  resourceId: object.resourceId,
  uniqueResourceId: object.uniqueResourceId,
  uuid: object.uuid,
  name: object.name,
  partNumber: object.partNumber,
  type: object.type,
  mesh: object.mesh,
  componentCount: object.components.length,
});

export interface McpServerOptions {
  viewerModeByDefault?: ViewerMode;
  chromePath?: string;
  /** @deprecated Use viewerModeByDefault. */
  openBrowserByDefault?: boolean;
}

export const createMcpServer = (
  store: ModelStore,
  options: McpServerOptions = {},
): McpServer => {
  const viewers = new ViewerSessionManager(store);
  const server = new McpServer({
    name: "3mf-mcp",
    version: "0.1.0-alpha.1",
  });

  server.registerTool(
    "load_model",
    {
      title: "Load 3MF model",
      description:
        "Load and inspect a 3MF file. Provide exactly one of path or base64_data. Local paths are enabled by default only with the stdio transport.",
      inputSchema: {
        path: z.string().min(1).optional(),
        base64_data: z.string().min(1).optional(),
        file_name: z.string().min(1).max(255).optional(),
      },
    },
    async ({ path, base64_data: base64Data, file_name: fileName }) => {
      try {
        if (Boolean(path) === Boolean(base64Data)) {
          throw new Error("Provide exactly one of path or base64_data.");
        }
        const model = path
          ? await store.loadPath(path)
          : await store.loadBase64(base64Data!, fileName ?? "model.3mf");
        return success(loadedView(model));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_models",
    {
      title: "List loaded 3MF models",
      description: "List active model IDs and their compact summaries.",
      inputSchema: {},
    },
    async () => success({ models: store.list().map(loadedView) }),
  );

  server.registerTool(
    "unload_model",
    {
      title: "Unload 3MF model",
      description: "Remove a model report from this MCP server's temporary memory.",
      inputSchema: { model_id: z.string().uuid() },
    },
    async ({ model_id: modelId }) =>
      success({ modelId, unloaded: store.remove(modelId) }),
  );

  server.registerTool(
    "inspect_model",
    {
      title: "Inspect 3MF model",
      description:
        "Return a compact overall report: counts, dimensions, units, extensions, and compliance status.",
      inputSchema: { model_id: z.string().uuid() },
    },
    async ({ model_id: modelId }) => {
      try {
        return success(summaryView(store.get(modelId).report));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "check_compliance",
    {
      title: "Check 3MF compliance",
      description:
        "Run lib3mf strict/non-strict validation and preflight checks. Provide exactly one of model_id, path, or base64_data. Unlike load_model, this returns diagnostics for unreadable files.",
      inputSchema: {
        model_id: z.string().uuid().optional(),
        path: z.string().min(1).optional(),
        base64_data: z.string().min(1).optional(),
        file_name: z.string().min(1).max(255).optional(),
      },
    },
    async ({
      model_id: modelId,
      path,
      base64_data: base64Data,
      file_name: fileName,
    }) => {
      try {
        if ([modelId, path, base64Data].filter(Boolean).length !== 1) {
          throw new Error("Provide exactly one of model_id, path, or base64_data.");
        }
        if (modelId) return success(complianceView(store.get(modelId).report));
        return success(
          path
            ? await store.checkPath(path)
            : await store.checkBase64(base64Data!, fileName ?? "model.3mf"),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_objects",
    {
      title: "List objects and components",
      description: "List paginated object summaries. Use inspect_object for component references.",
      inputSchema: {
        model_id: z.string().uuid(),
        resource_id: z.number().int().nonnegative().optional(),
        ...paginationSchema,
      },
    },
    async ({ model_id: modelId, resource_id: resourceId, offset, limit }) => {
      try {
        const report = store.get(modelId).report;
        const objects = objectView(report, resourceId);
        return success({ objects: page(objects.map(objectSummaryView), offset, limit) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "inspect_object",
    {
      title: "Inspect one 3MF object",
      description:
        "Return one object resource and a separately paginated component-reference list.",
      inputSchema: {
        model_id: z.string().uuid(),
        resource_id: z.number().int().nonnegative(),
        ...paginationSchema,
      },
    },
    async ({ model_id: modelId, resource_id: resourceId, offset, limit }) => {
      try {
        const object = store
          .get(modelId)
          .report.objects.find((candidate) => candidate.resourceId === resourceId);
        if (!object) throw new Error(`Unknown object resource id: ${resourceId}`);
        return success({
          object: {
            ...objectSummaryView(object),
            components: page(object.components, offset, limit),
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_build_items",
    {
      title: "List 3MF build items",
      description: "Return the paginated build-item list and transforms.",
      inputSchema: { model_id: z.string().uuid(), ...paginationSchema },
    },
    async ({ model_id: modelId, offset, limit }) => {
      try {
        return success({
          buildItems: page(store.get(modelId).report.buildItems, offset, limit),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "validate_model",
    {
      title: "Validate 3MF model",
      description:
        "Return stored strict/non-strict diagnostics and preflight findings. Use check_compliance to validate an unreadable file directly.",
      inputSchema: { model_id: z.string().uuid() },
    },
    async ({ model_id: modelId }) => {
      try {
        return success(store.get(modelId).report.validation);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "inspect_metadata",
    {
      title: "Inspect 3MF metadata",
      description: "Return model-level and build-item metadata.",
      inputSchema: {
        model_id: z.string().uuid(),
        scope: z.enum(["model", "build_item"]).default("model"),
        build_item_index: z.number().int().nonnegative().optional(),
        ...paginationSchema,
      },
    },
    async ({ model_id: modelId, scope, build_item_index: buildItemIndex, offset, limit }) => {
      try {
        const report = store.get(modelId).report;
        if (scope === "model") {
          return success({ scope, metadata: page(report.metadata, offset, limit) });
        }
        if (buildItemIndex === undefined) {
          throw new Error("build_item_index is required when scope is build_item.");
        }
        const item = report.buildItems[buildItemIndex];
        if (!item) throw new Error(`Unknown build item index: ${buildItemIndex}`);
        return success({
          scope,
          buildItemIndex,
          metadata: page(item.metadata, offset, limit),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "inspect_materials",
    {
      title: "Inspect 3MF materials and colors",
      description: "Return base-material, color, and texture property group summaries.",
      inputSchema: {
        model_id: z.string().uuid(),
        resource_id: z.number().int().nonnegative().optional(),
        ...paginationSchema,
      },
    },
    async ({ model_id: modelId, resource_id: resourceId, offset, limit }) => {
      try {
        const report = store.get(modelId).report;
        if (resourceId === undefined) {
          return success({
            materialGroups: page(
              report.materialGroups.map(({ entries, ...group }) => ({
                ...group,
                entryCount: entries.length,
              })),
              offset,
              limit,
            ),
            textureCount: report.counts.textures,
          });
        }
        const group = report.materialGroups.find((candidate) => candidate.resourceId === resourceId);
        if (!group) throw new Error(`Unknown material-group resource id: ${resourceId}`);
        const { entries, ...summary } = group;
        return success({
          materialGroup: { ...summary, entries: page(entries, offset, limit) },
          textureCount: report.counts.textures,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "inspect_package",
    {
      title: "Inspect 3MF package",
      description:
        "Return package attachments, content types, relationship types, and byte sizes.",
      inputSchema: { model_id: z.string().uuid(), ...paginationSchema },
    },
    async ({ model_id: modelId, offset, limit }) => {
      try {
        return success(page(store.get(modelId).report.attachments, offset, limit));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "inspect_slices",
    {
      title: "Inspect 3MF slice stacks",
      description:
        "Return slice-stack Z ranges and aggregate slice, polygon, and vertex counts without returning huge contour arrays.",
      inputSchema: { model_id: z.string().uuid(), ...paginationSchema },
    },
    async ({ model_id: modelId, offset, limit }) => {
      try {
        return success(page(store.get(modelId).report.sliceStacks, offset, limit));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "inspect_beam_lattices",
    {
      title: "Inspect 3MF beam lattices",
      description:
        "Return beam and ball counts, radius and length ranges, and cap modes for each beam-lattice object.",
      inputSchema: { model_id: z.string().uuid(), ...paginationSchema },
    },
    async ({ model_id: modelId, offset, limit }) => {
      try {
        const lattices = store
          .get(modelId)
          .report.objects.filter((object) => object.mesh?.beamLattice)
          .map((object) => ({
            resourceId: object.resourceId,
            name: object.name,
            ...object.mesh!.beamLattice,
          }));
        return success(page(lattices, offset, limit));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "review_model",
    {
      title: "Review 3MF model",
      description:
        "Build a compact structural and compliance review, then optionally render standard headless views and return them as MCP images. Visual failure does not discard the structural review.",
      inputSchema: {
        model_id: z.string().uuid(),
        include_visuals: z.boolean().default(true),
        views: z
          .array(z.enum(["front", "back", "left", "right", "top", "bottom", "isometric"]))
          .min(1)
          .max(6)
          .default(["isometric", "front", "top"]),
        resource_id: z.number().int().nonnegative().optional(),
        isolate: z.boolean().default(false),
        wireframe: z.boolean().default(false),
        edges: z.boolean().default(true),
      },
    },
    async ({
      model_id: modelId,
      include_visuals: includeVisuals,
      views,
      resource_id: resourceId,
      isolate,
      wireframe,
      edges,
    }, extra) => {
      try {
        const report = store.get(modelId).report;
        const findings = reviewFindings(report);
        const status =
          !report.validation.compliant ||
          !report.validation.preflightPassed ||
          findings.errorCount > 0
            ? "failed"
            : findings.warningCount > 0
              ? "needs_attention"
              : "passed";
        const images: LabeledImage[] = [];
        const visualReview: Record<string, unknown> = {
          requested: includeVisuals,
          completed: false,
          views: [],
          browserDiagnostics: [],
        };
        let viewerSessionId: string | null = null;
        let progressSequence = 0;
        const reportProgress = async (progress: Record<string, unknown>) => {
          const progressToken = extra._meta?.progressToken;
          if (progressToken === undefined) return;
          const triangles = typeof progress.triangles === "number" ? progress.triangles : null;
          const total =
            typeof progress.totalTriangles === "number" ? progress.totalTriangles : undefined;
          const message =
            (typeof progress.detail === "string" && progress.detail) ||
            (typeof progress.stage === "string" && progress.stage) ||
            "Loading 3MF model";
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: triangles ?? ++progressSequence,
              ...(total === undefined ? {} : { total }),
              message,
            },
          });
        };
        if (includeVisuals) {
          try {
            const session = await viewers.open(modelId, {
              mode: "headless",
              ...(options.chromePath ? { chromePath: options.chromePath } : {}),
              preset: views[0] ?? "isometric",
              ...(resourceId === undefined ? {} : { resourceId }),
              isolate,
              wireframe,
              edges,
              onProgress: reportProgress,
            });
            viewerSessionId = session.viewerSessionId;
            const capturedViews: Array<Record<string, unknown>> = [];
            for (const view of views) {
              const camera = await viewers.command(
                viewerSessionId,
                "camera.setPreset",
                { preset: view },
              );
              if (!("ok" in camera) || camera.ok !== true) {
                throw new Error(`Unable to set the ${view} review camera.`);
              }
              const capture = await viewers.command(viewerSessionId, "capture.png", {});
              if (!("ok" in capture) || capture.ok !== true) {
                throw new Error(`Unable to capture the ${view} review view.`);
              }
              const png = viewers.capture(viewerSessionId, capture.commandId);
              if (!png) throw new Error(`The ${view} review capture was not retained.`);
              const result =
                capture.result && typeof capture.result === "object"
                  ? (capture.result as Record<string, unknown>)
                  : {};
              images.push({ label: view, png });
              capturedViews.push({
                view,
                width: result.width ?? null,
                height: result.height ?? null,
                mimeType: result.mimeType ?? "image/png",
              });
            }
            const viewerStatus = viewers.status(viewerSessionId);
            visualReview.completed = true;
            visualReview.views = capturedViews;
            visualReview.browserDiagnostics = viewerStatus.browserDiagnostics;
            visualReview.loadProgress = viewerStatus.loadProgress;
          } catch (error) {
            visualReview.error = error instanceof Error ? error.message : String(error);
            if (viewerSessionId) {
              visualReview.browserDiagnostics = viewers.status(viewerSessionId).browserDiagnostics;
            }
          } finally {
            if (viewerSessionId) viewers.close(viewerSessionId);
          }
        }
        return reviewSuccess(
          {
            modelId,
            status,
            summary: summaryView(report),
            findingCount: findings.total,
            omittedFindingCount: findings.omitted,
            findings: findings.items,
            objects: {
              total: report.objects.length,
              items: report.objects.slice(0, 100).map(objectSummaryView),
              omitted: Math.max(0, report.objects.length - 100),
            },
            buildItems: {
              total: report.buildItems.length,
              items: report.buildItems.slice(0, 100),
              omitted: Math.max(0, report.buildItems.length - 100),
            },
            visuals: visualReview,
          },
          images,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "open_model_viewer",
    {
      title: "Open model in 3MF Viewer",
      description:
        "Create a temporary loopback viewer session for a loaded model. Choose URL-only, system-browser, or agent-controlled headless mode when spatial geometry, assemblies, materials, slices, beam lattices, or validation findings benefit from visual inspection.",
      inputSchema: {
        model_id: z.string().uuid(),
        viewer_url: z.string().url().optional(),
        preset: z
          .enum(["front", "back", "left", "right", "top", "bottom", "isometric"])
          .default("isometric"),
        resource_id: z.number().int().nonnegative().optional(),
        isolate: z.boolean().default(false),
        wireframe: z.boolean().optional(),
        edges: z.boolean().optional(),
        viewer_mode: z.enum(["url", "system", "headless"]).optional(),
        /** @deprecated Prefer viewer_mode. */
        open_browser: z.boolean().optional(),
      },
    },
    async ({
      model_id: modelId,
      viewer_url: viewerUrl,
      preset,
      resource_id: resourceId,
      isolate,
      wireframe,
      edges,
      viewer_mode: viewerMode,
      open_browser: openBrowser,
    }) => {
      try {
        const mode =
          viewerMode ??
          (openBrowser === undefined
            ? options.viewerModeByDefault ?? (options.openBrowserByDefault ? "system" : "url")
            : openBrowser
              ? "system"
              : "url");
        return success(
          await viewers.open(modelId, {
            ...(viewerUrl === undefined ? {} : { viewerUrl }),
            preset,
            ...(resourceId === undefined ? {} : { resourceId }),
            isolate,
            ...(wireframe === undefined ? {} : { wireframe }),
            ...(edges === undefined ? {} : { edges }),
            mode,
            ...(options.chromePath ? { chromePath: options.chromePath } : {}),
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "control_model_viewer",
    {
      title: "Control an open 3MF Viewer",
      description:
        "Send a versioned viewer-control command to an open viewer session and wait briefly for its result. A completed capture.png is returned directly as MCP image content and also includes a temporary PNG URL.",
      inputSchema: {
        viewer_session_id: z.string().uuid(),
        command: z.enum([
          "viewer.getCapabilities",
          "viewer.getState",
          "model.clear",
          "scene.getManifest",
          "scene.select",
          "scene.setVisibility",
          "scene.isolate",
          "scene.resetVisibility",
          "camera.fit",
          "camera.reset",
          "camera.get",
          "camera.set",
          "camera.setPreset",
          "render.setOptions",
          "slice.setIndex",
          "beamLattice.setMode",
          "capture.png",
        ]),
        arguments: z.record(z.string(), z.unknown()).default({}),
        wait_ms: z.number().int().min(0).max(60_000).default(15_000),
      },
    },
    async ({
      viewer_session_id: viewerSessionId,
      command,
      arguments: argumentsValue,
      wait_ms: waitMs,
    }) => {
      try {
        const result = await viewers.command(viewerSessionId, command, argumentsValue, waitMs);
        if (command === "capture.png" && "commandId" in result) {
          const png = viewers.capture(viewerSessionId, result.commandId);
          if (png) return imageSuccess(result as unknown as Record<string, unknown>, png);
        }
        return success(result);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_viewer_session",
    {
      title: "Get 3MF Viewer session",
      description: "Check whether a viewer session is connected and rendered.",
      inputSchema: { viewer_session_id: z.string().uuid() },
    },
    async ({ viewer_session_id: viewerSessionId }) => {
      try {
        return success(viewers.status(viewerSessionId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_viewer_result",
    {
      title: "Get 3MF Viewer command result",
      description: "Retrieve the result of a viewer command that was still pending.",
      inputSchema: {
        viewer_session_id: z.string().uuid(),
        command_id: z.string().uuid(),
      },
    },
    async ({ viewer_session_id: viewerSessionId, command_id: commandId }) => {
      try {
        return success(viewers.result(viewerSessionId, commandId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "close_model_viewer",
    {
      title: "Close 3MF Viewer session",
      description: "Delete a temporary local viewer session and its captures.",
      inputSchema: { viewer_session_id: z.string().uuid() },
    },
    async ({ viewer_session_id: viewerSessionId }) =>
      success({ viewerSessionId, closed: viewers.close(viewerSessionId) }),
  );

  return server;
};
