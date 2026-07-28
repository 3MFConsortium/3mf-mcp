import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ComplianceReport, InspectionReport, StoredModel } from "./types.js";
import { ThreeMfInspector } from "./parser.js";

export interface ModelStoreOptions {
  maxFileBytes?: number;
  maxModels?: number;
  ttlMs?: number;
  allowLocalPaths?: boolean;
}

export class ModelStore {
  readonly maxFileBytes: number;
  readonly maxModels: number;
  readonly ttlMs: number;
  readonly allowLocalPaths: boolean;

  private readonly inspector = new ThreeMfInspector();
  private readonly models = new Map<string, StoredModel>();

  constructor(options: ModelStoreOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? 100 * 1024 * 1024;
    this.maxModels = options.maxModels ?? 4;
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.allowLocalPaths = options.allowLocalPaths ?? false;
  }

  async loadPath(path: string): Promise<StoredModel> {
    const { bytes, fileName } = await this.readPath(path);
    return this.loadBytes(bytes, fileName);
  }

  async checkPath(path: string): Promise<ComplianceReport> {
    const { bytes, fileName } = await this.readPath(path);
    return this.inspector.checkCompliance(bytes, fileName);
  }

  private async readPath(path: string): Promise<{ bytes: Uint8Array; fileName: string }> {
    if (!this.allowLocalPaths) {
      throw new Error("Local path loading is disabled for this server transport.");
    }
    const absolutePath = resolve(path);
    const info = await stat(absolutePath);
    if (!info.isFile()) throw new Error(`Not a regular file: ${absolutePath}`);
    this.assertSize(info.size);
    const bytes = new Uint8Array(await readFile(absolutePath));
    this.assertSize(bytes.byteLength);
    return { bytes, fileName: basename(absolutePath) };
  }

  async loadBase64(data: string, fileName = "model.3mf"): Promise<StoredModel> {
    return this.loadBytes(this.decodeBase64(data), fileName);
  }

  async checkBase64(data: string, fileName = "model.3mf"): Promise<ComplianceReport> {
    return this.inspector.checkCompliance(this.decodeBase64(data), fileName);
  }

  private decodeBase64(data: string): Uint8Array {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw new Error("base64_data must be valid, padded base64.");
    }
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const estimatedBytes = Math.floor((data.length * 3) / 4) - padding;
    this.assertSize(estimatedBytes);
    const bytes = Uint8Array.from(Buffer.from(data, "base64"));
    this.assertSize(bytes.byteLength);
    return bytes;
  }

  async loadBytes(bytes: Uint8Array, fileName: string): Promise<StoredModel> {
    this.cleanup();
    this.assertSize(bytes.byteLength);
    const report = await this.inspector.inspect(bytes, fileName);
    const now = Date.now();
    const stored: StoredModel = {
      id: randomUUID(),
      loadedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      report,
    };
    this.models.set(stored.id, stored);
    this.evictOverflow();
    return stored;
  }

  get(id: string): StoredModel {
    this.cleanup();
    const model = this.models.get(id);
    if (!model) throw new Error(`Unknown or expired model id: ${id}`);
    return model;
  }

  list(): StoredModel[] {
    this.cleanup();
    return [...this.models.values()];
  }

  remove(id: string): boolean {
    return this.models.delete(id);
  }

  private assertSize(size: number): void {
    if (size <= 0) throw new Error("The 3MF file is empty.");
    if (size > this.maxFileBytes) {
      throw new Error(
        `File is ${size} bytes; the configured limit is ${this.maxFileBytes} bytes.`,
      );
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, model] of this.models) {
      if (Date.parse(model.expiresAt) <= now) this.models.delete(id);
    }
  }

  private evictOverflow(): void {
    while (this.models.size > this.maxModels) {
      const oldest = this.models.keys().next().value as string | undefined;
      if (!oldest) break;
      this.models.delete(oldest);
    }
  }
}

export const summaryView = (report: InspectionReport) => ({
  file: report.file,
  libraryVersion: report.libraryVersion,
  unit: report.unit,
  language: report.language,
  counts: report.counts,
  extensions: report.extensions,
  bounds: report.bounds,
  resourceBounds: report.resourceBounds,
  buildBounds: report.buildBounds,
  validation: {
    compliant: report.validation.compliant,
    preflightPassed: report.validation.preflightPassed,
    nonStrictWarningCount: report.validation.nonStrict.warnings.length,
    nonStrictErrorCount: report.validation.nonStrict.errors.length,
    strictWarningCount: report.validation.strict.warnings.length,
    strictErrorCount: report.validation.strict.errors.length,
  },
});
