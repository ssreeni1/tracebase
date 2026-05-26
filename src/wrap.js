"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const { executablePath } = require("./executables");
const { TraceStore, sha256 } = require("./storage");

function executableFor(agent) {
  return process.env[`TRACE_${agent.toUpperCase()}_BIN`] || agent;
}

function wrapperDiagnostics(agent, env = process.env) {
  const command = env[`TRACE_${agent.toUpperCase()}_BIN`] || agent;
  const resolved = executablePath(command, env);
  return {
    agent,
    command,
    available: Boolean(resolved),
    path: resolved,
    overrideEnv: `TRACE_${agent.toUpperCase()}_BIN`
  };
}

function runChild(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        TRACE_WRAPPED_AGENT: command
      }
    });
    child.on("error", (error) => resolve({ code: null, signal: null, error }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

async function runWrappedAgent(agent, args) {
  const store = new TraceStore();
  store.init();
  const startedAt = new Date().toISOString();
  const sessionId = sha256(JSON.stringify([agent, process.cwd(), startedAt, args])).slice(0, 32);
  const taskId = sessionId;
  const invocation = {
    agent,
    args,
    cwd: process.cwd(),
    pid: process.pid,
    startedAt
  };
  store.addEvent({
    provider: agent,
    sessionId,
    taskId,
    type: "wrapper_start",
    cwd: process.cwd(),
    timestamp: startedAt,
    summary: `${agent} ${args.join(" ")}`.trim(),
    searchText: invocation,
    raw: invocation
  });
  store.upsertSession({
    id: sessionId,
    provider: agent,
    sourcePath: "wrapper",
    cwd: process.cwd(),
    startedAt,
    endedAt: null,
    eventCount: 1
  });
  store.upsertTask({
    id: taskId,
    title: `${agent} ${args.join(" ")}`.trim() || `${agent} session`,
    provider: agent,
    sessionId,
    cwd: process.cwd(),
    startedAt,
    endedAt: null
  });

  const result = await runChild(executableFor(agent), args);
  const endedAt = new Date().toISOString();
  const failedToStart = result.error ? `failed to start: ${result.error.message}` : null;
  const exitPayload = {
    agent,
    args,
    cwd: process.cwd(),
    code: result.code,
    signal: result.signal,
    error: failedToStart,
    endedAt
  };
  store.addEvent({
    provider: agent,
    sessionId,
    taskId,
    type: "wrapper_end",
    cwd: process.cwd(),
    timestamp: endedAt,
    summary: failedToStart || `${agent} exited ${result.code == null ? result.signal : result.code}`,
    searchText: exitPayload,
    raw: exitPayload
  });
  store.upsertSession({
    id: sessionId,
    provider: agent,
    sourcePath: "wrapper",
    cwd: process.cwd(),
    startedAt,
    endedAt,
    eventCount: 2
  });
  store.upsertTask({
    id: taskId,
    title: `${agent} ${args.join(" ")}`.trim() || `${agent} session`,
    provider: agent,
    sessionId,
    cwd: process.cwd(),
    startedAt,
    endedAt
  });
  if (result.error) {
    process.exitCode = 1;
    throw new Error(`${agent} wrapper failed to start ${executableFor(agent)}: ${result.error.message}`);
  }
  process.exitCode = result.code == null ? 1 : result.code;
}

module.exports = {
  executableFor,
  runWrappedAgent,
  wrapperDiagnostics
};
