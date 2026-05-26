"use strict";

const SECRET_PATTERNS = [
  { name: "anthropic_key", pattern: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g },
  { name: "openai_key", pattern: /\bsk-(?!ant-)[A-Za-z0-9_\-]{20,}\b/g },
  { name: "private_key_block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "github_fine_grained_token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "authorization_bearer", pattern: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi },
  { name: "url_credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\/\s:@]+:[^\/\s@]+@/gi },
  { name: "assignment_secret", pattern: /\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*|password|secret|token|api[_-]?key)\s*[:=]\s*(?:"[^"\n]{8,}"|'[^'\n]{8,}'|[^\s'"]{8,})/gi }
];

function redactText(value) {
  if (value == null) return "";
  let text = String(value);
  const hits = [];
  for (const item of SECRET_PATTERNS) {
    text = text.replace(item.pattern, (match) => {
      hits.push({ type: item.name, length: match.length });
      return `[REDACTED:${item.name}]`;
    });
  }
  return { text, hits };
}

function compactText(value, limit = 5000) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const redacted = redactText(raw || "");
  if (redacted.text.length <= limit) return redacted;
  return {
    text: redacted.text.slice(0, limit) + "\n[TRUNCATED]",
    hits: redacted.hits
  };
}

module.exports = {
  redactText,
  compactText
};
