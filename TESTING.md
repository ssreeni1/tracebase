# Testing Tracebase Locally

This guide covers the checks to run before trusting a Tracebase change or preparing a public release.

## Requirements

| Requirement | Notes |
| --- | --- |
| Node.js 24+ | Required for the built-in `node:sqlite` module. |
| npm dependencies | Run `npm install`. |
| Localhost binding | Needed for dashboard/API tests. |
| Optional CLIs | `codex` or `claude` are useful for real summary-runner tests. |

Use a disposable store when manually testing commands:

```sh
export TRACE_HOME="$(mktemp -d)"
```

## Automated Gates

| Command | When To Run | Coverage |
| --- | --- | --- |
| `npm run check` | Small JS edits | Syntax for packaged source and tests. |
| `npm run audit:release` | Release-sensitive edits | Metadata, docs, security defaults, UI assets, package shape. |
| `npm run smoke` | CLI/API/storage edits | Import, search, redaction, export, API, MCP, watcher, bootstrap, wrappers. |
| `npm run test:stress` | Storage/index edits | Concurrent writes, rebuilds, count/search consistency. |
| `npm run test:ui` | Dashboard edits | Production UI build plus served UI/API smoke. |
| `npm run test:e2e-local` | Workflow edits | Fixture-backed dashboard, export, summary-runner metadata, intake checks. |
| `npm run test:e2e-release` | OSS release | End-to-end CLI/API/MCP/export/privacy/live-intake/rendered-dashboard/package smoke. |
| `npm run test:package` | Packaging edits | `npm pack --dry-run` contents. |
| `npm run test:install` | Public package edits | Temp install, binary behavior, API surface. |
| `npm test` | Release/handoff | Runs the full local gate. |
| `npm audit --omit=dev` | Release/handoff | Runtime dependency audit against npm. |

## Manual CLI Workflow

```sh
export TRACE_HOME="$(mktemp -d)"
node bin/tracebase.js init
node bin/tracebase.js import-file claude test/fixtures/claude.jsonl
node bin/tracebase.js import-file codex test/fixtures/codex.jsonl
node bin/tracebase.js health
node bin/tracebase.js stats
node bin/tracebase.js recent --limit 5
```

Expected:

- `init` creates `TRACE_HOME`, a `key` file, and encrypted store directories.
- `health` reports local capture state and does not claim hidden/private reasoning capture.
- `stats` shows fixture event/session counts.
- `recent` returns meaningful events with noisy tool/token events filtered.
- `import-file` imports only the named fixture; `import` scans default local Codex and Claude transcript sources.

## Manual Dashboard Workflow

```sh
npm run build
node bin/tracebase.js serve --port 18427
```

Open `http://127.0.0.1:18427`.

Check:

- The page loads without a missing-dashboard warning.
- Provider, type, CWD, text query, time range, sort, and order controls work.
- Selecting a session updates events, trace tree, and cached summary area.
- `Export session` and `Export filtered` download zip bundles.
- Raw export requires checking `unlock raw export`.
- `Summarize` is disabled when the selected local runner is unavailable.

Useful API probes:

```sh
curl -s http://127.0.0.1:18427/api/health
curl -s http://127.0.0.1:18427/api/sessions?limit=5
curl -s http://127.0.0.1:18427/api/events?limit=5
curl -s http://127.0.0.1:18427/api/summary-runners
```

Expected security defaults:

- `/api/health` has `"intakeEnabled": false`.
- `/api/summary-runners` does not expose executable paths or commands.
- `POST /api/events` returns `403` unless intake is explicitly enabled.

## Live Intake Workflow

```sh
export TRACE_HOME="$(mktemp -d)"
node bin/tracebase.js agent --port 18427
```

In another terminal:

```sh
curl -s http://127.0.0.1:18427/api/events \
  -H 'content-type: application/json' \
  -d '{"id":"manual-event-1","provider":"test","session_id":"manual-session","type":"note","message":"manual intake works"}'
```

Then verify:

```sh
node bin/tracebase.js search "manual intake"
curl -s "http://127.0.0.1:18427/api/events?q=manual%20intake"
```

Expected:

- The event is accepted only in `agent` mode or `serve --allow-intake`.
- Search finds the redacted/indexed event.

## Export Workflow

Redacted export:

```sh
node bin/tracebase.js export --session-id SESSION_ID --out tracebase-export.zip
```

Raw export:

```sh
node bin/tracebase.js export --session-id SESSION_ID --raw --out tracebase-raw-export.zip
```

HTTP raw export requires an explicit header:

```sh
curl -fL "http://127.0.0.1:18427/api/export?sessionId=SESSION_ID&raw=1" \
  -H 'x-tracebase-raw-export: 1' \
  -o tracebase-raw-export.zip
```

Expected:

- Redacted exports include `manifest.json`, `events.jsonl`, `sessions.jsonl`, `traces.jsonl`, `spans.jsonl`, `session_metrics.jsonl`, `annotations.jsonl`, and summaries when present.
- Incident exports with `--incident` include `incident.json` and remain redacted by default.
- Raw exports include `raw.jsonl`.
- Raw HTTP export without `x-tracebase-raw-export: 1` returns `403`.

## Run Intelligence Workflow

```sh
node bin/tracebase.js analyze --session-id SESSION_ID
curl -s "http://127.0.0.1:18427/api/session-metrics?limit=50"
curl -s "http://127.0.0.1:18427/api/trace-diff?sessionId=SESSION_ID"
node bin/tracebase.js run-compare --base-session-id BASE --target-session-id TARGET
```

Expected:

- Session metrics report token totals (input, output, cache, reasoning) when model and usage data are present.
- Session metrics include context-waste counts plus quality, efficiency, and risk scores.
- Trace diff reports whether indexed rows match the source transcript.

## Summary Runner Workflow

```sh
node bin/tracebase.js doctor
curl -s http://127.0.0.1:18427/api/summary-runners
```

For real summaries, use an existing session id:

```sh
node bin/tracebase.js summarize --session-id SESSION_ID --runner codex
node bin/tracebase.js summarize --session-id SESSION_ID --runner claude
```

Expected:

- Unknown runners are rejected.
- Browser/API requests cannot override command or args.
- Summaries are generated only from visible trace artifacts.

## Security Checks

```sh
npm run smoke
npm run audit:release
npm audit --omit=dev
```

Remote bind should fail without explicit opt-in:

```sh
node bin/tracebase.js serve --host 0.0.0.0 --port 18427
```

Raw blob API should fail by default:

```sh
curl -i http://127.0.0.1:18427/api/blob/SOME_BLOB_ID
```

Cross-origin state-changing requests should fail:

```sh
curl -i http://127.0.0.1:18427/api/events \
  -H 'content-type: application/json' \
  -H 'origin: https://example.com' \
  -d '{"id":"blocked","provider":"test","session_id":"blocked"}'
```

## Package Install Verification

Automated:

```sh
npm run test:install
```

Manual equivalent:

```sh
npm pack
tmp="$(mktemp -d)"
npm install --prefix "$tmp" ./tracebase-local-*.tgz
"$tmp/node_modules/.bin/tracebase" --help
```
