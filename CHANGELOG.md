# Changelog

## 0.1.0-alpha.1

- Added local stdio and experimental Streamable HTTP MCP transports.
- Added compact 3MF inspection for objects, build items, metadata, materials,
  attachments, slices, and beam lattices.
- Added lib3mf strict/non-strict compliance diagnostics and deterministic
  preflight findings, including diagnostics for unreadable files.
- Added model-resource IDs, transformed build bounds, UUIDs, units, and
  extension summaries.
- Added bounded pagination, temporary report retention, file-size limits, and
  real-file integration tests.
- Added loopback 3MF Viewer 0.32.1 sessions with resource selection/isolation,
  camera and render controls, compact scene manifests, and PNG capture relay.
- Added configurable URL-only, system-browser, and Playwright-driven headless
  viewer modes; headless captures are returned directly as MCP image content.
- Added `review_model`, a high-level structural and compliance review with
  optional isometric, orthographic, and resource-isolated PNG views. Visual
  failures are reported without discarding the structural findings.
- Relayed viewer loading stages, counters, and heartbeats without imposing a
  geometry-dependent render deadline.
- Declared the optional WASM runtime peers needed for reproducible `npm ci`
  installs in clean environments.
