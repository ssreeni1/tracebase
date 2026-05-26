"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TraceStore } = require("../src/storage");
const { importJsonlFile } = require("../src/importers");
const { createServer } = require("../src/server");

function assetPaths(html) {
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value) => value.startsWith("/assets/"));
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { response, text };
}

async function assertMissingDashboardBuild(store) {
  const root = path.resolve(__dirname, "..");
  const dist = path.join(root, "dist");
  const backup = path.join(os.tmpdir(), `tracebase-dist-backup-${process.pid}-${Date.now()}`);
  if (!fs.existsSync(dist)) return;
  fs.renameSync(dist, backup);
  const server = createServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const missingPage = await fetchText(`${origin}/`);
    assert.equal(missingPage.response.status, 503);
    assert.equal(missingPage.response.headers.get("content-type").startsWith("text/html"), true);
    assert.equal(missingPage.text.includes("Tracebase Dashboard Not Built"), true);
    assert.equal(missingPage.text.includes("<script"), false);
    assert.equal(missingPage.text.includes("<style"), false);
    const missingAsset = await fetchText(`${origin}/assets/index.js`);
    assert.equal(missingAsset.response.status, 404);
    assert.equal(missingAsset.response.headers.get("content-type").startsWith("application/json"), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.renameSync(backup, dist);
  }
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tracebase-ui-smoke-"));
  process.env.TRACE_HOME = home;

  const store = new TraceStore({ home });
  store.init();
  const seen = store.seenEventIds();
  importJsonlFile(store, "claude", path.join(__dirname, "fixtures", "claude.jsonl"), seen);
  importJsonlFile(store, "codex", path.join(__dirname, "fixtures", "codex.jsonl"), seen);

  const server = createServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  try {
    const { response: pageResponse, text: page } = await fetchText(`${origin}/?provider=claude&sort=time&order=desc`);
    assert.equal(pageResponse.status, 200);
    assert.equal(pageResponse.headers.get("x-frame-options"), "DENY");
    const csp = pageResponse.headers.get("content-security-policy") || "";
    assert.equal(csp.includes("default-src 'self'"), true);
    assert.equal(csp.includes("script-src 'self'"), true);
    assert.equal(csp.includes("object-src 'none'"), true);
    assert.equal(csp.includes("frame-ancestors 'none'"), true);
    assert.equal(page.includes('<div id="root"></div>'), true);
    const assets = assetPaths(page);
    assert.equal(assets.some((asset) => asset.endsWith(".js")), true);
    assert.equal(assets.some((asset) => asset.endsWith(".css")), true);

    const jsAsset = assets.find((asset) => asset.endsWith(".js"));
    const cssAsset = assets.find((asset) => asset.endsWith(".css"));
    const { response: jsResponse, text: js } = await fetchText(`${origin}${jsAsset}`);
    assert.equal(jsResponse.status, 200);
    assert.equal(jsResponse.headers.get("content-type").startsWith("text/javascript"), true);
    assert.equal(jsResponse.headers.get("content-security-policy").includes("script-src 'self'"), true);
    for (const marker of [
      "Proxy this session packet to the local",
      "was not found on this machine",
      "Export filtered",
      "Export session",
      "Search sessions, prompts, tools, files",
      "unlock raw export"
    ]) {
      assert.equal(js.includes(marker), true, `built UI bundle missing ${marker}`);
    }

    const { response: cssResponse, text: css } = await fetchText(`${origin}${cssAsset}`);
    assert.equal(cssResponse.status, 200);
    assert.equal(cssResponse.headers.get("content-type").startsWith("text/css"), true);
    assert.equal(/@media\s*\((max-width:\s*980px|width<=980px)\)/.test(css), true);

    const spaFallback = await fetchText(`${origin}/session/fixture-claude`);
    assert.equal(spaFallback.response.status, 200);
    assert.equal(spaFallback.text.includes('<div id="root"></div>'), true);
    const traversal = await fetchText(`${origin}/%2e%2e/%2e%2e/package.json`);
    assert.equal(traversal.response.status, 200);
    assert.equal(traversal.response.headers.get("content-type").startsWith("text/html"), true);
    assert.equal(traversal.text.includes('"scripts"'), false);
    const missingAsset = await fetchText(`${origin}/assets/missing-dashboard-asset.js`);
    assert.equal(missingAsset.response.status, 404);
    assert.equal(missingAsset.response.headers.get("content-type").startsWith("application/json"), true);

    const filteredSessions = await fetch(`${origin}/api/sessions?provider=claude&q=vite&sort=time&order=desc`).then((r) => r.json());
    assert.equal(filteredSessions.some((session) => session.id === "fixture-claude"), true);
    assert.equal(filteredSessions.every((session) => session.provider === "claude"), true);
    const firstSession = filteredSessions[0].id;
    const events = await fetch(`${origin}/api/events?provider=claude&q=vite&sessionId=${encodeURIComponent(firstSession)}&limit=20`).then((r) => r.json());
    assert.equal(events.every((event) => event.sessionId === firstSession), true);
    const redactedExport = await fetch(`${origin}/api/export?provider=claude&q=vite`);
    assert.equal(redactedExport.status, 200);
    assert.equal(redactedExport.headers.get("content-disposition").includes("export-"), true);
    const rawExportWithoutHeader = await fetch(`${origin}/api/export?provider=claude&q=vite&raw=1`);
    assert.equal(rawExportWithoutHeader.status, 403);
    const summaryRunners = await fetch(`${origin}/api/summary-runners`).then((r) => r.json());
    assert.equal(summaryRunners.runners.some((runner) => runner.runner === "codex"), true);
    assert.equal(summaryRunners.runners.some((runner) => runner.runner === "claude"), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  await assertMissingDashboardBuild(store);

  console.log("ui smoke ok");
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
