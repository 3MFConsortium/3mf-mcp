export interface Diagnostic {
  kind: string;
  message: string;
  code?: number | string;
}

export interface ValidationMode {
  valid: boolean;
  warnings: Diagnostic[];
  errors: Diagnostic[];
}

export interface PreflightFinding {
  severity: "warning" | "error";
  code: string;
  message: string;
  resourceId?: number;
}

export interface ValidationSummary {
  compliant: boolean;
  preflightPassed: boolean;
  validator: {
    name: "lib3mf";
    version: string;
    level: "strict-reader";
  };
  nonStrict: ValidationMode;
  strict: ValidationMode;
  findings: PreflightFinding[];
}

export interface Bounds3d {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

export interface BeamLatticeSummary {
  beamCount: number;
  ballCount: number;
  radius: { min: number | null; max: number | null };
  length: { min: number | null; max: number | null };
  capModes: Record<string, number>;
  ballMode: string;
  defaultBallRadius: number | null;
}

export interface MeshSummary {
  vertexCount: number;
  triangleCount: number;
  manifoldAndOriented: boolean | null;
  bounds: Bounds3d | null;
  beamLattice: BeamLatticeSummary | null;
  sliceStackResourceId: number | null;
}

export interface ComponentReference {
  objectResourceId: number | null;
  uuid: string | null;
  transform: number[] | null;
}

export interface ObjectSummary {
  resourceId: number | null;
  uniqueResourceId: number | null;
  uuid: string | null;
  name: string | null;
  partNumber: string | null;
  type: "mesh" | "components" | "other";
  mesh: MeshSummary | null;
  components: ComponentReference[];
}

export interface BuildItemSummary {
  index: number;
  objectResourceId: number | null;
  uuid: string | null;
  transform: number[] | null;
  metadata: MetadataEntry[];
}

export interface MetadataEntry {
  key: string | null;
  name: string | null;
  namespace: string | null;
  type: string | null;
  value: string | null;
  mustPreserve: boolean;
}

export interface SliceStackSummary {
  resourceId: number | null;
  bottomZ: number | null;
  topZ: number | null;
  sliceCount: number;
  vertexCount: number;
  polygonCount: number;
  referencedStackCount: number;
}

export interface MaterialGroupSummary {
  resourceId: number | null;
  kind: "base-material" | "color" | "texture-2d";
  count: number;
  entries: Array<{ index: number; name?: string; rgba?: string }>;
}

export interface AttachmentSummary {
  index: number;
  path: string | null;
  relationshipType: string | null;
  contentType: string | null;
  byteLength: number | null;
}

export interface InspectionReport {
  format: "3MF";
  file: {
    name: string;
    byteLength: number;
    sha256: string;
  };
  libraryVersion: string;
  unit: { code: number | null; name: string; symbol: string };
  language: string | null;
  metadata: MetadataEntry[];
  counts: {
    objects: number;
    meshObjects: number;
    componentObjects: number;
    buildItems: number;
    vertices: number;
    triangles: number;
    components: number;
    sliceStacks: number;
    slices: number;
    sliceVertices: number;
    slicePolygons: number;
    beams: number;
    balls: number;
    materialGroups: number;
    textures: number;
    attachments: number;
  };
  extensions: {
    slices: boolean;
    beamLattice: boolean;
    production: boolean;
    materials: boolean;
    textures: boolean;
  };
  resourceBounds: Bounds3d | null;
  buildBounds: Bounds3d | null;
  /** @deprecated Use buildBounds. */
  bounds: Bounds3d | null;
  objects: ObjectSummary[];
  buildItems: BuildItemSummary[];
  sliceStacks: SliceStackSummary[];
  materialGroups: MaterialGroupSummary[];
  attachments: AttachmentSummary[];
  validation: ValidationSummary;
}

export interface ComplianceReport {
  file: InspectionReport["file"];
  parseable: boolean;
  extensions: InspectionReport["extensions"] | null;
  validation: ValidationSummary;
}

export interface StoredModel {
  id: string;
  loadedAt: string;
  expiresAt: string;
  report: InspectionReport;
  /** Original package bytes retained for local viewer sessions. */
  sourceBytes: Uint8Array;
}
