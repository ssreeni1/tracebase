# Tracebase

Secure, local-first trace capture and inspection for Codex and Claude agent sessions.

Tracebase imports local agent transcripts, encrypts raw events at rest, builds a searchable local index, and serves a localhost dashboard for debugging what happened in an agent run. It is designed for developer workstations: no network interception, no hidden reasoning capture, and no remote service required.

Most LLM observability tools start from application SDKs, hosted gateways, or OpenTelemetry pipelines. Tracebase starts from the local coding-agent logs developers already have, then turns those runs into auditable engineering traces: what happened, what failed, what recovered, what got expensive, and what is safe to share.

## At A Glance

| Capability | What You Get |
| --- | --- |
| Local capture | Import Codex and Claude JSONL transcripts, poll for new events, or use wrappers/hooks for future runs. |
| Private storage | Raw events are AES-256-GCM encrypted under `TRACE_HOME`; searchable metadata is redacted. |
| Dashboard | Browse sessions, events, canonical traces/spans, summaries, and exports at `127.0.0.1`. |
| Live intake | Opt-in local HTTP intake for custom events and Datadog LLMObs-style spans. |
| Exports | Redacted zip bundles by default; raw exports require explicit local intent. |
| Run intelligence | Analyze sessions for failures, resteers, context waste, repeated commands, redactions, token/cost rollups, and run scorecards. |
| Local integrations | CLI, CommonJS API, MCP, bootstrap instructions, shell wrappers, and launchd watcher support. |

## What You Can Answer

Tracebase makes agent work inspectable after the fact. Use it to answer:

| Question | Tracebase Signal |
| --- | --- |
| Did the agent actually run tests? | Tool commands, exit status, test output summaries, and session scorecards. |
| Where did the run get stuck? | Failure, loop, resteer, recovery, repeated-command, and context-waste annotations. |
| What did this run cost? | Model, token, cache, reasoning, and estimated USD rollups when transcripts expose usage. |
| Which files or tools mattered? | Structured tool metadata, touched-file hints, canonical spans, and searchable events. |
| Is this safe to share? | Redacted exports, incident packets, redaction counts, and explicit raw-export gates. |
| Did one run improve on another? | `run-compare` quality, failure, waste, token, cost, and risk deltas. |

Context-waste detection is intentionally practical rather than mystical: it catches repeated searches, repeated commands, large outputs, and other patterns that burn context without clearly moving the task forward. Some expensive actions are still necessary, such as real UI automation or final release logs; the scorecard is meant to make that tradeoff visible.

## Install

| Requirement | Version |
| --- | --- |
| Node.js | Node.js 24 or newer |
| npm | Bundled with Node |

```sh
npm install -g tracebase-local
tracebase init
tracebase import
tracebase serve
```

Open `http://127.0.0.1:7331`.

The npm package is `tracebase-local`; it installs `tracebase`, `traces`, `tcodex`, and `tclaude`.

## What It Captures

| Source | Included |
| --- | --- |
| Codex transcripts | Existing JSONL sessions from `~/.codex/sessions/**/*.jsonl`. |
| Claude Code transcripts | Existing JSONL sessions from `~/.claude/projects/**/*.jsonl`. |
| Claude hooks | Prompt/tool/session lifecycle payloads when configured. |
| Wrappers | Invocation start/end metadata for `tcodex` and `tclaude`. |
| Live intake | Explicit POSTed events and spans when `tracebase agent` is running. |

Tracebase records transcript-visible prompts, assistant messages, exposed reasoning summaries, tool calls, tool results, cwd, timestamps, approvals/errors when present, and raw provider transcript events. It does not capture hidden/private model chain-of-thought unless a provider explicitly emits that data.

## Privacy Defaults

| Boundary | Default |
| --- | --- |
| Store location | `~/.traces`, override with `TRACE_HOME=/path/to/store`. |
| Raw data | Encrypted locally with a generated key file. |
| Dashboard bind | `127.0.0.1`; remote bind requires `--allow-remote`. |
| Intake | Disabled in `tracebase serve`; enabled by `tracebase agent` or `--allow-intake`. |
| Raw blob API | Disabled unless `TRACEBASE_ALLOW_RAW_BLOB_API=1`. |
| Raw HTTP export | Requires `x-tracebase-raw-export: 1`. |
| Hidden reasoning | Not captured by design. |

To delete local Tracebase data:

```sh
tracebase watch-uninstall
rm -rf ~/.traces
```

Set `TRACE_KEY` to a base64-encoded 32-byte key only when you need to manage encryption externally.

## Quick Workflows

| Goal | Commands |
| --- | --- |
| Backfill and browse | `tracebase import` then `tracebase serve` |
| Print Codex bootstrap instructions | `tracebase bootstrap --agent codex` |
| Print Claude bootstrap instructions | `tracebase bootstrap --agent claude` |
| Write agent instructions | `tracebase install-instructions --agent codex --target ./TRACEBASE_AGENT.md` |
| Always-on macOS capture | `tracebase watch-install` then `tracebase watch-status` |
| Live local intake | `tracebase agent --port 7331` |
| Check capture health | `tracebase health` and `tracebase doctor` |
| Export a redacted bundle | `tracebase export --session-id ID --out trace.zip` |
| Pipe an export intentionally | `tracebase export --session-id ID --stdout > trace.zip` |
| Export raw local data | `tracebase export --session-id ID --raw --out trace-raw.zip` |
| Export a safe incident packet | `tracebase export --session-id ID --incident --out trace-incident.zip` |
| Inspect token/cost rollups | `tracebase analyze` then `tracebase costs --session-id ID` |
| Compare analyzed runs | `tracebase run-compare --base-session-id A --target-session-id B` |
| Generate a local summary | `tracebase summarize --session-id ID --runner codex` |
| Start MCP | `tracebase mcp` |

## CLI Overview

| Area | Commands |
| --- | --- |
| Setup | `init`, `bootstrap`, `install-instructions`, `shell-init`, `doctor` |
| Capture | `import`, `import-file`, `watch`, `watch-install`, `watch-status`, `watch-uninstall`, `hook`, `install-claude-hooks` |
| Inspect | `stats`, `health`, `recent`, `search`, `show`, `decision-log`, `trace-diff`, `run-compare`, `traces-list`, `spans`, `costs` |
| Dashboard/API | `serve`, `agent` |
| Export/summary | `export`, `summarize` |
| Observability | `analyze`, `llmobs-spans`, `llmobs-trace`, `net-snapshot` |
| MCP | `mcp` |

`tracebase doctor` reports paths, capture coverage, watcher state, and Codex/Claude CLI availability. Run `tracebase --help` for full options.

## Additional CLI Utilities

| Utility | Purpose |
| --- | --- |
| `traces search <query>` | Print matching indexed trace events as JSONL. |
| `traces show <blobId>` | Decrypt and print one raw local event. |
| `traces hook-config` | Print Claude Code settings JSON for trace hooks. |
| `traces shell-init` | Print shell aliases for this checkout. |

## Dashboard and API

`tracebase serve` runs a read-only localhost dashboard. `tracebase agent` serves the same UI with local intake enabled.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Capture health, event counts, and intake state. |
| `GET /api/sessions` | Filtered session list. |
| `GET /api/events` | Redacted indexed event search. |
| `GET /api/traces`, `GET /api/spans` | Canonical trace/span projection. |
| `GET /api/llmobs/traces`, `GET /api/llmobs/spans` | Datadog LLMObs-compatible envelopes. |
| `POST /api/events`, `POST /api/spans`, `POST /api/intake` | Opt-in live intake. |
| `GET /api/export` | Redacted or explicitly raw zip export. |
| `GET /api/costs`, `GET /api/session-metrics` | Analyzed token/cost and run scorecard rollups. |
| `GET /api/trace-diff` | Compare a session source transcript against indexed rows. |
| `GET /api/run-compare` | Compare analyzed scorecards for two sessions. |
| `GET/POST /api/summaries/session/:id` | Cached or generated local session summaries. |

State-changing browser requests reject `Origin` headers that do not exactly match the Tracebase server origin. CLI and curl requests without an `Origin` header remain supported.
For summaries, browser-supplied command overrides are ignored; the local server invokes only allowlisted `codex` or `claude` runners.

## Programmatic API

```js
const {
  TraceStore,
  buildExportZip,
  createServer,
  redactText
} = require("tracebase-local");

const store = new TraceStore();
store.init();
console.log(store.healthStats());
```

The package exports storage, server, export, summary, redaction, normalization, LLMObs, and MCP helpers.

## MCP

```toml
[mcp_servers.tracebase]
command = "node"
args = ["/absolute/path/to/bin/traces.js", "mcp"]
```

The MCP server is read-only and exposes trace search plus canonical trace/span listing. It intentionally does not expose write tools in the OSS build.

## Development

```sh
npm install
npm test
npm audit --omit=dev
```

For the full local checklist, see [TESTING.md](TESTING.md).

| Command | Purpose |
| --- | --- |
| `npm run check` | Syntax check packaged JS. |
| `npm run audit:release` | Release invariant audit. |
| `npm run smoke` | Core CLI/API/storage smoke tests. |
| `npm run test:stress` | Concurrent write and index rebuild stress test. |
| `npm run test:ui` | Build dashboard and smoke served UI/API. |
| `npm run test:e2e-local` | Fixture-backed dashboard/export/intake E2E. |
| `npm run test:e2e-release` | Release-grade E2E for privacy, MCP, exports, comparison, intake, and rendered UI. |
| `npm run test:package` | `npm pack --dry-run`. |
| `npm run test:install` | Install the packed package in a temp project and verify CLI/API behavior. |

## Repository Docs

| File | Purpose |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Storage, ingestion, API, and security boundaries. |
| [SECURITY.md](SECURITY.md) | Security model, issue guidance, and release checklist. |
| [TESTING.md](TESTING.md) | Manual and automated validation workflows. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Local development standards. |
| [NOTICE.md](NOTICE.md) | Third-party notice summary. |

## License

MIT. See [LICENSE](LICENSE).
