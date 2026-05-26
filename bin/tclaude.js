#!/usr/bin/env node
"use strict";

const { runWrappedAgent } = require("../src/wrap");
const { runCli } = require("../src/cli-runner");

runCli((args) => runWrappedAgent("claude", args), process.argv.slice(2));
