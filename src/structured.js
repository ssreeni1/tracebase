"use strict";

const { estimateCostUsd, numberOrNull } = require("./costs");

function first(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function objectAt(value, key) {
  return value && typeof value === "object" && !Array.isArray(value) ? value[key] : undefined;
}

function nested(raw, ...keys) {
  let current = raw;
  for (const key of keys) {
    current = objectAt(current, key);
    if (current == null) return undefined;
  }
  return current;
}

function usageCandidates(raw) {
  return [
    raw && raw.usage,
    raw && raw.metrics,
    raw && raw.token_usage,
    raw && raw.tokenUsage,
    nested(raw, "message", "usage"),
    nested(raw, "response", "usage"),
    nested(raw, "payload", "usage"),
    nested(raw, "payload", "metrics")
  ].filter((item) => item && typeof item === "object");
}

function metric(raw, ...names) {
  for (const source of [raw, ...usageCandidates(raw)]) {
    for (const name of names) {
      const value = objectAt(source, name);
      if (value != null && value !== "") return numberOrNull(value);
    }
  }
  return null;
}

function toolInput(raw) {
  return first(raw.tool_input, raw.toolInput, nested(raw, "payload", "tool_input"), nested(raw, "payload", "toolInput"), raw.input);
}

function toolOutput(raw) {
  return first(raw.tool_response, raw.toolResponse, nested(raw, "payload", "tool_response"), nested(raw, "payload", "toolResponse"), raw.output);
}

function commandFrom(input) {
  if (!input) return null;
  if (typeof input === "string") return input;
  return first(input.command, input.cmd, input.shell, input.script, input.args && Array.isArray(input.args) ? input.args.join(" ") : null);
}

function textSize(value) {
  if (value == null) return null;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

function filePathFrom(input, raw) {
  if (input && typeof input === "object") {
    const value = first(input.file_path, input.filePath, input.path, input.absolute_path, input.target_file, input.targetFile);
    if (value) return String(value);
  }
  return first(raw.file_path, raw.filePath, nested(raw, "payload", "file_path"), nested(raw, "payload", "filePath"));
}

function exitCodeFrom(raw, output) {
  return first(
    raw.exit_code,
    raw.exitCode,
    raw.status_code,
    raw.statusCode,
    output && typeof output === "object" ? first(output.exit_code, output.exitCode, output.status_code, output.statusCode) : null
  );
}

function approvalState(raw) {
  const text = [
    raw.type,
    raw.event,
    raw.hook_event_name,
    raw.status,
    raw.decision,
    raw.approval,
    nested(raw, "payload", "decision"),
    nested(raw, "payload", "approval")
  ].filter(Boolean).join(" ").toLowerCase();
  if (!/approv|permission|consent|denied|rejected|accepted|allow/.test(text)) return null;
  if (/denied|reject|blocked|disallow/.test(text)) return "denied";
  if (/accepted|approved|allow|granted/.test(text)) return "approved";
  return "requested";
}

function errorKind(raw, exitCode) {
  const text = JSON.stringify({
    type: raw.type,
    status: raw.status,
    error: raw.error,
    message: raw.message,
    payload: raw.payload
  }).toLowerCase();
  const code = numberOrNull(exitCode);
  if (code != null && code !== 0) return "nonzero_exit";
  if (/permission denied/.test(text)) return "permission_denied";
  if (/timeout/.test(text)) return "timeout";
  if (/traceback|exception/.test(text)) return "exception";
  if (/error|failed|failure/.test(text)) return "error";
  return null;
}

function extractStructured(raw = {}, base = {}) {
  const input = toolInput(raw);
  const output = toolOutput(raw);
  const model = first(raw.model, raw.model_name, raw.modelName, nested(raw, "message", "model"), nested(raw, "response", "model"), nested(raw, "payload", "model"));
  const inputTokens = metric(raw, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens");
  const outputTokens = metric(raw, "output_tokens", "outputTokens", "completion_tokens", "completionTokens");
  const cacheReadTokens = metric(raw, "cache_read_tokens", "cacheReadTokens", "cached_tokens", "cachedTokens", "cache_creation_input_tokens_read");
  const cacheWriteTokens = metric(raw, "cache_write_tokens", "cacheWriteTokens", "cache_creation_input_tokens", "cacheCreationInputTokens");
  const reasoningTokens = metric(raw, "reasoning_tokens", "reasoningTokens");
  const explicitTotal = metric(raw, "total_tokens", "totalTokens");
  const totalTokens = explicitTotal == null
    ? [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens].reduce((sum, value) => sum + (numberOrNull(value) || 0), 0) || null
    : explicitTotal;
  const toolName = first(raw.tool_name, raw.toolName, nested(raw, "payload", "tool_name"), nested(raw, "payload", "toolName"), /tool/i.test(String(base.type || raw.type || "")) ? raw.name : null);
  const exitCode = exitCodeFrom(raw, output);
  const filePath = filePathFrom(input, raw);
  const estimated = estimateCostUsd({
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: metric(raw, "cost_usd", "costUsd", "cost")
  });
  const structured = {
    model: model == null ? null : String(model),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    estimatedCostUsd: estimated.costUsd,
    costConfidence: estimated.costConfidence,
    toolName: toolName == null ? null : String(toolName),
    command: commandFrom(input),
    filePath: filePath == null ? null : String(filePath),
    inputChars: textSize(input),
    outputChars: textSize(output),
    exitCode: exitCode == null ? null : numberOrNull(exitCode),
    approvalState: approvalState(raw),
    errorKind: errorKind(raw, exitCode),
    filesTouched: filePath ? [String(filePath)] : [],
    redactionCount: 0
  };
  return Object.fromEntries(Object.entries(structured).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined && value !== "";
  }));
}

module.exports = {
  extractStructured,
  first
};
