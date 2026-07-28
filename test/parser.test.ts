import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ThreeMfInspector } from "../src/inspection/parser.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const inspect = async (name: string) => {
  const bytes = new Uint8Array(await readFile(fixture(name)));
  return new ThreeMfInspector().inspect(bytes, name);
};

describe("ThreeMfInspector with real files", () => {
  it("reports mesh and component resources", async () => {
    const report = await inspect("components.3mf");

    expect(report.counts.meshObjects).toBe(2);
    expect(report.counts.componentObjects).toBe(1);
    expect(report.counts.components).toBe(2);
    expect(report.counts.vertices).toBe(53);
    expect(report.counts.triangles).toBe(98);
    expect(report.objects.map((object) => object.resourceId)).toEqual([1, 2, 3]);
    expect(report.buildItems.map((item) => item.objectResourceId)).toEqual([3, 1]);
    expect(report.materialGroups[0]?.resourceId).toBe(4);
    expect(report.materialGroups[0]?.entries).toEqual([
      { index: 0, rgba: "#ff8000ff" },
      { index: 1, rgba: "#808080ff" },
    ]);
    expect(report.objects.some((object) => object.type === "components")).toBe(true);

    const componentObject = report.objects.find((object) => object.type === "components");
    expect(componentObject?.components[0]?.transform).toEqual([
      0.6427879929542542,
      0.766044020652771,
      0,
      -0.5341539978981018,
      0.4482089877128601,
      -0.7167909741401672,
      -0.549094021320343,
      0.4607439935207367,
      0.697288990020752,
      242.5030059814453,
      -130.3719940185547,
      72.47879791259766,
    ]);
  });

  it("decodes the model unit and distinguishes absent build transforms", async () => {
    const report = await inspect("cube.3mf");

    expect(report.unit).toEqual({ code: 1, name: "millimeter", symbol: "mm" });
    expect(report.buildItems[0]?.transform).toBeNull();
    expect(report.resourceBounds?.size).toEqual([10, 20, 30]);
    expect(report.buildBounds?.size).toEqual([130, 80, 110]);
    expect(report.bounds).toEqual(report.buildBounds);
    expect(report.extensions.production).toBe(true);
    expect(report.objects[0]?.uuid).toMatch(/^[0-9a-f-]{36}$/i);
    expect(report.validation).toMatchObject({
      compliant: true,
      preflightPassed: true,
      validator: { name: "lib3mf", level: "strict-reader" },
      findings: [],
    });
  });

  it("returns compliance diagnostics for an unreadable file", async () => {
    const bytes = new TextEncoder().encode("not a 3mf");
    const result = await new ThreeMfInspector().checkCompliance(bytes, "invalid.3mf");

    expect(result.parseable).toBe(false);
    expect(result.validation.compliant).toBe(false);
    expect(result.validation.findings).toContainEqual(
      expect.objectContaining({ severity: "error", code: "MODEL_UNREADABLE" }),
    );
  });

  it("reads actual slice statistics through indexed accessors", async () => {
    const report = await inspect("torus_sliced.3mf");

    expect(report.extensions.slices).toBe(true);
    expect(report.counts.sliceStacks).toBe(2);
    expect(report.counts.slices).toBe(50);
    expect(report.counts.sliceVertices).toBe(5362);
    expect(report.counts.slicePolygons).toBe(98);
    expect(report.sliceStacks[0]?.topZ).toBeTypeOf("number");
  });

  it(
    "aggregates a large beam lattice without materializing render geometry",
    async () => {
      const report = await inspect("octet_lattice.3mf");

      expect(report.extensions.beamLattice).toBe(true);
      expect(report.counts.meshObjects).toBe(14);
      expect(report.counts.beams).toBe(132440);
      expect(report.counts.vertices).toBe(25928);
      expect(JSON.stringify(report).length).toBeLessThan(100_000);
    },
    20_000,
  );

  it("does not call unsafe bulk vector bindings", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../src/inspection/parser.ts", import.meta.url)),
      "utf8",
    );

    expect(source).not.toMatch(/\.GetVertices\s*\(/);
    expect(source).not.toMatch(/\.GetBeams\s*\(/);
    expect(source).not.toMatch(/\.GetTriangles\s*\(/);
  });
});
