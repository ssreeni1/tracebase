"use strict";

const fs = require("node:fs");
const path = require("node:path");

function normalizeAgent(agent = "codex") {
  const value = String(agent || "codex").toLowerCase();
  if (value !== "codex" && value !== "claude") throw new Error("--agent must be codex or claude.");
  return value;
}

function instructionTemplate(agent = "codex") {
  agent = normalizeAgent(agent);
  const name = agent === "claude" ? "Claude Code" : "Codex";
  return `# Tracebase Agent Instructions

You may use Tracebase to capture and inspect local agent traces for this project.

## Privacy Boundary

- Use only transcript-visible events, tool inputs/results, local metadata, and provider-emitted summaries.
- Do not claim hidden/private chain-of-thought was captured.
- Do not use network interception to collect trace content.
- Treat raw exports as sensitive local data.

## Useful Commands

- Initialize local store: \`tracebase init\`
- Import existing ${name} traces: \`tracebase import --provider ${agent === "claude" ? "claude" : "codex"}\`
- Watch local transcript files: \`tracebase watch\`
- Start viewer: \`tracebase serve --port 18427\`
- Check health: \`tracebase health\`
- Search events: \`tracebase search "query"\`
- Summarize a session: \`tracebase summarize --session-id SESSION_ID --runner ${agent === "claude" ? "claude" : "codex"}\`
- Export traces: \`tracebase export --session-id SESSION_ID --out tracebase-export.zip\`

Ask the user before installing hooks, persistent watchers, or writing project instruction files.
`;
}

function bootstrapText(options = {}) {
  const agent = normalizeAgent(options.agent || "codex");
  return [
    "# Tracebase Bootstrap",
    "",
    "Run these commands from the Tracebase checkout or after installing the npm package:",
    "",
    "```sh",
    "tracebase init",
    `tracebase import --provider ${agent === "claude" ? "claude" : "codex"}`,
    "tracebase health",
    "tracebase serve --port 18427",
    "```",
    "",
    "Optional always-on capture:",
    "",
    "```sh",
    "# macOS launchd",
    "tracebase watch-install",
    "",
    "# any platform foreground process",
    "tracebase watch",
    "```",
    "",
    instructionTemplate(agent)
  ].join("\n");
}

function installInstructions(options = {}) {
  if (!options.target) throw new Error("install-instructions requires --target PATH.");
  const agent = normalizeAgent(options.agent || "codex");
  const file = path.resolve(options.target);
  if (fs.existsSync(file)) {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Refusing to write instruction file through symlink: ${file}`);
    if (!options.force) throw new Error(`Refusing to overwrite existing file without --force: ${file}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, instructionTemplate(agent), { mode: 0o600, flag: options.force ? "w" : "wx" });
  return { target: file, agent };
}

module.exports = {
  bootstrapText,
  installInstructions,
  instructionTemplate,
  normalizeAgent
};
