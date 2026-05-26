"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const { TraceStore } = require("../src/storage");
const { importJsonlFile } = require("../src/importers");

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function writeFixture(file, sessionId, count, offset = 0) {
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const n = offset + i;
    lines.push(JSON.stringify({
      type: n % 5 === 0 ? "assistant" : "user",
      session_id: sessionId,
      cwd: "/tmp/stress-project",
      message: {
        role: n % 5 === 0 ? "assistant" : "user",
        content: n % 17 === 0 ? `stress vite failure ${n} exit code 1` : `stress event ${n}`
      },
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()
    }));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

async function runParent() {
  const events = Number(readArg("--events", "10000"));
  const writers = Number(readArg("--writers", "1"));
  const keep = hasArg("--keep");
  const home = readArg("--home", fs.mkdtempSync(path.join(os.tmpdir(), "traces-stress-")));
  fs.mkdirSync(home, { recursive: true });
  const perWriter = Math.ceil(events / writers);
  const files = [];
  for (let i = 0; i < writers; i += 1) {
    const file = path.join(home, `fixture-${i}.jsonl`);
    writeFixture(file, `stress-session-${i}`, Math.min(perWriter, events - i * perWriter), i * perWriter);
    files.push(file);
  }

  const started = Date.now();
  if (writers === 1) {
    const store = new TraceStore({ home });
    store.init();
    importJsonlFile(store, "codex", files[0], store.seenEventIds());
  } else {
    await Promise.all(files.map((file, index) => runWorker(home, file, index)));
  }

  const store = new TraceStore({ home });
  store.init();
  const stats = store.stats();
  assert.equal(stats.eventCount, events, `expected ${events} events, saw ${stats.eventCount}`);
  assert.equal(store.search("vite", { limit: 10 }).length > 0, true, "expected vite search hits");
  const rebuild = store.rebuildIndex();
  assert.equal(rebuild.events, events, `expected rebuild to index ${events} events`);
  assert.equal(store.stats().eventCount, events);
  const result = {
    ok: true,
    home,
    events,
    writers,
    elapsedMs: Date.now() - started,
    bytes: store.stats().bytes
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!keep) fs.rmSync(home, { recursive: true, force: true });
}

function runWorker(home, file, index) {
  return new Promise((resolve, reject) => {
    const child = fork(__filename, ["--worker", "--home", home, "--file", file, "--index", String(index)], {
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker ${index} exited ${code}: ${stderr}`));
    });
  });
}

function runWorkerMain() {
  const home = readArg("--home");
  const file = readArg("--file");
  const index = readArg("--index", "0");
  const store = new TraceStore({ home });
  store.init();
  importJsonlFile(store, "codex", file, store.seenEventIds());
  process.stdout.write(JSON.stringify({ ok: true, index }) + "\n");
}

if (hasArg("--worker")) {
  runWorkerMain();
} else {
  runParent().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
