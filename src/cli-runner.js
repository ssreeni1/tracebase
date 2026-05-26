"use strict";

function formatCliError(error) {
  const message = error && error.message ? error.message : String(error || "Unknown error");
  if (process.env.TRACEBASE_DEBUG === "1") {
    return error && error.stack ? error.stack : `Error: ${message}`;
  }
  return `Error: ${message}`;
}

function runCli(main, argv) {
  return main(argv).catch((error) => {
    console.error(formatCliError(error));
    process.exitCode = 1;
  });
}

module.exports = {
  formatCliError,
  runCli
};
