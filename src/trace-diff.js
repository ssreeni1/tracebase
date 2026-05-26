"use strict";

const fs = require("node:fs");
const { readJsonlWithOffsets } = require("./jsonl");

function diffSourceFile(store, file) {
  if (!fs.existsSync(file)) throw new Error(`No such source file: ${file}`);
  const db = store.getDb();
  const indexed = db.prepare("SELECT id, offset, timestamp, type FROM events WHERE sourcePath = $sourcePath")
    .all({ $sourcePath: file });
  const indexedOffsets = new Set(indexed.map((row) => Number(row.offset)));
  const source = Array.from(readJsonlWithOffsets(file));
  const sourceOffsets = new Set(source.map((row) => Number(row.offset)));
  const missingOffsets = source.filter((row) => !indexedOffsets.has(Number(row.offset))).map((row) => row.offset);
  const orphanIndexedOffsets = indexed.filter((row) => !sourceOffsets.has(Number(row.offset))).map((row) => row.offset);
  return {
    sourcePath: file,
    sourceEvents: source.length,
    indexedEvents: indexed.length,
    missingIndexedEvents: missingOffsets.length,
    orphanIndexedEvents: orphanIndexedOffsets.length,
    missingOffsets: missingOffsets.slice(0, 50),
    orphanIndexedOffsets: orphanIndexedOffsets.slice(0, 50),
    complete: missingOffsets.length === 0 && orphanIndexedOffsets.length === 0
  };
}

function diffSession(store, sessionId) {
  const session = store.getDb().prepare("SELECT * FROM sessions WHERE id = $id").get({ $id: sessionId });
  if (!session) throw new Error(`No such indexed session: ${sessionId}`);
  return diffSourceFile(store, session.sourcePath);
}

module.exports = {
  diffSourceFile,
  diffSession
};
