"use strict";

const { TraceStore } = require("./storage");

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
  })
];

const WRITE_TOOLS = [];
const WRITE_TOOL_NAMES = new Set();

function toolsForOptions() {
  return READ_TOOLS;
}

function toolByName(name) {
  return READ_TOOLS.find((item) => item.name === name) || null;
}

function validateArgs(name, args = {}) {
  const spec = toolByName(name);
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

function callTool(store, name, args = {}) {
  args = validateArgs(name, args);
  switch (name) {
    case "stats":
      return store.stats();
    case "search_events":
      return store.search(args.query || "", args);
    case "list_traces":
      return store.listTraces(args);
    case "list_spans":
      return store.listSpans(args);
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

function response(id, result) {
  return { jsonrpc: JSONRPC, id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: JSONRPC, id: id == null ? null : id, error: { code, message } };
}

function handleMessage(store, message) {
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
    if (message.method === "tools/list") return response(id, { tools: READ_TOOLS });
    if (message.method === "tools/call") {
      const result = callTool(store, params.name, params.arguments || {});
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
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    const parsed = parseFrames(buffer);
    buffer = parsed.rest;
    for (const message of parsed.messages) {
      const result = handleMessage(store, message);
      if (result) output.write(encodeFrame(result));
    }
  });
}

module.exports = {
  READ_TOOLS,
  TOOLS: READ_TOOLS,
  WRITE_TOOLS,
  WRITE_TOOL_NAMES,
  callTool,
  encodeFrame,
  handleMessage,
  parseFrames,
  toolsForOptions,
  runMcpServer
};
