"use strict";

const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { sha256 } = require("./storage");

function parseLsof(output) {
  const lines = String(output || "").split(/\n/).filter(Boolean);
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const [command, pid, user, fd, type, device, sizeOff, node, ...nameParts] = parts;
    const name = nameParts.join(" ");
    rows.push({ command, pid: Number(pid) || pid, user, fd, type, device, sizeOff, node, name });
  }
  return rows;
}

function takeNetSnapshot(options = {}) {
  const args = ["-nP", "-iTCP"];
  if (options.established !== false) args.push("-sTCP:ESTABLISHED");
  const result = spawnSync("lsof", args, { encoding: "utf8" });
  const rows = result.status === 0 ? parseLsof(result.stdout) : [];
  return {
    artifact_kind: "network_metadata_snapshot",
    schema_version: 1,
    timestamp: new Date().toISOString(),
    host: os.hostname(),
    capture: "metadata_only",
    command: ["lsof", ...args],
    payloadCaptured: false,
    hiddenReasoningCaptured: false,
    rowCount: rows.length,
    rows,
    error: result.status === 0 ? null : {
      status: result.status,
      stderr: result.stderr || result.stdout || "lsof failed"
    }
  };
}

function makeNetSnapshotEvent(snapshot, options = {}) {
  const sessionId = options.sessionId || `net-snapshot-${snapshot.timestamp}`;
  return {
    id: sha256(JSON.stringify(["net-snapshot", sessionId, snapshot])),
    provider: "local-net",
    sourcePath: "net-snapshot",
    offset: Date.now(),
    sessionId,
    taskId: sessionId,
    type: "network_metadata_snapshot",
    role: null,
    cwd: null,
    timestamp: snapshot.timestamp,
    summary: `network metadata snapshot: ${snapshot.rowCount} TCP connections`,
    searchText: snapshot,
    raw: snapshot
  };
}

module.exports = {
  takeNetSnapshot,
  makeNetSnapshotEvent
};
