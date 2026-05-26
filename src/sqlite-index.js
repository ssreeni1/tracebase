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
      outcome TEXT,
      qualityScore INTEGER,
      analyzedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS workflow_lessons (
      id TEXT PRIMARY KEY,
      category TEXT,
      scope TEXT,
      repo TEXT,
      title TEXT,
      lesson TEXT,
      evidence TEXT,
      action TEXT,
      confidence REAL,
      sourceSessionId TEXT,
      sourceEventId TEXT,
      createdAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_lessons_category ON workflow_lessons(category, createdAt);
    CREATE INDEX IF NOT EXISTS idx_workflow_lessons_repo ON workflow_lessons(repo, createdAt);
    CREATE TABLE IF NOT EXISTS judges (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      description TEXT,
      scoreType TEXT,
      currentVersion INTEGER,
      createdAt TEXT,
      updatedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS judge_versions (
      id TEXT PRIMARY KEY,
      judgeId TEXT,
      version INTEGER,
      prompt TEXT,
      model TEXT,
      config TEXT,
      createdAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_judge_versions_judge ON judge_versions(judgeId, version);
    CREATE TABLE IF NOT EXISTS evaluations (
      id TEXT PRIMARY KEY,
      judgeId TEXT,
      judgeVersionId TEXT,
      traceId TEXT,
      spanId TEXT,
      sessionId TEXT,
      score REAL,
      passed INTEGER,
      label TEXT,
      reason TEXT,
      evidence TEXT,
      evaluatedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_evaluations_judge_time ON evaluations(judgeId, evaluatedAt);
    CREATE INDEX IF NOT EXISTS idx_evaluations_trace ON evaluations(traceId, evaluatedAt);
    CREATE TABLE IF NOT EXISTS behaviors (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      judgeId TEXT,
      description TEXT,
      createdAt TEXT,
      updatedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS behavior_results (
      id TEXT PRIMARY KEY,
      behaviorId TEXT,
      evaluationId TEXT,
      traceId TEXT,
      spanId TEXT,
      sessionId TEXT,
      detected INTEGER,
      label TEXT,
      reason TEXT,
      createdAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_behavior_results_behavior_time ON behavior_results(behaviorId, createdAt);
    CREATE INDEX IF NOT EXISTS idx_behavior_results_trace ON behavior_results(traceId, createdAt);
    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      description TEXT,
      kind TEXT,
      createdAt TEXT,
      updatedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS dataset_items (
      id TEXT PRIMARY KEY,
      datasetId TEXT,
      traceId TEXT,
      spanId TEXT,
      sessionId TEXT,
      source TEXT,
      sourceId TEXT,
      label TEXT,
      note TEXT,
      createdAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dataset_items_dataset ON dataset_items(datasetId, createdAt);
    CREATE INDEX IF NOT EXISTS idx_dataset_items_trace ON dataset_items(traceId);
    CREATE TABLE IF NOT EXISTS buckets (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      datasetId TEXT,
      behaviorId TEXT,
      description TEXT,
      enabled INTEGER,
      createdAt TEXT,
      updatedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_buckets_behavior ON buckets(behaviorId);
    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      description TEXT,
      behaviorId TEXT,
      minCount INTEGER,
      enabled INTEGER,
      createdAt TEXT,
      updatedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rules_behavior ON rules(behaviorId);
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      ruleId TEXT,
      behaviorId TEXT,
      traceId TEXT,
      sessionId TEXT,
      severity TEXT,
      message TEXT,
      count INTEGER,
      createdAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_rule_time ON alerts(ruleId, createdAt);
    CREATE INDEX IF NOT EXISTS idx_alerts_behavior_time ON alerts(behaviorId, createdAt);
    CREATE TABLE IF NOT EXISTS configs (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      kind TEXT,
      description TEXT,
      latestCommitId TEXT,
      createdAt TEXT,
      updatedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS config_commits (
      id TEXT PRIMARY KEY,
      configId TEXT,
      content TEXT,
      contentHash TEXT,
      message TEXT,
      metadata TEXT,
      committedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_config_commits_config ON config_commits(configId, committedAt);
    CREATE TABLE IF NOT EXISTS config_tags (
      configId TEXT,
      tag TEXT,
      commitId TEXT,
      updatedAt TEXT,
      PRIMARY KEY (configId, tag)
    );
  `));
  migrateTraceSessionUniqueness(db);
  backfillCanonicalTraceTables(db);
  return db;
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
    $blobId: row.blobId || null
  };
}

function insertEvent(db, row) {
  const params = eventParams(row);
  const result = withRetry(() => db.prepare(`
    INSERT OR IGNORE INTO events (
      id, taskId, sessionId, provider, type, role, cwd, sourcePath, offset,
      timestamp, summary, searchText, redactions, blobId
    ) VALUES (
      $id, $taskId, $sessionId, $provider, $type, $role, $cwd, $sourcePath, $offset,
      $timestamp, $summary, $searchText, $redactions, $blobId
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
    redactions: row.redactions ? JSON.parse(row.redactions) : []
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
           m.failureCount, m.resteerCount, m.loopCount, m.recoveryCount,
           m.outcome, m.qualityScore, m.analyzedAt
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

function listWorkflowLessons(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 10000);
  const category = options.category || null;
  const repo = options.repo || null;
  return db.prepare(`
    SELECT *
    FROM workflow_lessons
    WHERE ($category IS NULL OR category = $category)
      AND ($repo IS NULL OR repo = $repo)
    ORDER BY confidence DESC, createdAt DESC
    LIMIT $limit
  `).all({ $category: category, $repo: repo, $limit: limit }).map((row) => ({
    ...row,
    evidence: row.evidence ? JSON.parse(row.evidence) : []
  }));
}

function upsertJudge(db, spec) {
  const judge = spec.judge || spec;
  const version = spec.version || null;
  db.prepare(`
    INSERT INTO judges (id, name, description, scoreType, currentVersion, createdAt, updatedAt)
    VALUES ($id, $name, $description, $scoreType, $currentVersion, $createdAt, $updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      scoreType = excluded.scoreType,
      currentVersion = excluded.currentVersion,
      updatedAt = excluded.updatedAt
  `).run({
    $id: judge.id,
    $name: judge.name,
    $description: judge.description || null,
    $scoreType: judge.scoreType || "binary",
    $currentVersion: Number(judge.currentVersion || 1),
    $createdAt: judge.createdAt || new Date().toISOString(),
    $updatedAt: judge.updatedAt || new Date().toISOString()
  });
  if (version) upsertJudgeVersion(db, version);
}

function upsertJudgeVersion(db, version) {
  db.prepare(`
    INSERT OR REPLACE INTO judge_versions (id, judgeId, version, prompt, model, config, createdAt)
    VALUES ($id, $judgeId, $version, $prompt, $model, $config, $createdAt)
  `).run({
    $id: version.id,
    $judgeId: version.judgeId,
    $version: Number(version.version || 1),
    $prompt: version.prompt || null,
    $model: version.model || "local",
    $config: asJson(version.config || {}),
    $createdAt: version.createdAt || new Date().toISOString()
  });
}

function listJudges(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 10000);
  return db.prepare(`
    SELECT *
    FROM judges
    ORDER BY updatedAt DESC
    LIMIT $limit
  `).all({ $limit: limit });
}

function getJudge(db, idOrName) {
  return db.prepare("SELECT * FROM judges WHERE id = $id OR name = $id").get({ $id: idOrName }) || null;
}

function getJudgeVersion(db, judgeId, version) {
  const row = version == null
    ? db.prepare("SELECT * FROM judge_versions WHERE judgeId = $judgeId ORDER BY version DESC LIMIT 1").get({ $judgeId: judgeId })
    : db.prepare("SELECT * FROM judge_versions WHERE judgeId = $judgeId AND version = $version").get({ $judgeId: judgeId, $version: Number(version) });
  return row ? { ...row, config: row.config ? JSON.parse(row.config) : {} } : null;
}

function insertEvaluation(db, row) {
  db.prepare(`
    INSERT OR REPLACE INTO evaluations (
      id, judgeId, judgeVersionId, traceId, spanId, sessionId, score, passed, label, reason, evidence, evaluatedAt
    ) VALUES (
      $id, $judgeId, $judgeVersionId, $traceId, $spanId, $sessionId, $score, $passed, $label, $reason, $evidence, $evaluatedAt
    )
  `).run({
    $id: row.id,
    $judgeId: row.judgeId,
    $judgeVersionId: row.judgeVersionId,
    $traceId: row.traceId || null,
    $spanId: row.spanId || null,
    $sessionId: row.sessionId || null,
    $score: row.score == null ? null : Number(row.score),
    $passed: row.passed ? 1 : 0,
    $label: row.label || null,
    $reason: row.reason || null,
    $evidence: asJson(row.evidence || {}),
    $evaluatedAt: row.evaluatedAt || new Date().toISOString()
  });
}

function listEvaluations(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 50000);
  const judgeId = options.judgeId || null;
  const traceId = options.traceId || null;
  const sessionId = options.sessionId || null;
  return db.prepare(`
    SELECT *
    FROM evaluations
    WHERE ($judgeId IS NULL OR judgeId = $judgeId)
      AND ($traceId IS NULL OR traceId = $traceId)
      AND ($sessionId IS NULL OR sessionId = $sessionId)
    ORDER BY evaluatedAt DESC
    LIMIT $limit
  `).all({ $judgeId: judgeId, $traceId: traceId, $sessionId: sessionId, $limit: limit }).map((row) => ({
    ...row,
    passed: Boolean(row.passed),
    evidence: row.evidence ? JSON.parse(row.evidence) : {}
  }));
}

function upsertBehavior(db, row) {
  db.prepare(`
    INSERT INTO behaviors (id, name, judgeId, description, createdAt, updatedAt)
    VALUES ($id, $name, $judgeId, $description, $createdAt, $updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      judgeId = excluded.judgeId,
      description = excluded.description,
      updatedAt = excluded.updatedAt
  `).run({
    $id: row.id,
    $name: row.name,
    $judgeId: row.judgeId,
    $description: row.description || null,
    $createdAt: row.createdAt || new Date().toISOString(),
    $updatedAt: row.updatedAt || new Date().toISOString()
  });
}

function listBehaviors(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 10000);
  const judgeId = options.judgeId || null;
  return db.prepare(`
    SELECT b.*, COUNT(r.id) AS detectionCount
    FROM behaviors b
    LEFT JOIN behavior_results r ON r.behaviorId = b.id
    WHERE ($judgeId IS NULL OR b.judgeId = $judgeId)
    GROUP BY b.id
    ORDER BY b.updatedAt DESC
    LIMIT $limit
  `).all({ $judgeId: judgeId, $limit: limit });
}

function insertBehaviorResult(db, behavior, evaluation) {
  if (evaluation == null) {
    const row = behavior;
    db.prepare(`
      INSERT OR REPLACE INTO behavior_results (
        id, behaviorId, evaluationId, traceId, spanId, sessionId, detected, label, reason, createdAt
      ) VALUES (
        $id, $behaviorId, $evaluationId, $traceId, $spanId, $sessionId, $detected, $label, $reason, $createdAt
      )
    `).run({
      $id: row.id || `${row.behaviorId}:${row.evaluationId}`,
      $behaviorId: row.behaviorId,
      $evaluationId: row.evaluationId,
      $traceId: row.traceId || null,
      $spanId: row.spanId || null,
      $sessionId: row.sessionId || null,
      $detected: row.detected ? 1 : 0,
      $label: row.label || null,
      $reason: row.reason || null,
      $createdAt: row.createdAt || new Date().toISOString()
    });
    return;
  }
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO behavior_results (
      id, behaviorId, evaluationId, traceId, spanId, sessionId, detected, label, reason, createdAt
    ) VALUES (
      $id, $behaviorId, $evaluationId, $traceId, $spanId, $sessionId, $detected, $label, $reason, $createdAt
    )
  `).run({
    $id: `${behavior.id}:${evaluation.id}`,
    $behaviorId: behavior.id,
    $evaluationId: evaluation.id,
    $traceId: evaluation.traceId || null,
    $spanId: evaluation.spanId || null,
    $sessionId: evaluation.sessionId || null,
    $detected: 1,
    $label: evaluation.label || null,
    $reason: evaluation.reason || null,
    $createdAt: createdAt
  });
}

function listBehaviorResults(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 50000);
  const behaviorId = options.behaviorId || null;
  const traceId = options.traceId || null;
  const sessionId = options.sessionId || null;
  return db.prepare(`
    SELECT *
    FROM behavior_results
    WHERE ($behaviorId IS NULL OR behaviorId = $behaviorId)
      AND ($traceId IS NULL OR traceId = $traceId)
      AND ($sessionId IS NULL OR sessionId = $sessionId)
    ORDER BY createdAt DESC
    LIMIT $limit
  `).all({ $behaviorId: behaviorId, $traceId: traceId, $sessionId: sessionId, $limit: limit }).map((row) => ({
    ...row,
    detected: Boolean(row.detected)
  }));
}

function upsertDataset(db, row) {
  db.prepare(`
    INSERT INTO datasets (id, name, description, kind, createdAt, updatedAt)
    VALUES ($id, $name, $description, $kind, $createdAt, $updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      kind = excluded.kind,
      updatedAt = excluded.updatedAt
  `).run({
    $id: row.id,
    $name: row.name,
    $description: row.description || null,
    $kind: row.kind || "trace",
    $createdAt: row.createdAt || new Date().toISOString(),
    $updatedAt: row.updatedAt || new Date().toISOString()
  });
}

function listDatasets(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 10000);
  return db.prepare(`
    SELECT d.*, COUNT(i.id) AS itemCount
    FROM datasets d
    LEFT JOIN dataset_items i ON i.datasetId = d.id
    GROUP BY d.id
    ORDER BY d.updatedAt DESC
    LIMIT $limit
  `).all({ $limit: limit });
}

function getDataset(db, idOrName) {
  return db.prepare("SELECT * FROM datasets WHERE id = $id OR name = $id").get({ $id: idOrName }) || null;
}

function insertDatasetItem(db, row) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO dataset_items (
      id, datasetId, traceId, spanId, sessionId, source, sourceId, label, note, createdAt
    ) VALUES (
      $id, $datasetId, $traceId, $spanId, $sessionId, $source, $sourceId, $label, $note, $createdAt
    )
  `).run({
    $id: row.id,
    $datasetId: row.datasetId,
    $traceId: row.traceId || null,
    $spanId: row.spanId || null,
    $sessionId: row.sessionId || null,
    $source: row.source || null,
    $sourceId: row.sourceId || null,
    $label: row.label || null,
    $note: row.note || null,
    $createdAt: row.createdAt || new Date().toISOString()
  });
  return result.changes;
}

function listDatasetItems(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 50000);
  const datasetId = options.datasetId || null;
  const traceId = options.traceId || null;
  const sessionId = options.sessionId || null;
  return db.prepare(`
    SELECT *
    FROM dataset_items
    WHERE ($datasetId IS NULL OR datasetId = $datasetId)
      AND ($traceId IS NULL OR traceId = $traceId)
      AND ($sessionId IS NULL OR sessionId = $sessionId)
    ORDER BY createdAt DESC
    LIMIT $limit
  `).all({ $datasetId: datasetId, $traceId: traceId, $sessionId: sessionId, $limit: limit });
}

function upsertBucket(db, row) {
  db.prepare(`
    INSERT INTO buckets (id, name, datasetId, behaviorId, description, enabled, createdAt, updatedAt)
    VALUES ($id, $name, $datasetId, $behaviorId, $description, $enabled, $createdAt, $updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      datasetId = excluded.datasetId,
      behaviorId = excluded.behaviorId,
      description = excluded.description,
      enabled = excluded.enabled,
      updatedAt = excluded.updatedAt
  `).run({
    $id: row.id,
    $name: row.name,
    $datasetId: row.datasetId,
    $behaviorId: row.behaviorId,
    $description: row.description || null,
    $enabled: row.enabled ? 1 : 0,
    $createdAt: row.createdAt || new Date().toISOString(),
    $updatedAt: row.updatedAt || new Date().toISOString()
  });
}

function listBuckets(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 10000);
  const behaviorId = options.behaviorId || null;
  const datasetId = options.datasetId || null;
  return db.prepare(`
    SELECT *
    FROM buckets
    WHERE ($behaviorId IS NULL OR behaviorId = $behaviorId)
      AND ($datasetId IS NULL OR datasetId = $datasetId)
    ORDER BY updatedAt DESC
    LIMIT $limit
  `).all({ $behaviorId: behaviorId, $datasetId: datasetId, $limit: limit }).map((row) => ({
    ...row,
    enabled: Boolean(row.enabled)
  }));
}

function getBucket(db, idOrName) {
  const row = db.prepare("SELECT * FROM buckets WHERE id = $id OR name = $id").get({ $id: idOrName }) || null;
  return row ? { ...row, enabled: Boolean(row.enabled) } : null;
}

function upsertRule(db, row) {
  db.prepare(`
    INSERT INTO rules (id, name, description, behaviorId, minCount, enabled, createdAt, updatedAt)
    VALUES ($id, $name, $description, $behaviorId, $minCount, $enabled, $createdAt, $updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      behaviorId = excluded.behaviorId,
      minCount = excluded.minCount,
      enabled = excluded.enabled,
      updatedAt = excluded.updatedAt
  `).run({
    $id: row.id,
    $name: row.name,
    $description: row.description || null,
    $behaviorId: row.behaviorId,
    $minCount: Number(row.minCount || 1),
    $enabled: row.enabled ? 1 : 0,
    $createdAt: row.createdAt || new Date().toISOString(),
    $updatedAt: row.updatedAt || new Date().toISOString()
  });
}

function listRules(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 10000);
  const behaviorId = options.behaviorId || null;
  return db.prepare(`
    SELECT *
    FROM rules
    WHERE ($behaviorId IS NULL OR behaviorId = $behaviorId)
    ORDER BY updatedAt DESC
    LIMIT $limit
  `).all({ $behaviorId: behaviorId, $limit: limit }).map((row) => ({
    ...row,
    enabled: Boolean(row.enabled)
  }));
}

function getRule(db, idOrName) {
  const row = db.prepare("SELECT * FROM rules WHERE id = $id OR name = $id").get({ $id: idOrName }) || null;
  return row ? { ...row, enabled: Boolean(row.enabled) } : null;
}

function insertAlert(db, row) {
  db.prepare(`
    INSERT OR REPLACE INTO alerts (id, ruleId, behaviorId, traceId, sessionId, severity, message, count, createdAt)
    VALUES ($id, $ruleId, $behaviorId, $traceId, $sessionId, $severity, $message, $count, $createdAt)
  `).run({
    $id: row.id,
    $ruleId: row.ruleId,
    $behaviorId: row.behaviorId || null,
    $traceId: row.traceId || null,
    $sessionId: row.sessionId || null,
    $severity: row.severity || "warning",
    $message: row.message || null,
    $count: row.count == null ? null : Number(row.count),
    $createdAt: row.createdAt || new Date().toISOString()
  });
}

function listAlerts(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 50000);
  const ruleId = options.ruleId || null;
  const behaviorId = options.behaviorId || null;
  const sessionId = options.sessionId || null;
  return db.prepare(`
    SELECT *
    FROM alerts
    WHERE ($ruleId IS NULL OR ruleId = $ruleId)
      AND ($behaviorId IS NULL OR behaviorId = $behaviorId)
      AND ($sessionId IS NULL OR sessionId = $sessionId)
    ORDER BY createdAt DESC
    LIMIT $limit
  `).all({ $ruleId: ruleId, $behaviorId: behaviorId, $sessionId: sessionId, $limit: limit });
}

function commitConfig(db, spec) {
  const config = spec.config || spec;
  const commit = spec.commit;
  const tags = spec.tags || [];
  db.prepare(`
    INSERT INTO configs (id, name, kind, description, latestCommitId, createdAt, updatedAt)
    VALUES ($id, $name, $kind, $description, $latestCommitId, $createdAt, $updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      description = excluded.description,
      latestCommitId = excluded.latestCommitId,
      updatedAt = excluded.updatedAt
  `).run({
    $id: config.id,
    $name: config.name,
    $kind: config.kind || "prompt",
    $description: config.description || null,
    $latestCommitId: config.latestCommitId,
    $createdAt: config.createdAt || new Date().toISOString(),
    $updatedAt: config.updatedAt || new Date().toISOString()
  });
  if (commit) {
    db.prepare(`
      INSERT OR REPLACE INTO config_commits (id, configId, content, contentHash, message, metadata, committedAt)
      VALUES ($id, $configId, $content, $contentHash, $message, $metadata, $committedAt)
    `).run({
      $id: commit.id,
      $configId: commit.configId,
      $content: commit.content || "",
      $contentHash: commit.contentHash || null,
      $message: commit.message || null,
      $metadata: asJson(commit.metadata || {}),
      $committedAt: commit.committedAt || new Date().toISOString()
    });
  }
  for (const tag of tags) setConfigTag(db, tag);
}

function setConfigTag(db, row) {
  db.prepare(`
    INSERT OR REPLACE INTO config_tags (configId, tag, commitId, updatedAt)
    VALUES ($configId, $tag, $commitId, $updatedAt)
  `).run({
    $configId: row.configId,
    $tag: row.tag,
    $commitId: row.commitId,
    $updatedAt: row.updatedAt || new Date().toISOString()
  });
}

function listConfigs(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 10000);
  const kind = options.kind || null;
  return db.prepare(`
    SELECT *
    FROM configs
    WHERE ($kind IS NULL OR kind = $kind)
    ORDER BY updatedAt DESC
    LIMIT $limit
  `).all({ $kind: kind, $limit: limit });
}

function listConfigCommits(db, options = {}) {
  const limit = boundedInt(options.limit, 1000, 1, 10000);
  const configId = options.configId || null;
  return db.prepare(`
    SELECT *
    FROM config_commits
    WHERE ($configId IS NULL OR configId = $configId)
    ORDER BY committedAt DESC
    LIMIT $limit
  `).all({ $configId: configId, $limit: limit }).map((row) => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : {}
  }));
}

function getConfig(db, idOrName, options = {}) {
  const config = db.prepare("SELECT * FROM configs WHERE id = $id OR name = $id").get({ $id: idOrName });
  if (!config) return null;
  let commitId = options.commitId || null;
  if (options.tag) {
    const tag = db.prepare("SELECT * FROM config_tags WHERE configId = $configId AND tag = $tag").get({ $configId: config.id, $tag: options.tag });
    commitId = tag && tag.commitId;
  }
  if (!commitId) commitId = config.latestCommitId;
  const commit = commitId
    ? db.prepare("SELECT * FROM config_commits WHERE id = $id AND configId = $configId").get({ $id: commitId, $configId: config.id })
    : null;
  const tags = db.prepare("SELECT * FROM config_tags WHERE configId = $configId ORDER BY tag ASC").all({ $configId: config.id });
  return {
    ...config,
    commit: commit ? { ...commit, metadata: commit.metadata ? JSON.parse(commit.metadata) : {} } : null,
    tags
  };
}

function workflowStats(db) {
  const lessonCount = db.prepare("SELECT COUNT(*) AS n FROM workflow_lessons").get().n;
  const byCategory = db.prepare("SELECT category, COUNT(*) AS count FROM workflow_lessons GROUP BY category ORDER BY count DESC").all();
  const byRepo = db.prepare("SELECT repo, COUNT(*) AS count FROM workflow_lessons WHERE repo IS NOT NULL GROUP BY repo ORDER BY count DESC LIMIT 20").all();
  return { lessonCount, byCategory, byRepo };
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
  const judgeCount = db.prepare("SELECT COUNT(*) AS n FROM judges").get().n;
  const evaluationCount = db.prepare("SELECT COUNT(*) AS n FROM evaluations").get().n;
  const behaviorCount = db.prepare("SELECT COUNT(*) AS n FROM behaviors").get().n;
  const behaviorDetectionCount = db.prepare("SELECT COUNT(*) AS n FROM behavior_results").get().n;
  const datasetCount = db.prepare("SELECT COUNT(*) AS n FROM datasets").get().n;
  const datasetItemCount = db.prepare("SELECT COUNT(*) AS n FROM dataset_items").get().n;
  const bucketCount = db.prepare("SELECT COUNT(*) AS n FROM buckets").get().n;
  const ruleCount = db.prepare("SELECT COUNT(*) AS n FROM rules").get().n;
  const alertCount = db.prepare("SELECT COUNT(*) AS n FROM alerts").get().n;
  const configCount = db.prepare("SELECT COUNT(*) AS n FROM configs").get().n;
  const configCommitCount = db.prepare("SELECT COUNT(*) AS n FROM config_commits").get().n;
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
    byType,
    judges: {
      judgeCount,
      evaluationCount,
      behaviorCount,
      behaviorDetectionCount
    },
    datasets: {
      datasetCount,
      datasetItemCount,
      bucketCount
    },
    alerts: {
      ruleCount,
      alertCount
    },
    configs: {
      configCount,
      configCommitCount
    }
  };
  if (deep) {
    out.intelligence = intelligenceStats(db);
    out.workflows = workflowStats(db);
  }
  return out;
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
      DELETE FROM workflow_lessons;
      DELETE FROM judges;
      DELETE FROM judge_versions;
      DELETE FROM evaluations;
      DELETE FROM behaviors;
      DELETE FROM behavior_results;
      DELETE FROM datasets;
      DELETE FROM dataset_items;
      DELETE FROM buckets;
      DELETE FROM rules;
      DELETE FROM alerts;
      DELETE FROM configs;
      DELETE FROM config_commits;
      DELETE FROM config_tags;
    `);
    let events = 0;
    const rawRows = store.readEventLog();
    const rows = typeof store.readRehydratedEventLog === "function" ? store.readRehydratedEventLog() : rawRows;
    for (const row of rows) events += insertEvent(db, row);
    for (const row of store.readSessionLog()) upsertSession(db, row);
    for (const row of store.readTaskLog()) upsertTask(db, row);
    restoreLiveSpans(db, store, rawRows);
    if (typeof store.readJudgeLog === "function") {
      for (const row of store.readJudgeLog()) upsertJudge(db, row);
    }
    if (typeof store.readEvaluationLog === "function") {
      for (const row of store.readEvaluationLog()) insertEvaluation(db, row);
    }
    if (typeof store.readBehaviorLog === "function") {
      for (const row of store.readBehaviorLog()) upsertBehavior(db, row);
    }
    if (typeof store.readBehaviorResultLog === "function") {
      for (const row of store.readBehaviorResultLog()) insertBehaviorResult(db, row);
    }
    if (typeof store.readDatasetLog === "function") {
      for (const row of store.readDatasetLog()) upsertDataset(db, row);
    }
    if (typeof store.readDatasetItemLog === "function") {
      for (const row of store.readDatasetItemLog()) insertDatasetItem(db, row);
    }
    if (typeof store.readBucketLog === "function") {
      for (const row of store.readBucketLog()) upsertBucket(db, row);
    }
    if (typeof store.readRuleLog === "function") {
      for (const row of store.readRuleLog()) upsertRule(db, row);
    }
    if (typeof store.readAlertLog === "function") {
      for (const row of store.readAlertLog()) insertAlert(db, row);
    }
    if (typeof store.readConfigLog === "function") {
      for (const row of store.readConfigLog()) commitConfig(db, row);
    }
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
  listTasks,
  listTraces,
  getTrace,
  listSpans,
  listAnnotations,
  listSessionMetrics,
  listWorkflowLessons,
  upsertJudge,
  getJudge,
  getJudgeVersion,
  listJudges,
  insertEvaluation,
  listEvaluations,
  upsertBehavior,
  listBehaviors,
  insertBehaviorResult,
  listBehaviorResults,
  upsertDataset,
  listDatasets,
  getDataset,
  insertDatasetItem,
  listDatasetItems,
  upsertBucket,
  listBuckets,
  getBucket,
  upsertRule,
  listRules,
  getRule,
  insertAlert,
  listAlerts,
  commitConfig,
  listConfigs,
  listConfigCommits,
  getConfig,
  stats,
  healthStats,
  rebuildIndex
};
