import { createHash, randomUUID } from "node:crypto";
import createLib3mf from "@3mfconsortium/lib3mf";
import type {
  BeamLatticeSummary,
  AttachmentSummary,
  Bounds3d,
  BuildItemSummary,
  ComplianceReport,
  Diagnostic,
  InspectionReport,
  MaterialGroupSummary,
  MetadataEntry,
  ObjectSummary,
  PreflightFinding,
  SliceStackSummary,
  ValidationSummary,
  ValidationMode,
} from "./types.js";

const UNIT_NAMES = new Map<number, { name: string; symbol: string }>([
  [0, { name: "micrometer", symbol: "um" }],
  [1, { name: "millimeter", symbol: "mm" }],
  [2, { name: "centimeter", symbol: "cm" }],
  [3, { name: "inch", symbol: "in" }],
  [4, { name: "foot", symbol: "ft" }],
  [5, { name: "meter", symbol: "m" }],
]);

const safeDelete = (value: unknown): void => {
  try {
    (value as { delete?: () => void } | null)?.delete?.();
  } catch {
    // Cleanup must not mask the inspection result.
  }
};

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const converted = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(converted) ? converted : null;
};

const count = (value: unknown): number => Math.max(0, Math.trunc(finite(value) ?? 0));

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const readUuid = (owner: any): string | null => {
  const raw = call<any>(owner, "GetUUID", null);
  return text(raw) ?? text(raw?.return) ?? text(raw?.Return);
};

const call = <T>(target: any, method: string, fallback: T, ...args: unknown[]): T => {
  try {
    const fn = target?.[method];
    return typeof fn === "function" ? (fn.apply(target, args) as T) : fallback;
  } catch {
    return fallback;
  }
};

const readTransform = (transform: any): number[] | null => {
  if (!transform) return null;
  const values: number[] = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const value =
        finite(call(transform, `get_Fields_${row}_${column}`, undefined)) ??
        finite(call(transform, `get_Fields${row}${column}`, undefined));
      if (value === null) return null;
      values.push(value);
    }
  }
  return values;
};

const readMetadata = (owner: any): MetadataEntry[] => {
  const group = call<any>(owner, "GetMetaDataGroup", null);
  if (!group) return [];
  const entries: MetadataEntry[] = [];
  try {
    const total = count(call(group, "GetMetaDataCount", 0));
    for (let index = 0; index < total; index += 1) {
      const item = call<any>(group, "GetMetaData", null, index);
      if (!item) continue;
      try {
        entries.push({
          key: text(call(item, "GetKey", null)),
          name: text(call(item, "GetName", null)),
          namespace: text(call(item, "GetNameSpace", null)),
          type: text(call(item, "GetType", null)),
          value: text(call(item, "GetValue", null)),
          mustPreserve: Boolean(call(item, "GetMustPreserve", false)),
        });
      } finally {
        safeDelete(item);
      }
    }
  } finally {
    safeDelete(group);
  }
  return entries;
};

const warningResult = (raw: unknown): Diagnostic => {
  if (typeof raw === "string") return { kind: "warning", message: raw };
  if (raw && typeof raw === "object") {
    const result = raw as Record<string, unknown>;
    const message =
      text(result.return) ??
      text(result.Return) ??
      text(result.Message) ??
      text(result.message) ??
      JSON.stringify(result);
    const rawCode = result.ErrorCode ?? result.Code ?? result.code;
    const codeValue =
      typeof rawCode === "number" || typeof rawCode === "string" ? rawCode : undefined;
    return codeValue === undefined
      ? { kind: "warning", message }
      : { kind: "warning", message, code: codeValue };
  }
  return { kind: "warning", message: String(raw) };
};

const collectReaderWarnings = (reader: any): Diagnostic[] => {
  const warnings: Diagnostic[] = [];
  const total = count(call(reader, "GetWarningCount", 0));
  for (let index = 0; index < total; index += 1) {
    try {
      warnings.push(warningResult(reader.GetWarning(index)));
    } catch (error) {
      warnings.push({
        kind: "warning-read-error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return warnings;
};

const lastError = (wrapper: any, owner: any, kind: string): Diagnostic | null => {
  try {
    const raw = wrapper.GetLastError(owner);
    const message =
      typeof raw === "string"
        ? text(raw)
        : text(raw?.sLastErrorString) ?? text(raw?.message) ?? text(raw?.return);
    return message ? { kind, message } : null;
  } catch {
    return null;
  }
};

const readValidation = (
  wrapper: any,
  model: any,
  reader: any,
  readError: unknown,
): ValidationMode => {
  const errors: Diagnostic[] = [];
  if (readError) {
    errors.push({
      kind: "exception",
      message: readError instanceof Error ? readError.message : String(readError),
    });
  }
  const readerError = lastError(wrapper, reader, "reader-last-error");
  const modelError = lastError(wrapper, model, "model-last-error");
  if (readerError) errors.push(readerError);
  if (modelError) errors.push(modelError);
  return {
    valid: errors.length === 0,
    warnings: collectReaderWarnings(reader),
    errors,
  };
};

const boundsAccumulator = () => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  return {
    add(x: number, y: number, z: number) {
      const values = [x, y, z];
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis]!, values[axis]!);
        max[axis] = Math.max(max[axis]!, values[axis]!);
      }
    },
    result(): Bounds3d | null {
      if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) return null;
      return {
        min: [min[0]!, min[1]!, min[2]!],
        max: [max[0]!, max[1]!, max[2]!],
        size: [max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!],
      };
    },
  };
};

const mergeBounds = (items: Array<Bounds3d | null>): Bounds3d | null => {
  const aggregate = boundsAccumulator();
  for (const item of items) {
    if (!item) continue;
    aggregate.add(...item.min);
    aggregate.add(...item.max);
  }
  return aggregate.result();
};

const transformPoint = (
  point: [number, number, number],
  transform: number[] | null,
): [number, number, number] => {
  if (!transform) return point;
  const [x, y, z] = point;
  return [
    x * transform[0]! + y * transform[3]! + z * transform[6]! + transform[9]!,
    x * transform[1]! + y * transform[4]! + z * transform[7]! + transform[10]!,
    x * transform[2]! + y * transform[5]! + z * transform[8]! + transform[11]!,
  ];
};

const transformBounds = (bounds: Bounds3d, transforms: Array<number[] | null>): Bounds3d => {
  const result = boundsAccumulator();
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        let point: [number, number, number] = [x, y, z];
        for (const transform of transforms) point = transformPoint(point, transform);
        result.add(...point);
      }
    }
  }
  return result.result()!;
};

const enumName = (enumObject: Record<string, unknown> | undefined, value: unknown): string => {
  if (!enumObject) return String(value ?? "unknown");
  const match = Object.entries(enumObject).find(([, enumValue]) => enumValue === value);
  return match?.[0] ?? String(value ?? "unknown");
};

const inspectBeamLattice = (
  module: Awaited<ReturnType<typeof createLib3mf>>,
  mesh: any,
  vertices: Array<[number, number, number]>,
): BeamLatticeSummary | null => {
  const lattice = call<any>(mesh, "BeamLattice", null);
  if (!lattice) return null;
  try {
    const beamCount = count(call(lattice, "GetBeamCount", 0));
    const ballCount = count(call(lattice, "GetBallCount", 0));
    if (beamCount === 0 && ballCount === 0) return null;

    let minRadius = Infinity;
    let maxRadius = -Infinity;
    let minLength = Infinity;
    let maxLength = -Infinity;
    const capModes: Record<string, number> = {};

    for (let index = 0; index < beamCount; index += 1) {
      const beam = call<any>(lattice, "GetBeam", null, index);
      if (!beam) continue;
      try {
        const radii = [
          finite(call(beam, "get_Radii0", null)),
          finite(call(beam, "get_Radii1", null)),
        ].filter((radius): radius is number => radius !== null);
        for (const radius of radii) {
          minRadius = Math.min(minRadius, radius);
          maxRadius = Math.max(maxRadius, radius);
        }
        const nodeA = count(call(beam, "get_Indices0", 0));
        const nodeB = count(call(beam, "get_Indices1", 0));
        const a = vertices[nodeA];
        const b = vertices[nodeB];
        if (a && b) {
          const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
          minLength = Math.min(minLength, length);
          maxLength = Math.max(maxLength, length);
        }
        for (const method of ["get_CapModes0", "get_CapModes1"]) {
          const mode = enumName(module.eBeamLatticeCapMode, call(beam, method, "unknown"));
          capModes[mode] = (capModes[mode] ?? 0) + 1;
        }
      } finally {
        safeDelete(beam);
      }
    }

    const ballOptions = call<any>(lattice, "GetBallOptions", null);
    const defaultBallRadius = finite(ballOptions?.BallRadius);
    const ballMode = enumName(module.eBeamLatticeBallMode, ballOptions?.BallMode);

    for (let index = 0; index < ballCount; index += 1) {
      const ball = call<any>(lattice, "GetBall", null, index);
      if (!ball) continue;
      try {
        const radius = finite(call(ball, "get_Radius", defaultBallRadius));
        if (radius !== null) {
          minRadius = Math.min(minRadius, radius);
          maxRadius = Math.max(maxRadius, radius);
        }
      } finally {
        safeDelete(ball);
      }
    }

    return {
      beamCount,
      ballCount,
      radius: {
        min: Number.isFinite(minRadius) ? minRadius : null,
        max: Number.isFinite(maxRadius) ? maxRadius : null,
      },
      length: {
        min: Number.isFinite(minLength) ? minLength : null,
        max: Number.isFinite(maxLength) ? maxLength : null,
      },
      capModes,
      ballMode,
      defaultBallRadius,
    };
  } finally {
    safeDelete(lattice);
  }
};

const inspectObjects = (
  module: Awaited<ReturnType<typeof createLib3mf>>,
  model: any,
): ObjectSummary[] => {
  const objects: ObjectSummary[] = [];
  const iterator = call<any>(model, "GetObjects", null);
  if (!iterator) return objects;
  try {
    while (call(iterator, "MoveNext", false)) {
      const object = call<any>(iterator, "GetCurrentObject", null);
      if (!object) continue;
      try {
        const resourceId = finite(call(object, "GetModelResourceID", null));
        const uniqueResourceId = finite(call(object, "GetUniqueResourceID", null));
        const uuid = readUuid(object);
        const name = text(call(object, "GetName", null));
        const partNumber = text(call(object, "GetPartNumber", null));
        if (call(object, "IsMeshObject", false)) {
          const vertexCount = count(call(object, "GetVertexCount", 0));
          const triangleCount = count(call(object, "GetTriangleCount", 0));
          const bounds = boundsAccumulator();
          const vertices: Array<[number, number, number]> = [];
          for (let index = 0; index < vertexCount; index += 1) {
            const vertex = call<any>(object, "GetVertex", null, index);
            if (!vertex) continue;
            try {
              const x = finite(call(vertex, "get_Coordinates0", null));
              const y = finite(call(vertex, "get_Coordinates1", null));
              const z = finite(call(vertex, "get_Coordinates2", null));
              if (x !== null && y !== null && z !== null) {
                vertices.push([x, y, z]);
                bounds.add(x, y, z);
              } else {
                vertices.push([0, 0, 0]);
              }
            } finally {
              safeDelete(vertex);
            }
          }
          const stack = call<any>(object, "GetSliceStack", null);
          let sliceStackResourceId: number | null = null;
          if (stack) {
            try {
              sliceStackResourceId = finite(call(stack, "GetModelResourceID", null));
            } finally {
              safeDelete(stack);
            }
          }
          objects.push({
            resourceId,
            uniqueResourceId,
            uuid,
            name,
            partNumber,
            type: "mesh",
            mesh: {
              vertexCount,
              triangleCount,
              manifoldAndOriented:
                triangleCount > 0 ? Boolean(call(object, "IsManifoldAndOriented", false)) : null,
              bounds: bounds.result(),
              beamLattice: inspectBeamLattice(module, object, vertices),
              sliceStackResourceId,
            },
            components: [],
          });
        } else if (call(object, "IsComponentsObject", false)) {
          const components = [];
          const componentCount = count(call(object, "GetComponentCount", 0));
          for (let index = 0; index < componentCount; index += 1) {
            const component = call<any>(object, "GetComponent", null, index);
            if (!component) continue;
            try {
              const transform = call(component, "HasTransform", false)
                ? call<any>(component, "GetTransform", null)
                : null;
              const referencedObject = call<any>(component, "GetObjectResource", null);
              components.push({
                objectResourceId: finite(call(referencedObject, "GetModelResourceID", null)),
                uuid: readUuid(component),
                transform: readTransform(transform),
              });
              safeDelete(referencedObject);
              safeDelete(transform);
            } finally {
              safeDelete(component);
            }
          }
          objects.push({
            resourceId,
            uniqueResourceId,
            uuid,
            name,
            partNumber,
            type: "components",
            mesh: null,
            components,
          });
        } else {
          objects.push({
            resourceId,
            uniqueResourceId,
            uuid,
            name,
            partNumber,
            type: "other",
            mesh: null,
            components: [],
          });
        }
      } finally {
        safeDelete(object);
      }
    }
  } finally {
    safeDelete(iterator);
  }
  return objects;
};

const inspectBuildItems = (model: any): BuildItemSummary[] => {
  const items: BuildItemSummary[] = [];
  const iterator = call<any>(model, "GetBuildItems", null);
  if (!iterator) return items;
  try {
    while (call(iterator, "MoveNext", false)) {
      const item = call<any>(iterator, "GetCurrent", null);
      if (!item) continue;
      try {
        const object = call<any>(item, "GetObjectResource", null);
        const transform = call(item, "HasObjectTransform", false)
          ? call<any>(item, "GetObjectTransform", null)
          : null;
        items.push({
          index: items.length,
          objectResourceId: finite(call(object, "GetModelResourceID", null)),
          uuid: readUuid(item),
          transform: readTransform(transform),
          metadata: readMetadata(item),
        });
        safeDelete(transform);
        safeDelete(object);
      } finally {
        safeDelete(item);
      }
    }
  } finally {
    safeDelete(iterator);
  }
  return items;
};

const inspectSliceStacks = (model: any): SliceStackSummary[] => {
  const stacks: SliceStackSummary[] = [];
  const iterator = call<any>(model, "GetSliceStacks", null);
  if (!iterator) return stacks;
  try {
    while (call(iterator, "MoveNext", false)) {
      const stack = call<any>(iterator, "GetCurrentSliceStack", null);
      if (!stack) continue;
      try {
        const sliceCount = count(call(stack, "GetSliceCount", 0));
        let vertexCount = 0;
        let polygonCount = 0;
        let topZ: number | null = null;
        for (let index = 0; index < sliceCount; index += 1) {
          const slice = call<any>(stack, "GetSlice", null, index);
          if (!slice) continue;
          try {
            vertexCount += count(call(slice, "GetVertexCount", 0));
            polygonCount += count(call(slice, "GetPolygonCount", 0));
            const currentTop = finite(call(slice, "GetZTop", null));
            if (currentTop !== null) topZ = topZ === null ? currentTop : Math.max(topZ, currentTop);
          } finally {
            safeDelete(slice);
          }
        }
        stacks.push({
          resourceId: finite(call(stack, "GetModelResourceID", null)),
          bottomZ: finite(call(stack, "GetBottomZ", null)),
          topZ,
          sliceCount,
          vertexCount,
          polygonCount,
          referencedStackCount: count(call(stack, "GetSliceRefCount", 0)),
        });
      } finally {
        safeDelete(stack);
      }
    }
  } finally {
    safeDelete(iterator);
  }
  return stacks;
};

const rgbaHex = (color: any): string | undefined => {
  if (!color) return undefined;
  const channels = ["Red", "Green", "Blue", "Alpha"].map((channel, index) => {
    const fallback = index === 3 ? 255 : 0;
    return count(call(color, `get_${channel}`, fallback));
  });
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
};

const inspectMaterialGroups = (model: any): MaterialGroupSummary[] => {
  const groups: MaterialGroupSummary[] = [];
  const definitions = [
    {
      iterator: "GetBaseMaterialGroups",
      current: "GetCurrentBaseMaterialGroup",
      kind: "base-material" as const,
    },
    { iterator: "GetColorGroups", current: "GetCurrentColorGroup", kind: "color" as const },
    {
      iterator: "GetTexture2DGroups",
      current: "GetCurrentTexture2DGroup",
      kind: "texture-2d" as const,
    },
  ];
  for (const definition of definitions) {
    const iterator = call<any>(model, definition.iterator, null);
    if (!iterator) continue;
    try {
      while (call(iterator, "MoveNext", false)) {
        const group = call<any>(iterator, definition.current, null);
        if (!group) continue;
        try {
          const total = count(call(group, "GetCount", 0));
          const entries: MaterialGroupSummary["entries"] = [];
          for (let index = 0; index < total; index += 1) {
            if (definition.kind === "texture-2d") {
              entries.push({ index });
              continue;
            }
            const propertyId = index + 1;
            const name = text(call(group, "GetName", null, propertyId)) ?? undefined;
            const color =
              call<any>(group, "GetDisplayColor", null, propertyId) ??
              call<any>(group, "GetColor", null, propertyId);
            const rgba = rgbaHex(color);
            safeDelete(color);
            entries.push({
              index,
              ...(name ? { name } : {}),
              ...(rgba ? { rgba } : {}),
            });
          }
          groups.push({
            resourceId: finite(call(group, "GetModelResourceID", null)),
            kind: definition.kind,
            count: total,
            entries,
          });
        } finally {
          safeDelete(group);
        }
      }
    } finally {
      safeDelete(iterator);
    }
  }
  return groups;
};

const textureCount = (model: any): number => {
  const iterator = call<any>(model, "GetTexture2Ds", null);
  if (!iterator) return 0;
  let total = 0;
  try {
    while (call(iterator, "MoveNext", false)) total += 1;
  } finally {
    safeDelete(iterator);
  }
  return total;
};

const inspectAttachments = (model: any): AttachmentSummary[] => {
  const attachments: AttachmentSummary[] = [];
  const total = count(call(model, "GetAttachmentCount", 0));
  for (let index = 0; index < total; index += 1) {
    const attachment = call<any>(model, "GetAttachment", null, index);
    if (!attachment) continue;
    try {
      attachments.push({
        index,
        path: text(call(attachment, "GetPath", null)),
        relationshipType: text(call(attachment, "GetRelationShipType", null)),
        contentType: text(call(attachment, "GetContentType", null)),
        byteLength: finite(call(attachment, "GetStreamSize", null)),
      });
    } finally {
      safeDelete(attachment);
    }
  }
  return attachments;
};

const computeBuildBounds = (
  objects: ObjectSummary[],
  buildItems: BuildItemSummary[],
): Bounds3d | null => {
  const byId = new Map(
    objects
      .filter((object): object is ObjectSummary & { resourceId: number } => object.resourceId !== null)
      .map((object) => [object.resourceId, object]),
  );

  const resolve = (
    resourceId: number,
    transforms: Array<number[] | null>,
    ancestors: Set<number>,
  ): Bounds3d | null => {
    if (ancestors.has(resourceId)) return null;
    const object = byId.get(resourceId);
    if (!object) return null;
    if (object.mesh?.bounds) return transformBounds(object.mesh.bounds, transforms);

    const nextAncestors = new Set(ancestors).add(resourceId);
    return mergeBounds(
      object.components.map((component) =>
        component.objectResourceId === null
          ? null
          : resolve(
              component.objectResourceId,
              [component.transform, ...transforms],
              nextAncestors,
            ),
      ),
    );
  };

  return mergeBounds(
    buildItems.map((item) =>
      item.objectResourceId === null
        ? null
        : resolve(item.objectResourceId, [item.transform], new Set()),
    ),
  );
};

const preflightFindings = (
  objects: ObjectSummary[],
  buildItems: BuildItemSummary[],
): PreflightFinding[] => {
  const findings: PreflightFinding[] = [];
  const ids = new Set(
    objects.flatMap((object) => (object.resourceId === null ? [] : [object.resourceId])),
  );

  if (buildItems.length === 0) {
    findings.push({
      severity: "error",
      code: "EMPTY_BUILD",
      message: "The model has no build items.",
    });
  }
  if (!objects.some((object) => object.mesh)) {
    findings.push({
      severity: "error",
      code: "NO_MESH_RESOURCES",
      message: "The model contains no mesh resources.",
    });
  }

  for (const object of objects) {
    if (object.mesh) {
      const hasPrintableGeometry =
        object.mesh.triangleCount > 0 ||
        (object.mesh.beamLattice?.beamCount ?? 0) > 0 ||
        object.mesh.sliceStackResourceId !== null;
      if (!hasPrintableGeometry) {
        findings.push({
          severity: "warning",
          code: "EMPTY_MESH",
          message: "Mesh resource has no triangles, beams, or assigned slice stack.",
          ...(object.resourceId === null ? {} : { resourceId: object.resourceId }),
        });
      }
      if (object.mesh.manifoldAndOriented === false) {
        findings.push({
          severity: "warning",
          code: "NON_MANIFOLD_MESH",
          message: "Mesh is not manifold and consistently oriented.",
          ...(object.resourceId === null ? {} : { resourceId: object.resourceId }),
        });
      }
    }
    for (const component of object.components) {
      if (component.objectResourceId === null || !ids.has(component.objectResourceId)) {
        findings.push({
          severity: "error",
          code: "DANGLING_COMPONENT_REFERENCE",
          message: "Component references an object that is not present in the model.",
          ...(object.resourceId === null ? {} : { resourceId: object.resourceId }),
        });
      }
    }
  }

  for (const item of buildItems) {
    if (item.objectResourceId === null || !ids.has(item.objectResourceId)) {
      findings.push({
        severity: "error",
        code: "DANGLING_BUILD_REFERENCE",
        message: `Build item ${item.index} references an object that is not present in the model.`,
      });
    }
  }

  const byId = new Map(
    objects
      .filter((object): object is ObjectSummary & { resourceId: number } => object.resourceId !== null)
      .map((object) => [object.resourceId, object]),
  );
  const visit = (resourceId: number, ancestors: Set<number>): void => {
    if (ancestors.has(resourceId)) {
      findings.push({
        severity: "error",
        code: "COMPONENT_CYCLE",
        message: "Component graph contains a cycle.",
        resourceId,
      });
      return;
    }
    const object = byId.get(resourceId);
    if (!object) return;
    const next = new Set(ancestors).add(resourceId);
    for (const component of object.components) {
      if (component.objectResourceId !== null) visit(component.objectResourceId, next);
    }
  };
  for (const item of buildItems) {
    if (item.objectResourceId !== null) visit(item.objectResourceId, new Set());
  }

  return findings.filter(
    (finding, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.code === finding.code &&
          candidate.resourceId === finding.resourceId &&
          candidate.message === finding.message,
      ) === index,
  );
};

const libraryVersion = (wrapper: any): string => {
  const raw = call<any>(wrapper, "GetLibraryVersion", {});
  return [
    finite(raw?.Major) ?? 0,
    finite(raw?.Minor) ?? 0,
    finite(raw?.Micro) ?? 0,
  ].join(".");
};

const validationSummary = (
  version: string,
  nonStrict: ValidationMode,
  strict: ValidationMode,
  findings: PreflightFinding[],
): ValidationSummary => ({
  compliant: strict.valid,
  preflightPassed: !findings.some((finding) => finding.severity === "error"),
  validator: { name: "lib3mf", version, level: "strict-reader" },
  nonStrict,
  strict,
  findings,
});

class ModelReadError extends Error {
  constructor(
    message: string,
    readonly validation: ValidationSummary,
  ) {
    super(message);
    this.name = "ModelReadError";
  }
}

const strictValidation = (path: string, wrapper: any) => {
  const model = wrapper.CreateModel();
  const reader = model.QueryReader("3mf");
  let readError: unknown = null;
  try {
    call(reader, "SetStrictModeActive", undefined, true);
    try {
      reader.ReadFromFile(path);
    } catch (error) {
      readError = error;
    }
    return readValidation(wrapper, model, reader, readError);
  } finally {
    safeDelete(reader);
    safeDelete(model);
  }
};

export class ThreeMfInspector {
  private modulePromise: ReturnType<typeof createLib3mf> | null = null;
  private queue: Promise<void> = Promise.resolve();

  private module() {
    this.modulePromise ??= createLib3mf();
    return this.modulePromise;
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(action);
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  inspect(bytes: Uint8Array, fileName: string): Promise<InspectionReport> {
    return this.enqueue(() => this.inspectExclusive(bytes, fileName));
  }

  checkCompliance(bytes: Uint8Array, fileName: string): Promise<ComplianceReport> {
    return this.enqueue(async () => {
      try {
        const report = await this.inspectExclusive(bytes, fileName);
        return {
          file: report.file,
          parseable: true,
          extensions: report.extensions,
          validation: report.validation,
        };
      } catch (error) {
        if (!(error instanceof ModelReadError)) throw error;
        return {
          file: {
            name: fileName,
            byteLength: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
          parseable: false,
          extensions: null,
          validation: error.validation,
        };
      }
    });
  }

  private async inspectExclusive(bytes: Uint8Array, fileName: string): Promise<InspectionReport> {
    const module = await this.module();
    const wrapper = new module.CWrapper();
    const model = wrapper.CreateModel();
    const reader = model.QueryReader("3mf");
    const virtualPath = `/mcp_${randomUUID()}.3mf`;
    try {
      module.FS.writeFile(virtualPath, bytes);
      call(reader, "SetStrictModeActive", undefined, false);
      let readError: unknown = null;
      try {
        reader.ReadFromFile(virtualPath);
      } catch (error) {
        readError = error;
      }
      const nonStrict = readValidation(wrapper, model, reader, readError);
      const strict = strictValidation(virtualPath, wrapper);
      const version = libraryVersion(wrapper);
      if (readError) {
        const findings: PreflightFinding[] = [
          {
            severity: "error",
            code: "MODEL_UNREADABLE",
            message: readError instanceof Error ? readError.message : String(readError),
          },
        ];
        throw new ModelReadError(
          findings[0]!.message,
          validationSummary(version, nonStrict, strict, findings),
        );
      }

      const objects = inspectObjects(module, model);
      const buildItems = inspectBuildItems(model);
      const sliceStacks = inspectSliceStacks(model);
      const materialGroups = inspectMaterialGroups(model);
      const textures = textureCount(model);
      const attachments = inspectAttachments(model);
      const meshes = objects.filter((object) => object.type === "mesh");
      const componentObjects = objects.filter((object) => object.type === "components");
      const beamSummaries = meshes
        .map((object) => object.mesh?.beamLattice)
        .filter((beam): beam is BeamLatticeSummary => beam !== null && beam !== undefined);
      const rawUnit = call(model, "GetUnit", null);
      const unitName = Object.entries(module.eModelUnit ?? {}).find(([, value]) => value === rawUnit)?.[0];
      const unitCode =
        unitName === "MicroMeter" ? 0
        : unitName === "MilliMeter" ? 1
        : unitName === "CentiMeter" ? 2
        : unitName === "Inch" ? 3
        : unitName === "Foot" ? 4
        : unitName === "Meter" ? 5
        : finite(rawUnit);
      const unit = unitCode === null ? null : UNIT_NAMES.get(unitCode);
      const resourceBounds = mergeBounds(meshes.map((object) => object.mesh?.bounds ?? null));
      const buildBounds = computeBuildBounds(objects, buildItems);
      const findings = preflightFindings(objects, buildItems);

      const report: InspectionReport = {
        format: "3MF",
        file: {
          name: fileName,
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        libraryVersion: version,
        unit: {
          code: unitCode,
          name: unit?.name ?? "unknown",
          symbol: unit?.symbol ?? "",
        },
        language: text(call(model, "GetLanguage", null)),
        metadata: readMetadata(model),
        counts: {
          objects: objects.length,
          meshObjects: meshes.length,
          componentObjects: componentObjects.length,
          buildItems: buildItems.length,
          vertices: meshes.reduce((sum, object) => sum + (object.mesh?.vertexCount ?? 0), 0),
          triangles: meshes.reduce((sum, object) => sum + (object.mesh?.triangleCount ?? 0), 0),
          components: componentObjects.reduce((sum, object) => sum + object.components.length, 0),
          sliceStacks: sliceStacks.length,
          slices: sliceStacks.reduce((sum, stack) => sum + stack.sliceCount, 0),
          sliceVertices: sliceStacks.reduce((sum, stack) => sum + stack.vertexCount, 0),
          slicePolygons: sliceStacks.reduce((sum, stack) => sum + stack.polygonCount, 0),
          beams: beamSummaries.reduce((sum, beam) => sum + beam.beamCount, 0),
          balls: beamSummaries.reduce((sum, beam) => sum + beam.ballCount, 0),
          materialGroups: materialGroups.length,
          textures,
          attachments: attachments.length,
        },
        extensions: {
          slices: sliceStacks.length > 0,
          beamLattice: beamSummaries.length > 0,
          production:
            objects.some(
              (object) => object.uuid !== null || object.components.some((component) => component.uuid !== null),
            ) || buildItems.some((item) => item.uuid !== null),
          materials: materialGroups.some((group) => group.kind !== "texture-2d"),
          textures: textures > 0 || materialGroups.some((group) => group.kind === "texture-2d"),
        },
        resourceBounds,
        buildBounds,
        bounds: buildBounds,
        objects,
        buildItems,
        sliceStacks,
        materialGroups,
        attachments,
        validation: validationSummary(version, nonStrict, strict, findings),
      };
      return report;
    } finally {
      try {
        module.FS.unlink(virtualPath);
      } catch {
        // The virtual file may not exist if initialization failed.
      }
      safeDelete(reader);
      safeDelete(model);
      safeDelete(wrapper);
    }
  }
}
