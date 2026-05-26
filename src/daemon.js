"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const LABEL = "io.tracebase.watch";
const LEGACY_LABELS = ["com.saneel.local-agent-traces.watch"];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function launchAgentsDir() {
  return path.join(os.homedir(), "Library", "LaunchAgents");
}

function plistPath(label = LABEL) {
  return path.join(launchAgentsDir(), `${label}.plist`);
}

function logDir(traceHome = path.join(os.homedir(), ".traces")) {
  const dir = path.join(traceHome, "logs");
  ensureDir(dir);
  return dir;
}

function xmlEscape(value) {
  return String(value).replace(/[<>&'"]/g, (ch) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;"
  })[ch]);
}

function runLaunchctl(args, options = {}) {
  const result = spawnSync("launchctl", args, { encoding: "utf8", timeout: Number(options.timeoutMs || 10000) });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || null,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error && result.error.message || ""
  };
}

function userDomain() {
  return `gui/${process.getuid ? process.getuid() : spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim()}`;
}

function makePlist(options = {}) {
  const root = path.resolve(__dirname, "..");
  const node = process.execPath;
  const traceHome = path.resolve(options.traceHome || path.join(os.homedir(), ".traces"));
  const intervalMs = String(options.intervalMs || 10000);
  const since = options.since || "";
  const args = [
    node,
    path.join(root, "bin", "traces.js"),
    "watch",
    "--interval-ms",
    intervalMs
  ];
  if (since) args.push("--since", since);
  if (options.provider) args.push("--provider", options.provider);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TRACE_HOME</key>
    <string>${xmlEscape(traceHome)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir(traceHome), "watch.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir(traceHome), "watch.err"))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

function installWatch(options = {}) {
  if (process.platform !== "darwin") {
    throw new Error("watch daemon install currently supports macOS launchd only. Use `traces watch` directly on this platform.");
  }
  ensureDir(launchAgentsDir());
  const file = plistPath();
  for (const legacyLabel of LEGACY_LABELS) {
    const legacyFile = plistPath(legacyLabel);
    if (fs.existsSync(legacyFile)) runLaunchctl(["bootout", userDomain(), legacyFile]);
  }
  if (fs.existsSync(file)) {
    runLaunchctl(["bootout", userDomain(), file]);
  }
  fs.writeFileSync(file, makePlist(options), { mode: 0o600 });
  const result = runLaunchctl(["bootstrap", userDomain(), file]);
  if (!result.ok) throw new Error(result.stderr || result.stdout || `launchctl bootstrap failed with ${result.status}`);
  const traceHome = path.resolve(options.traceHome || path.join(os.homedir(), ".traces"));
  return { label: LABEL, plistPath: file, logPath: path.join(logDir(traceHome), "watch.log"), errorLogPath: path.join(logDir(traceHome), "watch.err") };
}

function uninstallWatch() {
  const file = plistPath();
  const bootout = fs.existsSync(file) ? runLaunchctl(["bootout", userDomain(), file]) : runLaunchctl(["bootout", userDomain(), LABEL]);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const legacy = [];
  for (const legacyLabel of LEGACY_LABELS) {
    const legacyFile = plistPath(legacyLabel);
    const result = fs.existsSync(legacyFile) ? runLaunchctl(["bootout", userDomain(), legacyFile]) : runLaunchctl(["bootout", userDomain(), legacyLabel]);
    if (fs.existsSync(legacyFile)) fs.unlinkSync(legacyFile);
    legacy.push({ label: legacyLabel, removed: true, bootout: result });
  }
  return { label: LABEL, removed: true, bootout, legacy };
}

function extractTraceHome(detail) {
  const match = String(detail || "").match(/\bTRACE_HOME => ([^\n]+)/);
  return match ? match[1].trim() : null;
}

function launchdStatus(label) {
  const result = runLaunchctl(["print", `${userDomain()}/${label}`], { timeoutMs: 2000 });
  const text = `${result.stdout}\n${result.stderr}`;
  const pidMatch = text.match(/\bpid = (\d+)/);
  return { label, result, text, pid: pidMatch ? Number(pidMatch[1]) : null };
}

function watchRecommendations(status = {}) {
  const recommendations = [];
  if (status.supported === false) {
    recommendations.push("Persistent watcher install is macOS launchd-only; run `tracebase watch` under your preferred process manager.");
    return recommendations;
  }
  if (status.legacyLabelUsed) {
    recommendations.push(`Legacy watcher label detected. Run \`tracebase watch-install\` to migrate to ${LABEL}, or \`tracebase watch-uninstall\` to remove it.`);
  }
  if (status.storeMatches === false) {
    recommendations.push(`Watcher is using ${status.configuredTraceHome || "another TRACE_HOME"} but this command is checking ${status.expectedTraceHome || "the current TRACE_HOME"}. Reinstall with \`TRACE_HOME="${status.expectedTraceHome || "$TRACE_HOME"}" tracebase watch-install\`.`);
  }
  if (!status.running) {
    recommendations.push("Persistent watcher is not running. Run `tracebase watch-install` on macOS or `tracebase watch` in a foreground process.");
  }
  return recommendations;
}

function watchStatus(options = {}) {
  if (process.platform !== "darwin") {
    const status = { label: LABEL, supported: false, running: false };
    return { ...status, recommendations: watchRecommendations(status) };
  }
  const primary = launchdStatus(LABEL);
  const status = primary.result.ok ? primary : LEGACY_LABELS.map(launchdStatus).find((item) => item.result.ok) || primary;
  const result = status.result;
  const text = status.text;
  const configuredTraceHome = extractTraceHome(text);
  const expectedTraceHome = options.traceHome ? path.resolve(options.traceHome) : null;
  const statusTraceHome = expectedTraceHome || configuredTraceHome || path.join(os.homedir(), ".traces");
  const storeMatches = !expectedTraceHome || !configuredTraceHome ? null : path.resolve(configuredTraceHome) === expectedTraceHome;
  const payload = {
    label: status.label,
    currentLabel: LABEL,
    legacyLabelUsed: status.label !== LABEL,
    supported: true,
    running: result.ok && /state = running/.test(text),
    pid: status.pid,
    plistPath: plistPath(status.label),
    installed: fs.existsSync(plistPath(status.label)),
    configuredTraceHome,
    expectedTraceHome,
    storeMatches,
    runningForExpectedStore: result.ok && /state = running/.test(text) && storeMatches !== false,
    logPath: path.join(logDir(statusTraceHome), "watch.log"),
    errorLogPath: path.join(logDir(statusTraceHome), "watch.err"),
    legacyLabels: LEGACY_LABELS,
    detail: result.ok ? result.stdout : result.stderr
  };
  return { ...payload, recommendations: watchRecommendations(payload) };
}

module.exports = {
  LABEL,
  makePlist,
  installWatch,
  uninstallWatch,
  watchRecommendations,
  watchStatus
};
