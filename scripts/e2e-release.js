"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const JSZip = require("jszip");
const { encodeFrame, parseFrames } = require("../src/mcp");
const { TraceStore } = require("../src/storage");
const { importJsonlFile } = require("../src/importers");
const { createServer } = require("../src/server");
const { analyzeStore } = require("../src/analyze");

const ROOT = path.resolve(__dirname, "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    input: options.input,
    encoding: options.encoding || "utf8",
    timeout: options.timeout || 180000,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`${[command, ...args].join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr || result.error && result.error.message || ""}`);
  }
  return result;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

async function zipFromResponse(response) {
  assert.equal(response.status, 200);
  return JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
}

async function zipText(zip) {
  const parts = [];
  for (const name of Object.keys(zip.files)) {
    if (!zip.files[name].dir) parts.push(await zip.file(name).async("string").catch(() => ""));
  }
  return parts.join("\n");
}

function assertNoSecret(text, secret) {
  assert.equal(String(text).includes(secret), false, `secret leaked: ${secret}`);
}

function seedStore(home) {
  const store = new TraceStore({ home });
  store.init();
  const seen = store.seenEventIds();
  importJsonlFile(store, "claude", path.join(ROOT, "test", "fixtures", "claude.jsonl"), seen);
  importJsonlFile(store, "codex", path.join(ROOT, "test", "fixtures", "codex.jsonl"), seen);
  const secret = "sk-" + "r".repeat(24);
  store.ingestLiveEvent({
    id: "release-secret-prompt",
    session_id: "release-waste",
    provider: "codex",
    type: "user",
    role: "user",
    cwd: "/tmp/project",
    message: `please run tests with OPENAI_API_KEY=${secret}`,
    timestamp: "2026-05-18T14:00:00.000Z"
  });
  store.ingestLiveEvent({
    id: "release-waste-1",
    session_id: "release-waste",
    provider: "codex",
    type: "tool_call",
    cwd: "/tmp/project",
    model: "gpt-4.1-mini",
    usage: { input_tokens: 500, output_tokens: 50, total_tokens: 550 },
    tool_name: "exec_command",
    tool_input: { command: `OPENAI_API_KEY=${secret} npm test`, file_path: "package.json" },
    tool_response: { content: "x".repeat(13000) },
    exit_code: 2,
    timestamp: "2026-05-18T14:01:00.000Z"
  });
  store.ingestLiveEvent({
    id: "release-waste-2",
    session_id: "release-waste",
    provider: "codex",
    type: "tool_call",
    cwd: "/tmp/project",
    model: "gpt-4.1-mini",
    usage: { input_tokens: 250, output_tokens: 20, total_tokens: 270 },
    tool_name: "exec_command",
    tool_input: { command: "npm test", file_path: "test/smoke.js" },
    timestamp: "2026-05-18T14:02:00.000Z"
  });
  store.ingestLiveEvent({
    id: "release-waste-3",
    session_id: "release-waste",
    provider: "codex",
    type: "tool_call",
    cwd: "/tmp/project",
    model: "gpt-4.1-mini",
    usage: { input_tokens: 125, output_tokens: 10, total_tokens: 135 },
    tool_name: "exec_command",
    tool_input: { command: "npm test", file_path: "test/smoke.js" },
    decision: "denied",
    timestamp: "2026-05-18T14:03:00.000Z"
  });
  analyzeStore(store, { sessionId: "fixture-codex" });
  analyzeStore(store, { sessionId: "release-waste" });
  return { store, secret };
}

function assertCli(home) {
  const env = { TRACE_HOME: home };
  assert.equal(run(process.execPath, ["bin/tracebase.js", "health"], { env }).stdout.includes("hiddenPrivateReasoning"), true);
  const costs = JSON.parse(run(process.execPath, ["bin/tracebase.js", "costs", "--session-id", "release-waste"], { env }).stdout);
  assert.equal(costs.totals.totalTokens, 955);
  const compare = JSON.parse(run(process.execPath, ["bin/tracebase.js", "run-compare", "--base-session-id", "fixture-codex", "--target-session-id", "release-waste"], { env }).stdout);
  assert.equal(compare.deltas.totalTokens.target, 955);
  const diff = JSON.parse(run(process.execPath, ["bin/tracebase.js", "trace-diff", "--session-id", "fixture-claude"], { env }).stdout);
  assert.equal(diff.complete, true);
}

function assertMcp(home, secret) {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "release-e2e", version: "0" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "session_scorecard", arguments: { sessionId: "release-waste" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "costs", arguments: { sessionId: "release-waste" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "run_compare", arguments: { baseSessionId: "fixture-codex", targetSessionId: "release-waste" } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_spans", arguments: { sessionId: "release-waste", limit: 20 } } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "stats", arguments: { unexpected: true } } }
  ].map(encodeFrame).join("");
  const mcp = run(process.execPath, ["bin/traces.js", "mcp"], { env: { TRACE_HOME: home }, input });
  assertNoSecret(mcp.stdout, secret);
  const messages = parseFrames(mcp.stdout).messages;
  assert.equal(messages.find((msg) => msg.id === 2).result.tools.some((tool) => tool.name === "run_compare"), true);
  const scorecard = JSON.parse(messages.find((msg) => msg.id === 3).result.content[0].text);
  assert.equal(scorecard.metrics.contextWasteCount >= 1, true);
  const costs = JSON.parse(messages.find((msg) => msg.id === 4).result.content[0].text);
  assert.equal(costs.totals.totalTokens, 955);
  const spans = JSON.parse(messages.find((msg) => msg.id === 6).result.content[0].text);
  assert.equal(JSON.stringify(spans).includes(secret), false);
  assert.equal(messages.find((msg) => msg.id === 7).error.message.includes("Unexpected MCP argument"), true);
}

async function assertApiAndExports(store, secret) {
  const server = createServer({ store });
  const origin = await listen(server);
  try {
    const health = await json(`${origin}/api/health`);
    assert.equal(health.body.intakeEnabled, false);
    const blocked = await json(`${origin}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: JSON.stringify({ id: "blocked", provider: "test", session_id: "blocked", message: "blocked" })
    });
    assert.equal(blocked.response.status, 403);
    const costs = await json(`${origin}/api/costs?sessionId=release-waste`);
    assert.equal(costs.body.totals.totalTokens, 955);
    const compare = await json(`${origin}/api/run-compare?baseSessionId=fixture-codex&targetSessionId=release-waste`);
    assert.equal(compare.body.deltas.contextWasteCount.target >= 1, true);
    const spans = await json(`${origin}/api/spans?sessionId=release-waste&limit=20`);
    assertNoSecret(JSON.stringify(spans.body), secret);
    const redactedZip = await zipFromResponse(await fetch(`${origin}/api/export?sessionId=release-waste`));
    assert.equal(Boolean(redactedZip.file("raw.jsonl")), false);
    assert.equal(Boolean(redactedZip.file("session_metrics.jsonl")), true);
    assertNoSecret(await zipText(redactedZip), secret);
    const incidentZip = await zipFromResponse(await fetch(`${origin}/api/export?sessionId=release-waste&incident=1`));
    assert.equal(Boolean(incidentZip.file("incident.json")), true);
    assertNoSecret(await zipText(incidentZip), secret);
    const rawDenied = await fetch(`${origin}/api/export?sessionId=release-waste&raw=1`);
    assert.equal(rawDenied.status, 403);
    const rawZip = await zipFromResponse(await fetch(`${origin}/api/export?sessionId=release-waste&raw=1`, {
      headers: { "x-tracebase-raw-export": "1" }
    }));
    assert.equal(Boolean(rawZip.file("raw.jsonl")), true);
    assert.equal((await zipText(rawZip)).includes(secret), true);
    const rawBlobDenied = await fetch(`${origin}/api/blob/${store.search("", { sessionId: "release-waste", limit: 1 })[0].blobId}`);
    assert.equal(rawBlobDenied.status, 403);
    return origin;
  } finally {
    await close(server);
  }
}

async function assertLiveIntake(store) {
  const server = createServer({ store, allowIntake: true });
  const origin = await listen(server);
  try {
    const accepted = await json(`${origin}/api/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ id: "release-live-event", provider: "test", session_id: "release-live", type: "note", message: "release live intake works" }],
        spans: [{ trace_id: "release-live-trace", span_id: "release-live-span", session_id: "release-live", kind: "llm", name: "release span", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }]
      })
    });
    assert.equal(accepted.response.status, 202);
    const found = await json(`${origin}/api/events?q=release%20live%20intake`);
    assert.equal(found.body.some((event) => event.id === "release-live-event"), true);
    const spans = await json(`${origin}/api/llmobs/spans?traceId=release-live-trace`);
    assert.equal(spans.body.some((span) => span.attributes.metrics.totalTokens === 15), true);
  } finally {
    await close(server);
  }
}

async function assertRenderedDashboard(home) {
  const port = 7333;
  const child = spawn(process.execPath, ["bin/traces.js", "serve", "--port", String(port)], {
    cwd: ROOT,
    env: { ...process.env, TRACE_HOME: home },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForHealth(`http://127.0.0.1:${port}/api/health`);
    const screenshot = path.join(os.tmpdir(), `tracebase-release-${process.pid}.png`);
    const shot = spawnSync("npm", [
      "exec",
      "--package=playwright",
      "--",
      "playwright",
      "screenshot",
      "--viewport-size=1440,1000",
      "--full-page",
      `http://127.0.0.1:${port}/?provider=codex&sort=time&order=desc`,
      screenshot
    ], {
      cwd: ROOT,
      env: { ...process.env },
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024
    });
    if (shot.status !== 0) throw new Error(`playwright screenshot failed\n${shot.stdout}\n${shot.stderr}`);
    const bytes = fs.readFileSync(screenshot);
    assert.equal(bytes.slice(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.length > 10000, true);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 1000);
    });
  }
}

async function waitForHealth(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("timed out waiting for " + url);
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tracebase-release-e2e-"));
  const { store, secret } = seedStore(home);
  assertCli(home);
  assertMcp(home, secret);
  await assertApiAndExports(store, secret);
  await assertLiveIntake(store);
  await assertRenderedDashboard(home);
  run(process.execPath, ["scripts/package-install-smoke.js"], { timeout: 240000 });
  console.log("release e2e ok");
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
