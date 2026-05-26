"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function pathCandidates(command, env = process.env) {
  const value = String(command || "");
  if (!value) return [];
  if (path.isAbsolute(value) || value.includes(path.sep)) return [value];
  const dirs = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = os.platform() === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  const names = path.extname(value) ? [value] : extensions.map((ext) => `${value}${ext.toLowerCase()}`);
  return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

function executablePath(command, env = process.env) {
  for (const candidate of pathCandidates(command, env)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning PATH.
    }
  }
  return null;
}

module.exports = {
  executablePath,
  pathCandidates
};
