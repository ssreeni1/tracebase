"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { executablePath } = require("./executables");
const { compactText, redactText } = require("./redact");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function summariesPath(traceHome) {
  return path.join(traceHome, "summaries.jsonl");
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\n/).filter(Boolean)) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Append-only logs can be interrupted; ignore malformed summary rows.
    }
  }
  return rows;
}

function appendJsonl(file, row) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
}

function runnerCommand(runner, env = process.env) {
  return env[`TRACE_${runner.toUpperCase()}_BIN`] || runner;
}

function defaultRunnerConfig(runner, env = process.env) {
  if (runner === "claude") {
    return { command: runnerCommand(runner, env), args: ["-p", "--output-format", "text", "--tools", "", "--no-session-persistence"] };
  }
  return { command: runnerCommand(runner, env), args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "-"] };
}

function availableSummaryRunners(env = process.env) {
  return ["codex", "claude"].map((runner) => {
    const config = defaultRunnerConfig(runner, env);
    const executable = executablePath(config.command, env);
    return {
      runner,
      label: runner === "claude" ? "Claude CLI" : "Codex CLI",
      available: Boolean(executable),
      command: config.command,
      path: executable,
      overrideEnv: `TRACE_${runner.toUpperCase()}_BIN`,
      args: config.args
    };
  });
}

function sessionPacket(store, sessionId, options = {}) {
  const session = store.listSessions({ q: sessionId, limit: 100 }).find((row) => row.id === sessionId) || null;
  const traces = store.listTraces({ sessionId, limit: 5 });
  const events = store.search(options.query || "", {
    sessionId,
    limit: options.limit || 120,
    order: "asc",
    sort: "time"
  });
  const spans = store.listSpans({ sessionId, limit: 120 });
  const annotations = store.listAnnotations({ sessionId, limit: 80 });
  return { session, traces, events, spans, annotations };
}

function renderSummaryPrompt(packet) {
  const payload = compactText(JSON.stringify(packet, null, 2), 30000).text;
  return [
    "Summarize this local agent trace session for a developer who wants to understand what happened.",
    "Use only the visible trace artifacts in the JSON below.",
    "Do not claim hidden/private chain-of-thought or private reasoning was captured.",
    "Call out goal, outcome, important commands/tools, failures, recoveries, and reusable lessons.",
    "Return concise Markdown with headings: Goal, Outcome, Timeline, Failures, Useful Follow-ups.",
    "",
    payload
  ].join("\n");
}

function listSummaries(options = {}) {
  const rows = readJsonl(summariesPath(options.traceHome));
  return rows
    .filter((row) => !options.sessionId || row.sessionId === options.sessionId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Number(options.limit || 100));
}

function latestSummary(options = {}) {
  return listSummaries({ ...options, limit: 1 })[0] || null;
}

function prepareSummaryRun(store, sessionId, options = {}) {
  if (!sessionId) throw new Error("sessionId is required.");
  const runner = options.runner || "codex";
  if (!["codex", "claude"].includes(runner)) throw new Error("runner must be codex or claude.");
  const packet = sessionPacket(store, sessionId, options);
  if (!packet.session) throw new Error(`Unknown session: ${sessionId}`);
  const prompt = renderSummaryPrompt(packet);
  const config = options.command
    ? { command: options.command, args: options.args || [] }
    : defaultRunnerConfig(runner);
  return { runner, packet, prompt, config };
}

function writeSummaryRow(store, sessionId, run, stdout) {
  const redacted = redactText(stdout || "");
  const row = {
    id: "summary:" + hash(`${sessionId}:${run.runner}:${Date.now()}:${redacted.text}`),
    sessionId,
    runner: run.runner,
    promptVersion: "session_summary_v1",
    command: run.config.command,
    args: run.config.args,
    createdAt: new Date().toISOString(),
    eventIds: run.packet.events.map((event) => event.id).filter(Boolean),
    spanIds: run.packet.spans.map((span) => span.id).filter(Boolean),
    redactions: redacted.hits,
    summary: redacted.text.trim()
  };
  appendJsonl(summariesPath(store.home), row);
  return row;
}

function summarizeSession(store, sessionId, options = {}) {
  const runSpec = prepareSummaryRun(store, sessionId, options);
  const run = spawnSync(runSpec.config.command, runSpec.config.args, {
    input: runSpec.prompt,
    encoding: "utf8",
    timeout: Number(options.timeoutMs || 120000),
    maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, TRACE_HOME: store.home }
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error((run.stderr || run.stdout || `${runSpec.config.command} exited ${run.status}`).slice(0, 2000));
  return writeSummaryRow(store, sessionId, runSpec, run.stdout);
}

function summarizeSessionAsync(store, sessionId, options = {}) {
  const runSpec = prepareSummaryRun(store, sessionId, options);
  const timeoutMs = Number(options.timeoutMs || 120000);
  return new Promise((resolve, reject) => {
    const child = spawn(runSpec.config.command, runSpec.config.args, {
      env: { ...process.env, TRACE_HOME: store.home },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`summary runner timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 5 * 1024 * 1024) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error((stderr || stdout || `${runSpec.config.command} exited ${code}`).slice(0, 2000)));
      try {
        resolve(writeSummaryRow(store, sessionId, runSpec, stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(runSpec.prompt);
  });
}

module.exports = {
  availableSummaryRunners,
  defaultRunnerConfig,
  latestSummary,
  listSummaries,
  renderSummaryPrompt,
  runnerCommand,
  summarizeSession,
  summarizeSessionAsync
};
