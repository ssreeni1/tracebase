"use strict";

const fs = require("node:fs");
const path = require("node:path");

function walkFiles(root, predicate) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (!predicate || predicate(full)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function findJsonl(root) {
  return walkFiles(root, (file) => file.endsWith(".jsonl")).sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return a.localeCompare(b);
    }
  });
}

module.exports = {
  walkFiles,
  findJsonl
};
