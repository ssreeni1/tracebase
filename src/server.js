"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { TraceStore } = require("./storage");
const { buildDecisionLog } = require("./decision-log");
const { compareDatasets, compareSessions } = require("./regression");
const { listLlmObsSpans, listLlmObsTraces, llmObsTraceFromCanonical } = require("./llmobs");
const { buildExportZip } = require("./export");
const { availableSummaryRunners, latestSummary, listSummaries, summarizeSessionAsync } = require("./summaries");

function securityHeaders(extra = {}) {
  return {
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-resource-policy": "same-origin",
    ...extra
  };
}

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, securityHeaders({
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  }));
  res.end(body);
}

function sendHtml(res, body, status = 200) {
  res.writeHead(status, securityHeaders({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  }));
  res.end(body);
}

function attachmentFilename(value) {
  return String(value || "tracebase-export.zip").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sendBuffer(res, buffer, options = {}) {
  res.writeHead(options.status || 200, securityHeaders({
    "content-type": options.contentType || "application/octet-stream",
    "content-length": buffer.length,
    "cache-control": "no-store",
    ...(options.filename ? { "content-disposition": `attachment; filename="${attachmentFilename(options.filename)}"` } : {})
  }));
  res.end(buffer);
}

function notFound(res) {
  sendJson(res, { error: "not_found" }, 404);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 10 * 1024 * 1024) reject(new Error("request_body_too_large"));
    });
    req.on("end", () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function requestOptions(url) {
  return {
    provider: url.searchParams.get("provider") || undefined,
    sessionId: url.searchParams.get("sessionId") || undefined,
    traceId: url.searchParams.get("traceId") || undefined,
    sourcePath: url.searchParams.get("sourcePath") || undefined
  };
}

function parseOrigin(value) {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return false;
  }
}

function normalizedHostPort(value) {
  const input = String(value || "").trim().toLowerCase();
  if (!input) return null;
  if (input.startsWith("[")) {
    const end = input.indexOf("]");
    if (end < 0) return null;
    const host = input.slice(1, end);
    const rest = input.slice(end + 1);
    return { host, port: rest.startsWith(":") ? rest.slice(1) : "" };
  }
  const lastColon = input.lastIndexOf(":");
  if (lastColon > -1 && input.indexOf(":") === lastColon) {
    return { host: input.slice(0, lastColon), port: input.slice(lastColon + 1) };
  }
  return { host: input, port: "" };
}

function requestOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const parsed = parseOrigin(origin);
  if (!parsed || !isLoopbackHost(parsed.hostname)) return false;
  const requestHost = normalizedHostPort(req.headers.host);
  if (!requestHost || !isLoopbackHost(requestHost.host)) return false;
  return requestHost.host === parsed.hostname.toLowerCase() && requestHost.port === parsed.port;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function apiEvent(row) {
  const text = String(row.searchText || "");
  return {
    ...row,
    searchText: text.length > 1200 ? text.slice(0, 1200) + "\n[TRUNCATED]" : text
  };
}

function boundedInt(value, fallback, min, max) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  const n = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.max(min, Math.min(max, n));
}

function queryLimit(url, fallback = 1000, max = 50000) {
  return boundedInt(url.searchParams.get("limit"), fallback, 1, max);
}

function queryOffset(url) {
  return boundedInt(url.searchParams.get("offset"), 0, 0, 1000000);
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

function staticAsset(urlPath) {
  const dist = path.resolve(__dirname, "..", "dist");
  const requested = urlPath === "/" ? "index.html" : decodePathSegment(urlPath.slice(1));
  if (requested == null) return null;
  const file = path.resolve(dist, requested);
  if (!file.startsWith(dist + path.sep) && file !== path.join(dist, "index.html")) return null;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return file;
}

function sendStaticOrFallback(res, urlPath) {
  const file = staticAsset(urlPath);
  if (!file && urlPath.startsWith("/assets/")) return notFound(res);
  const fallback = file || staticAsset("/");
  if (!fallback) return sendHtml(res, missingDashboardBuildPage(), 503);
  const ext = path.extname(fallback);
  const body = fs.readFileSync(fallback);
  res.writeHead(200, securityHeaders({
    "content-type": MIME_TYPES[ext] || "application/octet-stream",
    "content-length": body.length,
    "cache-control": "no-store"
  }));
  res.end(body);
}

function queryOptions(url) {
  return {
    q: url.searchParams.get("q") || "",
    provider: url.searchParams.get("provider") || null,
    sessionId: url.searchParams.get("sessionId") || null,
    cwd: url.searchParams.get("cwd") || null,
    type: url.searchParams.get("type") || null,
    from: url.searchParams.get("from") || url.searchParams.get("since") || null,
    to: url.searchParams.get("to") || null,
    sort: url.searchParams.get("sort") || "time",
    order: url.searchParams.get("order") || "desc",
    limit: queryLimit(url, 1000, 10000),
    offset: queryOffset(url)
  };
}

function missingDashboardBuildPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tracebase</title>
</head>
<body>
  <main>
    <h1>Tracebase Dashboard Not Built</h1>
    <p>The local API is running, but the dashboard assets are missing.</p>
    <p>From a source checkout, run <code>npm run build</code> and restart <code>tracebase serve</code>.</p>
    <p>Installed npm packages include prebuilt dashboard assets.</p>
  </main>
</body>
</html>`;
}

function createServer(options = {}) {
  const store = options.store || new TraceStore();
  const summaryRunner = options.summaryRunner || null;
  const allowRawBlobApi = Boolean(options.allowRawBlobApi || process.env.TRACEBASE_ALLOW_RAW_BLOB_API === "1");
  const allowIntake = Boolean(options.allowIntake || process.env.TRACEBASE_ALLOW_INTAKE === "1");
  if (!store.db) store.init();
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "POST") {
      if (!requestOriginAllowed(req)) return sendJson(res, { error: "origin_not_allowed" }, 403);
      readJsonBody(req).then((body) => {
        if (url.pathname.startsWith("/api/summaries/session/")) {
          const sessionId = decodePathSegment(url.pathname.slice("/api/summaries/session/".length));
          if (!sessionId) return sendJson(res, { error: "invalid_path" }, 400);
          const requestedRunner = body.runner || url.searchParams.get("runner") || "codex";
          if (!["codex", "claude"].includes(requestedRunner)) {
            return sendJson(res, { error: "runner must be codex or claude." }, 400);
          }
          const runnerOptions = {
            runner: requestedRunner,
            timeoutMs: 120000
          };
          if (summaryRunner) {
            runnerOptions.command = summaryRunner.command;
            runnerOptions.args = summaryRunner.args || [];
          } else {
            const runner = availableSummaryRunners().find((item) => item.runner === requestedRunner);
            if (!runner || !runner.available) {
              return sendJson(res, {
                error: "summary_runner_unavailable",
                runner: requestedRunner,
                message: `${requestedRunner} CLI was not found on PATH. Install it or configure TRACE_${requestedRunner.toUpperCase()}_BIN for wrapper use.`
              }, 503);
            }
          }
          return summarizeSessionAsync(store, sessionId, runnerOptions)
            .then((summary) => sendJson(res, summary, 201));
        }
        if (url.pathname === "/api/events") {
          if (!allowIntake) return sendJson(res, { error: "intake_disabled" }, 403);
          const events = Array.isArray(body) ? body : body.events || [body];
          const rows = events.map((event) => store.ingestLiveEvent(event, requestOptions(url)));
          return sendJson(res, { accepted: rows.length, events: rows }, 202);
        }
        if (url.pathname === "/api/spans") {
          if (!allowIntake) return sendJson(res, { error: "intake_disabled" }, 403);
          const spans = Array.isArray(body) ? body : body.spans || [body];
          const rows = spans.map((span) => store.ingestLiveSpan(span, requestOptions(url)).span);
          return sendJson(res, { accepted: rows.length, spans: rows }, 202);
        }
        if (url.pathname === "/api/intake") {
          if (!allowIntake) return sendJson(res, { error: "intake_disabled" }, 403);
          return sendJson(res, store.ingestLiveBatch(body, requestOptions(url)), 202);
        }
        return notFound(res);
      }).catch((error) => {
        const status = error.message === "request_body_too_large" ? 413 : 400;
        sendJson(res, { error: error.message }, status);
      });
      return;
    }
    if (req.method !== "GET") return sendJson(res, { error: "method_not_allowed" }, 405);
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") return sendStaticOrFallback(res, url.pathname);
    if (url.pathname === "/api/health") {
      const stats = store.healthStats();
      return sendJson(res, {
        ok: true,
        latestEventAt: stats.latestEventAt,
        latestMeaningfulEventAt: stats.latestMeaningfulEventAt,
        eventCount: stats.eventCount,
        sessionCount: stats.sessionCount,
        bytes: stats.bytes,
        intakeEnabled: allowIntake,
        coverage: {
          hiddenPrivateReasoningCaptured: false,
          hiddenPrivateReasoningNote: "Only transcript-visible reasoning summaries are captured."
        }
      });
    }
    if (url.pathname === "/api/stats") return sendJson(res, store.stats());
    if (url.pathname === "/api/summaries") {
      return sendJson(res, listSummaries({
        traceHome: store.home,
        sessionId: url.searchParams.get("sessionId") || null,
        limit: queryLimit(url, 100)
      }));
    }
    if (url.pathname === "/api/summary-runners") {
      return sendJson(res, {
        runners: availableSummaryRunners().map((runner) => ({
          runner: runner.runner,
          label: runner.label,
          available: runner.available,
          overrideEnv: runner.overrideEnv
        }))
      });
    }
    if (url.pathname.startsWith("/api/summaries/session/")) {
      const sessionId = decodePathSegment(url.pathname.slice("/api/summaries/session/".length));
      if (!sessionId) return sendJson(res, { error: "invalid_path" }, 400);
      return sendJson(res, latestSummary({ traceHome: store.home, sessionId }) || { sessionId, summary: null });
    }
    if (url.pathname === "/api/export") {
      const raw = url.searchParams.get("raw") === "1" || url.searchParams.get("raw") === "true";
      if (raw && req.headers["x-tracebase-raw-export"] !== "1") {
        return sendJson(res, { error: "raw_export_requires_header" }, 403);
      }
      buildExportZip(store, {
        ...queryOptions(url),
        raw
      }).then((bundle) => sendBuffer(res, bundle.buffer, {
        contentType: bundle.contentType,
        filename: bundle.filename
      })).catch((error) => sendJson(res, { error: error.message }, 400));
      return;
    }
    if (url.pathname === "/api/annotations") {
      return sendJson(res, store.listAnnotations({
        limit: queryLimit(url, 1000),
        sessionId: url.searchParams.get("sessionId") || null,
        kind: url.searchParams.get("kind") || null
      }));
    }
    if (url.pathname === "/api/session-metrics") {
      return sendJson(res, store.listSessionMetrics({ limit: queryLimit(url, 1000) }));
    }
    if (url.pathname === "/api/workflow-lessons") {
      return sendJson(res, store.listWorkflowLessons({
        limit: queryLimit(url, 1000),
        category: url.searchParams.get("category") || null,
        repo: url.searchParams.get("repo") || null
      }));
    }
    if (url.pathname === "/api/judges") {
      return sendJson(res, store.listJudges({ limit: queryLimit(url, 1000) }));
    }
    if (url.pathname === "/api/evaluations") {
      return sendJson(res, store.listEvaluations({
        limit: queryLimit(url, 1000),
        judgeId: url.searchParams.get("judgeId") || null,
        traceId: url.searchParams.get("traceId") || null,
        sessionId: url.searchParams.get("sessionId") || null
      }));
    }
    if (url.pathname === "/api/behaviors") {
      return sendJson(res, store.listBehaviors({
        limit: queryLimit(url, 1000),
        judgeId: url.searchParams.get("judgeId") || null
      }));
    }
    if (url.pathname === "/api/behavior-results") {
      return sendJson(res, store.listBehaviorResults({
        limit: queryLimit(url, 1000),
        behaviorId: url.searchParams.get("behaviorId") || null,
        traceId: url.searchParams.get("traceId") || null,
        sessionId: url.searchParams.get("sessionId") || null
      }));
    }
    if (url.pathname === "/api/datasets") {
      return sendJson(res, store.listDatasets({ limit: queryLimit(url, 1000) }));
    }
    if (url.pathname === "/api/dataset-items") {
      return sendJson(res, store.listDatasetItems({
        limit: queryLimit(url, 1000),
        datasetId: url.searchParams.get("datasetId") || null,
        traceId: url.searchParams.get("traceId") || null,
        sessionId: url.searchParams.get("sessionId") || null
      }));
    }
    if (url.pathname === "/api/buckets") {
      return sendJson(res, store.listBuckets({
        limit: queryLimit(url, 1000),
        datasetId: url.searchParams.get("datasetId") || null,
        behaviorId: url.searchParams.get("behaviorId") || null
      }));
    }
    if (url.pathname === "/api/rules") {
      return sendJson(res, store.listRules({
        limit: queryLimit(url, 1000),
        behaviorId: url.searchParams.get("behaviorId") || null
      }));
    }
    if (url.pathname === "/api/alerts") {
      return sendJson(res, store.listAlerts({
        limit: queryLimit(url, 1000),
        ruleId: url.searchParams.get("ruleId") || null,
        behaviorId: url.searchParams.get("behaviorId") || null,
        sessionId: url.searchParams.get("sessionId") || null
      }));
    }
    if (url.pathname === "/api/compare/sessions") {
      const before = url.searchParams.get("before");
      const after = url.searchParams.get("after");
      if (!before || !after) return sendJson(res, { error: "missing_before_or_after" }, 400);
      return sendJson(res, compareSessions(store, before, after));
    }
    if (url.pathname === "/api/compare/datasets") {
      const before = url.searchParams.get("before");
      const after = url.searchParams.get("after");
      if (!before || !after) return sendJson(res, { error: "missing_before_or_after" }, 400);
      return sendJson(res, compareDatasets(store, before, after));
    }
    if (url.pathname === "/api/configs") {
      return sendJson(res, store.listConfigs({
        limit: queryLimit(url, 1000),
        kind: url.searchParams.get("kind") || null
      }));
    }
    if (url.pathname === "/api/config-commits") {
      return sendJson(res, store.listConfigCommits({
        limit: queryLimit(url, 1000),
        configId: url.searchParams.get("configId") || null
      }));
    }
    if (url.pathname.startsWith("/api/configs/")) {
      const id = decodePathSegment(url.pathname.slice("/api/configs/".length));
      if (!id) return sendJson(res, { error: "invalid_path" }, 400);
      const config = store.getConfig(id, {
        tag: url.searchParams.get("tag") || null,
        commitId: url.searchParams.get("commitId") || null
      });
      return config ? sendJson(res, config) : notFound(res);
    }
    if (url.pathname === "/api/sessions") {
      return sendJson(res, store.listSessions(queryOptions(url)));
    }
    if (url.pathname === "/api/traces") {
      return sendJson(res, store.listTraces({
        ...queryOptions(url),
        limit: queryLimit(url, 1000),
        provider: url.searchParams.get("provider") || null,
        sessionId: url.searchParams.get("sessionId") || null
      }));
    }
    if (url.pathname === "/api/llmobs/traces") {
      return sendJson(res, listLlmObsTraces(store, {
        limit: queryLimit(url, 1000),
        provider: url.searchParams.get("provider") || null,
        sessionId: url.searchParams.get("sessionId") || null
      }));
    }
    if (url.pathname.startsWith("/api/llmobs/traces/")) {
      const id = decodePathSegment(url.pathname.slice("/api/llmobs/traces/".length));
      if (!id) return sendJson(res, { error: "invalid_path" }, 400);
      const trace = store.getTrace(id);
      if (!trace) return notFound(res);
      return sendJson(res, llmObsTraceFromCanonical(trace, store.listSpans({ traceId: trace.id, limit: 50000 })));
    }
    if (url.pathname.startsWith("/api/traces/")) {
      const id = decodePathSegment(url.pathname.slice("/api/traces/".length));
      if (!id) return sendJson(res, { error: "invalid_path" }, 400);
      const trace = store.getTrace(id);
      return trace ? sendJson(res, trace) : notFound(res);
    }
    if (url.pathname === "/api/spans") {
      return sendJson(res, store.listSpans({
        ...queryOptions(url),
        limit: queryLimit(url, 5000),
        traceId: url.searchParams.get("traceId") || null,
        sessionId: url.searchParams.get("sessionId") || null,
        spanType: url.searchParams.get("spanType") || null
      }));
    }
    if (url.pathname === "/api/llmobs/spans") {
      return sendJson(res, listLlmObsSpans(store, {
        limit: queryLimit(url, 5000),
        traceId: url.searchParams.get("traceId") || null,
        sessionId: url.searchParams.get("sessionId") || null,
        spanType: url.searchParams.get("spanType") || null
      }));
    }
    if (url.pathname === "/api/tasks") return sendJson(res, store.listTasks());
    if (url.pathname === "/api/recent") {
      return sendJson(res, store.listMeaningfulEvents({
        limit: queryLimit(url, 200),
        provider: url.searchParams.get("provider") || null,
        sessionId: url.searchParams.get("sessionId") || null,
        since: url.searchParams.get("since") || null
      }).map(apiEvent));
    }
    if (url.pathname === "/api/decision-log") {
      return sendJson(res, buildDecisionLog(store, {
        limit: queryLimit(url, 200),
        provider: url.searchParams.get("provider") || null,
        sessionId: url.searchParams.get("sessionId") || null,
        since: url.searchParams.get("since") || null
      }));
    }
    if (url.pathname === "/api/events") {
      const limit = queryLimit(url, 1000, 5000);
      const rows = store.search(url.searchParams.get("q") || "", {
        ...queryOptions(url),
        limit,
        offset: queryOffset(url),
        provider: url.searchParams.get("provider") || null,
        sessionId: url.searchParams.get("sessionId") || null,
        type: url.searchParams.get("type") || null
      }).map(apiEvent);
      return sendJson(res, rows);
    }
    if (url.pathname.startsWith("/api/blob/")) {
      if (!allowRawBlobApi) return sendJson(res, { error: "raw_blob_api_disabled" }, 403);
      const id = decodePathSegment(url.pathname.slice("/api/blob/".length));
      if (!id) return sendJson(res, { error: "invalid_path" }, 400);
      try {
        return sendJson(res, store.getBlob(id));
      } catch (error) {
        return sendJson(res, { error: error.message }, 404);
      }
    }
    return notFound(res);
  });
}

function isLoopbackHost(host) {
  const value = String(host || "").toLowerCase();
  return value === "localhost" || value === "::1" || value === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(value);
}

function listen(options = {}) {
  const port = Number(options.port || process.env.PORT || 7331);
  const host = options.host || "127.0.0.1";
  const allowRemote = Boolean(options.allowRemote || process.env.TRACEBASE_ALLOW_REMOTE === "1");
  if (!isLoopbackHost(host) && !allowRemote) {
    throw new Error(`Refusing to bind Tracebase to non-loopback host ${host}. Use --allow-remote or TRACEBASE_ALLOW_REMOTE=1 only on trusted networks.`);
  }
  const server = createServer(options);
  server.listen(port, host, () => {
    console.log(`Tracebase listening at http://${host}:${port}`);
  });
  return server;
}

module.exports = {
  createServer,
  listen,
  escapeHtml
};
