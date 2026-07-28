import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InspectionReport, ObjectSummary, StoredModel } from "../inspection/types.js";
import { ModelStore, summaryView } from "../inspection/store.js";

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

export const createMcpServer = (store: ModelStore): McpServer => {
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

  return server;
};
