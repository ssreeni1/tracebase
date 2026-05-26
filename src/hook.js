"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TraceStore } = require("./storage");
const { normalizeEvent } = require("./normalize");
const { likelyProviderFromTranscriptPath } = require("./importers");
const { analyzeStore } = require("./analyze");
const { distillWorkflows } = require("./workflow-intel");

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

async function ingestHook(stdinText, options = {}) {
  const payload = JSON.parse(stdinText || "{}");
  const store = new TraceStore();
  try {
    store.init();
    const sourcePath = payload.transcript_path || payload.sourcePath || "hook";
    const provider = likelyProviderFromTranscriptPath(sourcePath);
    const event = normalizeEvent(provider, sourcePath, Date.now(), payload);
    const seen = options.skipDedupe ? null : store.seenEventIds();
    if (!seen || !seen.has(event.id)) {
      store.addEvent(event);
    }
    store.upsertSession({
      id: event.sessionId,
      provider,
      sourcePath,
      cwd: payload.cwd || event.cwd || null,
      startedAt: event.timestamp,
      endedAt: event.timestamp,
      eventCount: 1
    });
    store.upsertTask({
      id: event.taskId,
      title: payload.prompt ? String(payload.prompt).slice(0, 120) : event.summary,
      provider,
      sessionId: event.sessionId,
      cwd: payload.cwd || null,
      startedAt: event.timestamp,
      endedAt: event.timestamp
    });
    if (options.analyze !== false) {
      analyzeStore(store, { sessionId: event.sessionId });
      distillWorkflows(store, { limit: 50000 });
    }
    return { ok: true, id: event.id };
  } finally {
    store.close();
  }
}

function claudeHookSettings(command) {
  const hook = {
    type: "command",
    command
  };
  const allTools = {
    matcher: "",
    hooks: [hook]
  };
  const toolMatcher = {
    matcher: "*",
    hooks: [hook]
  };
  return {
    hooks: {
      UserPromptSubmit: [allTools],
      PreToolUse: [toolMatcher],
      PostToolUse: [toolMatcher],
      Stop: [allTools],
      SubagentStop: [allTools],
      SessionStart: [allTools],
      SessionEnd: [allTools],
      Notification: [allTools]
    }
  };
}

function mergeHooks(existing, addition) {
  const merged = { ...(existing || {}) };
  merged.hooks = { ...(merged.hooks || {}) };
  for (const [eventName, entries] of Object.entries(addition.hooks || {})) {
    const current = Array.isArray(merged.hooks[eventName]) ? merged.hooks[eventName] : [];
    const serialized = new Set(current.map((entry) => JSON.stringify(entry)));
    const next = [...current];
    for (const entry of entries) {
      const key = JSON.stringify(entry);
      if (!serialized.has(key)) {
        next.push(entry);
        serialized.add(key);
      }
    }
    merged.hooks[eventName] = next;
  }
  return merged;
}

function installClaudeHooks(settingsPath) {
  const target = settingsPath || path.join(os.homedir(), ".claude", "settings.json");
  const command = `${process.execPath} ${path.resolve(__dirname, "..", "bin", "traces.js")} hook`;
  const addition = claudeHookSettings(command);
  let existing = {};
  if (fs.existsSync(target)) {
    existing = JSON.parse(fs.readFileSync(target, "utf8"));
    const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(target, backup);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const merged = mergeHooks(existing, addition);
  fs.writeFileSync(target, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  return { settingsPath: target, command };
}

function printClaudeHookInstall() {
  const command = `${process.execPath} ${path.resolve(__dirname, "..", "bin", "traces.js")} hook`;
  const settings = claudeHookSettings(command);
  process.stdout.write(JSON.stringify(settings, null, 2) + "\n");
}

async function runHookCommand() {
  let stdinText = "";
  let payload = {};
  try {
    stdinText = await readStdin();
    payload = JSON.parse(stdinText || "{}");
    await ingestHook(stdinText, { analyze: false, skipDedupe: true });
    const eventName = payload.hook_event_name || payload.hookEventName;
    if (eventName === "Stop" || eventName === "SubagentStop") {
      process.stdout.write("{}\n");
    }
  } catch (error) {
    const log = `${new Date().toISOString()} ${error.stack || error}\n`;
    try {
      fs.appendFileSync("/tmp/traces-hook-errors.log", log);
    } catch {
      // Hooks should never break the agent session.
    }
    const eventName = payload.hook_event_name || payload.hookEventName;
    if (eventName === "Stop" || eventName === "SubagentStop") {
      process.stdout.write("{}\n");
    }
  }
}

module.exports = {
  ingestHook,
  installClaudeHooks,
  printClaudeHookInstall,
  runHookCommand,
  claudeHookSettings,
  mergeHooks
};
