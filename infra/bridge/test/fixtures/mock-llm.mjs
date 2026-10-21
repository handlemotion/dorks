// Minimal OpenAI-compatible /v1/chat/completions mock for driving a real `opencode serve` deterministically (test/live-opencode.test.ts).
// Usage: node mock-llm.mjs [port, 0 = any] [logfile]; prints `mock provider listening on http://127.0.0.1:<port>/v1`.
// Script per request (stateless, decided from the conversation):
//   - request without `tools` (title/summary agents): stream a short title.
//   - last message is role "tool": stream final text answer, finish_reason "stop".
//   - last user message contains "RATELIMIT": 429 twice (with retry-after: 1), then normal.
//   - last user message contains "BADKEY": 401.
//   - last user message contains "SLOW": stream text slowly for ~30s (for abort tests).
//   - last user message contains "MCP": call the dorks MCP server's `dorks_pr_list` tool.
//   - otherwise: stream a bit of text, then one `bash` tool call (`cat README.md`), finish_reason "tool_calls".
import http from "node:http";
import fs from "node:fs";

const port = Number(process.argv[2] ?? 0);
const logFile = process.argv[3];
const log = (o) => logFile && fs.appendFileSync(logFile, JSON.stringify(o) + "\n");

const chunk = (id, delta, finish = null, usage) => ({
  id,
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: "mock-model",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(usage ? { usage } : {}),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http
  .createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.method === "GET" && req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
    }
    if (!req.url.endsWith("/chat/completions")) {
      res.writeHead(404);
      return res.end();
    }
    const j = JSON.parse(body || "{}");
    const msgs = j.messages ?? [];
    const last = msgs[msgs.length - 1] ?? {};
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const text = JSON.stringify(lastUser?.content ?? "");
    const hasTools = Array.isArray(j.tools) && j.tools.length > 0;
    log({ t: Date.now(), url: req.url, stream: j.stream, hasTools, nTools: j.tools?.length, toolNames: j.tools?.map((t) => t.function?.name), lastRole: last.role, nMsgs: msgs.length });

    if (j.stream === false) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "cmpl-x", object: "chat.completion", created: 0, model: "mock-model", choices: [{ index: 0, message: { role: "assistant", content: "Mock title" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
    }

    if (hasTools && text.includes("RATELIMIT")) {
      // first 2 attempts 429, then succeed (opencode retries with backoff)
      globalThis.rl = (globalThis.rl ?? 0) + 1;
      if (globalThis.rl <= 2) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        return res.end(JSON.stringify({ error: { message: "Rate limit exceeded (mock)", type: "rate_limit_error", code: "rate_limit_exceeded" } }));
      }
    }
    if (hasTools && text.includes("BADKEY")) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Invalid API key (mock)", type: "invalid_request_error", code: "invalid_api_key" } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const id = "chatcmpl-" + Math.random().toString(36).slice(2);
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };

    if (!hasTools) {
      send(chunk(id, { role: "assistant", content: "Mock " }));
      send(chunk(id, { content: "title" }));
      send(chunk(id, {}, "stop"));
      send({ ...chunk(id, {}), choices: [], usage });
    } else if (last.role === "tool") {
      send(chunk(id, { role: "assistant", content: "" }));
      for (const w of ["Done: ", "the tool ", "answered."]) {
        send(chunk(id, { content: w }));
        await sleep(50);
      }
      send(chunk(id, {}, "stop"));
      send({ ...chunk(id, {}), choices: [], usage });
    } else if (text.includes("SLOW")) {
      send(chunk(id, { role: "assistant", content: "" }));
      for (let i = 0; i < 60 && !res.destroyed; i++) {
        send(chunk(id, { content: `tick ${i} ` }));
        await sleep(500);
      }
      send(chunk(id, {}, "stop"));
      send({ ...chunk(id, {}), choices: [], usage });
    } else {
      send(chunk(id, { role: "assistant", content: "" }));
      for (const w of ["Let me ", "read the file."]) {
        send(chunk(id, { content: w }));
        await sleep(50);
      }
      const mcp = text.includes("MCP");
      const args = JSON.stringify(mcp ? {} : { command: "cat README.md", description: "Print the README" });
      send(chunk(id, { tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: mcp ? "dorks_pr_list" : "bash", arguments: "" } }] }));
      send(chunk(id, { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 20) } }] }));
      send(chunk(id, { tool_calls: [{ index: 0, function: { arguments: args.slice(20) } }] }));
      send(chunk(id, {}, "tool_calls"));
      send({ ...chunk(id, {}), choices: [], usage });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  })
  .listen(port, "127.0.0.1", function () {
    console.log(`mock provider listening on http://127.0.0.1:${this.address().port}/v1`);
  });
