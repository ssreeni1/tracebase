#!/usr/bin/env node
"use strict";

const { main } = require("../src/cli");
const { runCli } = require("../src/cli-runner");

runCli(main, process.argv.slice(2));
