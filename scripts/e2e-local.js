"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TraceStore } = require("../src/storage");
const { importJsonlFile } = require("../src/importers");
const { createServer } = require("../src/server");
const { analyzeStore } = require("../src/analyze");

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

async function main() {
  const root = path.resolve(__dirname, "..");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tracebase-e2e-"));
  process.env.TRACE_HOME = home;

  const store = new TraceStore({ home });
  store.init();
  const seen = store.seenEventIds();
  importJsonlFile(store, "claude", path.join(root, "test", "fixtures", "claude.jsonl"), seen);
  importJsonlFile(store, "codex", path.join(root, "test", "fixtures", "codex.jsonl"), seen);
  analyzeStore(store, { sessionId: "fixture-codex" });

  const server = createServer({ store });
  const origin = await listen(server);
  try {
    const health = await json(`${origin}/api/health`);
    assert.equal(health.response.status, 200);
    assert.equal(health.body.intakeEnabled, false);
    assert.equal(health.body.eventCount, 8);
    assert.equal(health.body.sessionCount, 2);

    const deepLink = await fetch(`${origin}/?q=vite&provider=claude&cwd=${encodeURIComponent("/tmp/project")}&sort=time&order=desc`);
    const deepLinkHtml = await deepLink.text();
    assert.equal(deepLink.status, 200);
    assert.equal(deepLinkHtml.includes('<div id="root"></div>'), true);
    assert.equal(deepLinkHtml.includes("Tracebase Dashboard Not Built"), false);

    const sessions = await json(`${origin}/api/sessions?provider=claude&q=vite&cwd=${encodeURIComponent("/tmp/project")}&limit=5`);
    assert.equal(sessions.response.status, 200);
    assert.equal(sessions.body.length, 1);
    assert.equal(sessions.body[0].id, "fixture-claude");

    const events = await json(`${origin}/api/events?provider=claude&q=vite&sessionId=fixture-claude&limit=20`);
    assert.equal(events.response.status, 200);
    assert.equal(events.body.length, 2);
    assert.equal(events.body.every((event) => event.sessionId === "fixture-claude"), true);

    const runners = await json(`${origin}/api/summary-runners`);
    assert.equal(runners.response.status, 200);
    assert.equal(runners.body.runners.some((runner) => runner.runner === "codex"), true);
    assert.equal(JSON.stringify(runners.body).includes("\"path\""), false);
    assert.equal(JSON.stringify(runners.body).includes("\"command\""), false);

    const metrics = await json(`${origin}/api/session-metrics?limit=10`);
    assert.equal(metrics.response.status, 200);
    assert.equal(metrics.body.some((row) => row.id === "fixture-codex" && row.totalTokens === 1300), true);
    const diff = await json(`${origin}/api/trace-diff?sessionId=fixture-claude`);
    assert.equal(diff.response.status, 200);
    assert.equal(diff.body.complete, true);
    const compareMissing = await json(`${origin}/api/run-compare?baseSessionId=fixture-codex&targetSessionId=fixture-claude`);
    assert.equal(compareMissing.response.status, 400);

    const blockedIntake = await json(`${origin}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "blocked", provider: "test", session_id: "blocked", message: "blocked" })
    });
    assert.equal(blockedIntake.response.status, 403);

    const redactedExport = await fetch(`${origin}/api/export?sessionId=fixture-claude`);
    assert.equal(redactedExport.status, 200);
    const rawDenied = await fetch(`${origin}/api/export?sessionId=fixture-claude&raw=1`);
    assert.equal(rawDenied.status, 403);
    const rawExport = await fetch(`${origin}/api/export?sessionId=fixture-claude&raw=1`, {
      headers: { "x-tracebase-raw-export": "1" }
    });
    assert.equal(rawExport.status, 200);
  } finally {
    await close(server);
  }

  const agentServer = createServer({ store, allowIntake: true });
  const agentOrigin = await listen(agentServer);
  try {
    const intake = await json(`${agentOrigin}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "manual-event-1",
        provider: "test",
        session_id: "manual-session",
        type: "note",
        message: "manual intake works"
      })
    });
    assert.equal(intake.response.status, 202);
    const found = await json(`${agentOrigin}/api/events?q=manual%20intake&limit=20`);
    assert.equal(found.response.status, 200);
    assert.equal(found.body.some((event) => event.id === "manual-event-1"), true);
  } finally {
    await close(agentServer);
  }

  console.log("local e2e ok");
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
