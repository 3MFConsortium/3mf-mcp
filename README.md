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
- Create loopback 3MF Viewer sessions, address rendered resources by canonical
  model-resource ID, control camera/visibility/render modes, and capture PNGs.
- Review a model in one call, combining compliance and preflight findings with
  optional images from consistent camera views.

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

To visualize a loaded model, call `open_model_viewer`. Choose `viewer_mode` as
`url`, `system`, or `headless`. The page transfers the retained 3MF bytes to the
deployed viewer and applies an optional resource selection, isolation, camera
preset, and render mode. Use `control_model_viewer` for subsequent commands.
In headless mode the call waits until the model is rendered, and `capture.png`
returns the PNG directly as MCP image content so an agent can inspect it.

Reports expire after 30 minutes by default. The server retains at most four
reports and evicts the oldest report when the limit is exceeded.

To validate data that may be malformed, call `check_compliance` directly. It
returns diagnostics even when `load_model` cannot parse the file.

For a useful first look at a loaded file, call `review_model`. It brings the
main inspection results together, identifies anything that needs attention,
and can render isometric, front, and top views for visual confirmation. This is
usually a better starting point than calling each inspection tool separately.

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
| `review_model` | Combine structural checks, findings, and optional standard-view images. |
| `open_model_viewer` | Create a temporary local interactive viewer session. |
| `control_model_viewer` | Select/isolate resources, control camera/rendering, or capture a PNG. |
| `get_viewer_session` | Check viewer connection and render readiness. |
| `get_viewer_result` | Retrieve a command result that was initially pending. |
| `close_model_viewer` | Delete a viewer session and its temporary captures. |

Paginated tools accept `offset` and `limit`. The default limit is 50 and the
maximum is 100. A non-null `nextOffset` identifies the next page.

## Bounds

`inspect_model` returns two different bounds:

- `resourceBounds` is the union of untransformed mesh-resource bounds.
- `buildBounds` recursively applies component and build-item transforms and
  describes the printable build.

The deprecated `bounds` field currently aliases `buildBounds`.

## Model review

`review_model` is the high-level entry point for answering a simple question:
does this model look healthy, both in its package structure and on screen?

The tool always returns the model summary, compliance and preflight findings,
object summaries, and build items. Its status is one of `passed`,
`needs_attention`, or `failed`. A passing status means the checks available to
this server found no problem. It is not a guarantee that every printer or
slicer will accept the file.

Visual review is enabled by default. The server opens a temporary headless
viewer, waits for the model to render, captures the requested views, and closes
the browser session when it is done. The default views are `isometric`,
`front`, and `top`. You can request between one and six views from `front`,
`back`, `left`, `right`, `top`, `bottom`, and `isometric`.

The inputs are:

- `model_id`, the UUID returned by `load_model`
- `include_visuals`, which defaults to `true`
- `views`, which defaults to `isometric`, `front`, and `top`
- `resource_id` and `isolate`, for focusing the review on one resource
- `wireframe` and `edges`, for controlling how geometry is drawn

The response includes a `visuals` section showing whether images were requested
and completed, along with image metadata and browser diagnostics. Captured PNGs
are also returned as MCP image content so the calling agent can inspect them
directly. If Chrome, the viewer deployment, or WebGL is unavailable, the visual
error is reported there while the structural review is still returned.

Model loading has no geometry-duration deadline. While a complex model is
loading, the viewer reports its current stage, available resource and triangle
counters, and a heartbeat through the session's `loadProgress` field.

Set `MCP_CHROME_PATH` when Chrome or Chromium is installed somewhere the server
cannot discover automatically. Set `MCP_VIEWER_URL` to use a different viewer
deployment. These settings are shared with the lower-level viewer tools.

## Viewer sessions

Viewer sessions use the control API introduced in 3MF Viewer 0.32.0. By
default the broker embeds `https://3mfviewer.com`; set `MCP_VIEWER_URL` or pass
`viewer_url` to `open_model_viewer` to use another deployment.

The broker binds to a random `127.0.0.1` port and returns a UUID-protected URL.
It retains the original 3MF package bytes for the lifetime of the loaded model,
serves them only to that local session, and removes session captures when
`close_model_viewer` is called or the 30-minute session expires.

Useful `control_model_viewer` commands include:

- `scene.getManifest`, `scene.select`, `scene.setVisibility`, and `scene.isolate`
- `camera.fit`, `camera.setPreset`, `camera.get`, and `camera.set`
- `render.setOptions`, `slice.setIndex`, and `beamLattice.setMode`
- `capture.png`, whose result contains a temporary loopback `captureUrl`

Viewer modes are:

- `url` (default): return the loopback URL without launching anything.
- `system`: open the loopback URL in the operating system's default browser.
- `headless`: launch and control the installed Chrome/Chromium with
  `playwright-core`, wait for `renderReady`, and collect browser errors.

Set `MCP_VIEWER_MODE` to choose a server-wide default or pass `viewer_mode` for
one call. `open_browser` remains as a compatibility alias for `system`/`url`.
Headless mode uses common system Chrome paths or `MCP_CHROME_PATH`; the
executable path is server configuration and is not exposed as an MCP tool input.

This broker is designed for a local stdio MCP client. A loopback URL produced
by a remotely hosted MCP process is local to that remote host and will not be
reachable from the user's browser without an explicit proxy or tunnel. HTTP
deployments should normally use `headless` mode unless the loopback page is
explicitly proxied or tunneled.

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
- `MCP_VIEWER_URL` (default `https://3mfviewer.com`)
- `MCP_VIEWER_MODE` (`url`, `system`, or `headless`; default `url`)
- `MCP_CHROME_PATH` (optional Chrome/Chromium executable for headless mode)

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
