"use strict";

function eventText(event) {
  return String(event.summary || "").replace(/\s+/g, " ").trim();
}

function kindFor(event) {
  if (event.type === "self_trace_decision") return "self_trace";
  if (event.role === "user" || event.type === "user_message" || event.type === "UserPromptSubmit") return "user_intent";
  if (event.role === "assistant" || event.type === "agent_message" || event.type === "message") return "assistant_update";
  if (/failure|error|parse_error/i.test(event.type || "")) return "failure_signal";
  return "event";
}

function buildDecisionLog(store, options = {}) {
  const events = store.listMeaningfulEvents({
    limit: options.limit || 200,
    sessionId: options.sessionId,
    provider: options.provider,
    since: options.since
  }).slice().reverse();
  const annotations = options.sessionId ? store.listAnnotations({ sessionId: options.sessionId, limit: 10000 }) : [];
  const annotationByEvent = new Map(annotations.map((row) => [row.eventId, row]));
  return events.map((event) => {
    const annotation = annotationByEvent.get(event.id);
    return {
      timestamp: event.timestamp,
      sessionId: event.sessionId,
      provider: event.provider,
      kind: annotation ? annotation.kind : kindFor(event),
      type: event.type,
      role: event.role,
      summary: eventText(event),
      evidence: {
        eventId: event.id,
        sourcePath: event.sourcePath,
        blobId: event.blobId,
        annotation: annotation ? {
          severity: annotation.severity,
          confidence: annotation.confidence,
          reason: annotation.reason
        } : null
      }
    };
  });
}

module.exports = {
  buildDecisionLog
};
