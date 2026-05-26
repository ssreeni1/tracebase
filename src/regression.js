"use strict";

function countBy(rows, key) {
  const out = {};
  for (const row of rows) {
    const value = row[key] == null ? "unknown" : String(row[key]);
    out[value] = (out[value] || 0) + 1;
  }
  return out;
}

function numericDelta(after, before) {
  return Number(after || 0) - Number(before || 0);
}

function objectDelta(after = {}, before = {}) {
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  return keys.map((key) => ({
    key,
    before: before[key] || 0,
    after: after[key] || 0,
    delta: (after[key] || 0) - (before[key] || 0)
  })).filter((row) => row.before || row.after || row.delta);
}

function sessionMetrics(store, sessionId) {
  const db = store.getDb();
  const session = db.prepare("SELECT * FROM sessions WHERE id = $id").get({ $id: sessionId });
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  const trace = store.listTraces({ sessionId, limit: 1 })[0] || null;
  const spans = store.listSpans({ sessionId, limit: 50000 });
  const evaluations = store.listEvaluations({ sessionId, limit: 50000 });
  const behaviorResults = store.listBehaviorResults({ sessionId, limit: 50000 });
  const alerts = store.listAlerts({ sessionId, limit: 50000 });
  const metrics = db.prepare("SELECT * FROM session_metrics WHERE sessionId = $sessionId").get({ $sessionId: sessionId }) || {};
  return {
    kind: "session",
    id: sessionId,
    traceId: trace && trace.id,
    eventCount: Number(session.eventCount || spans.filter((span) => span.eventId).length),
    spanCount: spans.length,
    errorSpanCount: spans.filter((span) => span.status === "error").length,
    toolSpanCount: spans.filter((span) => span.spanType === "tool").length,
    behaviorDetectionCount: behaviorResults.length,
    alertCount: alerts.length,
    evaluationCount: evaluations.length,
    evaluationPassCount: evaluations.filter((row) => row.passed).length,
    evaluationFailCount: evaluations.filter((row) => !row.passed).length,
    qualityScore: metrics.qualityScore == null ? null : Number(metrics.qualityScore),
    outcome: metrics.outcome || null,
    spanTypes: countBy(spans, "spanType"),
    spanStatuses: countBy(spans, "status"),
    behaviors: countBy(behaviorResults, "behaviorId"),
    alerts: countBy(alerts, "ruleId"),
    judges: countBy(evaluations, "judgeId")
  };
}

function datasetMetrics(store, datasetIdOrName) {
  const dataset = store.getDataset(datasetIdOrName);
  if (!dataset) throw new Error(`Unknown dataset: ${datasetIdOrName}`);
  const items = store.listDatasetItems({ datasetId: dataset.id, limit: 50000 });
  const sessionIds = Array.from(new Set(items.map((item) => item.sessionId).filter(Boolean)));
  const sessions = sessionIds.map((sessionId) => sessionMetrics(store, sessionId));
  const sum = (key) => sessions.reduce((total, row) => total + Number(row[key] || 0), 0);
  const merged = (key) => {
    const out = {};
    for (const session of sessions) {
      for (const [name, count] of Object.entries(session[key] || {})) out[name] = (out[name] || 0) + count;
    }
    return out;
  };
  return {
    kind: "dataset",
    id: dataset.id,
    itemCount: items.length,
    sessionCount: sessionIds.length,
    eventCount: sum("eventCount"),
    spanCount: sum("spanCount"),
    errorSpanCount: sum("errorSpanCount"),
    toolSpanCount: sum("toolSpanCount"),
    behaviorDetectionCount: sum("behaviorDetectionCount"),
    alertCount: sum("alertCount"),
    evaluationCount: sum("evaluationCount"),
    evaluationPassCount: sum("evaluationPassCount"),
    evaluationFailCount: sum("evaluationFailCount"),
    qualityScore: sessions.length
      ? Math.round(sessions.reduce((total, row) => total + Number(row.qualityScore || 0), 0) / sessions.length)
      : null,
    spanTypes: merged("spanTypes"),
    spanStatuses: merged("spanStatuses"),
    behaviors: merged("behaviors"),
    alerts: merged("alerts"),
    judges: merged("judges")
  };
}

function compareMetrics(before, after) {
  const numericKeys = [
    "eventCount",
    "spanCount",
    "errorSpanCount",
    "toolSpanCount",
    "behaviorDetectionCount",
    "alertCount",
    "evaluationCount",
    "evaluationPassCount",
    "evaluationFailCount",
    "qualityScore"
  ];
  if (before.kind === "dataset" || after.kind === "dataset") {
    numericKeys.unshift("itemCount", "sessionCount");
  }
  const deltas = {};
  for (const key of numericKeys) {
    if (before[key] != null || after[key] != null) {
      deltas[key] = { before: before[key] || 0, after: after[key] || 0, delta: numericDelta(after[key], before[key]) };
    }
  }
  return {
    before,
    after,
    deltas,
    spanTypeDelta: objectDelta(after.spanTypes, before.spanTypes),
    spanStatusDelta: objectDelta(after.spanStatuses, before.spanStatuses),
    behaviorDelta: objectDelta(after.behaviors, before.behaviors),
    alertDelta: objectDelta(after.alerts, before.alerts),
    judgeDelta: objectDelta(after.judges, before.judges),
    regressions: inferRegressions(deltas, before, after)
  };
}

function inferRegressions(deltas, before, after) {
  const out = [];
  if (deltas.errorSpanCount && deltas.errorSpanCount.delta > 0) out.push({ kind: "errors_increased", delta: deltas.errorSpanCount.delta });
  if (deltas.behaviorDetectionCount && deltas.behaviorDetectionCount.delta > 0) out.push({ kind: "behavior_detections_increased", delta: deltas.behaviorDetectionCount.delta });
  if (deltas.alertCount && deltas.alertCount.delta > 0) out.push({ kind: "alerts_increased", delta: deltas.alertCount.delta });
  if (before.qualityScore != null && after.qualityScore != null && after.qualityScore < before.qualityScore) {
    out.push({ kind: "quality_score_dropped", delta: after.qualityScore - before.qualityScore });
  }
  return out;
}

function compareSessions(store, beforeSessionId, afterSessionId) {
  return {
    kind: "session_comparison",
    beforeId: beforeSessionId,
    afterId: afterSessionId,
    ...compareMetrics(sessionMetrics(store, beforeSessionId), sessionMetrics(store, afterSessionId))
  };
}

function compareDatasets(store, beforeDatasetId, afterDatasetId) {
  return {
    kind: "dataset_comparison",
    beforeId: beforeDatasetId,
    afterId: afterDatasetId,
    ...compareMetrics(datasetMetrics(store, beforeDatasetId), datasetMetrics(store, afterDatasetId))
  };
}

module.exports = {
  compareDatasets,
  compareSessions,
  datasetMetrics,
  sessionMetrics
};
