"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { getDefaultSources } = require("./config");
const { findJsonl } = require("./discover");
const { readJsonlWithOffsets } = require("./jsonl");
const { normalizeEvent, sessionFromSource } = require("./normalize");

function importJsonlFile(store, provider, file, seenIds, options = {}) {
  let first = null;
  let firstUser = null;
  let last = null;
  let imported = 0;
  let skipped = 0;
  for (const item of readJsonlWithOffsets(file)) {
    if (options.remaining && options.remaining.count <= 0) break;
    const event = normalizeEvent(provider, file, item.offset, item.value);
    if (!first) first = event;
    if (!firstUser && (event.role === "user" || event.type === "user" || event.type === "user_message" || event.type === "UserPromptSubmit")) {
      firstUser = event;
    }
    last = event;
    if (seenIds.has(event.id)) {
      skipped += 1;
      continue;
    }
    store.addEvent(event);
    seenIds.add(event.id);
    if (options.remaining) options.remaining.count -= 1;
    imported += 1;
  }
  if (first) {
    store.upsertSession(sessionFromSource(provider, file, first, last, imported + skipped));
    store.upsertTask({
      id: first.taskId,
      title: (firstUser && firstUser.summary) || first.summary || `${provider} task`,
      provider,
      sessionId: first.sessionId,
      cwd: (last && last.cwd) || first.cwd || null,
      startedAt: first.timestamp,
      endedAt: last && last.timestamp
    });
  }
  store.recordImport({ provider, sourcePath: file, imported, skipped });
  return { provider, file, imported, skipped, sessionId: first ? first.sessionId : null };
}

function filterFiles(files, options = {}) {
  let out = files;
  if (options.since) {
    const sinceTime = new Date(options.since).getTime();
    if (Number.isNaN(sinceTime)) throw new Error(`Invalid --since value: ${options.since}`);
    out = out.filter((file) => {
      try {
        return fs.statSync(file).mtimeMs >= sinceTime;
      } catch {
        return false;
      }
    });
  }
  if (options.maxFiles != null) {
    const maxFiles = Number(options.maxFiles);
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error("--max-files must be a positive integer.");
    out = out.slice(0, maxFiles);
  }
  return out;
}

function importProvider(store, provider, root, options = {}) {
  const files = filterFiles(findJsonl(root), options);
  const seen = options.seenIds || store.seenEventIds();
  const results = [];
  for (const file of files) {
    if (options.remaining && options.remaining.count <= 0) break;
    results.push(importJsonlFile(store, provider, file, seen, options));
  }
  return results;
}

function importAll(store, options = {}) {
  const sources = { ...getDefaultSources(), ...options };
  let remaining = null;
  if (options.maxEvents != null) {
    const maxEvents = Number(options.maxEvents);
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new Error("--max-events must be a positive integer.");
    remaining = { count: maxEvents };
  }
  const seenIds = options.seenIds || null;
  const results = [];
  const providers = options.provider ? [options.provider] : ["codex", "claude"];
  if (providers.includes("codex")) {
    results.push(...importProvider(store, "codex", sources.codexSessions, { ...options, remaining, seenIds }));
  }
  if (providers.includes("claude")) {
    results.push(...importProvider(store, "claude", sources.claudeProjects, { ...options, remaining, seenIds }));
  }
  return results;
}

function likelyProviderFromTranscriptPath(transcriptPath) {
  const normalized = transcriptPath || "";
  if (normalized.includes(`${path.sep}.claude${path.sep}`)) return "claude";
  if (normalized.includes(`${path.sep}.codex${path.sep}`)) return "codex";
  return "hook";
}

module.exports = {
  importAll,
  importProvider,
  importJsonlFile,
  likelyProviderFromTranscriptPath
};
