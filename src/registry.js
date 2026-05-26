"use strict";

const crypto = require("node:crypto");

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function slug(value) {
  return String(value || "config")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "config";
}

function makeConfigCommit(input = {}) {
  if (!input.name) throw new Error("Config name is required.");
  const content = input.content == null ? "" : String(input.content);
  const committedAt = input.committedAt || nowIso();
  const configId = input.configId || `config:${slug(input.name)}`;
  const contentHash = hash(content);
  const commitId = input.commitId || `commit:${contentHash.slice(0, 16)}`;
  return {
    config: {
      id: configId,
      name: input.name,
      kind: input.kind || "prompt",
      description: input.description || null,
      latestCommitId: commitId,
      createdAt: input.createdAt || committedAt,
      updatedAt: committedAt
    },
    commit: {
      id: commitId,
      configId,
      content,
      contentHash,
      message: input.message || null,
      metadata: input.metadata || {},
      committedAt
    },
    tags: (input.tags || []).map((tag) => ({
      configId,
      tag,
      commitId,
      updatedAt: committedAt
    }))
  };
}

module.exports = {
  makeConfigCommit
};
