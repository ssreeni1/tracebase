# Security Policy

Tracebase is local-first agent observability software.

## Security Model

- Data is stored under `TRACE_HOME`, defaulting to `~/.traces`.
- Raw event blobs are encrypted at rest with a local key file.
- The dashboard binds to `127.0.0.1` by default and refuses non-loopback hosts unless `--allow-remote` or `TRACEBASE_ALLOW_REMOTE=1` is explicitly set.
- `tracebase serve` is read-only for trace intake by default. Live POST intake requires `tracebase agent`, `tracebase serve --allow-intake`, or `TRACEBASE_ALLOW_INTAKE=1`.
- State-changing HTTP requests reject browser `Origin` headers that do not exactly match the Tracebase server origin. CLI/curl requests without an `Origin` header remain supported.
- HTTP responses include defensive browser headers such as `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, and `Cross-Origin-Resource-Policy`.
- Tracebase does not intercept network traffic.
- Tracebase does not attempt to recover hidden/private model reasoning.
- The dashboard summary button invokes only local `codex` or `claude` CLI summary runners through the same-origin API; browser requests cannot override the executable or arguments.
- Normal API responses and redacted exports use the redaction layer.
- Raw exports are intentionally possible, but should be treated as sensitive local data. The HTTP raw export path requires the `x-tracebase-raw-export: 1` header so raw export is not a linkable GET.
- The raw blob HTTP API is disabled by default. Set `TRACEBASE_ALLOW_RAW_BLOB_API=1` only for local debugging where decrypted raw event reads over localhost are intended.
- The MCP server is read-only and exposes only trace search plus canonical trace/span listing.
- MCP tool schemas reject undeclared arguments so clients cannot smuggle hidden command overrides through extension-tool calls.

## Reporting Issues

Do not include secrets or raw trace exports in public issues. Provide a minimal reproduction, affected command/API, expected behavior, and observed behavior.

## Release Checklist

- Run `npm test`.
- Run `npm run smoke` when iterating on core CLI/API behavior.
- Run `npm run test:stress`.
- Run `npm run test:ui`.
- Run `npm run test:package`.
- Run `npm run test:install`.
- Run `npm run audit:release`.
- Run `npm audit --omit=dev`.
- Review `npm pack --dry-run` output.
- Verify `tracebase serve` binds to localhost.
- Verify dashboard responses include a restrictive `Content-Security-Policy`.
- Verify `tracebase serve` rejects live intake unless explicitly enabled.
- Verify state-changing HTTP endpoints reject cross-origin browser requests, including other loopback ports.
- Verify static serving does not disclose paths outside the packaged dashboard.
- Verify remote binding requires an explicit opt-in flag.
- Verify raw export requires explicit local intent.
- Verify MCP exposes only read-only trace tools.
- Verify launchd watcher labels use the public `io.tracebase.watch` label, with legacy pre-release labels handled only for cleanup/status compatibility.
