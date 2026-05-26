"use strict";

const { sha256 } = require("./storage");

const SELF_TRACE_PROMPT = `Opt-in self trace: at meaningful checkpoints, emit a compact JSON object with:
{
  "goal": "current user-visible objective",
  "decision": "what you chose to do next",
  "why": ["short reasons grounded in visible context"],
  "alternatives": ["reasonable alternatives considered"],
  "risks": ["known risks or uncertainty"],
  "evidence": ["files, commands, tests, or trace ids used"],
  "next": "next concrete action"
}
Do not include hidden chain-of-thought. Summarize only what is safe and useful for future debugging.`;

function makeSelfTraceEvent(payload, options = {}) {
  const timestamp = payload.timestamp || new Date().toISOString();
  const sessionId = options.sessionId || payload.sessionId || `self-trace-${timestamp}`;
  const normalized = {
    artifact_kind: "self_trace_decision",
    schema_version: 1,
    timestamp,
    sessionId,
    goal: payload.goal || null,
    decision: payload.decision || null,
    why: Array.isArray(payload.why) ? payload.why : [],
    alternatives: Array.isArray(payload.alternatives) ? payload.alternatives : [],
    risks: Array.isArray(payload.risks) ? payload.risks : [],
    evidence: Array.isArray(payload.evidence) ? payload.evidence : [],
    next: payload.next || null
  };
  const summary = [normalized.goal, normalized.decision, normalized.next].filter(Boolean).join(" | ").slice(0, 240) || "self trace";
  return {
    id: sha256(JSON.stringify(["self-trace", sessionId, timestamp, normalized])),
    provider: "self-trace",
    sourcePath: options.sourcePath || "self-trace",
    offset: Date.now(),
    sessionId,
    taskId: sessionId,
    type: "self_trace_decision",
    role: "assistant",
    cwd: payload.cwd || options.cwd || null,
    timestamp,
    summary,
    searchText: normalized,
    raw: normalized
  };
}

function parseSelfTraceInput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("self-trace-record requires JSON on stdin.");
  return JSON.parse(trimmed);
}

module.exports = {
  SELF_TRACE_PROMPT,
  makeSelfTraceEvent,
  parseSelfTraceInput
};
