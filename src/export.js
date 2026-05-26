"use strict";

const crypto = require("node:crypto");
const JSZip = require("jszip");
const { latestSummary } = require("./summaries");

function asJsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
}

function exportId(options = {}) {
  return "export-" + crypto.createHash("sha256").update(JSON.stringify({
    sessionId: options.sessionId || null,
    provider: options.provider || null,
    from: options.from || null,
    to: options.to || null,
    q: options.q || null,
    raw: Boolean(options.raw)
  })).digest("hex").slice(0, 16);
}

function rowsForExport(store, options = {}) {
  const sessions = store.listSessions({
    q: options.sessionId || options.q,
    provider: options.provider,
    from: options.from,
    to: options.to,
    cwd: options.cwd,
    sort: options.sort || "time",
    order: options.order || "desc",
    limit: options.limit || 10000
  }).filter((session) => !options.sessionId || session.id === options.sessionId);
  const sessionIds = new Set(sessions.map((session) => session.id));
  const events = store.search(options.q || "", {
    provider: options.provider,
    sessionId: options.sessionId,
    from: options.from,
    to: options.to,
    cwd: options.cwd,
    type: options.type,
    sort: "time",
    order: "asc",
    limit: options.eventLimit || 50000
  }).filter((event) => !sessionIds.size || sessionIds.has(event.sessionId));
  for (const event of events) sessionIds.add(event.sessionId);
  const traces = [];
  const spans = [];
  const summaries = [];
  for (const sessionId of sessionIds) {
    traces.push(...store.listTraces({ sessionId, limit: 100 }));
    spans.push(...store.listSpans({ sessionId, limit: 50000 }));
    const summary = latestSummary({ traceHome: store.home, sessionId });
    if (summary) summaries.push(summary);
  }
  return { sessions, events, traces, spans, summaries };
}

async function buildExportZip(store, options = {}) {
  const rows = rowsForExport(store, options);
  const id = exportId(options);
  const zip = new JSZip();
  const manifest = {
    id,
    generatedAt: new Date().toISOString(),
    rawIncluded: Boolean(options.raw),
    filters: {
      sessionId: options.sessionId || null,
      provider: options.provider || null,
      from: options.from || null,
      to: options.to || null,
      q: options.q || null,
      cwd: options.cwd || null,
      type: options.type || null
    },
    counts: {
      sessions: rows.sessions.length,
      events: rows.events.length,
      traces: rows.traces.length,
      spans: rows.spans.length,
      summaries: rows.summaries.length
    },
    privacy: {
      defaultRedacted: true,
      rawPayloadsMayContainSensitiveLocalData: Boolean(options.raw),
      hiddenPrivateReasoningCaptured: false
    }
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  zip.file("sessions.jsonl", asJsonl(rows.sessions));
  zip.file("events.jsonl", asJsonl(rows.events));
  zip.file("traces.jsonl", asJsonl(rows.traces));
  zip.file("spans.jsonl", asJsonl(rows.spans));
  zip.file("summaries.md", rows.summaries.map((row) => `# ${row.sessionId}\n\n${row.summary}\n`).join("\n---\n\n"));
  if (options.raw) {
    const rawRows = rows.events.map((event) => ({
      eventId: event.id,
      sessionId: event.sessionId,
      provider: event.provider,
      timestamp: event.timestamp,
      raw: store.getBlob(event.blobId)
    }));
    zip.file("raw.jsonl", asJsonl(rawRows));
  }
  return {
    id,
    filename: `${id}.zip`,
    contentType: "application/zip",
    buffer: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    manifest
  };
}

module.exports = {
  buildExportZip,
  rowsForExport
};
