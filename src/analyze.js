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

const LARGE_OUTPUT_CHARS = 12000;

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
  if (event.structured && event.structured.command) return event.structured.command;
  const text = event.searchText || "";
  const match = text.match(/"command"\s*:\s*"((?:\\"|[^"])*)"/);
  if (!match) return null;
  return match[1].replace(/\\"/g, '"').replace(/\s+/g, " ").trim().slice(0, 240);
}

function addMetric(acc, key, value) {
  const n = Number(value);
  if (Number.isFinite(n)) acc[key] += n;
}

function aggregateStructured(events) {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    failedToolCount: 0,
    approvalDeniedCount: 0,
    redactionCount: 0,
    largeOutputCount: 0
  };
  const models = new Map();
  const files = new Set();
  const commands = new Map();
  for (const event of events) {
    const structured = event.structured || {};
    addMetric(totals, "inputTokens", structured.inputTokens);
    addMetric(totals, "outputTokens", structured.outputTokens);
    addMetric(totals, "cacheReadTokens", structured.cacheReadTokens);
    addMetric(totals, "cacheWriteTokens", structured.cacheWriteTokens);
    addMetric(totals, "reasoningTokens", structured.reasoningTokens);
    addMetric(totals, "totalTokens", structured.totalTokens);
    addMetric(totals, "redactionCount", structured.redactionCount);
    if (structured.model) models.set(structured.model, (models.get(structured.model) || 0) + 1);
    for (const file of structured.filesTouched || []) files.add(file);
    if (structured.command) commands.set(structured.command, (commands.get(structured.command) || 0) + 1);
    if (structured.errorKind || (structured.exitCode != null && Number(structured.exitCode) !== 0)) totals.failedToolCount += 1;
    if (structured.approvalState === "denied") totals.approvalDeniedCount += 1;
    if (Number(structured.outputChars || 0) >= LARGE_OUTPUT_CHARS) totals.largeOutputCount += 1;
  }
  const repeatedCommandCount = Array.from(commands.values()).filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0);
  const model = Array.from(models.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return {
    ...totals,
    model,
    filesTouchedCount: files.size,
    repeatedCommandCount
  };
}

function isReadTool(event) {
  const structured = event.structured || {};
  return /^(read|view|open)$/i.test(structured.toolName || "") || /\bread\b/i.test(structured.command || "");
}

function isSearchCommand(event) {
  const command = String((event.structured && event.structured.command) || "");
  return /\b(rg|grep|find|ag|ack)\b/.test(command);
}

function classifyWaste(event, state) {
  const structured = event.structured || {};
  const findings = [];
  if (Number(structured.outputChars || 0) >= LARGE_OUTPUT_CHARS) {
    findings.push({
      kind: "context_waste",
      severity: "medium",
      confidence: 0.8,
      reason: "Tool output was large enough to risk wasting context."
    });
  }
  if (structured.filePath && isReadTool(event)) {
    const key = structured.filePath;
    const previous = state.fileReads.get(key) || [];
    const windowed = previous.filter((item) => Date.parse(event.timestamp) - Date.parse(item.timestamp) < 20 * 60 * 1000);
    if (windowed.length >= 2) {
      findings.push({
        kind: "context_waste",
        severity: "medium",
        confidence: 0.78,
        reason: "Same file was read at least three times within twenty minutes."
      });
    }
    windowed.push(event);
    state.fileReads.set(key, windowed);
  }
  if (isSearchCommand(event)) {
    const previous = state.searches;
    const windowed = previous.filter((item) => Date.parse(event.timestamp) - Date.parse(item.timestamp) < 10 * 60 * 1000);
    if (windowed.length >= 4) {
      findings.push({
        kind: "context_waste",
        severity: "low",
        confidence: 0.7,
        reason: "Search commands repeated at least five times within ten minutes."
      });
    }
    windowed.push(event);
    state.searches = windowed;
  }
  return findings;
}

function parseStructuredRows(events) {
  return events.map((event) => {
    if (!event.structured || typeof event.structured !== "string") return event;
    try {
      return { ...event, structured: JSON.parse(event.structured) };
    } catch {
      return { ...event, structured: {} };
    }
  });
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
  const wasteState = { fileReads: new Map(), searches: [] };

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

    for (const waste of classifyWaste(event, wasteState)) {
      annotations.push(createAnnotation(sessionId, event, waste));
    }
  }

  const counts = annotations.reduce((acc, row) => {
    acc[row.kind] = (acc[row.kind] || 0) + 1;
    return acc;
  }, {});
  const eventCount = events.length;
  const toolCount = events.filter((event) => /ToolUse|tool|response_item|event_msg/i.test(event.type || "")).length;
  const userPromptCount = events.filter((event) => event.role === "user" || event.type === "user" || event.type === "UserPromptSubmit").length;
  const structured = aggregateStructured(events);
  const outcome = counts.resteer || counts.failure > 2 ? "user_intervened_or_blocked" : counts.failure ? "recovered_or_unknown" : "clean_or_unknown";
  const qualityScore = Math.max(0, Math.min(100,
    100 - (counts.failure || 0) * 8 - (counts.resteer || 0) * 12 - (counts.loop || 0) * 10 + (counts.recovery || 0) * 4
  ));
  const efficiencyScore = Math.max(0, Math.min(100,
    100 - (structured.repeatedCommandCount || 0) * 8 - (structured.failedToolCount || 0) * 6 - (counts.loop || 0) * 10 - (counts.context_waste || 0) * 7
  ));
  const riskScore = Math.max(0, Math.min(100,
    (structured.redactionCount || 0) * 8 + (structured.approvalDeniedCount || 0) * 10 + (counts.failure || 0) * 5
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
      failedToolCount: structured.failedToolCount,
      approvalDeniedCount: structured.approvalDeniedCount,
      repeatedCommandCount: structured.repeatedCommandCount,
      contextWasteCount: counts.context_waste || 0,
      largeOutputCount: structured.largeOutputCount,
      filesTouchedCount: structured.filesTouchedCount,
      redactionCount: structured.redactionCount,
      model: structured.model,
      inputTokens: structured.inputTokens,
      outputTokens: structured.outputTokens,
      cacheReadTokens: structured.cacheReadTokens,
      cacheWriteTokens: structured.cacheWriteTokens,
      reasoningTokens: structured.reasoningTokens,
      totalTokens: structured.totalTokens,
      outcome,
      qualityScore,
      efficiencyScore,
      riskScore,
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
      const events = parseStructuredRows(db.prepare("SELECT * FROM events WHERE sessionId = $sessionId ORDER BY timestamp ASC, offset ASC").all({ $sessionId: session.id }));
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
          loopCount, recoveryCount, failedToolCount, approvalDeniedCount, repeatedCommandCount,
          contextWasteCount, largeOutputCount, filesTouchedCount, redactionCount, model, inputTokens, outputTokens, cacheReadTokens,
          cacheWriteTokens, reasoningTokens, totalTokens, outcome, qualityScore,
          efficiencyScore, riskScore, analyzedAt
        ) VALUES (
          $sessionId, $eventCount, $toolCount, $userPromptCount, $failureCount, $resteerCount,
          $loopCount, $recoveryCount, $failedToolCount, $approvalDeniedCount, $repeatedCommandCount,
          $contextWasteCount, $largeOutputCount, $filesTouchedCount, $redactionCount, $model, $inputTokens, $outputTokens, $cacheReadTokens,
          $cacheWriteTokens, $reasoningTokens, $totalTokens, $outcome, $qualityScore,
          $efficiencyScore, $riskScore, $analyzedAt
        )
        ON CONFLICT(sessionId) DO UPDATE SET
          eventCount = excluded.eventCount,
          toolCount = excluded.toolCount,
          userPromptCount = excluded.userPromptCount,
          failureCount = excluded.failureCount,
          resteerCount = excluded.resteerCount,
          loopCount = excluded.loopCount,
          recoveryCount = excluded.recoveryCount,
          failedToolCount = excluded.failedToolCount,
          approvalDeniedCount = excluded.approvalDeniedCount,
          repeatedCommandCount = excluded.repeatedCommandCount,
          contextWasteCount = excluded.contextWasteCount,
          largeOutputCount = excluded.largeOutputCount,
          filesTouchedCount = excluded.filesTouchedCount,
          redactionCount = excluded.redactionCount,
          model = excluded.model,
          inputTokens = excluded.inputTokens,
          outputTokens = excluded.outputTokens,
          cacheReadTokens = excluded.cacheReadTokens,
          cacheWriteTokens = excluded.cacheWriteTokens,
          reasoningTokens = excluded.reasoningTokens,
          totalTokens = excluded.totalTokens,
          outcome = excluded.outcome,
          qualityScore = excluded.qualityScore,
          efficiencyScore = excluded.efficiencyScore,
          riskScore = excluded.riskScore,
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
        $failedToolCount: result.metrics.failedToolCount,
        $approvalDeniedCount: result.metrics.approvalDeniedCount,
        $repeatedCommandCount: result.metrics.repeatedCommandCount,
        $contextWasteCount: result.metrics.contextWasteCount,
        $largeOutputCount: result.metrics.largeOutputCount,
        $filesTouchedCount: result.metrics.filesTouchedCount,
        $redactionCount: result.metrics.redactionCount,
        $model: result.metrics.model,
        $inputTokens: result.metrics.inputTokens,
        $outputTokens: result.metrics.outputTokens,
        $cacheReadTokens: result.metrics.cacheReadTokens,
        $cacheWriteTokens: result.metrics.cacheWriteTokens,
        $reasoningTokens: result.metrics.reasoningTokens,
        $totalTokens: result.metrics.totalTokens,
        $outcome: result.metrics.outcome,
        $qualityScore: result.metrics.qualityScore,
        $efficiencyScore: result.metrics.efficiencyScore,
        $riskScore: result.metrics.riskScore,
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
