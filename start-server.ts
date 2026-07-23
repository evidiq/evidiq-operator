import { readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { handler } from "./server.js";
import { withX402Gate } from "./lib/x402/gate.js";
import { getOperatorConfig } from "./lib/x402/config.js";
import { buildDiscoveryResponse } from "./lib/x402/challenge.js";

const PORT = Number(process.env.PORT || 3000);
const HOSTNAME = process.env.HOSTNAME || "0.0.0.0";

const gatedHandler = withX402Gate(handler);

function toWebHeaders(headers: IncomingHttpHeaders): Headers {
  const webHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) webHeaders.append(key, item);
    } else if (value !== undefined) {
      webHeaders.set(key, value);
    }
  }
  return webHeaders;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function getOrigin(req: IncomingMessage): string {
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  const proto = req.headers["x-forwarded-proto"] || "http";
  const firstHost = Array.isArray(host) ? host[0] : host;
  const firstProto = Array.isArray(proto) ? proto[0] : proto;
  return `${firstProto}://${firstHost}`;
}

async function createWebRequest(req: IncomingMessage): Promise<Request> {
  const abortController = new AbortController();
  req.on("aborted", () => abortController.abort());
  const url = new URL(req.url || "/", getOrigin(req)).toString();
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  return new Request(url, {
    method: req.method || "GET",
    headers: toWebHeaders(req.headers),
    body,
    signal: abortController.signal,
  });
}

async function sendWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/skill.md") {
    try {
      const skill = await readFile(new URL("../skill.md", import.meta.url), "utf8");
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" });
      res.end(skill);
    } catch (error) {
      console.error("Failed to read skill.md", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Skill document is unavailable" }));
    }
    return;
  }

  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "evidiq-operator-mcp" }));
    return;
  }

  const path = new URL(req.url || "/", getOrigin(req)).pathname;

  // x402 pricing discovery — GET /x402 returns the challenge (200, not 402).
  if (path === "/x402") {
    const cfg = getOperatorConfig();
    if (cfg) {
      const dr = buildDiscoveryResponse(cfg, `${getOrigin(req)}${path}`);
      await sendWebResponse(dr, res);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ x402: false, note: "No x402 config — all tools are free." }));
    return;
  }

  if (!["/mcp", "/sse", "/message"].includes(path)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }

  try {
    const response = await gatedHandler(await createWebRequest(req));
    await sendWebResponse(response, res);
  } catch (error) {
    console.error("MCP request failed", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
});

server.listen(PORT, HOSTNAME, () => {
  console.log(`EVIDIQ Operator MCP server running on http://${HOSTNAME}:${PORT}`);
  console.log(`MCP endpoint: http://${HOSTNAME}:${PORT}/mcp`);
});
