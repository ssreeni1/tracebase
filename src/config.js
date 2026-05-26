"use strict";

const os = require("node:os");
const path = require("node:path");

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function getTraceHome() {
  return path.resolve(expandHome(process.env.TRACE_HOME || "~/.traces"));
}

function getDefaultSources() {
  return {
    codexSessions: path.join(os.homedir(), ".codex", "sessions"),
    claudeProjects: path.join(os.homedir(), ".claude", "projects")
  };
}

module.exports = {
  expandHome,
  getTraceHome,
  getDefaultSources
};
