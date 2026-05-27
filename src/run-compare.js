"use strict";

function bySessionId(rows, id) {
  return rows.find((row) => row.id === id || row.sessionId === id) || null;
}

function analyzed(row) {
  return row && row.analyzedAt;
}

function annotationCounts(rows) {
  return rows.reduce((acc, row) => {
    acc[row.kind] = (acc[row.kind] || 0) + 1;
    return acc;
  }, {});
}

function numericDelta(base, target, key) {
  return {
    base: Number(base && base[key] || 0),
    target: Number(target && target[key] || 0),
    delta: Number(target && target[key] || 0) - Number(base && base[key] || 0)
  };
}

function buildRunComparison(store, baseSessionId, targetSessionId) {
  if (!baseSessionId || !targetSessionId) throw new Error("baseSessionId and targetSessionId are required.");
  const metrics = store.listSessionMetrics({ limit: 10000 });
  const sessions = store.listSessions({ limit: 10000 });
  const base = bySessionId(metrics, baseSessionId);
  const target = bySessionId(metrics, targetSessionId);
  if (!analyzed(base)) throw new Error(`No analyzed metrics for base session: ${baseSessionId}`);
  if (!analyzed(target)) throw new Error(`No analyzed metrics for target session: ${targetSessionId}`);
  const baseAnnotations = store.listAnnotations({ sessionId: baseSessionId, limit: 10000 });
  const targetAnnotations = store.listAnnotations({ sessionId: targetSessionId, limit: 10000 });
  const keys = [
    "qualityScore",
    "efficiencyScore",
    "riskScore",
    "totalTokens",
    "failureCount",
    "contextWasteCount",
    "repeatedCommandCount",
    "largeOutputCount",
    "filesTouchedCount",
    "redactionCount"
  ];
  return {
    base: { session: bySessionId(sessions, baseSessionId), metrics: base, annotationCounts: annotationCounts(baseAnnotations) },
    target: { session: bySessionId(sessions, targetSessionId), metrics: target, annotationCounts: annotationCounts(targetAnnotations) },
    deltas: Object.fromEntries(keys.map((key) => [key, numericDelta(base, target, key)])),
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  buildRunComparison
};
