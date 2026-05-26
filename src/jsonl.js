"use strict";

const fs = require("node:fs");

function* readJsonlWithOffsets(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  let offset = 0;
  for (const line of text.split(/\n/)) {
    const lineOffset = offset;
    offset += Buffer.byteLength(line, "utf8") + 1;
    if (!line.trim()) continue;
    try {
      yield { offset: lineOffset, value: JSON.parse(line) };
    } catch (error) {
      yield {
        offset: lineOffset,
        value: {
          type: "parse_error",
          error: error.message,
          line: line.slice(0, 1000)
        }
      };
    }
  }
}

module.exports = {
  readJsonlWithOffsets
};
