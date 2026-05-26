"use strict";

const PRICING = [
  { match: /^gpt-5\.5/i, inputPerMillion: 1.25, outputPerMillion: 10 },
  { match: /^gpt-5\.4/i, inputPerMillion: 1.1, outputPerMillion: 8.8 },
  { match: /^gpt-5\.3/i, inputPerMillion: 1, outputPerMillion: 8 },
  { match: /^gpt-5/i, inputPerMillion: 1.25, outputPerMillion: 10 },
  { match: /^gpt-4\.1-mini/i, inputPerMillion: 0.4, outputPerMillion: 1.6 },
  { match: /^gpt-4\.1/i, inputPerMillion: 2, outputPerMillion: 8 },
  { match: /^gpt-4o-mini/i, inputPerMillion: 0.15, outputPerMillion: 0.6 },
  { match: /^gpt-4o/i, inputPerMillion: 2.5, outputPerMillion: 10 },
  { match: /opus/i, inputPerMillion: 15, outputPerMillion: 75 },
  { match: /sonnet/i, inputPerMillion: 3, outputPerMillion: 15 },
  { match: /haiku/i, inputPerMillion: 0.8, outputPerMillion: 4 }
];

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pricingForModel(model) {
  const name = String(model || "").trim();
  if (!name) return null;
  return PRICING.find((row) => row.match.test(name)) || null;
}

function estimateCostUsd(metrics = {}) {
  const reported = numberOrNull(metrics.costUsd);
  if (reported != null) return { costUsd: reported, costConfidence: "provider_reported" };
  const pricing = pricingForModel(metrics.model);
  if (!pricing) return { costUsd: null, costConfidence: "unknown" };
  const input = numberOrNull(metrics.inputTokens) || 0;
  const output = numberOrNull(metrics.outputTokens) || 0;
  const cacheRead = numberOrNull(metrics.cacheReadTokens) || 0;
  const cacheWrite = numberOrNull(metrics.cacheWriteTokens) || 0;
  if (!input && !output && !cacheRead && !cacheWrite) return { costUsd: null, costConfidence: "unknown" };
  const cacheReadDiscount = 0.1;
  const cacheWriteMultiplier = 1.25;
  const costUsd = (
    input * pricing.inputPerMillion +
    output * pricing.outputPerMillion +
    cacheRead * pricing.inputPerMillion * cacheReadDiscount +
    cacheWrite * pricing.inputPerMillion * cacheWriteMultiplier
  ) / 1000000;
  return { costUsd: Number(costUsd.toFixed(8)), costConfidence: "estimated" };
}

module.exports = {
  PRICING,
  estimateCostUsd,
  numberOrNull,
  pricingForModel
};
