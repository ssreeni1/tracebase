"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const { extractStructured } = require("./structured");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (value.content) return asText(value.content);
    if (value.message) return asText(value.message);
  }
  return JSON.stringify(value);
}

function claudeProjectFromPath(sourcePath) {
  const parts = sourcePath.split(path.sep);
  const projectsIndex = parts.lastIndexOf("projects");
  if (projectsIndex >= 0 && parts[projectsIndex + 1]) return parts[projectsIndex + 1];
  return null;
}

function inferType(provider, raw) {
  const candidates = [
    raw.hook_event_name,
    raw.payload && raw.payload.type,
    raw.type,
    raw.event,
    raw.message && raw.message.role,
    raw.tool_name && "tool_call"
  ].filter(Boolean);
  if (!candidates.length) return `${provider}_event`;
  return String(candidates[0]);
}

function inferRole(raw) {
  if (raw.role) return raw.role;
  if (raw.message && raw.message.role) return raw.message.role;
  if (raw.payload && raw.payload.role) return raw.payload.role;
  if (raw.payload && raw.payload.type === "user_message") return "user";
  if (raw.payload && raw.payload.type === "agent_message") return "assistant";
  if (raw.type === "user" || raw.type === "assistant" || raw.type === "system") return raw.type;
  return null;
}

function inferTimestamp(raw) {
  return (
    raw.timestamp ||
    raw.created_at ||
    raw.createdAt ||
    raw.time ||
    raw.datetime ||
    (raw.payload && raw.payload.timestamp) ||
    new Date().toISOString()
  );
}

function summarize(raw) {
  if (raw.tool_name) return `${raw.hook_event_name || "tool"} ${raw.tool_name}`;
  if (raw.cwd && raw.hook_event_name) return `${raw.hook_event_name} in ${raw.cwd}`;
  if (raw.type === "session_meta" && raw.payload && raw.payload.cwd) return `session in ${raw.payload.cwd}`;
  if (raw.payload && typeof raw.payload.message === "string") return raw.payload.message.replace(/\s+/g, " ").trim().slice(0, 240);
  if (raw.payload && typeof raw.payload.last_agent_message === "string") return raw.payload.last_agent_message.replace(/\s+/g, " ").trim().slice(0, 240);
  if (raw.payload && raw.payload.role === "user") return asText(raw.payload.content).replace(/\s+/g, " ").trim().slice(0, 240);
  if (raw.payload && raw.payload.type === "user_message") return asText(raw.payload.message).replace(/\s+/g, " ").trim().slice(0, 240);
  if (raw.payload && raw.payload.type === "agent_message") return asText(raw.payload.message).replace(/\s+/g, " ").trim().slice(0, 240);
  if (raw.payload && raw.payload.role === "assistant") return asText(raw.payload.content).replace(/\s+/g, " ").trim().slice(0, 240);
  const text = asText(raw.message || raw.content || raw.text || raw.prompt || raw.tool_input || raw.tool_response || raw);
  return text.replace(/\s+/g, " ").trim().slice(0, 240) || "event";
}

function inferSessionId(sourcePath, raw) {
  return (
    raw.session_id ||
    raw.sessionId ||
    raw.conversation_id ||
    raw.conversationId ||
    (raw.payload && (raw.payload.session_id || raw.payload.sessionId || raw.payload.id)) ||
    path.basename(sourcePath || "session", ".jsonl")
  );
}

function inferCwd(raw) {
  return raw.cwd || (raw.payload && raw.payload.cwd) || null;
}

function normalizeEvent(provider, sourcePath, offset, raw) {
  const sessionId = inferSessionId(sourcePath, raw);
  const taskId = raw.task_id || raw.taskId || sessionId;
  const type = inferType(provider, raw);
  const role = inferRole(raw);
  const cwd = inferCwd(raw);
  const searchPayload = {
    type,
    role,
    cwd,
    message: raw.message,
    content: raw.content,
    text: raw.text,
    prompt: raw.prompt,
    payload_type: raw.payload && raw.payload.type,
    payload_role: raw.payload && raw.payload.role,
    payload_message: raw.payload && raw.payload.message,
    payload_content: raw.payload && raw.payload.content,
    payload_last_agent_message: raw.payload && raw.payload.last_agent_message,
    tool_name: raw.tool_name,
    tool_input: raw.tool_input,
    tool_response: raw.tool_response,
    error: raw.error
  };
  const base = {
    id: sha256(JSON.stringify([provider, sourcePath, offset, raw.uuid || raw.id || raw.session_id || raw.timestamp, raw])),
    provider,
    sourcePath,
    offset,
    sessionId,
    taskId,
    type,
    role,
    cwd,
    timestamp: inferTimestamp(raw),
    summary: summarize(raw),
    searchText: searchPayload,
    raw
  };
  return {
    ...base,
    structured: extractStructured(raw, base)
  };
}

function sessionFromSource(provider, sourcePath, firstEvent, lastEvent, count) {
  const id = firstEvent ? firstEvent.sessionId : path.basename(sourcePath, ".jsonl");
  return {
    id,
    provider,
    sourcePath,
    cwd: (lastEvent && lastEvent.cwd) || (firstEvent && firstEvent.cwd) || null,
    startedAt: firstEvent ? firstEvent.timestamp : null,
    endedAt: lastEvent ? lastEvent.timestamp : null,
    eventCount: count,
    project: provider === "claude" ? claudeProjectFromPath(sourcePath) : null
  };
}

module.exports = {
  normalizeEvent,
  sessionFromSource,
  asText
};
