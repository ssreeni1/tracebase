"use strict";

const crypto = require("node:crypto");

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function rootSpanId(sessionId) {
  return `trace:${sessionId}:root`;
}

function traceIdForSession(sessionId) {
  return `session:${sessionId}`;
}

function spanTypeFromEvent(event) {
  const type = String(event.type || "").toLowerCase();
  if (type.includes("tool") || event.summary && /^tool\b/i.test(event.summary)) return "tool";
  if (type.includes("user") || event.role === "user") return "user";
  if (type.includes("assistant") || event.role === "assistant") return "assistant";
  if (type.includes("reasoning")) return "reasoning";
  if (type.includes("error") || /\berror\b/i.test(event.summary || "")) return "error";
  if (type.includes("self_trace")) return "decision";
  return "span";
}

function spanStatus(event) {
  const text = `${event.summary || ""}\n${event.searchText || ""}`;
  if (/\bis_error["']?\s*:\s*true\b|\bexit code\s+[1-9]\d*\b|\btraceback\b|\bexception\b|\bpermission denied\b/i.test(text)) {
    return "error";
  }
  if (/\bexit code 0\b|\btests? passed\b|\bsmoke ok\b|\bsuccess\b/i.test(text)) return "ok";
  return "unknown";
}

function safeJson(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redactionsForSpan(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function canonicalTraceFromSession(session) {
  const id = traceIdForSession(session.id);
  return {
    id,
    sessionId: session.id,
    provider: session.provider || null,
    name: session.project || session.id,
    cwd: session.cwd || null,
    sourcePath: session.sourcePath || null,
    startedAt: session.startedAt || null,
    endedAt: session.endedAt || session.startedAt || null,
    status: "unknown",
    spanCount: session.eventCount == null ? 0 : Number(session.eventCount),
    updatedAt: session.updatedAt || new Date().toISOString()
  };
}

function rootSpanFromSession(session) {
  const trace = canonicalTraceFromSession(session);
  return {
    id: rootSpanId(session.id),
    traceId: trace.id,
    parentSpanId: null,
    sessionId: session.id,
    eventId: null,
    provider: session.provider || null,
    type: "session",
    spanType: "trace",
    name: trace.name || session.id,
    role: null,
    cwd: session.cwd || null,
    startTime: session.startedAt || null,
    endTime: session.endedAt || session.startedAt || null,
    durationMs: durationMs(session.startedAt, session.endedAt),
    status: "unknown",
    input: null,
    output: null,
    metadata: { sourcePath: session.sourcePath || null, project: session.project || null },
    blobId: null,
    redactions: []
  };
}

function canonicalSpanFromEvent(event) {
  const sessionId = event.sessionId || event.taskId || "unknown";
  const spanType = spanTypeFromEvent(event);
  return {
    id: event.id || hash(JSON.stringify(event)),
    traceId: traceIdForSession(sessionId),
    parentSpanId: rootSpanId(sessionId),
    sessionId,
    eventId: event.id || null,
    provider: event.provider || null,
    type: event.type || "event",
    spanType,
    name: event.summary || event.type || "event",
    role: event.role || null,
    cwd: event.cwd || null,
    startTime: event.timestamp || null,
    endTime: event.timestamp || null,
    durationMs: 0,
    status: spanStatus(event),
    input: event.role === "user" ? event.searchText || event.summary || null : null,
    output: event.role !== "user" ? event.searchText || event.summary || null : null,
    metadata: {
      sourcePath: event.sourcePath || null,
      offset: event.offset == null ? null : Number(event.offset),
      taskId: event.taskId || null
    },
    blobId: event.blobId || null,
    redactions: redactionsForSpan(event.redactions)
  };
}

function durationMs(start, end) {
  if (!start || !end) return null;
  const started = Date.parse(start);
  const ended = Date.parse(end);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
  return Math.max(0, ended - started);
}

function publicSpan(row) {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    redactions: row.redactions ? JSON.parse(row.redactions) : []
  };
}

module.exports = {
  canonicalTraceFromSession,
  canonicalSpanFromEvent,
  rootSpanFromSession,
  publicSpan,
  rootSpanId,
  traceIdForSession
};
