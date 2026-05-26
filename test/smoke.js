"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const JSZip = require("jszip");
const { encodeFrame, parseFrames } = require("../src/mcp");
const { TraceStore } = require("../src/storage");
const { importJsonlFile } = require("../src/importers");
const { ingestHook } = require("../src/hook");
const { mergeHooks, claudeHookSettings } = require("../src/hook");
const { createServer, listen } = require("../src/server");
const { makeSelfTraceEvent } = require("../src/self-trace");
const { buildDecisionLog } = require("../src/decision-log");
const { diffSourceFile } = require("../src/trace-diff");
const { takeNetSnapshot } = require("../src/net-snapshot");
const { evaluateJudge, makeBehaviorSpec, makeJudgeSpec } = require("../src/judges");
const { makeBucketSpec, makeDatasetSpec, runBucket } = require("../src/datasets");
const { evaluateRule, makeRuleSpec } = require("../src/rules");
const { compareDatasets, compareSessions } = require("../src/regression");
const { makeConfigCommit } = require("../src/registry");
const { installTemplate, listTemplates } = require("../src/templates");
const { listLlmObsSpans } = require("../src/llmobs");
const { redactText } = require("../src/redact");
const { bootstrapText, installInstructions } = require("../src/bootstrap");
const { makePlist, watchRecommendations } = require("../src/daemon");

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "traces-smoke-"));
  process.env.TRACE_HOME = home;

  const store = new TraceStore({ home });
  store.init();
  const seen = store.seenEventIds();
  importJsonlFile(store, "claude", path.join(__dirname, "fixtures", "claude.jsonl"), seen);
  importJsonlFile(store, "codex", path.join(__dirname, "fixtures", "codex.jsonl"), seen);

  assert.equal(store.listEvents().length, 7);
  assert.equal(store.listTraces().length, 2);
  assert.equal(store.listSpans({ sessionId: "fixture-claude" }).some((span) => span.spanType === "trace"), true);
  assert.equal(store.listSpans({ sessionId: "fixture-claude" }).some((span) => span.eventId), true);
  assert.equal(store.search("vite").length >= 1, true);
  assert.equal(store.search("vite", { limit: "not-a-number", offset: "also-bad" }).length >= 1, true);
  assert.equal(store.search("vite", { limit: 999999 }).length <= 10000, true);
  assert.equal(store.listMeaningfulEvents({ limit: 20 }).some((event) => event.summary.includes("vite")), true);
  assert.equal(store.stats().reasoning.hiddenPrivateReasoningCaptured, false);
  const fixtureClaude = store.listEvents({ limit: 20 }).find((event) => event.sessionId === "fixture-claude");
  assert.equal(store.getBlob(fixtureClaude.blobId).session_id, "fixture-claude");
  assert.throws(() => store.getBlob("../key"), /invalid blob id/);
  assert.equal(fs.statSync(path.join(home, "key")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(home, "blobs", `${fixtureClaude.blobId}.json`)).mode & 0o777, 0o600);
  assert.equal(store.listTraces({ sessionId: "fixture-claude" }).length, 1);
  assert.equal(store.listSpans({ sessionId: "fixture-claude" }).length >= 4, true);
  const exportWithoutDestination = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "traces.js"), "export", "--session-id", "fixture-claude"], {
    env: { ...process.env, TRACE_HOME: home },
    encoding: "utf8"
  });
  assert.equal(exportWithoutDestination.status, 1);
  assert.equal(exportWithoutDestination.stderr.includes("export requires --out PATH"), true);
  const exportStdout = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "traces.js"), "export", "--session-id", "fixture-claude", "--stdout"], {
    env: { ...process.env, TRACE_HOME: home },
    encoding: "buffer",
    maxBuffer: 5 * 1024 * 1024
  });
  assert.equal(exportStdout.status, 0, exportStdout.stderr.toString());
  assert.equal(exportStdout.stdout.slice(0, 2).toString("utf8"), "PK");

  const liveSpan = store.ingestLiveSpan({
    trace_id: "trace-live-1",
    span_id: "live-root",
    session_id: "live-session",
    type: "agent.workflow",
    name: "one shot prompt trial",
    provider: "codex",
    service: "local-agent",
    model: "gpt-test",
    start: "2026-05-18T13:00:00.000Z",
    end: "2026-05-18T13:00:01.250Z",
    status: "ok",
    input: { prompt: "implement live intake" },
    output: { result: "done" },
    usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46, cost_usd: 0.001 }
  }).span;
  assert.equal(liveSpan.id, "live-root");
  assert.equal(liveSpan.traceId, "trace-live-1");
  assert.equal(store.listSpans({ traceId: "trace-live-1" }).some((span) => span.id === "live-root" && span.spanType === "agent"), true);
  const projectedLiveSpan = listLlmObsSpans(store, { traceId: "trace-live-1" }).find((span) => span.id === "live-root");
  assert.equal(projectedLiveSpan.attributes.trace_id, "trace-live-1");
  assert.equal(projectedLiveSpan.attributes.metrics.totalTokens, 46);
  store.ingestLiveEvent({
    id: "live-event-1",
    session_id: "live-session",
    provider: "codex",
    type: "permission",
    message: "permission prompt accepted",
    timestamp: "2026-05-18T13:00:02.000Z"
  });
  assert.equal(store.search("permission prompt", { sessionId: "live-session" }).length >= 1, true);
  const diff = diffSourceFile(store, path.join(__dirname, "fixtures", "claude.jsonl"));
  assert.equal(diff.complete, true);

  const judgeSpec = makeJudgeSpec({ name: "Vite Mention", pattern: "vite" });
  store.upsertJudge(judgeSpec);
  const behavior = makeBehaviorSpec({ name: "Asked About Vite", judgeId: judgeSpec.judge.id });
  store.upsertBehavior(behavior);
  const judgeResult = evaluateJudge(store, judgeSpec.judge.id, { sessionId: "fixture-claude" });
  assert.equal(judgeResult.evaluations.some((row) => row.passed), true);
  assert.equal(store.listEvaluations({ judgeId: judgeSpec.judge.id }).some((row) => row.passed), true);
  assert.equal(store.listBehaviors({ judgeId: judgeSpec.judge.id })[0].detectionCount >= 1, true);
  assert.equal(store.listBehaviorResults({ behaviorId: behavior.id }).length >= 1, true);

  const cliJudgeSpec = makeJudgeSpec({
    name: "CLI Trace Quality",
    rubric: "Pass when the trace packet includes a Vite-related span.",
    runner: "custom",
    command: process.execPath,
    args: ["-e", "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const passed=s.includes('vite'); console.log(JSON.stringify({score: passed ? 1 : 0, passed, label: passed ? 'vite-present' : 'vite-missing', reason: passed ? 'Trace mentions vite.' : 'Trace does not mention vite.', evidence_spans: []}));});"]
  });
  store.upsertJudge(cliJudgeSpec);
  const cliJudgeResult = evaluateJudge(store, cliJudgeSpec.judge.id, { sessionId: "fixture-claude" });
  assert.equal(cliJudgeResult.evaluations.length, 1);
  assert.equal(cliJudgeResult.evaluations[0].passed, 1);
  assert.equal(cliJudgeResult.evaluations[0].label, "vite-present");

  const dataset = makeDatasetSpec({ name: "Vite Regression Cases", description: "Traces where the Vite behavior fired." });
  store.upsertDataset(dataset);
  const bucket = makeBucketSpec({ name: "Vite Behavior Bucket", datasetId: dataset.id, behaviorId: behavior.id });
  store.upsertBucket(bucket);
  const bucketResult = runBucket(store, bucket.id);
  assert.equal(bucketResult.added >= 1, true);
  assert.equal(store.listDatasets()[0].itemCount >= 1, true);
  assert.equal(store.listDatasetItems({ datasetId: dataset.id }).some((row) => row.sessionId === "fixture-claude"), true);

  const rule = makeRuleSpec({ name: "Vite Behavior Alert", behaviorId: behavior.id, minCount: 1 });
  store.upsertRule(rule);
  const ruleResult = evaluateRule(store, rule.id, { sessionId: "fixture-claude" });
  assert.equal(ruleResult.triggered, true);
  assert.equal(store.listRules({ behaviorId: behavior.id })[0].enabled, true);
  assert.equal(store.listAlerts({ ruleId: rule.id }).length >= 1, true);

  const regressed = store.addEvent({
    provider: "test",
    sessionId: "regressed-session",
    taskId: "regressed-session",
    type: "tool_result",
    role: "tool",
    cwd: "/tmp/project",
    sourcePath: "generated-regression",
    offset: 1,
    timestamp: "2026-05-18T10:10:00.000Z",
    summary: "command failed exit code 1 vite",
    searchText: "command failed with exit code 1 while running vite"
  });
  store.upsertSession({
    id: "regressed-session",
    provider: "test",
    sourcePath: "generated-regression",
    cwd: "/tmp/project",
    startedAt: regressed.timestamp,
    endedAt: regressed.timestamp,
    eventCount: 1,
    project: "regression"
  });
  evaluateJudge(store, judgeSpec.judge.id, { sessionId: "regressed-session" });
  evaluateRule(store, rule.id, { sessionId: "regressed-session" });
  const sessionComparison = compareSessions(store, "fixture-claude", "regressed-session");
  assert.equal(sessionComparison.deltas.errorSpanCount.delta >= 1, true);
  assert.equal(sessionComparison.regressions.some((row) => row.kind === "errors_increased"), true);

  const afterDataset = makeDatasetSpec({ name: "Vite Regressed Cases" });
  store.upsertDataset(afterDataset);
  store.addDatasetItem({
    id: "dataset-item-regressed-session",
    datasetId: afterDataset.id,
    traceId: "session:regressed-session",
    sessionId: "regressed-session",
    spanId: null,
    source: "smoke",
    sourceId: "smoke",
    label: "regressed",
    note: "generated regression case",
    createdAt: new Date().toISOString()
  });
  const datasetComparison = compareDatasets(store, dataset.id, afterDataset.id);
  assert.equal(datasetComparison.deltas.errorSpanCount.delta >= 1, true);

  const configCommit = makeConfigCommit({
    name: "Agent Prompt",
    kind: "prompt",
    content: "Use tools carefully.",
    message: "baseline prompt",
    tags: ["prod"]
  });
  store.commitConfig(configCommit);
  const fetchedConfig = store.getConfig("Agent Prompt", { tag: "prod" });
  assert.equal(fetchedConfig.commit.content, "Use tools carefully.");
  assert.equal(store.listConfigs({ kind: "prompt" }).some((row) => row.id === configCommit.config.id), true);

  assert.equal(listTemplates().some((row) => row.name === "coding-agent-baseline"), true);
  const templateResult = installTemplate(store, "coding-agent-baseline");
  assert.equal(templateResult.installed.judges >= 1, true);
  assert.equal(store.listDatasets().some((row) => row.id === "dataset:store-reliability-regressions"), true);

  const selfTrace = store.addEvent(makeSelfTraceEvent({
    goal: "verify trace observability",
    decision: "record explicit decision summary",
    why: ["visible context only"],
    alternatives: ["do nothing"],
    risks: ["summary may be incomplete"],
    evidence: ["smoke test"],
    next: "continue"
  }, { sessionId: "self-trace-fixture" }));
  assert.equal(selfTrace.type, "self_trace_decision");
  assert.equal(buildDecisionLog(store, { sessionId: "self-trace-fixture" }).length, 1);

  await ingestHook(JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: "hook-session",
    transcript_path: path.join(home, ".claude", "projects", "x", "hook-session.jsonl"),
    cwd: "/tmp/project",
    prompt: "token=secret-value-12345",
    timestamp: "2026-05-18T12:00:00.000Z"
  }));
  assert.equal(store.search("secret-value-12345").length, 0);
  assert.equal(store.search("[REDACTED").length >= 1, true);
  const secretSummary = store.ingestLiveEvent({
    id: "secret-summary-event",
    session_id: "secret-session",
    provider: "codex",
    type: "note",
    summary: "password=supersecretvalue",
    message: "summary redaction regression check",
    timestamp: "2026-05-18T12:00:01.000Z"
  });
  assert.equal(secretSummary.summary.includes("supersecretvalue"), false);
  assert.equal(store.search("supersecretvalue").length, 0);

  const redactedSecrets = redactText([
    "ANTHROPIC_API_KEY=sk-ant-" + "a".repeat(24),
    "OPENAI_API_KEY=sk-" + "b".repeat(24),
    "GITHUB_TOKEN=github_pat_" + "A".repeat(30),
    "SLACK_BOT_TOKEN=xoxb-1234567890-abcdefghijkl",
    "NPM_TOKEN=npm_" + "c".repeat(36),
    "DATABASE_URL=https://user:passw0rdsecret@example.com/db",
    "PRIVATE_KEY=\"-----BEGIN PRIVATE KEY-----\nabc123abc123abc123\n-----END PRIVATE KEY-----\""
  ].join("\n"));
  assert.equal(redactedSecrets.text.includes("sk-ant-"), false);
  assert.equal(redactedSecrets.text.includes("sk-" + "b".repeat(24)), false);
  assert.equal(redactedSecrets.text.includes("github_pat_"), false);
  assert.equal(redactedSecrets.text.includes("xoxb-"), false);
  assert.equal(redactedSecrets.text.includes("npm_"), false);
  assert.equal(redactedSecrets.text.includes("user:passw0rdsecret@"), false);
  assert.equal(redactedSecrets.text.includes("BEGIN PRIVATE KEY"), false);
  assert.equal(redactedSecrets.hits.length >= 7, true);

  const server = createServer({
    store,
    allowIntake: true,
    summaryRunner: {
      command: process.execPath,
      args: ["-e", "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log('## Goal\\nSummarized fixture trace with vite evidence.'));"]
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/events?q=vite`).then((r) => r.json());
  assert.equal(response.length >= 1, true);
  const malformedEventsResponse = await fetch(`http://127.0.0.1:${port}/api/events?limit=not-a-number&offset=also-bad`);
  assert.equal(malformedEventsResponse.status, 200);
  const malformedEvents = await malformedEventsResponse.json();
  assert.equal(Array.isArray(malformedEvents), true);
  const cappedEvents = await fetch(`http://127.0.0.1:${port}/api/events?limit=999999`).then((r) => r.json());
  assert.equal(cappedEvents.length <= 5000, true);
  const healthResponse = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(healthResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(healthResponse.headers.get("referrer-policy"), "no-referrer");
  assert.equal(healthResponse.headers.get("x-frame-options"), "DENY");
  assert.equal(healthResponse.headers.get("content-security-policy").includes("default-src 'self'"), true);
  assert.equal(healthResponse.headers.get("cache-control"), "no-store");
  const summaryRunners = await fetch(`http://127.0.0.1:${port}/api/summary-runners`).then((r) => r.json());
  assert.equal(summaryRunners.runners.some((runner) => runner.runner === "codex" && typeof runner.available === "boolean"), true);
  assert.equal(summaryRunners.runners.some((runner) => runner.runner === "claude" && typeof runner.available === "boolean"), true);
  assert.equal(summaryRunners.runners.every((runner) => !Object.hasOwn(runner, "command") && !Object.hasOwn(runner, "path")), true);
  const traversalResponse = await fetch(`http://127.0.0.1:${port}/%2e%2e/%2e%2e/package.json`);
  assert.equal(traversalResponse.headers.get("content-type").startsWith("text/html"), true);
  assert.equal((await traversalResponse.text()).includes('"scripts"'), false);
  const filteredSessions = await fetch(`http://127.0.0.1:${port}/api/sessions?provider=claude&q=fixture&from=2026-05-18T00:00:00.000Z&to=2026-05-19T00:00:00.000Z&sort=events&order=desc`).then((r) => r.json());
  assert.equal(filteredSessions.some((row) => row.id === "fixture-claude"), true);
  assert.equal(filteredSessions.every((row) => row.provider === "claude"), true);
  const contentMatchedSessions = await fetch(`http://127.0.0.1:${port}/api/sessions?provider=claude&q=vite`).then((r) => r.json());
  assert.equal(contentMatchedSessions.some((row) => row.id === "fixture-claude"), true);
  const malformedSessionsResponse = await fetch(`http://127.0.0.1:${port}/api/sessions?limit=bad&offset=bad`);
  assert.equal(malformedSessionsResponse.status, 200);
  assert.equal(Array.isArray(await malformedSessionsResponse.json()), true);
  const traces = await fetch(`http://127.0.0.1:${port}/api/traces?sessionId=fixture-claude`).then((r) => r.json());
  assert.equal(traces.length, 1);
  const trace = await fetch(`http://127.0.0.1:${port}/api/traces/${encodeURIComponent(traces[0].id)}`).then((r) => r.json());
  assert.equal(trace.sessionId, "fixture-claude");
  const spans = await fetch(`http://127.0.0.1:${port}/api/spans?traceId=${encodeURIComponent(traces[0].id)}`).then((r) => r.json());
  assert.equal(spans.length >= 2, true);
  assert.equal(spans.some((span) => span.spanType === "trace"), true);
  const malformedSpansResponse = await fetch(`http://127.0.0.1:${port}/api/spans?traceId=${encodeURIComponent(traces[0].id)}&limit=bad`);
  assert.equal(malformedSpansResponse.status, 200);
  assert.equal(Array.isArray(await malformedSpansResponse.json()), true);
  const postSpan = await fetch(`http://127.0.0.1:${port}/api/spans`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      trace_id: "trace-live-1",
      span_id: "live-child",
      parent_id: "live-root",
      session_id: "live-session",
      kind: "llm",
      name: "judge rubric completion",
      provider: "codex",
      start: "2026-05-18T13:00:03.000Z",
      end: "2026-05-18T13:00:04.000Z",
      status: "ok",
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }
    })
  }).then((r) => r.json());
  assert.equal(postSpan.accepted, 1);
  const sameOriginPost = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ id: "same-origin-accepted", provider: "test", session_id: "origin-ok", message: "same origin accepted" })
  });
  assert.equal(sameOriginPost.status, 202);
  const loopbackOtherPortPost = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:65530" },
    body: JSON.stringify({ id: "loopback-other-port-blocked", provider: "test", session_id: "blocked", message: "blocked" })
  });
  assert.equal(loopbackOtherPortPost.status, 403);
  const crossOriginPost = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.com" },
    body: JSON.stringify({ id: "cross-origin-blocked", provider: "test", session_id: "blocked", message: "blocked" })
  });
  assert.equal(crossOriginPost.status, 403);
  const llmobsSpans = await fetch(`http://127.0.0.1:${port}/api/llmobs/spans?traceId=trace-live-1`).then((r) => r.json());
  assert.equal(llmobsSpans.some((span) => span.id === "live-child" && span.attributes.parent_id === "live-root"), true);
  const llmobsTrace = await fetch(`http://127.0.0.1:${port}/api/llmobs/traces/trace-live-1`).then((r) => r.json());
  assert.equal(llmobsTrace.attributes.trace_id, "trace-live-1");
  assert.equal(llmobsTrace.attributes.spans.some((span) => span.id === "live-root"), true);
  const postEvent = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "live-event-2", session_id: "live-session", provider: "codex", type: "note", message: "server intake event" })
  }).then((r) => r.json());
  assert.equal(postEvent.accepted, 1);
  const judges = await fetch(`http://127.0.0.1:${port}/api/judges`).then((r) => r.json());
  assert.equal(judges.some((row) => row.id === judgeSpec.judge.id), true);
  const behaviorRows = await fetch(`http://127.0.0.1:${port}/api/behaviors?judgeId=${encodeURIComponent(judgeSpec.judge.id)}`).then((r) => r.json());
  assert.equal(behaviorRows[0].detectionCount >= 1, true);
  const evalRows = await fetch(`http://127.0.0.1:${port}/api/evaluations?judgeId=${encodeURIComponent(judgeSpec.judge.id)}`).then((r) => r.json());
  assert.equal(evalRows.some((row) => row.passed), true);
  const datasets = await fetch(`http://127.0.0.1:${port}/api/datasets`).then((r) => r.json());
  assert.equal(datasets.some((row) => row.id === dataset.id && row.itemCount >= 1), true);
  const datasetItems = await fetch(`http://127.0.0.1:${port}/api/dataset-items?datasetId=${encodeURIComponent(dataset.id)}`).then((r) => r.json());
  assert.equal(datasetItems.some((row) => row.sessionId === "fixture-claude"), true);
  const buckets = await fetch(`http://127.0.0.1:${port}/api/buckets?datasetId=${encodeURIComponent(dataset.id)}`).then((r) => r.json());
  assert.equal(buckets.some((row) => row.id === bucket.id && row.enabled), true);
  const rules = await fetch(`http://127.0.0.1:${port}/api/rules?behaviorId=${encodeURIComponent(behavior.id)}`).then((r) => r.json());
  assert.equal(rules.some((row) => row.id === rule.id && row.enabled), true);
  const alerts = await fetch(`http://127.0.0.1:${port}/api/alerts?ruleId=${encodeURIComponent(rule.id)}`).then((r) => r.json());
  assert.equal(alerts.some((row) => row.sessionId === "fixture-claude"), true);
  const sessionCompare = await fetch(`http://127.0.0.1:${port}/api/compare/sessions?before=fixture-claude&after=regressed-session`).then((r) => r.json());
  assert.equal(sessionCompare.regressions.some((row) => row.kind === "errors_increased"), true);
  const datasetCompare = await fetch(`http://127.0.0.1:${port}/api/compare/datasets?before=${encodeURIComponent(dataset.id)}&after=${encodeURIComponent(afterDataset.id)}`).then((r) => r.json());
  assert.equal(datasetCompare.deltas.errorSpanCount.delta >= 1, true);
  const configs = await fetch(`http://127.0.0.1:${port}/api/configs?kind=prompt`).then((r) => r.json());
  assert.equal(configs.some((row) => row.id === configCommit.config.id), true);
  const configShow = await fetch(`http://127.0.0.1:${port}/api/configs/${encodeURIComponent(configCommit.config.id)}?tag=prod`).then((r) => r.json());
  assert.equal(configShow.commit.content, "Use tools carefully.");
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
  assert.equal(health.coverage.hiddenPrivateReasoningCaptured, false);
  const recent = await fetch(`http://127.0.0.1:${port}/api/recent?limit=5`).then((r) => r.json());
  assert.equal(Array.isArray(recent), true);
  const rawBlobDisabled = await fetch(`http://127.0.0.1:${port}/api/blob/${fixtureClaude.blobId}`);
  assert.equal(rawBlobDisabled.status, 403);
  const decisions = await fetch(`http://127.0.0.1:${port}/api/decision-log?sessionId=self-trace-fixture`).then((r) => r.json());
  assert.equal(decisions[0].kind, "self_trace");
  const summary = await fetch(`http://127.0.0.1:${port}/api/summaries/session/fixture-claude`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runner: "codex",
      command: process.execPath,
      args: ["-e", "console.log('unsafe override should be ignored')"]
    })
  }).then((r) => r.json());
  assert.equal(summary.summary.includes("vite evidence"), true);
  assert.equal(summary.summary.includes("unsafe override"), false);
  const invalidRunner = await fetch(`http://127.0.0.1:${port}/api/summaries/session/fixture-claude`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runner: "shell" })
  });
  assert.equal(invalidRunner.status, 400);
  fs.appendFileSync(path.join(home, "summaries.jsonl"), "{not-json\n");
  const cachedSummary = await fetch(`http://127.0.0.1:${port}/api/summaries/session/fixture-claude`).then((r) => r.json());
  assert.equal(cachedSummary.summary.includes("vite evidence"), true);
  const summariesAfterCorruptRow = await fetch(`http://127.0.0.1:${port}/api/summaries?sessionId=fixture-claude`).then((r) => r.json());
  assert.equal(Array.isArray(summariesAfterCorruptRow), true);
  assert.equal(summariesAfterCorruptRow.some((row) => row.summary.includes("vite evidence")), true);
  const malformedPath = await fetch(`http://127.0.0.1:${port}/api/traces/%E0%A4%A`);
  assert.equal(malformedPath.status, 400);
  const redactedExportBuffer = Buffer.from(await fetch(`http://127.0.0.1:${port}/api/export?sessionId=fixture-claude`).then((r) => r.arrayBuffer()));
  const redactedZip = await JSZip.loadAsync(redactedExportBuffer);
  assert.equal(Boolean(redactedZip.file("manifest.json")), true);
  assert.equal(Boolean(redactedZip.file("raw.jsonl")), false);
  const manifest = JSON.parse(await redactedZip.file("manifest.json").async("string"));
  assert.equal(manifest.rawIncluded, false);
  assert.equal(manifest.filters.sessionId, "fixture-claude");
  const rangeExportBuffer = Buffer.from(await fetch(`http://127.0.0.1:${port}/api/export?provider=claude&from=2026-05-18T09:59:00.000Z&to=2026-05-18T10:01:00.000Z`).then((r) => r.arrayBuffer()));
  const rangeZip = await JSZip.loadAsync(rangeExportBuffer);
  const rangeManifest = JSON.parse(await rangeZip.file("manifest.json").async("string"));
  const rangeSessions = (await rangeZip.file("sessions.jsonl").async("string")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const rangeEvents = (await rangeZip.file("events.jsonl").async("string")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(rangeManifest.filters.provider, "claude");
  assert.equal(rangeManifest.filters.from, "2026-05-18T09:59:00.000Z");
  assert.equal(rangeSessions.length, 1);
  assert.equal(rangeSessions[0].id, "fixture-claude");
  assert.equal(rangeEvents.every((event) => event.provider === "claude"), true);
  assert.equal(rangeEvents.every((event) => event.timestamp >= "2026-05-18T09:59:00.000Z" && event.timestamp <= "2026-05-18T10:01:00.000Z"), true);
  const rawExportWithoutHeader = await fetch(`http://127.0.0.1:${port}/api/export?sessionId=fixture-claude&raw=1`);
  assert.equal(rawExportWithoutHeader.status, 403);
  const rawExportBuffer = Buffer.from(await fetch(`http://127.0.0.1:${port}/api/export?sessionId=fixture-claude&raw=1`, {
    headers: { "x-tracebase-raw-export": "1" }
  }).then((r) => {
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("content-disposition").includes("export-"), true);
    return r.arrayBuffer();
  }));
  const rawZip = await JSZip.loadAsync(rawExportBuffer);
  assert.equal(Boolean(rawZip.file("raw.jsonl")), true);
  await new Promise((resolve) => server.close(resolve));

  const unavailableServer = createServer({ store });
  await new Promise((resolve) => unavailableServer.listen(0, "127.0.0.1", resolve));
  const unavailablePort = unavailableServer.address().port;
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = "";
    const unavailableRunner = await fetch(`http://127.0.0.1:${unavailablePort}/api/summaries/session/fixture-claude`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runner: "codex" })
    });
    assert.equal(unavailableRunner.status, 503);
    const unavailablePayload = await unavailableRunner.json();
    assert.equal(unavailablePayload.error, "summary_runner_unavailable");
    assert.equal(unavailablePayload.runner, "codex");
  } finally {
    process.env.PATH = originalPath;
    await new Promise((resolve) => unavailableServer.close(resolve));
  }

  const readOnlyServer = createServer({ store });
  await new Promise((resolve) => readOnlyServer.listen(0, "127.0.0.1", resolve));
  const readOnlyPort = readOnlyServer.address().port;
  const intakeDisabled = await fetch(`http://127.0.0.1:${readOnlyPort}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "should-not-write", provider: "test", session_id: "blocked", message: "blocked" })
  });
  assert.equal(intakeDisabled.status, 403);
  const readOnlyHealth = await fetch(`http://127.0.0.1:${readOnlyPort}/api/health`).then((r) => r.json());
  assert.equal(readOnlyHealth.intakeEnabled, false);
  await new Promise((resolve) => readOnlyServer.close(resolve));

  assert.throws(() => listen({ store, port: 0, host: "0.0.0.0" }), /Refusing to bind Tracebase/);

  const snapshot = takeNetSnapshot();
  assert.equal(snapshot.payloadCaptured, false);
  assert.equal(snapshot.hiddenReasoningCaptured, false);

  const merged = mergeHooks({ hooks: { Stop: [] }, model: "sonnet" }, claudeHookSettings("node traces hook"));
  assert.equal(merged.model, "sonnet");
  assert.equal(Array.isArray(merged.hooks.UserPromptSubmit), true);
  assert.equal(bootstrapText({ agent: "claude" }).includes("Claude Code"), true);
  assert.throws(() => bootstrapText({ agent: "shell" }), /--agent must be codex or claude/);
  const instructionTarget = path.join(home, "instructions", "TRACEBASE_AGENT.md");
  const installedInstructions = installInstructions({ agent: "codex", target: instructionTarget });
  assert.equal(installedInstructions.agent, "codex");
  assert.equal(fs.readFileSync(instructionTarget, "utf8").includes("Tracebase Agent Instructions"), true);
  assert.throws(() => installInstructions({ agent: "claude", target: instructionTarget }), /Refusing to overwrite/);
  const forcedInstructions = installInstructions({ agent: "claude", target: instructionTarget, force: true });
  assert.equal(forcedInstructions.agent, "claude");
  assert.equal(fs.readFileSync(instructionTarget, "utf8").includes("Claude Code"), true);
  const symlinkTarget = path.join(home, "instructions", "symlink-target.md");
  const symlinkPath = path.join(home, "instructions", "symlink-agent.md");
  fs.writeFileSync(symlinkTarget, "do not overwrite\n");
  fs.symlinkSync(symlinkTarget, symlinkPath);
  assert.throws(() => installInstructions({ agent: "codex", target: symlinkPath, force: true }), /Refusing to write instruction file through symlink/);
  assert.equal(fs.readFileSync(symlinkTarget, "utf8"), "do not overwrite\n");
  const watcherHome = path.join(home, "watch-store");
  const plist = makePlist({
    traceHome: watcherHome,
    intervalMs: 12345,
    provider: "claude",
    since: "2026-05-18T00:00:00.000Z"
  });
  assert.equal(plist.includes("<string>io.tracebase.watch</string>"), true);
  assert.equal(plist.includes("<key>TRACE_HOME</key>"), true);
  assert.equal(plist.includes(`<string>${watcherHome}</string>`), true);
  assert.equal(plist.includes(`<string>${path.join(watcherHome, "logs", "watch.log")}</string>`), true);
  assert.equal(plist.includes(`<string>${path.join(watcherHome, "logs", "watch.err")}</string>`), true);
  assert.equal(plist.includes("<string>--provider</string>\n    <string>claude</string>"), true);
  assert.equal(plist.includes("<string>--interval-ms</string>\n    <string>12345</string>"), true);
  assert.equal(plist.includes(["local", "agent", "traces"].join("-")), false);
  const legacyRecommendations = watchRecommendations({
    supported: true,
    running: true,
    legacyLabelUsed: true,
    configuredTraceHome: path.join(home, "old-store"),
    expectedTraceHome: watcherHome,
    storeMatches: false
  });
  assert.equal(legacyRecommendations.some((item) => item.includes("watch-install")), true);
  assert.equal(legacyRecommendations.some((item) => item.includes("TRACE_HOME")), true);

  const doctor = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "traces.js"), "doctor"], {
    env: { ...process.env, TRACE_HOME: home },
    encoding: "utf8"
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  const doctorPayload = JSON.parse(doctor.stdout);
  assert.equal(doctorPayload.traceHome, home);
  assert.equal(doctorPayload.summaryRunners.some((runner) => runner.runner === "codex" && typeof runner.available === "boolean"), true);
  assert.equal(doctorPayload.summaryRunners.some((runner) => runner.runner === "claude" && typeof runner.available === "boolean"), true);
  assert.equal(doctorPayload.wrappers.tcodex.target.overrideEnv, "TRACE_CODEX_BIN");
  assert.equal(doctorPayload.wrappers.tclaude.target.overrideEnv, "TRACE_CLAUDE_BIN");
  assert.equal(Array.isArray(doctorPayload.recommendations), true);
  if (doctorPayload.watcher.supported) {
    assert.equal(doctorPayload.watcher.currentLabel, "io.tracebase.watch");
    assert.equal(doctorPayload.watcher.expectedTraceHome, home);
    assert.equal(Array.isArray(doctorPayload.watcher.recommendations), true);
    assert.equal(doctorPayload.watcher.storeMatches === false || doctorPayload.watcher.storeMatches === null, true);
    if (doctorPayload.watcher.storeMatches === false) assert.equal(doctorPayload.watcher.runningForExpectedStore, false);
    assert.equal(doctorPayload.watcher.recommendations.every((item) => doctorPayload.recommendations.includes(item)), true);
  }
  const tracebaseDoctor = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "tracebase.js"), "doctor"], {
    env: { ...process.env, TRACE_HOME: home },
    encoding: "utf8"
  });
  assert.equal(tracebaseDoctor.status, 0, tracebaseDoctor.stderr);
  const tracebaseDoctorPayload = JSON.parse(tracebaseDoctor.stdout);
  assert.equal(tracebaseDoctorPayload.traceHome, home);
  if (tracebaseDoctorPayload.watcher.supported) {
    assert.equal(tracebaseDoctorPayload.watcher.currentLabel, "io.tracebase.watch");
    assert.equal(tracebaseDoctorPayload.watcher.expectedTraceHome, home);
  }
  const doctorNoPath = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "traces.js"), "doctor"], {
    env: { TRACE_HOME: home, PATH: "" },
    encoding: "utf8"
  });
  assert.equal(doctorNoPath.status, 0, doctorNoPath.stderr);
  const doctorNoPathPayload = JSON.parse(doctorNoPath.stdout);
  assert.equal(doctorNoPathPayload.summaryRunners.every((runner) => runner.available === false), true);
  assert.equal(doctorNoPathPayload.wrappers.tcodex.target.available, false);
  assert.equal(doctorNoPathPayload.recommendations.some((item) => item.includes("Codex CLI was not found")), true);
  assert.equal(doctorNoPathPayload.recommendations.some((item) => item.includes("TRACE_CODEX_BIN")), true);
  const doctorOverride = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "traces.js"), "doctor"], {
    env: { TRACE_HOME: home, PATH: "", TRACE_CODEX_BIN: process.execPath },
    encoding: "utf8"
  });
  assert.equal(doctorOverride.status, 0, doctorOverride.stderr);
  const doctorOverridePayload = JSON.parse(doctorOverride.stdout);
  const codexOverrideRunner = doctorOverridePayload.summaryRunners.find((runner) => runner.runner === "codex");
  assert.equal(codexOverrideRunner.available, true);
  assert.equal(codexOverrideRunner.command, process.execPath);
  assert.equal(codexOverrideRunner.overrideEnv, "TRACE_CODEX_BIN");
  assert.equal(doctorOverridePayload.recommendations.some((item) => item.includes("Codex CLI was not found")), false);
  const invalidMaxFiles = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "traces.js"), "import", "--max-files", "abc"], {
    env: { ...process.env, TRACE_HOME: home },
    encoding: "utf8"
  });
  assert.notEqual(invalidMaxFiles.status, 0);
  assert.equal(invalidMaxFiles.stderr.includes("--max-files must be an integer"), true);
  assert.equal(/\n\s+at\s/.test(invalidMaxFiles.stderr), false);
  const invalidMaxEvents = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "traces.js"), "import", "--max-events", "0"], {
    env: { ...process.env, TRACE_HOME: home },
    encoding: "utf8"
  });
  assert.notEqual(invalidMaxEvents.status, 0);
  assert.equal(invalidMaxEvents.stderr.includes("--max-events must be an integer"), true);
  assert.equal(/\n\s+at\s/.test(invalidMaxEvents.stderr), false);
  const invalidPort = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "traces.js"), "serve", "--port", "abc"], {
    env: { ...process.env, TRACE_HOME: home },
    encoding: "utf8"
  });
  assert.notEqual(invalidPort.status, 0);
  assert.equal(invalidPort.stderr.includes("--port must be an integer"), true);
  assert.equal(/\n\s+at\s/.test(invalidPort.stderr), false);
  const unknownCommand = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "traces.js"), "unknown-command"], {
    env: { ...process.env, TRACE_HOME: home },
    encoding: "utf8"
  });
  assert.notEqual(unknownCommand.status, 0);
  assert.equal(unknownCommand.stderr.includes("Unknown command: unknown-command"), true);
  assert.equal(/\n\s+at\s/.test(unknownCommand.stderr), false);
  const wrappedCodex = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "tcodex.js"), "-e", "process.exit(7)"], {
    env: { ...process.env, TRACE_HOME: home, TRACE_CODEX_BIN: process.execPath },
    encoding: "utf8"
  });
  assert.equal(wrappedCodex.status, 7);
  const missingWrappedClaude = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "tclaude.js"), "--version"], {
    env: { ...process.env, TRACE_HOME: home, TRACE_CLAUDE_BIN: path.join(home, "missing-claude-bin") },
    encoding: "utf8"
  });
  assert.notEqual(missingWrappedClaude.status, 0);
  assert.equal(missingWrappedClaude.stderr.includes("claude wrapper failed to start"), true);
  assert.equal(/\n\s+at\s/.test(missingWrappedClaude.stderr), false);
  assert.equal(store.search("failed to start", { sessionId: null }).some((event) => event.type === "wrapper_end"), true);

  const llmobsCli = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "traces.js"), "llmobs-spans", "--trace-id", "trace-live-1"], {
    env: { ...process.env, TRACE_HOME: home },
    encoding: "utf8"
  });
  assert.equal(llmobsCli.status, 0, llmobsCli.stderr);
  assert.equal(llmobsCli.stdout.includes("live-root"), true);
  const llmobsTraceCli = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "traces.js"), "llmobs-trace", "--trace-id", "trace-live-1"], {
    env: { ...process.env, TRACE_HOME: home },
    encoding: "utf8"
  });
  assert.equal(llmobsTraceCli.status, 0, llmobsTraceCli.stderr);
  assert.equal(JSON.parse(llmobsTraceCli.stdout).attributes.trace_id, "trace-live-1");

  const mcpInput = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_events", arguments: { query: "vite", limit: 5 } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "compare_sessions", arguments: { before: "fixture-claude", after: "regressed-session" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_config", arguments: { config: "Agent Prompt", tag: "prod" } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "create_dataset", arguments: { name: "MCP Write Should Be Blocked" } } }
  ].map(encodeFrame).join("");
  const mcp = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "traces.js"), "mcp"], {
    env: { ...process.env, TRACE_HOME: home },
    input: mcpInput,
    encoding: "utf8"
  });
  assert.equal(mcp.status, 0, mcp.stderr);
  const mcpMessages = parseFrames(mcp.stdout).messages;
  assert.equal(mcpMessages.find((msg) => msg.id === 2).result.tools.some((tool) => tool.name === "compare_sessions"), true);
  assert.equal(mcpMessages.find((msg) => msg.id === 2).result.tools.some((tool) => tool.name === "create_dataset"), false);
  assert.equal(mcpMessages.find((msg) => msg.id === 2).result.tools.every((tool) => tool.inputSchema.additionalProperties === false), true);
  const searchPayload = JSON.parse(mcpMessages.find((msg) => msg.id === 3).result.content[0].text);
  assert.equal(searchPayload.length >= 1, true);
  const comparePayload = JSON.parse(mcpMessages.find((msg) => msg.id === 4).result.content[0].text);
  assert.equal(comparePayload.regressions.some((row) => row.kind === "errors_increased"), true);
  const configPayload = JSON.parse(mcpMessages.find((msg) => msg.id === 5).result.content[0].text);
  assert.equal(configPayload.commit.content, "Use tools carefully.");
  assert.equal(mcpMessages.find((msg) => msg.id === 6).error.message.includes("--allow-write"), true);
  const mcpWriteList = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_judge", arguments: { name: "Blocked Custom Command", pattern: "vite", command: process.execPath } } }
  ].map(encodeFrame).join("");
  const mcpWrite = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "traces.js"), "mcp", "--allow-write"], {
    env: { ...process.env, TRACE_HOME: home },
    input: mcpWriteList,
    encoding: "utf8"
  });
  assert.equal(mcpWrite.status, 0, mcpWrite.stderr);
  const mcpWriteTools = parseFrames(mcpWrite.stdout).messages.find((msg) => msg.id === 2).result.tools;
  assert.equal(mcpWriteTools.some((tool) => tool.name === "create_dataset"), true);
  assert.equal(mcpWriteTools.every((tool) => tool.inputSchema.additionalProperties === false), true);
  const mcpWriteMessages = parseFrames(mcpWrite.stdout).messages;
  assert.equal(mcpWriteMessages.find((msg) => msg.id === 3).error.message.includes("Unexpected MCP argument"), true);

  fs.appendFileSync(store.indexPath, "{partial-json\n");
  fs.appendFileSync(store.judgesPath, "{partial-json\n");
  fs.appendFileSync(store.datasetsPath, "{partial-json\n");
  store.rebuildIndex();
  assert.equal(store.search("vite").length >= 1, true);
  assert.equal(store.listSpans({ traceId: "trace-live-1" }).some((span) => span.id === "live-root"), true);

  console.log("smoke ok");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
