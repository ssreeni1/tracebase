"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const PACKAGE_NAME = require("../package.json").name;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    input: options.input || undefined,
    timeout: options.timeout || 120000,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) {
    const rendered = [command, ...args].join(" ");
    throw new Error(`${rendered} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr || result.error && result.error.message || ""}`);
  }
  return result;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForJson(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("timed out waiting for " + url);
}

async function assertInstalledServer(bin, traceHome) {
  const port = await getFreePort();
  const child = spawn(bin, ["serve", "--port", String(port)], {
    cwd: ROOT,
    env: { ...process.env, TRACE_HOME: traceHome },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  try {
    const health = await waitForJson(`http://127.0.0.1:${port}/api/health`);
    if (!health || health.intakeEnabled !== false) throw new Error("installed server did not default to read-only intake");
    const intake = await fetch(`http://127.0.0.1:${port}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "package-smoke", provider: "test", session_id: "package-smoke", message: "should be blocked" })
    });
    if (intake.status !== 403) throw new Error(`installed server accepted intake in viewer mode: ${intake.status}`);
    const page = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
    if (!page.includes("Tracebase")) throw new Error("installed server did not serve Tracebase UI");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 1000);
    });
  }
  if (!output.includes(`127.0.0.1:${port}`)) throw new Error("installed server did not print listen URL");
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tracebase-package-smoke-"));
  const packDir = path.join(tmp, "pack");
  const installDir = path.join(tmp, "install");
  const traceHome = path.join(tmp, "trace-home");
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });

  const packed = run("npm", ["pack", "--pack-destination", packDir], {
    env: { npm_config_cache: path.join(ROOT, ".npm-cache") }
  });
  const filename = packed.stdout.trim().split(/\r?\n/).reverse().find((line) => line.trim().endsWith(".tgz"));
  if (!filename) throw new Error("npm pack output did not include a tarball filename\n" + packed.stdout);
  const tarball = path.join(packDir, filename.trim());
  if (!fs.existsSync(tarball)) throw new Error("npm pack did not create tarball: " + tarball);

  run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDir, tarball], {
    env: { npm_config_cache: path.join(ROOT, ".npm-cache") }
  });

  if (fs.existsSync(path.join(installDir, "node_modules", PACKAGE_NAME, "scripts"))) {
    throw new Error("published package should not include repo-only scripts/");
  }
  if (fs.existsSync(path.join(installDir, "node_modules", PACKAGE_NAME, "src", "ui"))) {
    throw new Error("published package should not include frontend source src/ui/");
  }
  const api = require(path.join(installDir, "node_modules", PACKAGE_NAME));
  for (const name of ["TraceStore", "createServer", "buildExportZip", "redactText"]) {
    if (typeof api[name] !== "function") throw new Error(`installed package API missing ${name}`);
  }

  const bin = path.join(installDir, "node_modules", ".bin", process.platform === "win32" ? "tracebase.cmd" : "tracebase");
  const tclaude = path.join(installDir, "node_modules", ".bin", process.platform === "win32" ? "tclaude.cmd" : "tclaude");
  const help = run(bin, ["--help"], { env: { TRACE_HOME: traceHome } });
  if (!help.stdout.includes("Usage: tracebase")) throw new Error("installed tracebase --help output missing usage");

  const init = run(bin, ["init"], { env: { TRACE_HOME: traceHome } });
  if (!init.stdout.includes(traceHome)) throw new Error("installed tracebase init did not report TRACE_HOME");
  if (!fs.existsSync(path.join(traceHome, "key"))) throw new Error("installed tracebase init did not create encrypted-store key");

  const bootstrap = run(bin, ["bootstrap", "--agent", "claude"], { env: { TRACE_HOME: traceHome } });
  if (!bootstrap.stdout.includes("Claude Code")) throw new Error("installed tracebase bootstrap did not render Claude instructions");

  const instructionTarget = path.join(tmp, "TRACEBASE_AGENT.md");
  const installInstructions = run(bin, ["install-instructions", "--agent", "codex", "--target", instructionTarget], {
    env: { TRACE_HOME: traceHome }
  });
  if (!installInstructions.stdout.includes(instructionTarget)) throw new Error("installed tracebase install-instructions did not report target");
  const instructionText = fs.readFileSync(instructionTarget, "utf8");
  if (!instructionText.includes("Tracebase Agent Instructions")) throw new Error("installed instruction file missing heading");
  if (!instructionText.includes("Codex")) throw new Error("installed instruction file missing Codex-specific text");
  const refusedOverwrite = spawnSync(bin, ["install-instructions", "--agent", "claude", "--target", instructionTarget], {
    cwd: ROOT,
    env: { ...process.env, TRACE_HOME: traceHome },
    encoding: "utf8"
  });
  if (refusedOverwrite.status === 0 || !String(refusedOverwrite.stderr).includes("Refusing to overwrite")) {
    throw new Error("installed tracebase install-instructions did not refuse overwrite by default");
  }
  const missingWrappedAgent = spawnSync(tclaude, ["--version"], {
    cwd: ROOT,
    env: { ...process.env, TRACE_HOME: traceHome, TRACE_CLAUDE_BIN: path.join(tmp, "missing-claude-bin") },
    encoding: "utf8"
  });
  if (missingWrappedAgent.status === 0 || !String(missingWrappedAgent.stderr).includes("claude wrapper failed to start")) {
    throw new Error("installed tclaude wrapper did not report missing agent executable cleanly");
  }
  if (/\n\s+at\s/.test(String(missingWrappedAgent.stderr))) {
    throw new Error("installed tclaude wrapper printed a stack trace by default");
  }

  await assertInstalledServer(bin, traceHome);

  console.log("package install smoke ok");
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
