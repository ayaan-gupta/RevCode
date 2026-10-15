// Scripted OpenAI-compatible streaming server for exercising the TUI end to end.
import http from "node:http";

const port = Number(process.argv[2] ?? 8799);

const FINAL = `Here's what I found and changed:

## Summary

The **README** starts with a title and a short description. I made one edit to \`hello.txt\` and ran a quick check.

| File | Change | Status |
|:-----|:------:|-------:|
| hello.txt | greeting updated | done |
| README.md | none | skipped |

Next steps:

1. Run the test suite with \`npm test\`
2. Review the diff above
   - check the wording
   - check the line numbers

\`\`\`ts
export function greet(name: string): string {
  // friendly greeting
  return \`Hello, \${name}!\`;
}
\`\`\`

> Note: this was produced by a scripted mock model — see [the docs](https://example.com/docs) for more.
`;

const SLOW = "This is a deliberately long paragraph that keeps streaming word by word so that the interface has to cope with a line that never ends for a good while, wrapping across many rows while the activity indicator keeps spinning and the elapsed timer keeps counting up, which is exactly what a real model does when it explains something at length without any line breaks at all. ".repeat(3) + "\n\nAnd then a short closing line.\n";

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stream(res, { text, tools, delay = 15 }) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model: "mock" };
  if (text) {
    const parts = text.match(/\S+\s*|\s+/g) ?? [];
    for (let i = 0; i < parts.length; i += 2) {
      sse(res, { ...base, choices: [{ index: 0, delta: { content: parts.slice(i, i + 2).join("") }, finish_reason: null }] });
      await sleep(delay);
    }
  }
  if (tools?.length) {
    tools.forEach((t, i) => {
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${Date.now()}_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }] }, finish_reason: null }] });
    });
  }
  sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: tools?.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540 } });
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
      res.writeHead(404).end("nope");
      return;
    }
    const json = JSON.parse(body || "{}");
    const messages = json.messages ?? [];
    const userMsgs = messages.filter((m) => m.role === "user");
    const lastUser = (userMsgs.at(-1)?.content ?? "").toString();
    const tail = messages.slice(messages.lastIndexOf(userMsgs.at(-1)) + 1);
    const toolResults = tail.filter((m) => m.role === "tool").length;
    if (json.stream !== true) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "mock", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
      return;
    }
    const scenario = /slow/i.test(lastUser) ? "slow" : /boom/i.test(lastUser) ? "boom" : /demo/i.test(lastUser) ? "demo" : "chat";

    if (/flaky/i.test(lastUser)) { globalThis.flaky = (globalThis.flaky ?? 0) + 1; if (globalThis.flaky <= 3) { res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "overloaded" } })); return; } }
    if (scenario === "boom") { res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "mock upstream exploded" } })); return; }
    if (scenario === "slow") { await stream(res, { text: SLOW, delay: 140 }); return; }
    if (scenario === "demo") {
      if (toolResults === 0) return stream(res, { text: "I'll start by looking at the README and the greeting file.", tools: [{ name: "read_file", args: { path: "README.md", limit: 5 } }, { name: "list_directory", args: { path: "." } }] });
      if (toolResults === 2) return stream(res, { text: "Now I'll update the greeting.", tools: [{ name: "edit_file", args: { path: "hello.txt", edits: [{ oldText: "hello world", newText: "hello, brave new world" }] } }] });
      if (toolResults === 3) return stream(res, { tools: [{ name: "shell", args: { command: "echo checking && cat hello.txt && (for i in 1 2 3 4 5 6 7 8 9 10; do echo \"line $i\"; done)" } }] });
      return stream(res, { text: FINAL });
    }
    await stream(res, { text: `You said: "${lastUser.slice(0, 80)}"\n\nThis is a **mock** reply with \`inline code\` and a list:\n\n- one\n- two\n- three\n` });
  });
});
server.listen(port, "127.0.0.1", () => console.log(`mock listening on ${port}`));
