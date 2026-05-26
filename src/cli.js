"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { getTraceHome, getDefaultSources } = require("./config");
const { TraceStore } = require("./storage");
const { importAll, importJsonlFile } = require("./importers");
const { listen } = require("./server");
const { installClaudeHooks, printClaudeHookInstall, runHookCommand } = require("./hook");
const { analyzeStore } = require("./analyze");
const { distillWorkflows } = require("./workflow-intel");
const { installWatch, uninstallWatch, watchStatus } = require("./daemon");
const { SELF_TRACE_PROMPT, makeSelfTraceEvent, parseSelfTraceInput } = require("./self-trace");
const { buildDecisionLog } = require("./decision-log");
const { diffSourceFile, diffSession } = require("./trace-diff");
const { takeNetSnapshot, makeNetSnapshotEvent } = require("./net-snapshot");
const { evaluateJudge, makeBehaviorSpec, makeJudgeSpec } = require("./judges");
const { makeBucketSpec, makeDatasetSpec, runBucket } = require("./datasets");
const { evaluateRule, makeRuleSpec } = require("./rules");
const { compareDatasets, compareSessions } = require("./regression");
const { makeConfigCommit } = require("./registry");
const { runMcpServer } = require("./mcp");
const { installTemplate, listTemplates } = require("./templates");
const { listLlmObsSpans, llmObsTraceFromCanonical } = require("./llmobs");
const { redactText } = require("./redact");
const { bootstrapText, installInstructions } = require("./bootstrap");
const { buildExportZip } = require("./export");
const { availableSummaryRunners, latestSummary, listSummaries, summarizeSession } = require("./summaries");
const { wrapperDiagnostics } = require("./wrap");

function usage() {
  return `Usage: tracebase <command> [options]

The "traces" binary remains supported as a compatibility alias.

Commands:
  init                  Create the encrypted local trace store
  bootstrap             Print Tracebase bootstrap and agent instructions
  install-instructions  Write Tracebase agent instructions to an explicit target
  import [filters]      Backfill Codex and Claude JSONL transcripts
  watch [filters]       Poll transcript directories and import recent changes
  watch-install         Install a persistent macOS launchd trace watcher
  watch-status          Show persistent watcher status
  watch-uninstall       Remove persistent watcher
  index                 Rebuild SQLite/FTS query index from JSONL logs
  analyze               Annotate sessions for failures, resteers, loops, recoveries
  distill               Extract workflow lessons from annotations
  stats                 Print trace store metrics
  health                Print capture health and known coverage limits
  recent                Print recent meaningful events as JSONL
  decision-log          Print visible decision provenance as JSONL
  self-trace-prompt     Print opt-in self-tracing instructions
  self-trace-record     Read self-trace JSON from stdin and store it
  trace-diff            Compare source transcript events against indexed rows
  traces-list           Print canonical trace records as JSONL
  spans                 Print canonical spans for --trace-id or --session-id
  llmobs-spans          Print Datadog LLMObs-compatible spans as JSONL
  llmobs-trace          Print one Datadog LLMObs-compatible trace as JSON
  judge-create          Create/update a regex or CLI LLM judge
  judge-run             Evaluate spans with a local judge
  judges                Print local judges as JSONL
  behavior-create       Create/update a behavior backed by a judge
  behaviors             Print behaviors as JSONL
  dataset-create        Create/update a trace dataset
  datasets              Print datasets as JSONL
  dataset-items         Print dataset items as JSONL
  bucket-create         Create/update a behavior-to-dataset bucket
  bucket-run            Route matching behavior results into a dataset
  buckets               Print buckets as JSONL
  rule-create           Create/update a behavior alert rule
  rule-run              Evaluate one alert rule
  rules                 Print alert rules as JSONL
  alerts                Print alert records as JSONL
  compare-sessions      Compare two sessions for regressions
  compare-datasets      Compare two trace datasets for regressions
  config-commit         Commit a prompt/config version
  configs               Print prompt/config records as JSONL
  config-show           Print one prompt/config version
  template-list         Print built-in monitoring templates
  template-install      Install a built-in or JSON template
  mcp                   Start the local read-only stdio MCP server
  net-snapshot          Capture metadata-only local TCP connection snapshot
  import-file <p> <f>   Import one JSONL transcript for provider p
  serve [--port N]      Start the localhost trace viewer
  agent [--port N]      Start localhost live intake plus trace viewer
  summarize             Generate/list local session summaries
  export                Export traces as a zip bundle
  search <query>        Search indexed trace events
  show <blobId>         Decrypt and print one raw event blob
  hook                  Ingest one Claude hook payload from stdin
  hook-config           Print Claude Code settings JSON for trace hooks
  install-claude-hooks  Backup and merge hooks into ~/.claude/settings.json
  shell-init            Print shell aliases for traces, tcodex, and tclaude
  doctor                Print paths and capture status

Common filters:
  --provider codex|claude
  --since YYYY-MM-DD
  --session-id ID       Limit commands that accept sessions to one session

Import/watch options:
  --max-files N
  --max-events N
  --interval-ms N       For watch, default 30000

Serve/security options:
  --host HOST           For serve/agent, default 127.0.0.1
  --allow-remote        Permit serve/agent to bind non-loopback hosts
  --allow-intake        Permit serve to accept POST /api/events|spans|intake
  --allow-write         Permit MCP tools that mutate local judges/datasets/rules/configs

Summary/export options:
  --list                For summarize, list saved summaries
  --cached              For summarize, reuse the latest saved summary when available
  --runner codex|claude For summarize/judges, choose a local CLI runner
  --out PATH            For export, write a zip bundle to PATH
  --raw                 For export, include raw decrypted events after explicit local intent
  --stdout              Write export zip bytes to stdout instead of --out PATH

`;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function parsePort(args) {
  const index = args.indexOf("--port");
  if (index >= 0 && args[index + 1]) return parsePositiveInteger(args[index + 1], "--port", { min: 1, max: 65535 });
  return undefined;
}

function parseHost(args) {
  return readOption(args, "--host");
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return undefined;
}

function parsePositiveInteger(value, name, options = {}) {
  const parsed = Number(value);
  const min = options.min == null ? 1 : options.min;
  const max = options.max == null ? Number.MAX_SAFE_INTEGER : options.max;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function parseImportOptions(args) {
  const provider = readOption(args, "--provider");
  if (provider && provider !== "codex" && provider !== "claude") {
    throw new Error("--provider must be codex or claude.");
  }
  const maxFiles = readOption(args, "--max-files");
  const maxEvents = readOption(args, "--max-events");
  return {
    provider,
    since: readOption(args, "--since"),
    maxFiles: maxFiles == null ? undefined : parsePositiveInteger(maxFiles, "--max-files"),
    maxEvents: maxEvents == null ? undefined : parsePositiveInteger(maxEvents, "--max-events")
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeImport(results) {
  return {
    imported: results.reduce((sum, row) => sum + row.imported, 0),
    skipped: results.reduce((sum, row) => sum + row.skipped, 0),
    files: results.length
  };
}

function redactForOutput(value) {
  if (typeof value === "string") return redactText(value).text;
  if (Array.isArray(value)) return value.map(redactForOutput);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactForOutput(item)]));
  }
  return value;
}

function printRows(rows) {
  for (const row of rows) process.stdout.write(JSON.stringify(redactForOutput(row)) + "\n");
}

function positionalAfter(args, start) {
  const values = [];
  for (let i = start; i < args.length; i += 1) {
    if (String(args[i]).startsWith("--")) {
      i += 1;
      continue;
    }
    values.push(args[i]);
  }
  return values.join(" ").trim();
}

async function main(args) {
  const command = args[0] || "help";
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (command === "init") {
    const store = new TraceStore();
    store.init();
    console.log(`Initialized trace store at ${store.home}`);
    return;
  }
  if (command === "bootstrap") {
    process.stdout.write(bootstrapText({ agent: readOption(args, "--agent") || "codex" }) + "\n");
    return;
  }
  if (command === "install-instructions") {
    const result = installInstructions({
      agent: readOption(args, "--agent") || "codex",
      target: readOption(args, "--target"),
      force: args.includes("--force")
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (command === "import") {
    const store = new TraceStore();
    store.init();
    const results = importAll(store, parseImportOptions(args));
    const summary = summarizeImport(results);
    console.log(`Imported ${summary.imported} events, skipped ${summary.skipped} duplicates from ${summary.files} files.`);
    return;
  }
  if (command === "watch") {
    const store = new TraceStore();
    store.init();
    const intervalMs = parsePositiveInteger(readOption(args, "--interval-ms") || 30000, "--interval-ms", { min: 1000, max: 24 * 60 * 60 * 1000 });
    let since = readOption(args, "--since") || new Date(Date.now() - intervalMs * 2).toISOString();
    const seenIds = store.seenEventIds();
    console.log(`Watching Codex/Claude transcripts every ${intervalMs}ms. Initial since=${since}`);
    for (;;) {
      const started = new Date();
      const results = importAll(store, { ...parseImportOptions(args), since, seenIds });
      const summary = summarizeImport(results);
      if (summary.imported) {
        const sessionIds = Array.from(new Set(results.map((row) => row.sessionId).filter(Boolean)));
        for (const sessionId of sessionIds) analyzeStore(store, { sessionId });
        distillWorkflows(store, { limit: 50000 });
        console.log(`${new Date().toISOString()} imported=${summary.imported} skipped=${summary.skipped} files=${summary.files}`);
      }
      since = new Date(started.getTime() - intervalMs).toISOString();
      await sleep(intervalMs);
    }
  }
  if (command === "watch-install") {
    const result = installWatch({
      since: readOption(args, "--since"),
      intervalMs: parsePositiveInteger(readOption(args, "--interval-ms") || 10000, "--interval-ms", { min: 1000, max: 24 * 60 * 60 * 1000 }),
      provider: readOption(args, "--provider"),
      traceHome: readOption(args, "--trace-home") || getTraceHome()
    });
    console.log(`Installed trace watcher ${result.label}`);
    console.log(`Plist: ${result.plistPath}`);
    console.log(`Log: ${result.logPath}`);
    console.log(`Errors: ${result.errorLogPath}`);
    return;
  }
  if (command === "watch-status") {
    process.stdout.write(JSON.stringify(watchStatus({ traceHome: getTraceHome() }), null, 2) + "\n");
    return;
  }
  if (command === "watch-uninstall") {
    const result = uninstallWatch();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (command === "index") {
    const store = new TraceStore();
    store.init();
    const started = Date.now();
    const result = store.rebuildIndex();
    console.log(`Rebuilt SQLite index with ${result.events} events in ${Date.now() - started}ms.`);
    return;
  }
  if (command === "analyze") {
    const store = new TraceStore();
    store.init();
    const started = Date.now();
    const result = analyzeStore(store, {
      sessionId: readOption(args, "--session-id"),
      limit: readOption(args, "--limit") || 100000
    });
    console.log(`Analyzed ${result.sessions} sessions, wrote ${result.annotations} annotations in ${Date.now() - started}ms.`);
    return;
  }
  if (command === "distill") {
    const store = new TraceStore();
    store.init();
    const started = Date.now();
    const result = distillWorkflows(store, { limit: readOption(args, "--limit") || 50000 });
    console.log(`Distilled ${result.lessons} workflow lessons from ${result.annotationsRead} annotations in ${Date.now() - started}ms.`);
    return;
  }
  if (command === "stats") {
    const store = new TraceStore();
    store.init();
    process.stdout.write(JSON.stringify(store.stats({ deep: args.includes("--deep") }), null, 2) + "\n");
    return;
  }
  if (command === "health") {
    const store = new TraceStore();
    store.init();
    const stats = store.healthStats();
    const latestMs = stats.latestEventAt ? Date.parse(stats.latestEventAt) : 0;
    const ageSeconds = latestMs ? Math.round((Date.now() - latestMs) / 1000) : null;
    process.stdout.write(JSON.stringify({
      ok: Boolean(stats.eventCount),
      traceHome: store.home,
      eventCount: stats.eventCount,
      sessionCount: stats.sessionCount,
      latestEventAt: stats.latestEventAt,
      latestEventAgeSeconds: ageSeconds,
      latestMeaningfulEventAt: stats.latestMeaningfulEventAt,
      watcher: watchStatus({ traceHome: store.home }),
      coverage: {
        codex: "JSONL transcript import/watch; live capture depends on Codex writing transcripts.",
        claude: "JSONL transcript import/watch plus installed Claude hook support.",
        hiddenPrivateReasoning: "not captured",
        hiddenPrivateReasoningNote: "The tool records transcript-visible events and provider-emitted reasoning summaries only. It does not and should not intercept hidden chain-of-thought or bypass provider privacy boundaries."
      },
      logs: {
        watch: path.join(store.home, "logs", "watch.log"),
        watchErrors: path.join(store.home, "logs", "watch.err"),
        hookErrors: "/tmp/traces-hook-errors.log"
      }
    }, null, 2) + "\n");
    return;
  }
  if (command === "recent") {
    const store = new TraceStore();
    store.init();
    printRows(store.listMeaningfulEvents({
      limit: readOption(args, "--limit") || 50,
      provider: readOption(args, "--provider"),
      sessionId: readOption(args, "--session-id"),
      since: readOption(args, "--since")
    }));
    return;
  }
  if (command === "decision-log") {
    const store = new TraceStore();
    store.init();
    printRows(buildDecisionLog(store, {
      limit: readOption(args, "--limit") || 200,
      provider: readOption(args, "--provider"),
      sessionId: readOption(args, "--session-id"),
      since: readOption(args, "--since")
    }));
    return;
  }
  if (command === "summarize") {
    const store = new TraceStore();
    store.init();
    const sessionId = readOption(args, "--session-id") || args[1];
    if (args.includes("--list")) {
      printRows(listSummaries({ traceHome: store.home, sessionId, limit: readOption(args, "--limit") || 50 }));
      return;
    }
    if (!sessionId) throw new Error("summarize requires --session-id ID or --list.");
    const cached = args.includes("--cached") ? latestSummary({ traceHome: store.home, sessionId }) : null;
    const row = cached || summarizeSession(store, sessionId, {
      runner: readOption(args, "--runner") || "codex",
      timeoutMs: readOption(args, "--timeout-ms")
    });
    process.stdout.write(JSON.stringify(row, null, 2) + "\n");
    return;
  }
  if (command === "export") {
    const store = new TraceStore();
    store.init();
    const bundle = await buildExportZip(store, {
      sessionId: readOption(args, "--session-id"),
      provider: readOption(args, "--provider"),
      from: readOption(args, "--from") || readOption(args, "--since"),
      to: readOption(args, "--to"),
      q: readOption(args, "--query") || readOption(args, "--q"),
      cwd: readOption(args, "--cwd"),
      type: readOption(args, "--type"),
      raw: args.includes("--raw")
    });
    const out = readOption(args, "--out");
    if (out) {
      fs.writeFileSync(path.resolve(out), bundle.buffer, { mode: 0o600 });
      process.stdout.write(JSON.stringify({ file: path.resolve(out), manifest: bundle.manifest }, null, 2) + "\n");
      return;
    }
    if (!args.includes("--stdout")) throw new Error("export requires --out PATH, or --stdout when piping zip bytes intentionally.");
    process.stdout.write(bundle.buffer);
    return;
  }
  if (command === "self-trace-prompt") {
    process.stdout.write(SELF_TRACE_PROMPT + "\n");
    return;
  }
  if (command === "self-trace-record") {
    const store = new TraceStore();
    store.init();
    const payload = parseSelfTraceInput(await readStdin());
    const row = store.addEvent(makeSelfTraceEvent(payload, {
      sessionId: readOption(args, "--session-id"),
      cwd: readOption(args, "--cwd")
    }));
    store.upsertSession({
      id: row.sessionId,
      provider: row.provider,
      sourcePath: row.sourcePath,
      cwd: row.cwd,
      startedAt: row.timestamp,
      endedAt: row.timestamp,
      eventCount: 1,
      project: "self-trace"
    });
    store.upsertTask({
      id: row.taskId,
      title: row.summary,
      provider: row.provider,
      sessionId: row.sessionId,
      cwd: row.cwd,
      startedAt: row.timestamp,
      endedAt: row.timestamp
    });
    process.stdout.write(JSON.stringify(row, null, 2) + "\n");
    return;
  }
  if (command === "trace-diff") {
    const store = new TraceStore();
    store.init();
    const file = readOption(args, "--file");
    const sessionId = readOption(args, "--session-id");
    if (!file && !sessionId) throw new Error("trace-diff requires --file PATH or --session-id ID.");
    const result = file ? diffSourceFile(store, path.resolve(file)) : diffSession(store, sessionId);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (command === "traces-list") {
    const store = new TraceStore();
    store.init();
    printRows(store.listTraces({
      limit: readOption(args, "--limit") || 1000,
      provider: readOption(args, "--provider"),
      sessionId: readOption(args, "--session-id")
    }));
    return;
  }
  if (command === "spans") {
    const store = new TraceStore();
    store.init();
    printRows(store.listSpans({
      limit: readOption(args, "--limit") || 5000,
      traceId: readOption(args, "--trace-id"),
      sessionId: readOption(args, "--session-id"),
      spanType: readOption(args, "--span-type")
    }));
    return;
  }
  if (command === "llmobs-spans") {
    const store = new TraceStore();
    store.init();
    printRows(listLlmObsSpans(store, {
      limit: readOption(args, "--limit") || 5000,
      traceId: readOption(args, "--trace-id"),
      sessionId: readOption(args, "--session-id"),
      spanType: readOption(args, "--span-type")
    }));
    return;
  }
  if (command === "llmobs-trace") {
    const store = new TraceStore();
    store.init();
    const id = readOption(args, "--trace-id") || readOption(args, "--session-id") || args[1];
    if (!id) throw new Error("llmobs-trace requires --trace-id, --session-id, or an id argument.");
    const trace = store.getTrace(id);
    if (!trace) throw new Error("trace not found: " + id);
    process.stdout.write(JSON.stringify(llmObsTraceFromCanonical(trace, store.listSpans({ traceId: trace.id, limit: 50000 })), null, 2) + "\n");
    return;
  }
  if (command === "judge-create") {
    const store = new TraceStore();
    store.init();
    const spec = makeJudgeSpec({
      name: readOption(args, "--name"),
      description: readOption(args, "--description"),
      pattern: readOption(args, "--pattern"),
      rubric: readOption(args, "--rubric"),
      runner: readOption(args, "--runner"),
      prompt: readOption(args, "--prompt"),
      flags: readOption(args, "--flags"),
      spanType: readOption(args, "--span-type"),
      timeoutMs: readOption(args, "--timeout-ms"),
      maxSpans: readOption(args, "--max-spans"),
      version: readOption(args, "--version") || 1
    });
    store.upsertJudge(spec);
    process.stdout.write(JSON.stringify(spec, null, 2) + "\n");
    return;
  }
  if (command === "judges") {
    const store = new TraceStore();
    store.init();
    printRows(store.listJudges({ limit: readOption(args, "--limit") || 1000 }));
    return;
  }
  if (command === "judge-run") {
    const store = new TraceStore();
    store.init();
    const judgeId = readOption(args, "--judge") || args[1];
    if (!judgeId) throw new Error("judge-run requires --judge ID_OR_NAME.");
    const result = evaluateJudge(store, judgeId, {
      version: readOption(args, "--version"),
      traceId: readOption(args, "--trace-id"),
      sessionId: readOption(args, "--session-id"),
      limit: readOption(args, "--limit") || 50000
    });
    process.stdout.write(JSON.stringify({
      judge: result.judge,
      version: result.version,
      evaluations: result.evaluations.length,
      positive: result.evaluations.filter((row) => row.passed).length
    }, null, 2) + "\n");
    return;
  }
  if (command === "behavior-create") {
    const store = new TraceStore();
    store.init();
    const behavior = makeBehaviorSpec({
      name: readOption(args, "--name"),
      judgeId: readOption(args, "--judge"),
      description: readOption(args, "--description")
    });
    store.upsertBehavior(behavior);
    process.stdout.write(JSON.stringify(behavior, null, 2) + "\n");
    return;
  }
  if (command === "behaviors") {
    const store = new TraceStore();
    store.init();
    printRows(store.listBehaviors({ limit: readOption(args, "--limit") || 1000, judgeId: readOption(args, "--judge") }));
    return;
  }
  if (command === "dataset-create") {
    const store = new TraceStore();
    store.init();
    const dataset = makeDatasetSpec({
      name: readOption(args, "--name"),
      description: readOption(args, "--description"),
      kind: readOption(args, "--kind") || "trace"
    });
    store.upsertDataset(dataset);
    process.stdout.write(JSON.stringify(dataset, null, 2) + "\n");
    return;
  }
  if (command === "datasets") {
    const store = new TraceStore();
    store.init();
    printRows(store.listDatasets({ limit: readOption(args, "--limit") || 1000 }));
    return;
  }
  if (command === "dataset-items") {
    const store = new TraceStore();
    store.init();
    printRows(store.listDatasetItems({
      limit: readOption(args, "--limit") || 1000,
      datasetId: readOption(args, "--dataset"),
      traceId: readOption(args, "--trace-id"),
      sessionId: readOption(args, "--session-id")
    }));
    return;
  }
  if (command === "bucket-create") {
    const store = new TraceStore();
    store.init();
    const bucket = makeBucketSpec({
      name: readOption(args, "--name"),
      datasetId: readOption(args, "--dataset"),
      behaviorId: readOption(args, "--behavior"),
      description: readOption(args, "--description"),
      enabled: !args.includes("--disabled")
    });
    store.upsertBucket(bucket);
    process.stdout.write(JSON.stringify(bucket, null, 2) + "\n");
    return;
  }
  if (command === "bucket-run") {
    const store = new TraceStore();
    store.init();
    const bucketId = readOption(args, "--bucket") || args[1];
    if (!bucketId) throw new Error("bucket-run requires --bucket ID_OR_NAME.");
    const result = runBucket(store, bucketId, {
      traceId: readOption(args, "--trace-id"),
      sessionId: readOption(args, "--session-id"),
      limit: readOption(args, "--limit") || 50000
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (command === "buckets") {
    const store = new TraceStore();
    store.init();
    printRows(store.listBuckets({
      limit: readOption(args, "--limit") || 1000,
      datasetId: readOption(args, "--dataset"),
      behaviorId: readOption(args, "--behavior")
    }));
    return;
  }
  if (command === "rule-create") {
    const store = new TraceStore();
    store.init();
    const rule = makeRuleSpec({
      name: readOption(args, "--name"),
      behaviorId: readOption(args, "--behavior"),
      description: readOption(args, "--description"),
      minCount: readOption(args, "--min-count") || 1,
      enabled: !args.includes("--disabled")
    });
    store.upsertRule(rule);
    process.stdout.write(JSON.stringify(rule, null, 2) + "\n");
    return;
  }
  if (command === "rule-run") {
    const store = new TraceStore();
    store.init();
    const ruleId = readOption(args, "--rule") || args[1];
    if (!ruleId) throw new Error("rule-run requires --rule ID_OR_NAME.");
    const result = evaluateRule(store, ruleId, {
      traceId: readOption(args, "--trace-id"),
      sessionId: readOption(args, "--session-id"),
      limit: readOption(args, "--limit") || 50000
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  if (command === "rules") {
    const store = new TraceStore();
    store.init();
    printRows(store.listRules({ limit: readOption(args, "--limit") || 1000, behaviorId: readOption(args, "--behavior") }));
    return;
  }
  if (command === "alerts") {
    const store = new TraceStore();
    store.init();
    printRows(store.listAlerts({
      limit: readOption(args, "--limit") || 1000,
      ruleId: readOption(args, "--rule"),
      behaviorId: readOption(args, "--behavior"),
      sessionId: readOption(args, "--session-id")
    }));
    return;
  }
  if (command === "compare-sessions") {
    const store = new TraceStore();
    store.init();
    const before = readOption(args, "--before") || args[1];
    const after = readOption(args, "--after") || args[2];
    if (!before || !after) throw new Error("compare-sessions requires --before SESSION and --after SESSION.");
    process.stdout.write(JSON.stringify(compareSessions(store, before, after), null, 2) + "\n");
    return;
  }
  if (command === "compare-datasets") {
    const store = new TraceStore();
    store.init();
    const before = readOption(args, "--before") || args[1];
    const after = readOption(args, "--after") || args[2];
    if (!before || !after) throw new Error("compare-datasets requires --before DATASET and --after DATASET.");
    process.stdout.write(JSON.stringify(compareDatasets(store, before, after), null, 2) + "\n");
    return;
  }
  if (command === "config-commit") {
    const store = new TraceStore();
    store.init();
    const content = readOption(args, "--content") || await readStdin();
    const tags = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--tag" && args[i + 1]) tags.push(args[i + 1]);
    }
    const spec = makeConfigCommit({
      name: readOption(args, "--name"),
      kind: readOption(args, "--kind") || "prompt",
      description: readOption(args, "--description"),
      message: readOption(args, "--message"),
      content,
      tags
    });
    store.commitConfig(spec);
    process.stdout.write(JSON.stringify(spec, null, 2) + "\n");
    return;
  }
  if (command === "configs") {
    const store = new TraceStore();
    store.init();
    printRows(store.listConfigs({ limit: readOption(args, "--limit") || 1000, kind: readOption(args, "--kind") }));
    return;
  }
  if (command === "config-show") {
    const store = new TraceStore();
    store.init();
    const id = readOption(args, "--config") || args[1];
    if (!id) throw new Error("config-show requires --config ID_OR_NAME.");
    const config = store.getConfig(id, { tag: readOption(args, "--tag"), commitId: readOption(args, "--commit") });
    if (!config) throw new Error(`Unknown config: ${id}`);
    process.stdout.write(JSON.stringify(config, null, 2) + "\n");
    return;
  }
  if (command === "template-list") {
    printRows(listTemplates());
    return;
  }
  if (command === "template-install") {
    const name = readOption(args, "--template") || args[1];
    if (!name) throw new Error("template-install requires --template NAME_OR_PATH.");
    const store = new TraceStore();
    store.init();
    process.stdout.write(JSON.stringify(installTemplate(store, name), null, 2) + "\n");
    return;
  }
  if (command === "mcp") {
    runMcpServer({ allowWrite: args.includes("--allow-write") });
    return;
  }
  if (command === "net-snapshot") {
    const store = new TraceStore();
    store.init();
    const snapshot = takeNetSnapshot();
    if (args.includes("--record")) {
      const row = store.addEvent(makeNetSnapshotEvent(snapshot, { sessionId: readOption(args, "--session-id") }));
      process.stdout.write(JSON.stringify({ recorded: true, event: row, snapshot }, null, 2) + "\n");
    } else {
      process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
    }
    return;
  }
  if (command === "import-file") {
    const provider = args[1];
    const file = args[2];
    if (!provider || !file) throw new Error("import-file requires provider and file path.");
    const store = new TraceStore();
    store.init();
    printRows([importJsonlFile(store, provider, path.resolve(file), store.seenEventIds())]);
    return;
  }
  if (command === "serve" || command === "agent") {
    const store = new TraceStore();
    store.init();
    listen({
      store,
      port: parsePort(args),
      host: parseHost(args),
      allowRemote: args.includes("--allow-remote"),
      allowIntake: command === "agent" || args.includes("--allow-intake")
    });
    return;
  }
  if (command === "search") {
    const store = new TraceStore();
    store.init();
    printRows(store.search(args.slice(1).join(" ")));
    return;
  }
  if (command === "show") {
    const store = new TraceStore();
    store.init();
    const id = args[1];
    if (!id) throw new Error("show requires a blob id.");
    process.stdout.write(JSON.stringify(store.getBlob(id), null, 2) + "\n");
    return;
  }
  if (command === "hook") {
    await runHookCommand();
    return;
  }
  if (command === "hook-config") {
    printClaudeHookInstall();
    return;
  }
  if (command === "install-claude-hooks") {
    const settingsPath = readOption(args, "--settings");
    const result = installClaudeHooks(settingsPath);
    console.log(`Installed Claude hooks in ${result.settingsPath}`);
    console.log(`Hook command: ${result.command}`);
    return;
  }
  if (command === "shell-init") {
    const root = path.resolve(__dirname, "..");
    process.stdout.write([
      `alias tracebase='${process.execPath} ${path.join(root, "bin", "tracebase.js")}'`,
      `alias traces='${process.execPath} ${path.join(root, "bin", "traces.js")}'`,
      `alias tcodex='${process.execPath} ${path.join(root, "bin", "tcodex.js")}'`,
      `alias tclaude='${process.execPath} ${path.join(root, "bin", "tclaude.js")}'`
    ].join("\n") + "\n");
    return;
  }
  if (command === "doctor") {
    const sources = getDefaultSources();
    const summaryRunners = availableSummaryRunners();
    const wrappers = {
      tcodex: {
        bin: path.resolve(__dirname, "..", "bin", "tcodex.js"),
        target: wrapperDiagnostics("codex")
      },
      tclaude: {
        bin: path.resolve(__dirname, "..", "bin", "tclaude.js"),
        target: wrapperDiagnostics("claude")
      }
    };
    const watcher = watchStatus({ traceHome: getTraceHome() });
    const recommendations = [...(watcher.recommendations || [])];
    if (!summaryRunners.find((runner) => runner.runner === "codex" && runner.available)) {
      recommendations.push("Codex CLI was not found on PATH. Install Codex or set TRACE_CODEX_BIN before using Codex summaries or tcodex.");
    }
    if (!summaryRunners.find((runner) => runner.runner === "claude" && runner.available)) {
      recommendations.push("Claude CLI was not found on PATH. Install Claude Code or set TRACE_CLAUDE_BIN before using Claude summaries or tclaude.");
    }
    for (const wrapper of Object.values(wrappers)) {
      if (!wrapper.target.available) {
        recommendations.push(`${wrapper.target.agent} wrapper target ${wrapper.target.command} is not executable. Set ${wrapper.target.overrideEnv} to an absolute executable path if needed.`);
      }
    }
    const payload = {
      traceHome: getTraceHome(),
      storeExists: fs.existsSync(getTraceHome()),
      codexSessions: sources.codexSessions,
      codexSessionsExists: fs.existsSync(sources.codexSessions),
      claudeProjects: sources.claudeProjects,
      claudeProjectsExists: fs.existsSync(sources.claudeProjects),
      summaryRunners,
      wrappers,
      watcher,
      recommendations,
      coverage: {
        hiddenPrivateReasoningCaptured: false,
        hiddenPrivateReasoningNote: "Only transcript-visible reasoning summaries are available. Network interception of hidden/private reasoning is intentionally unsupported."
      }
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

module.exports = {
  main
};
