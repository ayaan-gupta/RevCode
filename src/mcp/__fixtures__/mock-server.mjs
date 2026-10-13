// Tiny MCP server over stdio for tests. Plain ESM, no dependencies.
//
// Behaviour switches (environment variables):
//   MOCK_NAME              serverInfo.name (default "mock")
//   MOCK_PAGE_SIZE         tools/list page size (default 2, so pagination is exercised)
//   MOCK_PROTOCOL_VERSION  force the protocolVersion in the initialize result
//   MOCK_EXIT_ON_START     write a message to stderr and exit with code 3 immediately
//   MOCK_HANG_ON_INIT      never answer `initialize`
//   MOCK_NO_TOOLS          answer tools/list with -32601 (server without tools)
//   MOCK_STDOUT_NOISE      print a non-JSON line to stdout before answering

import process from "node:process";
import { Buffer } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";

const env = process.env;

if (env.MOCK_EXIT_ON_START) {
  // Exit from the write callback so the message is flushed before the process dies.
  process.stderr.write("boom: missing API key (MOCK_EXIT_ON_START)\n", () => process.exit(3));
}

const PAGE_SIZE = Number(env.MOCK_PAGE_SIZE ?? 2);

/** Static tools. Order matters for the pagination test. */
const tools = [
  {
    name: "echo",
    description: "Echo the text back.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add",
    description: "Add two numbers; returns structured content.",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  },
  { name: "fail", description: "Always reports a tool error.", inputSchema: { type: "object", properties: {} } },
  { name: "image", description: "Returns text plus an image.", inputSchema: { type: "object", properties: {} } },
  {
    name: "big",
    description: "Returns `chars` characters of text.",
    inputSchema: { type: "object", properties: { chars: { type: "number" } } },
  },
  { name: "crash", description: "Writes to stderr, then exits.", inputSchema: { type: "object", properties: {} } },
  { name: "probe", description: "Sends requests to the client and reports the replies.", inputSchema: { type: "object", properties: {} } },
  { name: "add_tool", description: "Adds a tool and emits tools/list_changed.", inputSchema: { type: "object", properties: {} } },
  {
    name: "slow",
    description: "Answers after `ms` milliseconds.",
    inputSchema: { type: "object", properties: { ms: { type: "number" } } },
  },
  { name: "pid", description: "Returns this process id.", inputSchema: { type: "object", properties: {} } },
  { name: "dotted.name", description: "Name needs sanitizing.", inputSchema: { type: "object", properties: {} } },
  { name: "no_schema", description: "Declares no input schema at all." },
  { name: "ghost", description: "Listed but unknown to tools/call (-32602).", inputSchema: { type: "object", properties: {} } },
  { name: "cwd", description: "Returns the working directory.", inputSchema: { type: "object", properties: {} } },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Server -> client requests: resolved when the client's response arrives. */
const outstanding = new Map();
let nextServerRequestId = 9000;
function askClient(method, params) {
  return new Promise((resolve) => {
    const id = nextServerRequestId++;
    outstanding.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function callTool(name, args) {
  switch (name) {
    case "echo":
      return { content: [{ type: "text", text: `echo: ${args.text}` }] };
    case "add": {
      const sum = Number(args.a) + Number(args.b);
      return {
        content: [{ type: "text", text: `The sum is ${sum}` }],
        structuredContent: { sum },
      };
    }
    case "fail":
      return { isError: true, content: [{ type: "text", text: "something went wrong" }] };
    case "image":
      return {
        content: [
          { type: "text", text: "here is an image" },
          { type: "image", data: Buffer.from("fake-png-bytes").toString("base64"), mimeType: "image/png" },
        ],
      };
    case "big":
      return { content: [{ type: "text", text: `${"abcdefghij".repeat(Math.ceil(Number(args.chars ?? 100) / 10))}`.slice(0, Number(args.chars ?? 100)) }] };
    case "crash":
      process.stderr.write("fatal: the crash tool was invoked\n", () => process.exit(7));
      return new Promise(() => {}); // never answers: the process is about to die
    case "probe": {
      const ping = await askClient("ping", {});
      const roots = await askClient("roots/list", {});
      const unknown = await askClient("sampling/createMessage", { messages: [] });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ping: ping.result, roots: roots.result, unknown: unknown.error?.code }),
          },
        ],
      };
    }
    case "add_tool":
      tools.push({ name: "added_later", description: "Appeared after startup.", inputSchema: { type: "object", properties: {} } });
      void sleep(10).then(() => send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
      return { content: [{ type: "text", text: "tool added" }] };
    case "slow":
      await sleep(Number(args.ms ?? 1000));
      return { content: [{ type: "text", text: "slow done" }] };
    case "pid":
      return { content: [{ type: "text", text: String(process.pid) }] };
    case "cwd":
      return { content: [{ type: "text", text: process.cwd() }] };
    case "dotted.name":
      return { content: [{ type: "text", text: "dotted ok" }] };
    case "no_schema":
      return { content: [{ type: "text", text: "no_schema ok" }] };
    case "added_later":
      return { content: [{ type: "text", text: "added_later ok" }] };
    default:
      return undefined;
  }
}

async function handleRequest(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      if (env.MOCK_HANG_ON_INIT) {
        return; // never answer
      }
      if (env.MOCK_STDOUT_NOISE) {
        process.stdout.write("hello, this line is not JSON\n");
      }
      reply(id, {
        protocolVersion: env.MOCK_PROTOCOL_VERSION ?? params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: env.MOCK_NAME ?? "mock", version: "1.2.3" },
        instructions: "Use the mock tools wisely.",
      });
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list": {
      if (env.MOCK_NO_TOOLS) {
        replyError(id, -32601, "Method not found");
        return;
      }
      const start = params?.cursor ? Number(params.cursor) : 0;
      const page = tools.slice(start, start + PAGE_SIZE);
      const end = start + PAGE_SIZE;
      reply(id, end < tools.length ? { tools: page, nextCursor: String(end) } : { tools: page });
      return;
    }
    case "tools/call": {
      const result = await callTool(params?.name, params?.arguments ?? {});
      if (result === undefined) {
        replyError(id, -32602, `Unknown tool: ${params?.name}`);
      } else {
        reply(id, result);
      }
      return;
    }
    default:
      replyError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() === "") continue;
    const message = JSON.parse(line);
    if (message.method !== undefined && message.id !== undefined) {
      void handleRequest(message);
    } else if (message.method === undefined && message.id !== undefined) {
      outstanding.get(message.id)?.(message);
      outstanding.delete(message.id);
    }
    // notifications (initialized, cancelled) need no reply
  }
});
process.stdin.on("end", () => process.exit(0));
