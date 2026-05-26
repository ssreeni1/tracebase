"use strict";

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function slug(value) {
  return String(value || "judge")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "judge";
}

function makeJudgeSpec(input = {}) {
  if (!input.name) throw new Error("Judge name is required.");
  if (input.runner || input.rubric || input.kind === "cli_llm" || (input.config && input.config.kind === "cli_llm")) {
    return makeCliLlmJudgeSpec(input);
  }
  const pattern = input.pattern || (input.config && input.config.pattern);
  if (!pattern) throw new Error("A local regex judge requires a pattern.");
  const createdAt = input.createdAt || nowIso();
  const judgeId = input.id || `judge:${slug(input.name)}`;
  const version = Number(input.version || 1);
  const versionId = input.versionId || `${judgeId}:v${version}`;
  const scoreType = input.scoreType || "binary";
  const config = {
    kind: "regex",
    pattern,
    flags: input.flags || (input.config && input.config.flags) || "i",
    target: input.target || (input.config && input.config.target) || "span",
    spanType: input.spanType || (input.config && input.config.spanType) || null
  };
  return {
    judge: {
      id: judgeId,
      name: input.name,
      description: input.description || null,
      scoreType,
      currentVersion: version,
      createdAt,
      updatedAt: createdAt
    },
    version: {
      id: versionId,
      judgeId,
      version,
      prompt: input.prompt || `Detect whether the trace evidence matches /${pattern}/.`,
      model: "local-regex",
      config,
      createdAt
    }
  };
}

function makeCliLlmJudgeSpec(input = {}) {
  if (!input.name) throw new Error("Judge name is required.");
  const rubric = input.rubric || input.prompt;
  if (!rubric) throw new Error("A CLI LLM judge requires a rubric or prompt.");
  const createdAt = input.createdAt || nowIso();
  const judgeId = input.id || `judge:${slug(input.name)}`;
  const version = Number(input.version || 1);
  const versionId = input.versionId || `${judgeId}:v${version}`;
  const runner = input.runner || (input.config && input.config.runner) || "codex";
  const defaults = defaultRunnerConfig(runner);
  const config = {
    kind: "cli_llm",
    runner,
    command: input.command || (input.config && input.config.command) || defaults.command,
    args: input.args || (input.config && input.config.args) || defaults.args,
    timeoutMs: Number(input.timeoutMs || (input.config && input.config.timeoutMs) || 120000),
    maxSpans: Number(input.maxSpans || (input.config && input.config.maxSpans) || 200)
  };
  return {
    judge: {
      id: judgeId,
      name: input.name,
      description: input.description || null,
      scoreType: input.scoreType || "binary",
      currentVersion: version,
      createdAt,
      updatedAt: createdAt
    },
    version: {
      id: versionId,
      judgeId,
      version,
      prompt: rubric,
      model: `cli:${runner}`,
      config,
      createdAt
    }
  };
}

function defaultRunnerConfig(runner) {
  if (runner === "claude") {
    return {
      command: "claude",
      args: ["-p", "--output-format", "text", "--tools", "", "--no-session-persistence"]
    };
  }
  if (runner === "custom") return { command: null, args: [] };
  return {
    command: "codex",
    args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "-"]
  };
}

function makeBehaviorSpec(input = {}) {
  if (!input.name) throw new Error("Behavior name is required.");
  if (!input.judgeId) throw new Error("Behavior judgeId is required.");
  const createdAt = input.createdAt || nowIso();
  return {
    id: input.id || `behavior:${slug(input.name)}`,
    name: input.name,
    judgeId: input.judgeId,
    description: input.description || null,
    createdAt,
    updatedAt: createdAt
  };
}

function evaluateRegexJudge(store, judge, version, options = {}) {
  const config = version.config || {};
  const flags = String(config.flags || "i").replace(/[^dgimsuvy]/g, "");
  const pattern = new RegExp(config.pattern, flags);
  const spans = store.listSpans({
    limit: options.limit || 50000,
    traceId: options.traceId,
    sessionId: options.sessionId,
    spanType: config.spanType || options.spanType
  });
  const rows = [];
  for (const span of spans) {
    if (span.spanType === "trace" && config.target !== "trace") continue;
    const haystack = [
      span.name,
      span.type,
      span.spanType,
      span.input,
      span.output,
      JSON.stringify(span.metadata || {})
    ].filter(Boolean).join("\n");
    const matched = pattern.test(haystack);
    pattern.lastIndex = 0;
    const evaluatedAt = nowIso();
    rows.push({
      id: hash(`${judge.id}:${version.id}:${span.id}:${evaluatedAt}:${matched}`),
      judgeId: judge.id,
      judgeVersionId: version.id,
      traceId: span.traceId,
      spanId: span.id,
      sessionId: span.sessionId,
      score: matched ? 1 : 0,
      passed: matched ? 1 : 0,
      label: matched ? "true" : "false",
      reason: matched ? `Matched /${config.pattern}/ on ${span.spanType} span.` : `No /${config.pattern}/ match on ${span.spanType} span.`,
      evidence: {
        spanName: span.name,
        spanType: span.spanType,
        pattern: config.pattern
      },
      evaluatedAt
    });
  }
  return rows;
}

function buildTracePacket(store, options = {}) {
  const sessionId = options.sessionId || null;
  const traceId = options.traceId || null;
  const trace = traceId ? store.getTrace(traceId) : (sessionId ? store.listTraces({ sessionId, limit: 1 })[0] : null);
  if (!trace && !sessionId && !traceId) throw new Error("CLI LLM judges require --session-id or --trace-id.");
  if (!trace && traceId) throw new Error(`Unknown trace: ${traceId}`);
  const effectiveSessionId = sessionId || (trace && trace.sessionId);
  const effectiveTraceId = traceId || (trace && trace.id);
  const spans = store.listSpans({
    traceId: effectiveTraceId,
    sessionId: effectiveSessionId,
    limit: options.maxSpans || 200
  }).map((span) => ({
    id: span.id,
    parentSpanId: span.parentSpanId,
    eventId: span.eventId,
    type: span.type,
    spanType: span.spanType,
    name: span.name,
    role: span.role,
    status: span.status,
    startTime: span.startTime,
    input: truncate(span.input, 2000),
    output: truncate(span.output, 2000),
    metadata: span.metadata || {}
  }));
  return {
    trace: trace || { id: effectiveTraceId, sessionId: effectiveSessionId },
    spans,
    annotations: store.listAnnotations({ sessionId: effectiveSessionId, limit: 200 }),
    behaviorResults: store.listBehaviorResults({ sessionId: effectiveSessionId, limit: 200 }),
    alerts: store.listAlerts({ sessionId: effectiveSessionId, limit: 200 })
  };
}

function truncate(value, max) {
  if (value == null) return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) + "\n[TRUNCATED]" : text;
}

function renderCliJudgePrompt(judge, version, packet) {
  return [
    "You are evaluating an agent trace as an agent behavior judge.",
    "Use only the provided trace packet. Do not infer from hidden reasoning or external facts.",
    "",
    "Rubric:",
    version.prompt,
    "",
    "Return exactly one JSON object and no markdown. The JSON object must match:",
    JSON.stringify({
      score: "number from 0 to 1",
      passed: "boolean",
      label: "short string category",
      reason: "concise explanation",
      evidence_spans: ["span ids that support the judgment"]
    }, null, 2),
    "",
    "Trace packet:",
    JSON.stringify(packet, null, 2)
  ].join("\n");
}

function parseJudgeJson(output) {
  const text = String(output || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("Judge runner did not return a JSON object.");
  }
}

function evaluateCliLlmJudge(store, judge, version, options = {}) {
  const config = version.config || {};
  const packet = buildTracePacket(store, { ...options, maxSpans: config.maxSpans || options.maxSpans });
  const prompt = renderCliJudgePrompt(judge, version, packet);
  const command = options.command || config.command;
  const args = options.args || config.args || [];
  if (!command) throw new Error("CLI LLM judge command is required.");
  const run = spawnSync(command, args, {
    input: prompt,
    encoding: "utf8",
    timeout: Number(options.timeoutMs || config.timeoutMs || 120000),
    maxBuffer: 10 * 1024 * 1024,
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.env || {}) }
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(`Judge runner exited ${run.status}: ${(run.stderr || run.stdout || "").trim().slice(0, 1000)}`);
  }
  const parsed = parseJudgeJson(run.stdout);
  const evidenceSpans = Array.isArray(parsed.evidence_spans) ? parsed.evidence_spans : [];
  const evaluatedAt = nowIso();
  return [{
    id: hash(`${judge.id}:${version.id}:${packet.trace.id}:${evaluatedAt}:${JSON.stringify(parsed)}`),
    judgeId: judge.id,
    judgeVersionId: version.id,
    traceId: packet.trace.id,
    spanId: evidenceSpans[0] || null,
    sessionId: packet.trace.sessionId,
    score: clampScore(parsed.score),
    passed: parsed.passed ? 1 : 0,
    label: parsed.label == null ? (parsed.passed ? "pass" : "fail") : String(parsed.label),
    reason: parsed.reason == null ? "CLI LLM judge returned no reason." : String(parsed.reason),
    evidence: {
      runner: config.runner,
      evidenceSpans,
      raw: parsed
    },
    evaluatedAt
  }];
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function evaluateJudge(store, judgeId, options = {}) {
  const judge = store.getJudge(judgeId);
  if (!judge) throw new Error(`Unknown judge: ${judgeId}`);
  const version = store.getJudgeVersion(judge.id, options.version);
  if (!version) throw new Error(`No version found for judge: ${judgeId}`);
  if (!version.config || !["regex", "cli_llm"].includes(version.config.kind)) {
    throw new Error(`Unsupported local judge kind: ${version.config && version.config.kind}`);
  }
  const evaluations = version.config.kind === "cli_llm"
    ? evaluateCliLlmJudge(store, judge, version, options)
    : evaluateRegexJudge(store, judge, version, options);
  for (const row of evaluations) store.recordEvaluation(row);
  const behaviors = store.listBehaviors({ judgeId: judge.id });
  for (const behavior of behaviors) {
    for (const evaluation of evaluations) {
      if (evaluation.passed) store.recordBehaviorResult(behavior, evaluation);
    }
  }
  return { judge, version, evaluations, behaviorResults: behaviors.length };
}

module.exports = {
  evaluateJudge,
  buildTracePacket,
  makeBehaviorSpec,
  makeJudgeSpec,
  parseJudgeJson,
  renderCliJudgePrompt
};
