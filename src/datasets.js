"use strict";

const crypto = require("node:crypto");

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function slug(value) {
  return String(value || "dataset")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "dataset";
}

function makeDatasetSpec(input = {}) {
  if (!input.name) throw new Error("Dataset name is required.");
  const createdAt = input.createdAt || nowIso();
  return {
    id: input.id || `dataset:${slug(input.name)}`,
    name: input.name,
    description: input.description || null,
    kind: input.kind || "trace",
    createdAt,
    updatedAt: createdAt
  };
}

function makeBucketSpec(input = {}) {
  if (!input.name) throw new Error("Bucket name is required.");
  if (!input.datasetId) throw new Error("Bucket datasetId is required.");
  if (!input.behaviorId) throw new Error("Bucket behaviorId is required.");
  const createdAt = input.createdAt || nowIso();
  return {
    id: input.id || `bucket:${slug(input.name)}`,
    name: input.name,
    datasetId: input.datasetId,
    behaviorId: input.behaviorId,
    description: input.description || null,
    enabled: input.enabled == null ? true : Boolean(input.enabled),
    createdAt,
    updatedAt: createdAt
  };
}

function datasetItemFromBehaviorResult(datasetId, result, source = "bucket") {
  return {
    id: hash(`${datasetId}:${result.traceId || ""}:${result.spanId || ""}:${result.behaviorId || ""}`),
    datasetId,
    traceId: result.traceId || null,
    spanId: result.spanId || null,
    sessionId: result.sessionId || null,
    source,
    sourceId: result.id || result.evaluationId || null,
    label: result.label || null,
    note: result.reason || null,
    createdAt: nowIso()
  };
}

function runBucket(store, bucketId, options = {}) {
  const bucket = store.getBucket(bucketId);
  if (!bucket) throw new Error(`Unknown bucket: ${bucketId}`);
  if (!bucket.enabled) return { bucket, added: 0, scanned: 0 };
  const results = store.listBehaviorResults({
    behaviorId: bucket.behaviorId,
    sessionId: options.sessionId,
    traceId: options.traceId,
    limit: options.limit || 50000
  });
  let added = 0;
  for (const result of results) {
    added += store.addDatasetItem(datasetItemFromBehaviorResult(bucket.datasetId, result, `bucket:${bucket.id}`));
  }
  return { bucket, added, scanned: results.length };
}

module.exports = {
  datasetItemFromBehaviorResult,
  makeBucketSpec,
  makeDatasetSpec,
  runBucket
};
