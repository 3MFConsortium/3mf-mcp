# 3MF MCP

An MCP server for inspecting and validating 3MF files with the official
`@3mfconsortium/lib3mf` WebAssembly package.

This is an alpha release. It is read-only: files are parsed locally, raw
geometry is not returned to the client, and the server does not call an LLM.

## Features

- Load a local 3MF path over stdio or base64 data over either transport.
- Check lib3mf strict/non-strict compliance, including unreadable files.
- Report deterministic preflight findings for empty builds, empty or
  non-manifold meshes, dangling references, and component cycles.
- Inspect model-resource IDs, UUIDs, units, language, counts, and extensions.
- Distinguish raw resource bounds from transformed printable build bounds.
- Traverse object resources, components, build items, and transforms.
- Inspect model/build-item metadata, materials, colors, textures, and package
  attachments.
- Summarize slice stacks and beam lattices without returning large raw arrays.
- Bound large MCP responses with pagination.
- Expire and evict temporary in-memory reports.

## Requirements

- Node.js 22 or newer

## Install and run

From a source checkout:

```bash
npm ci
npm run build
npm start
```

The default transport is stdio. An MCP client configuration can launch it as:

```json
{
  "mcpServers": {
    "3mf": {
      "command": "node",
      "args": ["/absolute/path/to/3mf-mcp/dist/cli.js"]
    }
  }
}
```

After npm publication, the executable is also available as `3mf-mcp` from the
`@3mfconsortium/mcp` package.

## Typical workflow

1. Call `load_model` with a local path or base64 data.
2. Use the returned `modelId` with the inspection tools.
3. Call `unload_model` when the report is no longer needed.

Reports expire after 30 minutes by default. The server retains at most four
reports and evicts the oldest report when the limit is exceeded.

To validate data that may be malformed, call `check_compliance` directly. It
returns diagnostics even when `load_model` cannot parse the file.

## Tools

| Tool | Purpose |
| --- | --- |
| `load_model` | Parse a 3MF file and retain a compact temporary report. |
| `list_models` | List active report IDs and summaries. |
| `unload_model` | Remove one retained report. |
| `inspect_model` | Return counts, units, extensions, bounds, and validation summary. |
| `check_compliance` | Validate a loaded model, path, or base64 payload. |
| `validate_model` | Return the complete stored validation and preflight result. |
| `list_objects` | List paginated object-resource summaries. |
| `inspect_object` | Inspect one object and paginate its component references. |
| `list_build_items` | List paginated build items and transforms. |
| `inspect_metadata` | Page model metadata or one build item's metadata. |
| `inspect_materials` | List material groups or page one group's entries. |
| `inspect_package` | List package attachments without returning their streams. |
| `inspect_slices` | Summarize slice-stack Z ranges and contour counts. |
| `inspect_beam_lattices` | Summarize beam/ball counts, radii, lengths, and cap modes. |

Paginated tools accept `offset` and `limit`. The default limit is 50 and the
maximum is 100. A non-null `nextOffset` identifies the next page.

## Bounds

`inspect_model` returns two different bounds:

- `resourceBounds` is the union of untransformed mesh-resource bounds.
- `buildBounds` recursively applies component and build-item transforms and
  describes the printable build.

The deprecated `bounds` field currently aliases `buildBounds`.

## Compliance semantics

`validation.compliant` means the file was accepted by the bundled lib3mf
strict reader. The result includes the validator name/version and both strict
and non-strict diagnostics.

`validation.preflightPassed` is separate. It covers deterministic checks
implemented by this server, including:

- missing build items or mesh resources
- empty mesh resources
- non-manifold or inconsistently oriented triangle meshes
- dangling component/build references
- component cycles reachable from the build

This is not a guarantee that every printer, slicer, or downstream profile will
accept the file. Advanced material models, volumetric data, level sets,
implicit functions, and vendor extensions are not yet deeply inspected.

## Experimental HTTP transport

Start the Streamable HTTP endpoint with:

```bash
npm start -- --http
```

The MCP endpoint is `http://127.0.0.1:3000/mcp`; health information is at
`/health`. Local path loading is disabled for HTTP by default, so remote clients
should send base64 data.

Configuration:

- `HOST` and `PORT`
- `MCP_MAX_FILE_BYTES` (default 100 MiB)
- `MCP_MAX_MODELS` (default 4)
- `MCP_MODEL_TTL_MS` (default 30 minutes)
- `MCP_ALLOW_LOCAL_PATHS` (do not enable for an untrusted HTTP service)

HTTP mode has bounded idle sessions, but it does not include authentication,
TLS, tenant isolation, or rate limiting. Do not expose it publicly without
those controls. Compressed file size also does not bound decompressed geometry,
so deployments must enforce process-level CPU and memory limits.

## Development

```bash
npm ci
npm run check
npm test
npm run build
npm audit --omit=dev
npm pack --dry-run
```

Real fixtures cover component transforms, slices, large beam lattices,
materials/colors, stdio-style in-memory MCP calls, and an end-to-end HTTP MCP
session.

Large vertex, triangle, beam, and contour arrays are intentionally omitted.
Indexed lib3mf accessors are used because bulk `std::vector` getters in the
current Emscripten binding are unsafe for these workloads.

## License

BSD-2-Clause. See [LICENSE](LICENSE).
