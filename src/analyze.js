"use strict";

const crypto = require("node:crypto");

const FAILURE_PATTERNS = [
  /\bis_error["']?\s*:\s*true\b/i,
  /\bexit code\s+[1-9]\d*\b/i,
  /\bcommand failed\b/i,
  /\bno such file or directory\b/i,
  /\bpermission denied\b/i,
  /\btimeout\b/i,
  /\btraceback\b/i,
  /\berror:/i,
  /\bfailed\b/i,
  /\bexception\b/i
];

const RESTEER_PATTERNS = [
  /\btry again\b/i,
  /\bactually\b/i,
  /\byou missed\b/i,
  /\bnot what i asked\b/i,
  /\bwrong\b/i,
  /\bfix this\b/i,
  /\bfix and rerun\b/i,
  /\brerun\b/i,
  /\bnew goal\b/i,
  /\bmake this a new\b/i,
  /\bfull e2e\b/i,
  /\bredo\b/i,
  /\binstead\b/i,
  /\bno[, ]/i,
  /\bthat's not\b/i,
  /\byou forgot\b/i,
  /\bstop\b/i
];

const RECOVERY_PATTERNS = [
  /\bexit code 0\b/i,
  /\btests? passed\b/i,
  /\bbuild succeeded\b/i,
  /\bcompiled successfully\b/i,
  /\bsmoke ok\b/i,
  /\bdone\b/i,
  /\bsuccess\b/i
];

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function classifyFailure(event) {
  const text = `${event.summary || ""}\n${event.searchText || ""}`;
  if (FAILURE_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      kind: "failure",
      severity: /permission denied|traceback|exception|timeout/i.test(text) ? "high" : "medium",
      confidence: /is_error["']?\s*:\s*true|exit code\s+[1-9]/i.test(text) ? 0.95 : 0.65,
      reason: "Tool output or transcript text contains a failure signal."
    };
  }
  return null;
}

function classifyResteer(event, previousFailure) {
  const text = `${event.summary || ""}\n${event.searchText || ""}`;
  const isUser = event.role === "user" || event.type === "user" || event.type === "user_message" || event.type === "UserPromptSubmit" || event.type === "last-prompt";
  if (!isUser) return null;
  if (/Codex agent history added since your last approval assessment|TRANSCRIPT DELTA START|planned action as untrusted evidence/i.test(text)) return null;
  const isToolResult = /"tool_result"|"tool_use_id"|"is_error"/i.test(text);
  const explicit = RESTEER_PATTERNS.some((pattern) => pattern.test(text));
  if (isToolResult && event.type !== "UserPromptSubmit" && event.type !== "last-prompt") return null;
  if (explicit) {
    return {
      kind: "resteer",
      severity: "medium",
      confidence: 0.85,
      reason: "User prompt contains correction/retry language."
    };
  }
  return null;
}

function classifyRecovery(event, previousFailure) {
  if (!previousFailure) return null;
  const text = `${event.summary || ""}\n${event.searchText || ""}`;
  if (RECOVERY_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      kind: "recovery",
      severity: "info",
      confidence: /exit code 0|smoke ok|tests? passed/i.test(text) ? 0.85 : 0.55,
      reason: "A success signal appeared after a recent failure."
    };
  }
  return null;
}

function commandFingerprint(event) {
  const text = event.searchText || "";
  const match = text.match(/"command"\s*:\s*"((?:\\"|[^"])*)"/);
  if (!match) return null;
  return match[1].replace(/\\"/g, '"').replace(/\s+/g, " ").trim().slice(0, 240);
}

function createAnnotation(sessionId, event, classification) {
  return {
    id: hash(`${sessionId}:${event.id}:${classification.kind}:${classification.reason}`),
    sessionId,
    eventId: event.id,
    provider: event.provider,
    kind: classification.kind,
    severity: classification.severity,
    confidence: classification.confidence,
    reason: classification.reason,
    timestamp: event.timestamp,
    summary: event.summary
  };
}

function analyzeSessionEvents(sessionId, events) {
  const annotations = [];
  let lastFailure = null;
  const recentCommands = new Map();

  for (const event of events) {
    const failure = classifyFailure(event);
    if (failure) {
      annotations.push(createAnnotation(sessionId, event, failure));
      lastFailure = event;
    }

    const resteer = classifyResteer(event, lastFailure);
    if (resteer) annotations.push(createAnnotation(sessionId, event, resteer));

    const recovery = classifyRecovery(event, lastFailure);
    if (recovery) {
      annotations.push(createAnnotation(sessionId, event, recovery));
      lastFailure = null;
    }

    const fingerprint = commandFingerprint(event);
    if (fingerprint) {
      const previous = recentCommands.get(fingerprint) || [];
      const windowed = previous.filter((item) => Date.parse(event.timestamp) - Date.parse(item.timestamp) < 10 * 60 * 1000);
      if (windowed.length >= 2) {
        annotations.push(createAnnotation(sessionId, event, {
          kind: "loop",
          severity: "medium",
          confidence: 0.75,
          reason: "Same command repeated at least three times within ten minutes."
        }));
      }
      windowed.push(event);
      recentCommands.set(fingerprint, windowed);
    }
  }

  const counts = annotations.reduce((acc, row) => {
    acc[row.kind] = (acc[row.kind] || 0) + 1;
    return acc;
  }, {});
  const eventCount = events.length;
  const toolCount = events.filter((event) => /ToolUse|tool|response_item|event_msg/i.test(event.type || "")).length;
  const userPromptCount = events.filter((event) => event.role === "user" || event.type === "user" || event.type === "UserPromptSubmit").length;
  const outcome = counts.resteer || counts.failure > 2 ? "user_intervened_or_blocked" : counts.failure ? "recovered_or_unknown" : "clean_or_unknown";
  const qualityScore = Math.max(0, Math.min(100,
    100 - (counts.failure || 0) * 8 - (counts.resteer || 0) * 12 - (counts.loop || 0) * 10 + (counts.recovery || 0) * 4
  ));

  return {
    annotations,
    metrics: {
      sessionId,
      eventCount,
      toolCount,
      userPromptCount,
      failureCount: counts.failure || 0,
      resteerCount: counts.resteer || 0,
      loopCount: counts.loop || 0,
      recoveryCount: counts.recovery || 0,
      outcome,
      qualityScore,
      analyzedAt: new Date().toISOString()
    }
  };
}

function analyzeStore(store, options = {}) {
  const db = store.getDb();
  const limit = Math.max(1, Math.min(100000, Number(options.limit || 100000)));
  const sessions = options.sessionId
    ? [{ id: options.sessionId }]
    : db.prepare("SELECT id FROM sessions ORDER BY COALESCE(endedAt, updatedAt, startedAt) DESC LIMIT $limit").all({ $limit: limit });
  let annotationCount = 0;
  db.exec("BEGIN");
  try {
    for (const session of sessions) {
      const events = db.prepare("SELECT * FROM events WHERE sessionId = $sessionId ORDER BY timestamp ASC, offset ASC").all({ $sessionId: session.id });
      const result = analyzeSessionEvents(session.id, events);
      db.prepare("DELETE FROM annotations WHERE sessionId = $sessionId").run({ $sessionId: session.id });
      for (const row of result.annotations) {
        db.prepare(`
          INSERT INTO annotations (id, sessionId, eventId, provider, kind, severity, confidence, reason, timestamp, summary)
          VALUES ($id, $sessionId, $eventId, $provider, $kind, $severity, $confidence, $reason, $timestamp, $summary)
        `).run({
          $id: row.id,
          $sessionId: row.sessionId,
          $eventId: row.eventId,
          $provider: row.provider,
          $kind: row.kind,
          $severity: row.severity,
          $confidence: row.confidence,
          $reason: row.reason,
          $timestamp: row.timestamp,
          $summary: row.summary
        });
        annotationCount += 1;
      }
      db.prepare(`
        INSERT INTO session_metrics (
          sessionId, eventCount, toolCount, userPromptCount, failureCount, resteerCount,
          loopCount, recoveryCount, outcome, qualityScore, analyzedAt
        ) VALUES (
          $sessionId, $eventCount, $toolCount, $userPromptCount, $failureCount, $resteerCount,
          $loopCount, $recoveryCount, $outcome, $qualityScore, $analyzedAt
        )
        ON CONFLICT(sessionId) DO UPDATE SET
          eventCount = excluded.eventCount,
          toolCount = excluded.toolCount,
          userPromptCount = excluded.userPromptCount,
          failureCount = excluded.failureCount,
          resteerCount = excluded.resteerCount,
          loopCount = excluded.loopCount,
          recoveryCount = excluded.recoveryCount,
          outcome = excluded.outcome,
          qualityScore = excluded.qualityScore,
          analyzedAt = excluded.analyzedAt
      `).run({
        $sessionId: result.metrics.sessionId,
        $eventCount: result.metrics.eventCount,
        $toolCount: result.metrics.toolCount,
        $userPromptCount: result.metrics.userPromptCount,
        $failureCount: result.metrics.failureCount,
        $resteerCount: result.metrics.resteerCount,
        $loopCount: result.metrics.loopCount,
        $recoveryCount: result.metrics.recoveryCount,
        $outcome: result.metrics.outcome,
        $qualityScore: result.metrics.qualityScore,
        $analyzedAt: result.metrics.analyzedAt
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { sessions: sessions.length, annotations: annotationCount };
}

module.exports = {
  analyzeStore,
  analyzeSessionEvents
};
