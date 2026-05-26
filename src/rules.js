"use strict";

const crypto = require("node:crypto");

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function slug(value) {
  return String(value || "rule")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "rule";
}

function makeRuleSpec(input = {}) {
  if (!input.name) throw new Error("Rule name is required.");
  if (!input.behaviorId) throw new Error("Rule behaviorId is required.");
  const createdAt = input.createdAt || nowIso();
  return {
    id: input.id || `rule:${slug(input.name)}`,
    name: input.name,
    description: input.description || null,
    behaviorId: input.behaviorId,
    minCount: Number(input.minCount || 1),
    enabled: input.enabled == null ? true : Boolean(input.enabled),
    createdAt,
    updatedAt: createdAt
  };
}

function evaluateRule(store, ruleId, options = {}) {
  const rule = store.getRule(ruleId);
  if (!rule) throw new Error(`Unknown rule: ${ruleId}`);
  if (!rule.enabled) return { rule, triggered: false, count: 0, alert: null };
  const results = store.listBehaviorResults({
    behaviorId: rule.behaviorId,
    traceId: options.traceId,
    sessionId: options.sessionId,
    limit: options.limit || 50000
  });
  const count = results.length;
  const triggered = count >= Number(rule.minCount || 1);
  if (!triggered) return { rule, triggered, count, alert: null };
  const createdAt = nowIso();
  const alert = {
    id: hash(`${rule.id}:${rule.behaviorId}:${options.traceId || ""}:${options.sessionId || ""}:${count}`),
    ruleId: rule.id,
    behaviorId: rule.behaviorId,
    traceId: options.traceId || null,
    sessionId: options.sessionId || null,
    severity: options.severity || "warning",
    message: `${rule.name} triggered with ${count} behavior detection${count === 1 ? "" : "s"}.`,
    count,
    createdAt
  };
  store.recordAlert(alert);
  return { rule, triggered, count, alert };
}

module.exports = {
  evaluateRule,
  makeRuleSpec
};
