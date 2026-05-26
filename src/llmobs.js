"use strict";

const crypto = require("node:crypto");

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function first(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function isoTime(value, fallback = new Date().toISOString()) {
  if (value == null || value === "") return fallback;
  if (typeof value === "number") {
    const millis = value > 10000000000 ? Math.floor(value / 1000000) : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function durationMs(start, end, explicit) {
  if (explicit != null && explicit !== "") return Math.max(0, Number(explicit));
  const started = Date.parse(start);
  const ended = Date.parse(end);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
  return Math.max(0, ended - started);
}

function normalizeSpanType(value) {
  const kind = String(value || "span").toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_");
  if (kind.includes("tool")) return "tool";
  if (kind.includes("llm") || kind.includes("completion") || kind.includes("chat")) return "llm";
  if (kind.includes("agent")) return "agent";
  if (kind.includes("task")) return "task";
  if (kind.includes("retrieval") || kind.includes("embedding")) return "retrieval";
  if (kind.includes("error")) return "error";
  if (kind.includes("trace") || kind.includes("session")) return "trace";
  return kind || "span";
}

function statusFromInput(input) {
  const status = first(input.status, input.status_code, input.error ? "error" : null);
  if (!status) return "unknown";
  const normalized = String(status).toLowerCase();
  if (["ok", "success", "passed", "200", "0"].includes(normalized)) return "ok";
  if (["error", "failed", "failure", "exception"].includes(normalized) || /^[45]\d\d$/.test(normalized)) return "error";
  return normalized;
}

function metricsFromInput(input) {
  const usage = input.usage || input.metrics || {};
  const metrics = {
    inputTokens: first(input.input_tokens, input.prompt_tokens, usage.input_tokens, usage.prompt_tokens),
    outputTokens: first(input.output_tokens, input.completion_tokens, usage.output_tokens, usage.completion_tokens),
    totalTokens: first(input.total_tokens, usage.total_tokens),
    costUsd: first(input.cost_usd, input.cost, usage.cost_usd, usage.cost),
    contextWindow: first(input.context_window, usage.context_window),
    retries: first(input.retries, usage.retries),
    toolCallCount: first(input.tool_call_count, usage.tool_call_count)
  };
  return Object.fromEntries(Object.entries(metrics).filter(([, value]) => value !== null));
}

function stringifyPayload(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function llmObsSpanFromInput(input, options = {}) {
  if (!input || typeof input !== "object") throw new Error("span payload must be an object");
  const sessionId = String(first(input.session_id, input.sessionId, options.sessionId, input.trace_id, input.traceId, "live-session"));
  const traceId = String(first(input.trace_id, input.traceId, options.traceId, "session:" + sessionId));
  const name = String(first(input.name, input.resource, input.operation, input.type, "live span"));
  const spanType = normalizeSpanType(first(input.span_type, input.spanType, input.kind, input.type));
  const id = String(first(input.span_id, input.spanId, input.id, hash(JSON.stringify([traceId, name, input.start || input.start_time || input.timestamp]))));
  const parentSpanId = first(input.parent_id, input.parent_span_id, input.parentSpanId, input.parentId);
  const startTime = isoTime(first(input.start, input.start_time, input.startTime, input.timestamp));
  const endTime = isoTime(first(input.end, input.end_time, input.endTime), startTime);
  const metadata = {
    service: first(input.service, input.service_name, options.service),
    env: first(input.env, options.env),
    version: first(input.version, options.version),
    model: first(input.model, input.model_name),
    tags: input.tags || [],
    metrics: metricsFromInput(input),
    taskId: first(input.task_id, input.taskId, options.taskId),
    source: first(input.source, options.source, "live-intake"),
    datadog: input.datadog || null
  };
  return {
    id,
    traceId,
    parentSpanId: parentSpanId == null ? null : String(parentSpanId),
    sessionId,
    eventId: id,
    provider: first(input.provider, options.provider, "llmobs"),
    type: first(input.type, input.kind, "llmobs.span"),
    spanType,
    name,
    role: first(input.role, null),
    cwd: first(input.cwd, options.cwd),
    startTime,
    endTime,
    durationMs: durationMs(startTime, endTime, first(input.duration_ms, input.durationMs, input.duration)),
    status: statusFromInput(input),
    input: input.input == null ? null : stringifyPayload(input.input),
    output: input.output == null ? null : stringifyPayload(input.output),
    metadata,
    blobId: null,
    redactions: []
  };
}

function traceFromSpan(span, options = {}) {
  return {
    id: span.traceId,
    sessionId: span.sessionId,
    provider: span.provider,
    name: first(options.name, span.metadata && span.metadata.taskId, span.sessionId, span.traceId),
    cwd: span.cwd || null,
    sourcePath: first(options.sourcePath, span.metadata && span.metadata.source, "live-intake"),
    startedAt: span.startTime,
    endedAt: span.endTime,
    status: span.status || "unknown",
    spanCount: options.spanCount == null ? null : Number(options.spanCount),
    updatedAt: new Date().toISOString()
  };
}

function llmObsSpanFromCanonical(span) {
  const metadata = span.metadata || {};
  return {
    id: span.id,
    type: "span",
    attributes: {
      trace_id: span.traceId,
      span_id: span.id,
      parent_id: span.parentSpanId || null,
      session_id: span.sessionId || null,
      event_id: span.eventId || null,
      service: metadata.service || span.provider || "tracebase",
      resource: span.name || span.type || "span",
      name: span.name || span.type || "span",
      span_type: span.spanType || span.type || "span",
      type: span.type || null,
      provider: span.provider || null,
      role: span.role || null,
      start: span.startTime || null,
      end: span.endTime || null,
      duration_ms: span.durationMs == null ? null : Number(span.durationMs),
      status: span.status || "unknown",
      input: span.input || null,
      output: span.output || null,
      metrics: metadata.metrics || {},
      tags: metadata.tags || [],
      metadata
    }
  };
}

function llmObsTraceFromCanonical(trace, spans = []) {
  const projectedSpans = spans.map(llmObsSpanFromCanonical);
  return {
    id: trace.id,
    type: "trace",
    attributes: {
      trace_id: trace.id,
      session_id: trace.sessionId || null,
      provider: trace.provider || null,
      name: trace.name || trace.id,
      service: trace.provider || "tracebase",
      cwd: trace.cwd || null,
      source_path: trace.sourcePath || null,
      start: trace.startedAt || null,
      end: trace.endedAt || null,
      status: trace.status || "unknown",
      span_count: projectedSpans.length,
      spans: projectedSpans
    }
  };
}

function listLlmObsSpans(store, options = {}) {
  return store.listSpans(options).map(llmObsSpanFromCanonical);
}

function listLlmObsTraces(store, options = {}) {
  return store.listTraces(options).map((trace) => llmObsTraceFromCanonical(trace, store.listSpans({ traceId: trace.id, limit: 50000 })));
}

module.exports = {
  llmObsSpanFromInput,
  llmObsSpanFromCanonical,
  llmObsTraceFromCanonical,
  listLlmObsSpans,
  listLlmObsTraces,
  normalizeSpanType,
  traceFromSpan
};
