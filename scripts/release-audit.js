"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PERSONAL_NAME_PATTERN = new RegExp([
  ["sa", "neel"].join(""),
  ["local", "agent", "traces"].join("-"),
  ["Local", "Agent", "Traces"].join(" ")
].join("|"));
const UNRESOLVED_MARKER_PATTERN = new RegExp(["TO", "DO|FIX", "ME"].join(""));
const failures = [];

function fail(message) {
  failures.push(message);
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

function exists(file) {
  return fs.existsSync(path.join(ROOT, file));
}

function assertIncludes(file, needle, reason) {
  const text = read(file);
  if (!text.includes(needle)) fail(`${file} missing ${reason || needle}`);
}

function run(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    input: options.input || undefined
  });
}

function hasStackTrace(output) {
  return /\n\s+at\s/.test(String(output || ""));
}

function auditPackage() {
  const pkg = JSON.parse(read("package.json"));
  if (pkg.name !== "tracebase-local") fail("package name must be tracebase-local because tracebase is already published on npm");
  if (pkg.private !== false) fail("package private must be false");
  if (pkg.license !== "MIT") fail("package license must be MIT");
  if (pkg.main !== "index.js") fail("package must expose the documented CommonJS API at index.js");
  if (!pkg.engines || pkg.engines.node !== ">=24") fail("package must require Node >=24");
  for (const bin of ["tracebase", "traces", "tcodex", "tclaude"]) {
    const rel = pkg.bin && pkg.bin[bin];
    if (!rel) {
      fail(`missing bin mapping for ${bin}`);
      continue;
    }
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) {
      fail(`bin target missing for ${bin}: ${rel}`);
      continue;
    }
    const stat = fs.statSync(file);
    if ((stat.mode & 0o111) === 0) fail(`bin target is not executable: ${rel}`);
    if (!fs.readFileSync(file, "utf8").startsWith("#!/usr/bin/env node")) fail(`bin target missing node shebang: ${rel}`);
  }
  for (const file of ["README.md", "SECURITY.md", "ARCHITECTURE.md", "CONTRIBUTING.md", "TESTING.md", "LICENSE"]) {
    if (!exists(file)) fail(`missing required release document: ${file}`);
  }
  for (const entry of ["index.js", "bin/", "dist/", "src/", "templates/"]) {
    if (!pkg.files || !pkg.files.includes(entry)) fail(`package files missing ${entry}`);
  }
  const apiSource = read("index.js");
  for (const symbol of ["TraceStore", "createServer", "buildExportZip", "redactText"]) {
    if (!apiSource.includes(symbol)) fail(`index.js missing documented API export ${symbol}`);
  }
  if (pkg.files && pkg.files.includes("scripts/")) {
    fail("published package must not include repo-only release/test scripts");
  }
  if (!pkg.files || !pkg.files.includes("!src/ui/")) {
    fail("published package must exclude frontend source; runtime serves built dist assets");
  }
  if (!pkg.scripts || !String(pkg.scripts.test || "").includes("audit:release")) {
    fail("npm test must include audit:release");
  }
  if (!pkg.scripts || !String(pkg.scripts.test || "").includes("test:install")) {
    fail("npm test must include test:install");
  }
  if (!pkg.scripts || !String(pkg.scripts.test || "").includes("test:stress")) {
    fail("npm test must include the concurrent storage stress gate");
  }
  if (!pkg.scripts || !/--writers\s+2/.test(String(pkg.scripts["test:stress"] || ""))) {
    fail("npm run test:stress must exercise concurrent writers");
  }
  if (!pkg.scripts || !String(pkg.scripts["test:ui"] || "").includes("test/ui-smoke.js")) {
    fail("npm test:ui must run the built dashboard runtime smoke");
  }
  const installSmoke = read("scripts/package-install-smoke.js");
  if (!installSmoke.includes("install-instructions") || !installSmoke.includes("Refusing to overwrite")) {
    fail("package install smoke must verify installed instruction-file flow");
  }
  const bootstrapSource = read("src/bootstrap.js");
  if (!bootstrapSource.includes("isSymbolicLink()") || !bootstrapSource.includes("flag: options.force ? \"w\" : \"wx\"")) {
    fail("instruction-file installer must refuse symlinks and use exclusive create by default");
  }
  for (const wrapper of ["bin/tcodex.js", "bin/tclaude.js"]) {
    if (!read(wrapper).includes("../src/cli-runner")) fail(`${wrapper} must use the shared clean CLI error renderer`);
  }
  if (!read("src/wrap.js").includes("child.on(\"error\"")) {
    fail("wrapped agent launcher must handle missing agent executables cleanly");
  }
  if (!installSmoke.includes("PACKAGE_NAME, \"scripts\"")) {
    fail("package install smoke must verify repo-only scripts are absent from the installed package name");
  }
  if (!installSmoke.includes("missingWrappedAgent") || !installSmoke.includes("wrapper printed a stack trace")) {
    fail("package install smoke must verify installed tclaude/tcodex wrapper error behavior");
  }
  if (!installSmoke.includes("PACKAGE_NAME, \"src\", \"ui\"")) {
    fail("package install smoke must verify frontend source is absent from the installed package name");
  }
  if (!installSmoke.includes("installed package API missing")) {
    fail("package install smoke must verify the installed CommonJS API surface");
  }
}

function auditDocs() {
  assertIncludes("README.md", "Node.js 24 or newer", "Node 24 requirement");
  assertIncludes("README.md", "npm install -g tracebase-local", "available npm package install command");
  assertIncludes("README.md", "TESTING.md", "local testing guide link");
  assertIncludes("README.md", "The npm package is `tracebase-local`", "npm package versus binary name note");
  assertIncludes("README.md", "tracebase bootstrap --agent codex", "Codex bootstrap flow");
  assertIncludes("README.md", "tracebase bootstrap --agent claude", "Claude bootstrap flow");
  assertIncludes("README.md", "tracebase install-instructions", "instruction install flow");
  assertIncludes("README.md", "tracebase watch-install", "always-on capture flow");
  assertIncludes("README.md", "tracebase serve", "viewer command");
  assertIncludes("README.md", "tracebase agent", "live intake command");
  assertIncludes("README.md", "Codex/Claude CLI availability", "doctor runner availability diagnostics");
  assertIncludes("README.md", "traces mcp --allow-write", "MCP write opt-in");
  assertIncludes("README.md", "## Programmatic API", "programmatic extension API docs");
  assertIncludes("README.md", "require(\"tracebase-local\")", "CommonJS API usage docs");
  assertIncludes("README.md", "browser-supplied command overrides are ignored", "summary runner command override boundary");
  assertIncludes("README.md", "x-tracebase-raw-export", "raw export guard");
  assertIncludes("README.md", "tracebase export --session-id ID --stdout > trace.zip", "explicit stdout export flow");
  assertIncludes("README.md", "## Additional CLI Utilities", "general CLI utilities section");
  assertIncludes("SECURITY.md", "127.0.0.1", "local bind security model");
  assertIncludes("SECURITY.md", "Content-Security-Policy", "dashboard CSP security model");
  assertIncludes("SECURITY.md", "Origin", "browser origin policy");
  assertIncludes("SECURITY.md", "TRACEBASE_ALLOW_RAW_BLOB_API=1", "raw blob opt-in");
  assertIncludes("SECURITY.md", "browser requests cannot override the executable or arguments", "local summary runner security boundary");
  assertIncludes("SECURITY.md", "TRACEBASE_MCP_ALLOW_WRITE=1", "MCP write opt-in");
  assertIncludes("SECURITY.md", "reject undeclared arguments", "MCP schema smuggling guard");
  assertIncludes("ARCHITECTURE.md", "read-only stdio MCP server", "MCP read-only architecture note");
  assertIncludes("ARCHITECTURE.md", "traces mcp --allow-write", "MCP write opt-in architecture note");
  assertIncludes("README.md", "npm run test:stress", "concurrent storage stress gate");
  assertIncludes("CONTRIBUTING.md", "npm test", "contributor test gate");
  assertIncludes("CONTRIBUTING.md", "npm run test:stress", "contributor stress test gate");
  assertIncludes("TESTING.md", "npm test", "full local release test command");
  assertIncludes("TESTING.md", "Manual Dashboard Workflow", "manual dashboard test guide");
  assertIncludes("TESTING.md", "Summary Runner Workflow", "summary runner test guide");
  assertIncludes("TESTING.md", "Package Install Verification", "package install test guide");
  assertIncludes("SECURITY.md", "npm test", "security release checklist full test gate");
  assertIncludes("SECURITY.md", "npm run test:stress", "security release checklist stress gate");
  assertIncludes("SECURITY.md", "npm audit --omit=dev", "security release checklist dependency audit");
  assertIncludes(".github/workflows/ci.yml", "node-version: \"24\"", "CI Node 24 gate");
  assertIncludes(".github/workflows/ci.yml", "npm test", "CI full test gate");
  assertIncludes(".github/workflows/ci.yml", "npm audit --omit=dev", "CI dependency audit gate");
}

function auditBuildArtifacts() {
  if (!exists("dist/index.html")) fail("dist/index.html missing; run npm run build before packaging");
  const assetsDir = path.join(ROOT, "dist", "assets");
  const assets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  if (!assets.some((name) => name.endsWith(".js"))) fail("built UI JS asset missing");
  if (!assets.some((name) => name.endsWith(".css"))) fail("built UI CSS asset missing");
  const uiCss = read("src/ui/styles.css");
  const uiMain = read("src/ui/main.jsx");
  const serverSource = read("src/server.js");
  if (!serverSource.includes("\"content-security-policy\"") || !serverSource.includes("script-src 'self'") || !serverSource.includes("object-src 'none'")) {
    fail("server must send a restrictive Content-Security-Policy");
  }
  if (serverSource.includes("<script>") || serverSource.includes("<style>")) {
    fail("server fallback HTML must remain CSP-compatible and not include inline script/style");
  }
  if (!serverSource.includes("Dashboard Not Built") || !serverSource.includes("urlPath.startsWith(\"/assets/\")")) {
    fail("server must report missing dashboard assets clearly and 404 missing asset URLs");
  }
  if (!/@media \(max-width: 980px\)/.test(uiCss)) fail("UI CSS missing mobile breakpoint");
  if (!/\.topbar\s*\{[^}]*height:\s*auto/.test(uiCss)) fail("mobile UI must let the topbar grow without overlap");
  if (!/\.sessions\s*\{[^}]*max-height:\s*44vh/.test(uiCss)) fail("mobile UI must bound the session picker height");
  if (!uiMain.includes("filtersRef.current") || !uiMain.includes("activeRef.current")) {
    fail("UI auto-refresh must preserve the current filter and selected-session state");
  }
  if (!uiMain.includes("nextSessions.some((session) => session.id === nextActive)")) {
    fail("UI filtering must not keep a selected session that is absent from the filtered session list");
  }
  if (!uiMain.includes("disabled={!active || busy}") || !uiMain.includes("disabled={!active || !rawUnlocked || busy}")) {
    fail("UI session export actions must be disabled without an active session");
  }
  if (!uiMain.includes("summaryUnavailable") || !uiMain.includes("was not found on this machine")) {
    fail("UI must disable summary generation when the selected local CLI runner is unavailable");
  }
  if (!uiMain.includes("/api/summary-runners") || !uiMain.includes("Proxy this session packet to the local")) {
    fail("UI must discover local summary CLI runners and route summary generation through the local server");
  }
}

function auditCliFlows() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracebase-release-audit-"));
  const env = { TRACE_HOME: tmp };
  const help = run(["bin/tracebase.js", "--help"], { env });
  if (help.status !== 0 || !help.stdout.includes("Usage: tracebase")) fail("tracebase --help failed");
  if (!help.stdout.includes("Common filters:") || !help.stdout.includes("--session-id ID       Limit commands that accept sessions to one session")) {
    fail("tracebase --help must describe --session-id as a shared command filter");
  }
  if (help.stdout.includes("For analyze")) {
    fail("tracebase --help must not reference stale analyze command wording");
  }
  for (const needle of ["Summary/export options:", "--runner codex|claude", "--out PATH", "--raw"]) {
    if (!help.stdout.includes(needle)) fail(`tracebase --help missing documented option: ${needle}`);
  }
  const bootstrap = run(["bin/tracebase.js", "bootstrap", "--agent", "codex"], { env });
  if (bootstrap.status !== 0 || !bootstrap.stdout.includes("Tracebase Agent Instructions")) fail("tracebase bootstrap --agent codex failed");
  if (/captures hidden\/private chain-of-thought|hidden\/private chain-of-thought is captured/i.test(bootstrap.stdout)) {
    fail("bootstrap text must not claim hidden reasoning capture");
  }
  const invalidBootstrap = run(["bin/tracebase.js", "bootstrap", "--agent", "shell"], { env });
  if (invalidBootstrap.status === 0 || !/--agent must be codex or claude/.test(invalidBootstrap.stderr)) {
    fail("tracebase bootstrap must reject unknown agents");
  }
  if (hasStackTrace(invalidBootstrap.stderr)) fail("tracebase errors must not print stack traces by default");
  const exportWithoutDestination = run(["bin/tracebase.js", "export", "--session-id", "missing-session"], { env });
  if (exportWithoutDestination.status === 0 || !/export requires --out PATH/.test(exportWithoutDestination.stderr)) {
    fail("tracebase export must require --out or explicit --stdout");
  }
  if (hasStackTrace(exportWithoutDestination.stderr)) fail("tracebase export error must not print stack traces by default");
  const invalidImportLimit = run(["bin/tracebase.js", "import", "--max-files", "abc"], { env });
  if (invalidImportLimit.status === 0 || !/--max-files must be an integer/.test(invalidImportLimit.stderr)) {
    fail("tracebase import must reject invalid --max-files values");
  }
  if (hasStackTrace(invalidImportLimit.stderr)) fail("tracebase import validation error must not print stack traces by default");
  const invalidPort = run(["bin/tracebase.js", "serve", "--port", "abc"], { env });
  if (invalidPort.status === 0 || !/--port must be an integer/.test(invalidPort.stderr)) {
    fail("tracebase serve must reject invalid --port values");
  }
  if (hasStackTrace(invalidPort.stderr)) fail("tracebase serve validation error must not print stack traces by default");
  const unknownCommand = run(["bin/tracebase.js", "unknown-command"], { env });
  if (unknownCommand.status === 0 || !/Unknown command: unknown-command/.test(unknownCommand.stderr)) {
    fail("tracebase must reject unknown commands");
  }
  if (hasStackTrace(unknownCommand.stderr)) fail("tracebase unknown-command error must not print stack traces by default");
  const target = path.join(tmp, "TRACEBASE_AGENT.md");
  const install = run(["bin/tracebase.js", "install-instructions", "--agent", "claude", "--target", target], { env });
  if (install.status !== 0) fail("tracebase install-instructions failed");
  if (!fs.existsSync(target) || !fs.readFileSync(target, "utf8").includes("Claude Code")) fail("installed Claude instruction file missing expected text");
  const init = run(["bin/tracebase.js", "init"], { env });
  if (init.status !== 0) fail("tracebase init failed in temporary store");
  if (!fs.existsSync(path.join(tmp, "key"))) fail("tracebase init did not create key file");
  const doctor = run(["bin/tracebase.js", "doctor"], { env: { TRACE_HOME: tmp, PATH: "" } });
  if (doctor.status !== 0) {
    fail("tracebase doctor must run even when PATH is empty");
  } else {
    const payload = JSON.parse(doctor.stdout);
    if (!Array.isArray(payload.summaryRunners) || !payload.wrappers || !Array.isArray(payload.recommendations)) {
      fail("tracebase doctor must report summary runners, wrapper targets, and recommendations");
    }
    if (!read("src/cli.js").includes("const recommendations = [...(watcher.recommendations || [])]")) {
      fail("tracebase doctor top-level recommendations must include watcher setup/migration recommendations");
    }
    if (!payload.recommendations.some((item) => item.includes("Codex CLI was not found"))) {
      fail("tracebase doctor must recommend setup when Codex CLI is unavailable");
    }
  }
  const doctorOverride = run(["bin/tracebase.js", "doctor"], { env: { TRACE_HOME: tmp, PATH: "", TRACE_CODEX_BIN: process.execPath } });
  if (doctorOverride.status !== 0) {
    fail("tracebase doctor must honor TRACE_CODEX_BIN when PATH is empty");
  } else {
    const payload = JSON.parse(doctorOverride.stdout);
    const codex = payload.summaryRunners.find((runner) => runner.runner === "codex");
    if (!codex || !codex.available || codex.command !== process.execPath || codex.overrideEnv !== "TRACE_CODEX_BIN") {
      fail("tracebase doctor summary runner diagnostics must honor TRACE_CODEX_BIN");
    }
  }
  const summarySource = read("src/summaries.js");
  if (!summarySource.includes("TRACE_${runner.toUpperCase()}_BIN")) {
    fail("summary runners must honor TRACE_CODEX_BIN/TRACE_CLAUDE_BIN overrides");
  }
  const serverSource = read("src/server.js");
  if (!serverSource.includes("summary_runner_unavailable") || !serverSource.includes("availableSummaryRunners().find")) {
    fail("summary API must reject unavailable local CLI runners before spawning");
  }
  if (serverSource.includes("path: runner.path") || serverSource.includes("command: runner.command")) {
    fail("/api/summary-runners must not expose local executable paths or commands to the browser API");
  }
}

function auditWatcherPlist() {
  const { LABEL, makePlist } = require("../src/daemon");
  const traceHome = path.join(os.tmpdir(), "tracebase-release-audit-watch");
  const plist = makePlist({ traceHome, intervalMs: 25000, provider: "codex" });
  if (!plist.includes(`<string>${LABEL}</string>`)) fail("watch plist missing public label");
  if (!plist.includes("<key>TRACE_HOME</key>")) fail("watch plist missing TRACE_HOME");
  if (!plist.includes(`<string>${traceHome}</string>`)) fail("watch plist missing configured trace home");
  if (!plist.includes(`<string>${path.join(traceHome, "logs", "watch.log")}</string>`)) fail("watch plist logs must follow TRACE_HOME");
  if (!plist.includes("<string>--provider</string>\n    <string>codex</string>")) fail("watch plist missing provider argument");
  if (!plist.includes("<string>--interval-ms</string>\n    <string>25000</string>")) fail("watch plist missing interval argument");
}

function auditSourceHygiene() {
  const allowedPersonal = new Set(["src/daemon.js"]);
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".git", ".gstack", ".npm-cache", ".playwright-mcp", "dist", "node_modules"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.(js|json|md|yml|yaml)$/.test(entry.name)) {
        files.push(full);
      }
    }
  }
  walk(ROOT);
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, "utf8");
    if (!allowedPersonal.has(rel) && PERSONAL_NAME_PATTERN.test(text)) {
      fail(`pre-release personal naming leaked into ${rel}`);
    }
    if (UNRESOLVED_MARKER_PATTERN.test(text)) fail(`unresolved work marker in ${rel}`);
  }
  const daemon = read("src/daemon.js");
  if (!daemon.includes("io.tracebase.watch")) fail("daemon missing public launchd label");
  if (!daemon.includes("LEGACY_LABELS")) fail("daemon should keep legacy watcher cleanup compatibility");
  if (/Lapdog/.test(read("README.md"))) fail("README contains stale internal observability naming");
}

auditPackage();
auditDocs();
auditBuildArtifacts();
auditCliFlows();
auditWatcherPlist();
auditSourceHygiene();

if (failures.length) {
  for (const failure of failures) console.error(`release audit failed: ${failure}`);
  process.exit(1);
}

console.log("release audit ok");
