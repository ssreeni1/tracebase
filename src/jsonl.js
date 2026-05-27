"use strict";

const fs = require("node:fs");

const DEFAULT_CHUNK_SIZE = 1 << 20; // 1 MiB

// Stream a file line-by-line without ever materializing it as a single string.
// JSONL logs can grow past Node's max string length (0x1fffffe8 ~= 512 MiB),
// so fs.readFileSync(file, "utf8") throws on large stores. We read fixed-size
// byte chunks and split on the newline BYTE (0x0A) over raw Buffers, decoding
// only complete lines to UTF-8 -- a multibyte character that straddles a chunk
// boundary is therefore never corrupted (0x0A can't appear inside a multibyte
// UTF-8 sequence). The yielded `offset` is the byte position of the line's first
// byte, matching the legacy `split(/\n/)` + `Buffer.byteLength(line) + 1` math.
function* iterJsonlLines(file, options = {}) {
  if (!fs.existsSync(file)) return;
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(chunkSize);
    let remainder = Buffer.alloc(0); // bytes of an as-yet-unterminated line
    let offset = 0; // byte offset of remainder's first byte within the file
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, chunk, 0, chunkSize, null)) > 0) {
      // Copy out of the reused `chunk` buffer; concat also copies `remainder`.
      const data = remainder.length
        ? Buffer.concat([remainder, chunk.subarray(0, bytesRead)])
        : Buffer.from(chunk.subarray(0, bytesRead));
      let start = 0;
      let nl;
      while ((nl = data.indexOf(0x0a, start)) !== -1) {
        yield { offset, line: data.toString("utf8", start, nl) };
        offset += (nl - start) + 1; // line bytes + the consumed newline
        start = nl + 1;
      }
      remainder = data.subarray(start);
    }
    if (remainder.length > 0) {
      yield { offset, line: remainder.toString("utf8") };
    }
  } finally {
    fs.closeSync(fd);
  }
}

function* readJsonlWithOffsets(file, options) {
  for (const { offset, line } of iterJsonlLines(file, options)) {
    if (!line.trim()) continue;
    try {
      yield { offset, value: JSON.parse(line) };
    } catch (error) {
      yield {
        offset,
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
  iterJsonlLines,
  readJsonlWithOffsets
};
