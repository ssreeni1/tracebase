"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { getTraceHome } = require("./config");
const { decryptJson, encryptJson, loadOrCreateKey } = require("./crypto-box");
const { compactText } = require("./redact");
const sqlite = require("./sqlite-index");
const { normalizeEvent } = require("./normalize");
const { llmObsSpanFromInput, traceFromSpan } = require("./llmobs");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort hardening for existing stores.
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\n/).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Append-only logs can contain a partial final row after interruption.
    }
  }
  return rows;
}

class TraceStore {
  constructor(options = {}) {
    this.home = options.home || getTraceHome();
    this.key = loadOrCreateKey(this.home);
    this.indexPath = path.join(this.home, "index.jsonl");
    this.tasksPath = path.join(this.home, "tasks.jsonl");
    this.sessionsPath = path.join(this.home, "sessions.jsonl");
    this.importsPath = path.join(this.home, "imports.jsonl");
    this.summariesPath = path.join(this.home, "summaries.jsonl");
    this.blobDir = path.join(this.home, "blobs");
    this.db = null;
    this.sizeCache = null;
    ensureDir(this.home);
    ensureDir(this.blobDir);
  }

  init() {
    ensureDir(this.home);
    ensureDir(this.blobDir);
    for (const file of [
      this.indexPath,
      this.tasksPath,
      this.sessionsPath,
      this.importsPath,
      this.summariesPath
    ]) {
      if (!fs.existsSync(file)) fs.writeFileSync(file, "", { mode: 0o600 });
    }
    this.db = sqlite.openIndex(this.home);
  }

  getDb() {
    if (!this.db) this.db = sqlite.openIndex(this.home);
    return this.db;
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  appendJsonl(file, row) {
    fs.appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
  }

  putBlob(payload) {
    const canonical = JSON.stringify(payload);
    const id = sha256(canonical);
    const file = path.join(this.blobDir, `${id}.json`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(encryptJson(this.key, payload)), { mode: 0o600 });
    }
    return id;
  }

  getBlob(id) {
    if (!/^[a-f0-9]{64}$/i.test(String(id || ""))) throw new Error("invalid blob id");
    const file = path.join(this.blobDir, `${id}.json`);
    return decryptJson(this.key, JSON.parse(fs.readFileSync(file, "utf8")));
  }

  recordImport(importRecord) {
    this.appendJsonl(this.importsPath, {
      importedAt: new Date().toISOString(),
      ...importRecord
    });
  }

  seenEventIds() {
    return new Set(readJsonl(this.indexPath).map((row) => row.id));
  }

  upsertTask(task) {
    const row = {
      updatedAt: new Date().toISOString(),
      ...task
    };
    this.appendJsonl(this.tasksPath, row);
    sqlite.upsertTask(this.getDb(), row);
  }

  upsertSession(session) {
    const row = {
      updatedAt: new Date().toISOString(),
      ...session
    };
    this.appendJsonl(this.sessionsPath, row);
    sqlite.upsertSession(this.getDb(), row);
  }

  addEvent(event) {
    const payload = event.raw == null ? event : event.raw;
    const blobId = this.putBlob(payload);
    const searchable = compactText(event.searchText || event.summary || payload);
    const summary = compactText(event.summary || searchable.text.slice(0, 240), 500);
    const row = {
      id: event.id || sha256(JSON.stringify([event.provider, event.sourcePath, event.offset, payload])),
      taskId: event.taskId || event.sessionId,
      sessionId: event.sessionId,
      provider: event.provider,
      type: event.type || "event",
      role: event.role || null,
      cwd: event.cwd || null,
      sourcePath: event.sourcePath || null,
      offset: event.offset || null,
      timestamp: event.timestamp || new Date().toISOString(),
      summary: summary.text.slice(0, 240),
      searchText: searchable.text,
      redactions: [...searchable.hits, ...summary.hits],
      blobId
    };
    this.appendJsonl(this.indexPath, row);
    sqlite.insertEvent(this.getDb(), row);
    return row;
  }

  listEvents(options = {}) {
    return sqlite.searchEvents(this.getDb(), "", { limit: options.limit || 10000 });
  }

  listSessions(options = {}) {
    return sqlite.listSessions(this.getDb(), options);
  }

  listCwds(options = {}) {
    return sqlite.listCwds(this.getDb(), options);
  }

  listTasks(options = {}) {
    return sqlite.listTasks(this.getDb(), options);
  }

  listTraces(options = {}) {
    return sqlite.listTraces(this.getDb(), options);
  }

  getTrace(id) {
    return sqlite.getTrace(this.getDb(), id);
  }

  listSpans(options = {}) {
    return sqlite.listSpans(this.getDb(), options);
  }

  recordTrace(trace) {
    sqlite.upsertTrace(this.getDb(), trace);
    return trace;
  }

  recordSpan(span) {
    sqlite.insertSpan(this.getDb(), span);
    return span;
  }

  countSessionEvents(sessionId) {
    if (!sessionId) return 0;
    return this.search("", { sessionId, limit: 50000 }).length;
  }

  ingestLiveEvent(input, options = {}) {
    if (!input || typeof input !== "object") throw new Error("event payload must be an object");
    const timestamp = input.timestamp || input.time || new Date().toISOString();
    const sessionId = input.sessionId || input.session_id || options.sessionId || "live-session";
    const taskId = input.taskId || input.task_id || options.taskId || sessionId;
    const row = this.addEvent({
      id: input.id || input.event_id || undefined,
      provider: input.provider || options.provider || "live",
      sessionId,
      taskId,
      type: input.type || input.eventType || "live_event",
      role: input.role || null,
      cwd: input.cwd || options.cwd || null,
      sourcePath: input.sourcePath || input.source_path || options.sourcePath || "live-intake",
      offset: input.offset == null ? null : input.offset,
      timestamp,
      summary: input.summary || input.name || input.message || input.type || "live event",
      searchText: input.searchText || input.message || input.summary || JSON.stringify(input),
      raw: input.raw == null ? input : input.raw
    });
    const eventCount = this.countSessionEvents(sessionId);
    this.upsertSession({
      id: sessionId,
      provider: row.provider,
      sourcePath: row.sourcePath,
      cwd: row.cwd,
      startedAt: row.timestamp,
      endedAt: row.timestamp,
      eventCount,
      project: input.project || options.project || null
    });
    this.upsertTask({
      id: taskId,
      sessionId,
      provider: row.provider,
      cwd: row.cwd,
      sourcePath: row.sourcePath,
      startedAt: row.timestamp,
      endedAt: row.timestamp,
      eventCount
    });
    return row;
  }

  ingestLiveSpan(input, options = {}) {
    const span = llmObsSpanFromInput(input, options);
    this.recordTrace(traceFromSpan(span, options));
    const event = this.addEvent({
      id: span.id,
      provider: span.provider,
      sessionId: span.sessionId,
      taskId: span.metadata.taskId || span.sessionId,
      type: "llmobs:" + span.spanType,
      role: span.role,
      cwd: span.cwd,
      sourcePath: options.sourcePath || span.metadata.source || "live-intake",
      timestamp: span.startTime,
      summary: span.name,
      searchText: [span.name, span.input, span.output, JSON.stringify(span.metadata)].filter(Boolean).join("\n"),
      raw: { kind: "llmobs_span", span: input }
    });
    const recorded = {
      ...span,
      eventId: event.id,
      blobId: event.blobId,
      redactions: event.redactions
    };
    this.recordSpan(recorded);
    const eventCount = this.countSessionEvents(span.sessionId);
    this.upsertSession({
      id: span.sessionId,
      provider: span.provider,
      sourcePath: event.sourcePath,
      cwd: span.cwd,
      startedAt: span.startTime,
      endedAt: span.endTime,
      eventCount,
      project: options.project || span.metadata.taskId || null
    });
    this.upsertTask({
      id: span.metadata.taskId || span.sessionId,
      sessionId: span.sessionId,
      provider: span.provider,
      cwd: span.cwd,
      sourcePath: event.sourcePath,
      startedAt: span.startTime,
      endedAt: span.endTime,
      eventCount
    });
    this.recordTrace(traceFromSpan(recorded, { ...options, spanCount: this.listSpans({ traceId: recorded.traceId, limit: 50000 }).length }));
    return { event, span: recorded };
  }

  ingestLiveBatch(payload, options = {}) {
    const body = Array.isArray(payload) ? { events: payload } : payload || {};
    const events = (body.events || []).map((event) => this.ingestLiveEvent(event, options));
    const spans = (body.spans || []).map((span) => this.ingestLiveSpan(span, options).span);
    if (!body.events && !body.spans && (body.span_id || body.spanId)) spans.push(this.ingestLiveSpan(body, options).span);
    return { events, spans, accepted: events.length + spans.length };
  }

  search(query, options = {}) {
    return sqlite.searchEvents(this.getDb(), query, options);
  }

  listMeaningfulEvents(options = {}) {
    return sqlite.listMeaningfulEvents(this.getDb(), options);
  }

  readEventLog() {
    return readJsonl(this.indexPath);
  }

  readRehydratedEventLog() {
    return this.readEventLog().map((row) => {
      try {
        const raw = this.getBlob(row.blobId);
        const normalized = normalizeEvent(row.provider, row.sourcePath || "rehydrated", row.offset, raw);
        const searchable = compactText(normalized.searchText || normalized.summary || raw);
        const summary = compactText(normalized.summary || row.summary || searchable.text.slice(0, 240), 500);
        return {
          ...row,
          taskId: normalized.taskId,
          sessionId: normalized.sessionId,
          provider: normalized.provider,
          type: normalized.type,
          role: normalized.role || null,
          cwd: normalized.cwd || row.cwd || null,
          timestamp: raw && raw.timestamp ? normalized.timestamp : row.timestamp,
          summary: summary.text.slice(0, 240),
          searchText: searchable.text,
          redactions: [...searchable.hits, ...summary.hits],
          blobId: row.blobId
        };
      } catch {
        return row;
      }
    });
  }

  readSessionLog() {
    return readJsonl(this.sessionsPath);
  }

  readTaskLog() {
    return readJsonl(this.tasksPath);
  }

  storeSize() {
    const now = Date.now();
    if (!this.sizeCache || now - this.sizeCache.at > 60000) {
      const bytes = process.env.TRACEBASE_FULL_SIZE === "1" ? directorySize(this.home) : fastStoreSize(this.home);
      this.sizeCache = { at: now, bytes };
    }
    return this.sizeCache.bytes;
  }

  healthStats() {
    return {
      ...sqlite.healthStats(this.getDb()),
      traceHome: this.home,
      blobDir: this.blobDir,
      bytes: this.storeSize()
    };
  }

  stats(options = {}) {
    return {
      ...sqlite.stats(this.getDb(), options),
      traceHome: this.home,
      blobDir: this.blobDir,
      bytes: this.storeSize()
    };
  }

  rebuildIndex() {
    return sqlite.rebuildIndex(this.getDb(), this);
  }

  listAnnotations(options = {}) {
    return sqlite.listAnnotations(this.getDb(), options);
  }

  listSessionMetrics(options = {}) {
    return sqlite.listSessionMetrics(this.getDb(), options);
  }

}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function fastStoreSize(dir) {
  return [
    "traces.sqlite",
    "traces.sqlite-wal",
    "traces.sqlite-shm",
    "index.jsonl",
    "tasks.jsonl",
    "sessions.jsonl",
    "imports.jsonl",
    "summaries.jsonl",
    "key"
  ].reduce((sum, name) => sum + fileSize(path.join(dir, name)), 0);
}

function directorySize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) stack.push(full);
        else total += fs.statSync(full).size;
      } catch {
        // Ignore files that disappear during measurement.
      }
    }
  }
  return total;
}

module.exports = {
  TraceStore,
  sha256,
  readJsonl
};
