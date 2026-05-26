"use strict";

const fs = require("node:fs");
const path = require("node:path");
if (!process.__tracesSqliteWarningPatch) {
  process.__tracesSqliteWarningPatch = true;
  const emitWarning = process.emitWarning;
  process.emitWarning = function patchedEmitWarning(warning, ...args) {
    if (String(warning).includes("SQLite is an experimental feature")) return;
    return emitWarning.call(this, warning, ...args);
  };
}
const { DatabaseSync } = require("node:sqlite");
const { canonicalSpanFromEvent, canonicalTraceFromSession, publicSpan, rootSpanFromSession } = require("./spans");
const { llmObsSpanFromInput, traceFromSpan } = require("./llmobs");

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(50, end - Date.now()));
}

function isBusyError(error) {
  const text = [error && error.code, error && error.message, error && error.errstr, error].filter(Boolean).map(String).join(" ");
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(text);
}

function withRetry(fn, options = {}) {
  const attempts = Number(options.attempts || 30);
  let delay = Number(options.delayMs || 25);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      if (!isBusyError(error) || attempt === attempts) throw error;
      sleepSync(delay);
      delay = Math.min(delay * 2, 500);
    }
  }
}

function openIndex(traceHome) {
  fs.mkdirSync(traceHome, { recursive: true, mode: 0o700 });
  const dbPath = path.join(traceHome, "traces.sqlite");
  const db = withRetry(() => new DatabaseSync(dbPath));
  db.exec("PRAGMA busy_timeout = 10000");
  withRetry(() => db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      taskId TEXT,
      sessionId TEXT,
      provider TEXT,
      type TEXT,
      role TEXT,
      cwd TEXT,
      sourcePath TEXT,
      offset INTEGER,
      timestamp TEXT,
      summary TEXT,
      searchText TEXT,
      redactions TEXT,
      structured TEXT,
      blobId TEXT,
      insertedAt TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_events_session_time ON events(sessionId, timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_provider_time ON events(provider, timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_cwd_time ON events(cwd, timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_time ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_source_offset ON events(sourcePath, offset);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      provider TEXT,
      sourcePath TEXT,
      cwd TEXT,
      startedAt TEXT,
      endedAt TEXT,
      eventCount INTEGER,
      project TEXT,
      updatedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_provider_updated ON sessions(provider, updatedAt);
    CREATE INDEX IF NOT EXISTS idx_sessions_time ON sessions(endedAt, updatedAt, startedAt);
    CREATE INDEX IF NOT EXISTS idx_sessions_cwd_time ON sessions(cwd, endedAt);
    CREATE TABLE IF NOT EXISTS traces (
      id TEXT PRIMARY KEY,
      sessionId TEXT,
      provider TEXT,
      name TEXT,
      cwd TEXT,
      sourcePath TEXT,
      startedAt TEXT,
      endedAt TEXT,
      status TEXT,
      spanCount INTEGER,
      updatedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(sessionId);
    CREATE INDEX IF NOT EXISTS idx_traces_provider_time ON traces(provider, endedAt);
    CREATE TABLE IF NOT EXISTS spans (
      id TEXT PRIMARY KEY,
      traceId TEXT,
      parentSpanId TEXT,
      sessionId TEXT,
      eventId TEXT,
      provider TEXT,
      type TEXT,
      spanType TEXT,
      name TEXT,
      role TEXT,
      cwd TEXT,
      startTime TEXT,
      endTime TEXT,
      durationMs INTEGER,
      status TEXT,
      input TEXT,
      output TEXT,
      metadata TEXT,
      blobId TEXT,
      redactions TEXT,
      insertedAt TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spans_trace_time ON spans(traceId, startTime);
    CREATE INDEX IF NOT EXISTS idx_spans_session_time ON spans(sessionId, startTime);
    CREATE INDEX IF NOT EXISTS idx_spans_event ON spans(eventId);
    CREATE INDEX IF NOT EXISTS idx_spans_type_time ON spans(spanType, startTime);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      provider TEXT,
      sessionId TEXT,
      cwd TEXT,
      startedAt TEXT,
      endedAt TEXT,
      updatedAt TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
      id UNINDEXED,
      summary,
      searchText,
      sourcePath,
      cwd,
      tokenize = 'unicode61'
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      sessionId TEXT,
      eventId TEXT,
      provider TEXT,
      kind TEXT,
      severity TEXT,
      confidence REAL,
      reason TEXT,
      timestamp TEXT,
      summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_annotations_session_time ON annotations(sessionId, timestamp);
    CREATE INDEX IF NOT EXISTS idx_annotations_kind_time ON annotations(kind, timestamp);
    CREATE TABLE IF NOT EXISTS session_metrics (
      sessionId TEXT PRIMARY KEY,
      eventCount INTEGER,
      toolCount INTEGER,
      userPromptCount INTEGER,
      failureCount INTEGER,
      resteerCount INTEGER,
      loopCount INTEGER,
      recoveryCount INTEGER,
      failedToolCount INTEGER,
      approvalDeniedCount INTEGER,
      repeatedCommandCount INTEGER,
      contextWasteCount INTEGER,
      largeOutputCount INTEGER,
      filesTouchedCount INTEGER,
      redactionCount INTEGER,
      model TEXT,
      inputTokens INTEGER,
      outputTokens INTEGER,
      cacheReadTokens INTEGER,
      cacheWriteTokens INTEGER,
      reasoningTokens INTEGER,
      totalTokens INTEGER,
      estimatedCostUsd REAL,
      outcome TEXT,
      qualityScore INTEGER,
      costScore INTEGER,
      efficiencyScore INTEGER,
      riskScore INTEGER,
      analyzedAt TEXT
    );
  `));
  migrateTraceSessionUniqueness(db);
  ensureColumn(db, "events", "structured", "TEXT");
  for (const [column, definition] of [
    ["failedToolCount", "INTEGER"],
    ["approvalDeniedCount", "INTEGER"],
    ["repeatedCommandCount", "INTEGER"],
    ["contextWasteCount", "INTEGER"],
    ["largeOutputCount", "INTEGER"],
    ["filesTouchedCount", "INTEGER"],
    ["redactionCount", "INTEGER"],
    ["model", "TEXT"],
    ["inputTokens", "INTEGER"],
    ["outputTokens", "INTEGER"],
    ["cacheReadTokens", "INTEGER"],
    ["cacheWriteTokens", "INTEGER"],
    ["reasoningTokens", "INTEGER"],
    ["totalTokens", "INTEGER"],
    ["estimatedCostUsd", "REAL"],
    ["costScore", "INTEGER"],
    ["efficiencyScore", "INTEGER"],
    ["riskScore", "INTEGER"]
  ]) ensureColumn(db, "session_metrics", column, definition);
  backfillCanonicalTraceTables(db);
  return db;
}

function ensureColumn(db, table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (rows.some((row) => row.name === column)) return;
  withRetry(() => db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`));
}

function migrateTraceSessionUniqueness(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'traces'").get();
  if (!row || !/sessionId\s+TEXT\s+UNIQUE/i.test(row.sql || "")) return;
  withRetry(() => db.exec("BEGIN"));
  try {
    withRetry(() => db.exec(`
      ALTER TABLE traces RENAME TO traces_unique_old;
      CREATE TABLE traces (
        id TEXT PRIMARY KEY,
        sessionId TEXT,
        provider TEXT,
        name TEXT,
        cwd TEXT,
        sourcePath TEXT,
        startedAt TEXT,
        endedAt TEXT,
        status TEXT,
        spanCount INTEGER,
        updatedAt TEXT
      );
      INSERT OR IGNORE INTO traces (id, sessionId, provider, name, cwd, sourcePath, startedAt, endedAt, status, spanCount, updatedAt)
      SELECT id, sessionId, provider, name, cwd, sourcePath, startedAt, endedAt, status, spanCount, updatedAt FROM traces_unique_old;
      DROP TABLE traces_unique_old;
      CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(sessionId);
      CREATE INDEX IF NOT EXISTS idx_traces_provider_time ON traces(provider, endedAt);
    `));
    withRetry(() => db.exec("COMMIT"));
  } catch (error) {
    withRetry(() => db.exec("ROLLBACK"));
    throw error;
  }
}
function asJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function eventParams(row) {
  return {
    $id: row.id,
    $taskId: row.taskId || null,
    $sessionId: row.sessionId || null,
    $provider: row.provider || null,
    $type: row.type || null,
    $role: row.role || null,
    $cwd: row.cwd || null,
    $sourcePath: row.sourcePath || null,
    $offset: row.offset == null ? null : Number(row.offset),
    $timestamp: row.timestamp || null,
    $summary: row.summary || null,
    $searchText: row.searchText || null,
    $redactions: asJson(row.redactions || []),
    $structured: asJson(row.structured || {}),
    $blobId: row.blobId || null
  };
}

function insertEvent(db, row) {
  const params = eventParams(row);
  const result = withRetry(() => db.prepare(`
    INSERT OR IGNORE INTO events (
      id, taskId, sessionId, provider, type, role, cwd, sourcePath, offset,
      timestamp, summary, searchText, redactions, structured, blobId
    ) VALUES (
      $id, $taskId, $sessionId, $provider, $type, $role, $cwd, $sourcePath, $offset,
      $timestamp, $summary, $searchText, $redactions, $structured, $blobId
    )
  `).run(params));
  if (result.changes) {
    withRetry(() => db.prepare(`
      INSERT INTO events_fts (id, summary, searchText, sourcePath, cwd)
      VALUES ($id, $summary, $searchText, $sourcePath, $cwd)
    `).run({
      $id: params.$id,
      $summary: params.$summary,
      $searchText: params.$searchText,
      $sourcePath: params.$sourcePath,
      $cwd: params.$cwd
    }));
    insertSpan(db, canonicalSpanFromEvent(row));
  }
  return result.changes;
}

function traceParams(row) {
  return {
    $id: row.id,
    $sessionId: row.sessionId,
    $provider: row.provider || null,
    $name: row.name || null,
    $cwd: row.cwd || null,
    $sourcePath: row.sourcePath || null,
    $startedAt: row.startedAt || null,
    $endedAt: row.endedAt || null,
    $status: row.status || "unknown",
    $spanCount: row.spanCount == null ? null : Number(row.spanCount),
    $updatedAt: row.updatedAt || new Date().toISOString()
  };
}

function upsertTrace(db, row) {
  withRetry(() => db.prepare(`
    INSERT INTO traces (id, sessionId, provider, name, cwd, sourcePath, startedAt, endedAt, status, spanCount, updatedAt)
    VALUES ($id, $sessionId, $provider, $name, $cwd, $sourcePath, $startedAt, $endedAt, $status, $spanCount, $updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      sessionId = excluded.sessionId,
      provider = COALESCE(excluded.provider, traces.provider),
      name = COALESCE(excluded.name, traces.name),
      cwd = COALESCE(excluded.cwd, traces.cwd),
      sourcePath = COALESCE(excluded.sourcePath, traces.sourcePath),
      startedAt = COALESCE(traces.startedAt, excluded.startedAt),
      endedAt = COALESCE(excluded.endedAt, traces.endedAt),
      status = COALESCE(excluded.status, traces.status),
      spanCount = COALESCE(excluded.spanCount, traces.spanCount),
      updatedAt = excluded.updatedAt
  `).run(traceParams(row)));
}

function spanParams(row) {
  return {
    $id: row.id,
    $traceId: row.traceId || null,
    $parentSpanId: row.parentSpanId || null,
    $sessionId: row.sessionId || null,
    $eventId: row.eventId || null,
    $provider: row.provider || null,
    $type: row.type || null,
    $spanType: row.spanType || null,
    $name: row.name || null,
    $role: row.role || null,
    $cwd: row.cwd || null,
    $startTime: row.startTime || null,
    $endTime: row.endTime || null,
    $durationMs: row.durationMs == null ? null : Number(row.durationMs),
    $status: row.status || "unknown",
    $input: row.input || null,
    $output: row.output || null,
    $metadata: asJson(row.metadata || {}),
    $blobId: row.blobId || null,
    $redactions: asJson(row.redactions || [])
  };
}

function insertSpan(db, row) {
  withRetry(() => db.prepare(`
    INSERT OR REPLACE INTO spans (
      id, traceId, parentSpanId, sessionId, eventId, provider, type, spanType, name,
      role, cwd, startTime, endTime, durationMs, status, input, output, metadata, blobId, redactions
    ) VALUES (
      $id, $traceId, $parentSpanId, $sessionId, $eventId, $provider, $type, $spanType, $name,
      $role, $cwd, $startTime, $endTime, $durationMs, $status, $input, $output, $metadata, $blobId, $redactions
    )
  `).run(spanParams(row)));
}

function backfillCanonicalTraceTables(db) {
  const marker = db.prepare("SELECT value FROM meta WHERE key = 'canonical_trace_tables_v2'").get();
  if (marker && marker.value === "1") return;
  const eventCount = db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  if (!eventCount) {
    withRetry(() => db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('canonical_trace_tables_v2', '1')").run());
    return;
  }
  withRetry(() => db.exec("BEGIN"));
  try {
    withRetry(() => db.exec(`
      DELETE FROM traces;
      DELETE FROM spans;
    `));
    for (const session of db.prepare("SELECT * FROM sessions").all()) {
      upsertTrace(db, canonicalTraceFromSession(session));
      insertSpan(db, rootSpanFromSession(session));
    }
    for (const event of db.prepare("SELECT * FROM events").all()) {
      insertSpan(db, canonicalSpanFromEvent(event));
    }
    withRetry(() => db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('canonical_trace_tables_v2', '1')").run());
    withRetry(() => db.exec("COMMIT"));
  } catch (error) {
    withRetry(() => db.exec("ROLLBACK"));
    throw error;
  }
}

function upsertSession(db, row) {
  withRetry(() => db.prepare(`
    INSERT INTO sessions (id, provider, sourcePath, cwd, startedAt, endedAt, eventCount, project, updatedAt)
    VALUES ($id, $provider, $sourcePath, $cwd, $startedAt, $endedAt, $eventCount, $project, $updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider,
      sourcePath = excluded.sourcePath,
      cwd = COALESCE(excluded.cwd, sessions.cwd),
      startedAt = COALESCE(sessions.startedAt, excluded.startedAt),
      endedAt = COALESCE(excluded.endedAt, sessions.endedAt),
      eventCount = excluded.eventCount,
      project = COALESCE(excluded.project, sessions.project),
      updatedAt = excluded.updatedAt
  `).run({
    $id: row.id,
    $provider: row.provider || null,
    $sourcePath: row.sourcePath || null,
    $cwd: row.cwd || null,
    $startedAt: row.startedAt || null,
    $endedAt: row.endedAt || null,
    $eventCount: row.eventCount == null ? null : Number(row.eventCount),
    $project: row.project || null,
    $updatedAt: row.updatedAt || new Date().toISOString()
  }));
  upsertTrace(db, canonicalTraceFromSession(row));
  insertSpan(db, rootSpanFromSession(row));
}

function upsertTask(db, row) {
  withRetry(() => db.prepare(`
    INSERT INTO tasks (id, title, provider, sessionId, cwd, startedAt, endedAt, updatedAt)
    VALUES ($id, $title, $provider, $sessionId, $cwd, $startedAt, $endedAt, $updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      title = COALESCE(excluded.title, tasks.title),
      provider = COALESCE(excluded.provider, tasks.provider),
      sessionId = COALESCE(excluded.sessionId, tasks.sessionId),
      cwd = COALESCE(excluded.cwd, tasks.cwd),
      startedAt = COALESCE(tasks.startedAt, excluded.startedAt),
      endedAt = COALESCE(excluded.endedAt, tasks.endedAt),
      updatedAt = excluded.updatedAt
  `).run({
    $id: row.id,
    $title: row.title || null,
    $provider: row.provider || null,
    $sessionId: row.sessionId || null,
    $cwd: row.cwd || null,
    $startedAt: row.startedAt || null,
    $endedAt: row.endedAt || null,
    $updatedAt: row.updatedAt || new Date().toISOString()
  }));
}

function parseEvent(row) {
  return {
    ...row,
    redactions: row.redactions ? JSON.parse(row.redactions) : [],
    structured: row.structured ? JSON.parse(row.structured) : {}
  };
}

function escapeMatch(query) {
  const terms = String(query || "")
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/"/g, "\"\""))
    .filter(Boolean);
  return terms.map((term) => `"${term}"`).join(" AND ");
}

function boundedInt(value, fallback, min, max) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  const n = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.max(min, Math.min(max, n));
}

function searchEvents(db, query, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 10000);
  const offset = boundedInt(options.offset, 0, 0, 1000000);
  const provider = options.provider || null;
  const sessionId = options.sessionId || null;
  const type = options.type || null;
  const cwd = options.cwd || null;
  const from = options.from || options.since || null;
  const to = options.to || null;
  const sort = options.sort === "inserted" ? "insertedAt" : "timestamp";
  const order = String(options.order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const params = { $limit: limit, $offset: offset };
  const filters = [];
  if (provider) {
    filters.push("e.provider = $provider");
    params.$provider = provider;
  }
  if (sessionId) {
    filters.push("e.sessionId = $sessionId");
    params.$sessionId = sessionId;
  }
  if (type) {
    filters.push("e.type = $type");
    params.$type = type;
  }
  if (cwd) {
    filters.push("e.cwd LIKE $cwd");
    params.$cwd = `%${cwd}%`;
  }
  if (from) {
    filters.push("e.timestamp >= $from");
    params.$from = from;
  }
  if (to) {
    filters.push("e.timestamp <= $to");
    params.$to = to;
  }
  const where = filters.length ? filters.join(" AND ") : "1 = 1";
  if (query && String(query).trim()) {
    params.$match = escapeMatch(query);
    return db.prepare(`
      SELECT e.*
      FROM events_fts f
      JOIN events e ON e.id = f.id
      WHERE events_fts MATCH $match AND ${where}
      ORDER BY e.${sort} ${order}
      LIMIT $limit OFFSET $offset
    `).all(params).map(parseEvent);
  }
  return db.prepare(`
    SELECT e.*
    FROM events e
    WHERE ${where}
    ORDER BY e.${sort} ${order}
    LIMIT $limit OFFSET $offset
  `).all(params).map(parseEvent);
}

const NOISE_TYPES = [
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "token_count",
  "reasoning",
  "turn_context",
  "thread_goal_updated",
  "task_started",
  "task_complete",
  "exec_command_end",
  "patch_apply_end",
  "web_search_call",
  "web_search_end"
];

function listMeaningfulEvents(db, options = {}) {
  const limit = boundedInt(options.limit, 200, 1, 10000);
  const provider = options.provider || null;
  const sessionId = options.sessionId || null;
  const since = options.since || null;
  const placeholders = NOISE_TYPES.map((_, index) => `$noise${index}`).join(", ");
  const params = {
    $limit: limit,
    $provider: provider,
    $sessionId: sessionId,
    $since: since
  };
  NOISE_TYPES.forEach((type, index) => {
    params[`$noise${index}`] = type;
  });
  return db.prepare(`
    SELECT *
    FROM events
    WHERE type NOT IN (${placeholders})
      AND ($provider IS NULL OR provider = $provider)
      AND ($sessionId IS NULL OR sessionId = $sessionId)
      AND ($since IS NULL OR timestamp >= $since)
      AND summary IS NOT NULL
      AND TRIM(summary) != ''
    ORDER BY timestamp DESC
    LIMIT $limit
  `).all(params).map(parseEvent);
}

function listSessions(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 10000);
  const offset = boundedInt(options.offset, 0, 0, 1000000);
  const provider = options.provider || null;
  const cwd = options.cwd || null;
  const q = options.q || null;
  const from = options.from || options.since || null;
  const to = options.to || null;
  const sortMap = {
    time: "COALESCE(endedAt, updatedAt, startedAt)",
    started: "startedAt",
    ended: "endedAt",
    events: "eventCount",
    provider: "provider"
  };
  const sort = sortMap[options.sort] || sortMap.time;
  const order = String(options.order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const params = { $limit: limit, $offset: offset };
  const filters = [];
  if (provider) {
    filters.push("provider = $provider");
    params.$provider = provider;
  }
  if (cwd) {
    filters.push("cwd LIKE $cwd");
    params.$cwd = `%${cwd}%`;
  }
  if (q) {
    filters.push(`(
      s.id LIKE $q
      OR s.cwd LIKE $q
      OR s.sourcePath LIKE $q
      OR s.project LIKE $q
      OR EXISTS (
        SELECT 1
        FROM events_fts f
        JOIN events e ON e.id = f.id
        WHERE e.sessionId = s.id
          AND events_fts MATCH $qMatch
      )
    )`);
    params.$q = `%${q}%`;
    params.$qMatch = escapeMatch(q);
  }
  if (from) {
    filters.push("COALESCE(endedAt, updatedAt, startedAt) >= $from");
    params.$from = from;
  }
  if (to) {
    filters.push("COALESCE(startedAt, updatedAt, endedAt) <= $to");
    params.$to = to;
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  return db.prepare(`
    SELECT s.* FROM sessions s
    ${where}
    ORDER BY ${sort} ${order}
    LIMIT $limit OFFSET $offset
  `).all(params);
}

function listTasks(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 10000);
  return db.prepare(`
    SELECT * FROM tasks
    ORDER BY COALESCE(endedAt, updatedAt, startedAt) DESC
    LIMIT $limit
  `).all({ $limit: limit });
}

function listCwds(db, options = {}) {
  const limit = boundedInt(options.limit, 250, 1, 1000);
  return db.prepare(`
    SELECT cwd, COUNT(*) AS sessionCount, MAX(COALESCE(endedAt, updatedAt, startedAt)) AS latestAt
    FROM sessions
    WHERE cwd IS NOT NULL AND cwd != ''
    GROUP BY cwd
    ORDER BY latestAt DESC, sessionCount DESC, cwd ASC
    LIMIT $limit
  `).all({ $limit: limit });
}

function listTraces(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 10000);
  const provider = options.provider || null;
  const sessionId = options.sessionId || null;
  const from = options.from || options.since || null;
  const to = options.to || null;
  const order = String(options.order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  return db.prepare(`
    SELECT *
    FROM traces
    WHERE ($provider IS NULL OR provider = $provider)
      AND ($sessionId IS NULL OR sessionId = $sessionId)
      AND ($from IS NULL OR COALESCE(endedAt, updatedAt, startedAt) >= $from)
      AND ($to IS NULL OR COALESCE(startedAt, updatedAt, endedAt) <= $to)
    ORDER BY COALESCE(endedAt, updatedAt, startedAt) ${order}
    LIMIT $limit
  `).all({ $provider: provider, $sessionId: sessionId, $from: from, $to: to, $limit: limit });
}

function getTrace(db, id) {
  return db.prepare("SELECT * FROM traces WHERE id = $id OR sessionId = $id").get({ $id: id }) || null;
}

function listSpans(db, options = {}) {
  const limit = boundedInt(options.limit, 5000, 1, 50000);
  const traceId = options.traceId || null;
  const sessionId = options.sessionId || null;
  const spanType = options.spanType || null;
  const params = { $limit: limit };
  const filters = [];
  if (traceId) {
    filters.push("traceId = $traceId");
    params.$traceId = traceId;
  }
  if (sessionId) {
    filters.push("sessionId = $sessionId");
    params.$sessionId = sessionId;
  }
  if (spanType) {
    filters.push("spanType = $spanType");
    params.$spanType = spanType;
  }
  const where = filters.length ? filters.join(" AND ") : "1 = 1";
  const order = filters.length
    ? "startTime ASC, insertedAt ASC"
    : "CASE WHEN parentSpanId IS NULL THEN 0 ELSE 1 END, startTime ASC, insertedAt ASC";
  return db.prepare(`
    SELECT *
    FROM spans
    WHERE ${where}
    ORDER BY ${order}
    LIMIT $limit
  `).all(params).map(publicSpan);
}

function listAnnotations(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 10000);
  const sessionId = options.sessionId || null;
  const kind = options.kind || null;
  const params = { $limit: limit };
  const filters = [];
  if (sessionId) {
    filters.push("sessionId = $sessionId");
    params.$sessionId = sessionId;
  }
  if (kind) {
    filters.push("kind = $kind");
    params.$kind = kind;
  }
  const where = filters.length ? filters.join(" AND ") : "1 = 1";
  return db.prepare(`
    SELECT *
    FROM annotations
    WHERE ${where}
    ORDER BY timestamp DESC
    LIMIT $limit
  `).all(params);
}

function listSessionMetrics(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 10000);
  return db.prepare(`
    SELECT s.id, s.provider, s.sourcePath, s.cwd, s.startedAt, s.endedAt,
           COALESCE(m.eventCount, s.eventCount) AS eventCount, s.project, s.updatedAt,
           m.toolCount, m.userPromptCount, m.failureCount, m.resteerCount, m.loopCount, m.recoveryCount,
           m.failedToolCount, m.approvalDeniedCount, m.repeatedCommandCount, m.contextWasteCount,
           m.largeOutputCount, m.filesTouchedCount,
           m.redactionCount, m.model, m.inputTokens, m.outputTokens, m.cacheReadTokens,
           m.cacheWriteTokens, m.reasoningTokens, m.totalTokens, m.estimatedCostUsd,
           m.outcome, m.qualityScore, m.costScore, m.efficiencyScore, m.riskScore, m.analyzedAt
    FROM sessions s
    LEFT JOIN session_metrics m ON m.sessionId = s.id
    ORDER BY COALESCE(s.endedAt, s.updatedAt, s.startedAt) DESC
    LIMIT $limit
  `).all({ $limit: limit });
}

function intelligenceStats(db) {
  const annotationCount = db.prepare("SELECT COUNT(*) AS n FROM annotations").get().n;
  const analyzedSessionCount = db.prepare("SELECT COUNT(*) AS n FROM session_metrics").get().n;
  const byKind = db.prepare("SELECT kind, COUNT(*) AS count FROM annotations GROUP BY kind ORDER BY count DESC").all();
  const outcomes = db.prepare("SELECT outcome, COUNT(*) AS count FROM session_metrics GROUP BY outcome ORDER BY count DESC").all();
  const avgQuality = db.prepare("SELECT AVG(qualityScore) AS value FROM session_metrics").get().value;
  const worstSessions = db.prepare(`
    SELECT s.id, s.provider, s.cwd, s.sourcePath, m.failureCount, m.resteerCount, m.loopCount,
           m.recoveryCount, m.outcome, m.qualityScore
    FROM session_metrics m
    JOIN sessions s ON s.id = m.sessionId
    ORDER BY m.qualityScore ASC, m.failureCount DESC
    LIMIT 10
  `).all();
  return { annotationCount, analyzedSessionCount, byKind, outcomes, avgQuality, worstSessions };
}

function stats(db, options = {}) {
  const deep = Boolean(options.deep);
  const eventCount = db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  const sessionCount = db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
  const traceCount = db.prepare("SELECT COUNT(*) AS n FROM traces").get().n;
  const spanCount = db.prepare("SELECT COUNT(*) AS n FROM spans").get().n;
  const taskCount = db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
  const blobCount = deep ? db.prepare("SELECT COUNT(DISTINCT blobId) AS n FROM events").get().n : null;
  const latestEventAt = db.prepare("SELECT MAX(timestamp) AS value FROM events").get().value;
  const latestMeaningfulEventAt = db.prepare(`
    SELECT MAX(timestamp) AS value
    FROM events
    WHERE type NOT IN (${NOISE_TYPES.map((type) => `'${type.replace(/'/g, "''")}'`).join(", ")})
  `).get().value;
  const reasoningSummaryCount = db.prepare(`
    SELECT COUNT(*) AS n
    FROM events
    WHERE type = 'reasoning'
      AND searchText IS NOT NULL
      AND searchText NOT LIKE '%"payload_content":null%'
  `).get().n;
  const byProvider = db.prepare("SELECT provider, COUNT(*) AS count FROM events GROUP BY provider ORDER BY count DESC").all();
  const byType = db.prepare("SELECT type, COUNT(*) AS count FROM events GROUP BY type ORDER BY count DESC LIMIT 25").all();
  return {
    eventCount,
    sessionCount,
    traceCount,
    spanCount,
    taskCount,
    ...(deep ? { blobCount } : {}),
    latestEventAt,
    latestMeaningfulEventAt,
    reasoning: {
      exposedSummaryEvents: reasoningSummaryCount,
      hiddenPrivateReasoningCaptured: false,
      note: "Only provider-emitted reasoning summaries or transcript-visible reasoning events are captured."
    },
    byProvider,
    byType
  };
}

function healthStats(db) {
  return {
    eventCount: db.prepare("SELECT COUNT(*) AS n FROM events").get().n,
    sessionCount: db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n,
    latestEventAt: db.prepare("SELECT MAX(timestamp) AS value FROM events").get().value,
    latestMeaningfulEventAt: db.prepare(`
      SELECT MAX(timestamp) AS value
      FROM events
      WHERE type NOT IN (${NOISE_TYPES.map((type) => `'${type.replace(/'/g, "''")}'`).join(", ")})
    `).get().value
  };
}

function restoreLiveSpans(db, store, rows) {
  if (!store || typeof store.getBlob !== "function") return;
  const touchedTraceIds = new Set();
  for (const row of rows) {
    if (!String(row.type || "").startsWith("llmobs:")) continue;
    try {
      const raw = store.getBlob(row.blobId);
      if (!raw || raw.kind !== "llmobs_span" || !raw.span) continue;
      const span = llmObsSpanFromInput(raw.span, { provider: row.provider, sessionId: row.sessionId });
      const recorded = {
        ...span,
        eventId: row.id,
        blobId: row.blobId || null,
        redactions: Array.isArray(row.redactions) ? row.redactions : []
      };
      insertSpan(db, recorded);
      touchedTraceIds.add(recorded.traceId);
    } catch {
      // Keep rebuild best-effort for encrypted live span payloads.
    }
  }
  for (const traceId of touchedTraceIds) {
    const first = db.prepare("SELECT * FROM spans WHERE traceId = $traceId ORDER BY startTime ASC, insertedAt ASC LIMIT 1").get({ $traceId: traceId });
    if (!first) continue;
    const count = db.prepare("SELECT COUNT(*) AS n FROM spans WHERE traceId = $traceId").get({ $traceId: traceId }).n;
    upsertTrace(db, traceFromSpan(publicSpan(first), { spanCount: count }));
  }
}
function rebuildIndex(db, store) {
  db.exec("BEGIN");
  try {
    db.exec(`
      DELETE FROM events_fts;
      DELETE FROM events;
      DELETE FROM sessions;
      DELETE FROM traces;
      DELETE FROM spans;
      DELETE FROM tasks;
      DELETE FROM annotations;
      DELETE FROM session_metrics;
    `);
    let events = 0;
    const rawRows = store.readEventLog();
    const rows = typeof store.readRehydratedEventLog === "function" ? store.readRehydratedEventLog() : rawRows;
    for (const row of rows) events += insertEvent(db, row);
    for (const row of store.readSessionLog()) upsertSession(db, row);
    for (const row of store.readTaskLog()) upsertTask(db, row);
    restoreLiveSpans(db, store, rawRows);
    db.exec("COMMIT");
    return { events };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

module.exports = {
  openIndex,
  insertEvent,
  insertSpan,
  upsertTrace,
  upsertSession,
  upsertTask,
  searchEvents,
  listMeaningfulEvents,
  listSessions,
  listCwds,
  listTasks,
  listTraces,
  getTrace,
  listSpans,
  listAnnotations,
  listSessionMetrics,
  stats,
  healthStats,
  rebuildIndex
};
