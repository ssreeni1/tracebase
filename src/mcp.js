"use strict";

const { TraceStore } = require("./storage");
const { makeJudgeSpec, makeBehaviorSpec, evaluateJudge } = require("./judges");
const { makeDatasetSpec, makeBucketSpec, runBucket } = require("./datasets");
const { makeRuleSpec, evaluateRule } = require("./rules");
const { compareSessions, compareDatasets } = require("./regression");
const { makeConfigCommit } = require("./registry");

const JSONRPC = "2.0";

function textResult(value) {
  return {
    content: [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
    }]
  };
}

function tool(name, description, properties = {}, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false
    }
  };
}

const READ_TOOLS = [
  tool("stats", "Return trace store metrics."),
  tool("search_events", "Search indexed trace events.", {
    query: { type: "string" },
    limit: { type: "number" },
    provider: { type: "string" },
    sessionId: { type: "string" }
  }, ["query"]),
  tool("list_traces", "List canonical traces.", {
    limit: { type: "number" },
    provider: { type: "string" },
    sessionId: { type: "string" }
  }),
  tool("list_spans", "List canonical spans for a trace or session.", {
    traceId: { type: "string" },
    sessionId: { type: "string" },
    spanType: { type: "string" },
    limit: { type: "number" }
  }),
  tool("list_behaviors", "List behavior definitions and detection counts.", {
    judgeId: { type: "string" },
    limit: { type: "number" }
  }),
  tool("list_behavior_results", "List behavior detections.", {
    behaviorId: { type: "string" },
    sessionId: { type: "string" },
    traceId: { type: "string" },
    limit: { type: "number" }
  }),
  tool("list_datasets", "List trace datasets.", {
    limit: { type: "number" }
  }),
  tool("list_dataset_items", "List dataset items.", {
    datasetId: { type: "string" },
    sessionId: { type: "string" },
    traceId: { type: "string" },
    limit: { type: "number" }
  }),
  tool("list_alerts", "List fired alert records.", {
    ruleId: { type: "string" },
    behaviorId: { type: "string" },
    sessionId: { type: "string" },
    limit: { type: "number" }
  }),
  tool("compare_sessions", "Compare two sessions for regressions.", {
    before: { type: "string" },
    after: { type: "string" }
  }, ["before", "after"]),
  tool("compare_datasets", "Compare two datasets for regressions.", {
    before: { type: "string" },
    after: { type: "string" }
  }, ["before", "after"]),
  tool("get_config", "Fetch a prompt/config by name/id, optionally by tag or commit.", {
    config: { type: "string" },
    tag: { type: "string" },
    commitId: { type: "string" }
  }, ["config"])
];

const WRITE_TOOLS = [
  tool("create_judge", "Create or update a local regex judge.", {
    name: { type: "string" },
    pattern: { type: "string" },
    rubric: { type: "string" },
    runner: { type: "string", enum: ["codex", "claude"] },
    description: { type: "string" },
    spanType: { type: "string" },
    version: { type: "number" }
  }, ["name"]),
  tool("evaluate_judge", "Evaluate spans with a local judge and record evaluation results.", {
    judge: { type: "string" },
    sessionId: { type: "string" },
    traceId: { type: "string" },
    version: { type: "number" },
    limit: { type: "number" }
  }, ["judge"]),
  tool("create_behavior", "Create or update a behavior backed by a judge.", {
    name: { type: "string" },
    judgeId: { type: "string" },
    description: { type: "string" }
  }, ["name", "judgeId"]),
  tool("create_dataset", "Create or update a trace dataset.", {
    name: { type: "string" },
    description: { type: "string" },
    kind: { type: "string" }
  }, ["name"]),
  tool("create_bucket", "Create or update a behavior-to-dataset bucket.", {
    name: { type: "string" },
    datasetId: { type: "string" },
    behaviorId: { type: "string" },
    description: { type: "string" },
    enabled: { type: "boolean" }
  }, ["name", "datasetId", "behaviorId"]),
  tool("run_bucket", "Route matching behavior detections into a dataset.", {
    bucket: { type: "string" },
    sessionId: { type: "string" },
    traceId: { type: "string" },
    limit: { type: "number" }
  }, ["bucket"]),
  tool("create_rule", "Create or update an alert rule over behavior detections.", {
    name: { type: "string" },
    behaviorId: { type: "string" },
    minCount: { type: "number" },
    description: { type: "string" },
    enabled: { type: "boolean" }
  }, ["name", "behaviorId"]),
  tool("run_rule", "Evaluate one alert rule and record matching alerts.", {
    rule: { type: "string" },
    sessionId: { type: "string" },
    traceId: { type: "string" },
    limit: { type: "number" }
  }, ["rule"]),
  tool("commit_config", "Commit a versioned prompt or agent config.", {
    name: { type: "string" },
    kind: { type: "string" },
    content: { type: "string" },
    message: { type: "string" },
    tags: { type: "array", items: { type: "string" } }
  }, ["name", "content"])
];

const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((item) => item.name));

function toolsForOptions(options = {}) {
  return options.allowWrite ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
}

function toolByName(name, options = {}) {
  return toolsForOptions(options).find((item) => item.name === name) || null;
}

function validateArgs(name, args = {}, options = {}) {
  const spec = toolByName(name, options);
  if (!spec) return args;
  const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const allowed = new Set(Object.keys(spec.inputSchema.properties || {}));
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Unexpected MCP argument for ${name}: ${key}`);
  }
  for (const key of spec.inputSchema.required || []) {
    if (input[key] == null || input[key] === "") throw new Error(`Missing MCP argument for ${name}: ${key}`);
  }
  return input;
}

function callTool(store, name, args = {}, options = {}) {
  if (WRITE_TOOL_NAMES.has(name) && !options.allowWrite) {
    throw new Error(`MCP tool ${name} requires explicit --allow-write.`);
  }
  args = validateArgs(name, args, options);
  switch (name) {
    case "stats":
      return store.stats();
    case "search_events":
      return store.search(args.query || "", args);
    case "list_traces":
      return store.listTraces(args);
    case "list_spans":
      return store.listSpans(args);
    case "list_behaviors":
      return store.listBehaviors(args);
    case "list_behavior_results":
      return store.listBehaviorResults(args);
    case "create_judge": {
      const spec = makeJudgeSpec(args);
      store.upsertJudge(spec);
      return spec;
    }
    case "evaluate_judge":
      return summarizeJudgeRun(evaluateJudge(store, args.judge, args));
    case "create_behavior": {
      const behavior = makeBehaviorSpec(args);
      store.upsertBehavior(behavior);
      return behavior;
    }
    case "create_dataset": {
      const dataset = makeDatasetSpec(args);
      store.upsertDataset(dataset);
      return dataset;
    }
    case "list_datasets":
      return store.listDatasets(args);
    case "list_dataset_items":
      return store.listDatasetItems(args);
    case "create_bucket": {
      const bucket = makeBucketSpec(args);
      store.upsertBucket(bucket);
      return bucket;
    }
    case "run_bucket":
      return runBucket(store, args.bucket, args);
    case "create_rule": {
      const rule = makeRuleSpec(args);
      store.upsertRule(rule);
      return rule;
    }
    case "run_rule":
      return evaluateRule(store, args.rule, args);
    case "list_alerts":
      return store.listAlerts(args);
    case "compare_sessions":
      return compareSessions(store, args.before, args.after);
    case "compare_datasets":
      return compareDatasets(store, args.before, args.after);
    case "commit_config": {
      const spec = makeConfigCommit(args);
      store.commitConfig(spec);
      return spec;
    }
    case "get_config":
      return store.getConfig(args.config, { tag: args.tag, commitId: args.commitId });
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

function summarizeJudgeRun(result) {
  return {
    judge: result.judge,
    version: result.version,
    evaluations: result.evaluations.length,
    positive: result.evaluations.filter((row) => row.passed).length
  };
}

function response(id, result) {
  return { jsonrpc: JSONRPC, id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: JSONRPC, id: id == null ? null : id, error: { code, message } };
}

function handleMessage(store, message, options = {}) {
  if (!message || message.jsonrpc !== JSONRPC) return errorResponse(message && message.id, -32600, "Invalid JSON-RPC message.");
  const id = message.id;
  const params = message.params || {};
  try {
    if (message.method === "initialize") {
      return response(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "tracebase", version: "0.1.0" }
      });
    }
    if (message.method === "notifications/initialized") return null;
    if (message.method === "ping") return response(id, {});
    if (message.method === "tools/list") return response(id, { tools: toolsForOptions(options) });
    if (message.method === "tools/call") {
      const result = callTool(store, params.name, params.arguments || {}, options);
      return response(id, textResult(result));
    }
    if (message.method === "resources/list") return response(id, { resources: [] });
    return errorResponse(id, -32601, `Unknown method: ${message.method}`);
  } catch (error) {
    return errorResponse(id, -32000, error.message);
  }
}

function encodeFrame(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function parseFrames(buffer) {
  const messages = [];
  let rest = buffer;
  for (;;) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const header = rest.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (rest.length < bodyEnd) break;
    messages.push(JSON.parse(rest.slice(bodyStart, bodyEnd)));
    rest = rest.slice(bodyEnd);
  }
  return { messages, rest };
}

function runMcpServer(options = {}) {
  const store = options.store || new TraceStore();
  store.init();
  const serverOptions = { allowWrite: Boolean(options.allowWrite || process.env.TRACEBASE_MCP_ALLOW_WRITE === "1") };
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    const parsed = parseFrames(buffer);
    buffer = parsed.rest;
    for (const message of parsed.messages) {
      const result = handleMessage(store, message, serverOptions);
      if (result) output.write(encodeFrame(result));
    }
  });
}

module.exports = {
  READ_TOOLS,
  TOOLS: READ_TOOLS,
  WRITE_TOOLS,
  callTool,
  encodeFrame,
  handleMessage,
  parseFrames,
  toolsForOptions,
  runMcpServer
};
