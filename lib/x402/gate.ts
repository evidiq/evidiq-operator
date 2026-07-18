import {
  build402Response,
  buildAccepts,
  encodePaymentResponseHeader,
} from "./challenge.js";
import { getNotaryConfig } from "./config.js";
import { getVerifier } from "./facilitator.js";
import { decodePaymentHeader } from "./verify.js";

/**
 * x402 gate in front of the EVIDIQ Notary MCP handler.
 * Ported from Evidiq main (lib/x402/gate.ts), adapted for standalone Node.js.
 *
 * - No X402_* config → transparent pass-through (free endpoint).
 * - Free tools (verify_attestation, get_receipt, notary_stats, notary_pubkey,
 *   initialize, tools/list) ALWAYS pass — only PAID_TOOLS require payment.
 * - tools/call on a paid tool without PAYMENT-SIGNATURE → HTTP 402 + accepts[].
 * - Accept-header leniency + SSE→JSON unwrapping for plain-HTTP x402 callers.
 */

export const PAID_TOOLS: ReadonlySet<string> = new Set([
  "browser_task",
  "login_and_extract",
  "fill_form",
  "download_document",
  "navigate",
  "screenshot",
  "multi_step_workflow",
]);

const ACCEPT_BOTH = "application/json, text/event-stream";

type JsonRpcCall = { method?: unknown; params?: { name?: unknown } };

function isPaidCall(msg: JsonRpcCall): boolean {
  return (
    msg?.method === "tools/call" &&
    typeof msg?.params?.name === "string" &&
    PAID_TOOLS.has(msg.params.name)
  );
}

/** Pick the right price (atomic) for a specific paid tool. Inference uses
 *  X402_PRICE; notarize_batch uses X402_BATCH_PRICE (covers up to 20 items). */
function priceForTool(toolName: string | undefined, cfg: { price: bigint; batchPrice: bigint }): bigint {
  if (toolName === "notarize_batch") return cfg.batchPrice;
  return cfg.price;
}

/** Find the paid tool name in a JSON-RPC batch (if any). */
function paidToolIn(messages: JsonRpcCall[]): string | undefined {
  for (const m of messages) {
    if (m?.method === "tools/call" && typeof m?.params?.name === "string" && PAID_TOOLS.has(m.params.name)) {
      return m.params.name;
    }
  }
  return undefined;
}

function acceptsEventStream(accept: string | null): boolean {
  if (!accept) return false;
  return (
    accept.includes("text/event-stream") ||
    accept.includes("*/*") ||
    accept.includes("text/*")
  );
}

function handlerRequest(req: Request, bodyText: string): Request {
  const headers = new Headers(req.headers);
  headers.set("accept", ACCEPT_BOTH);
  return new Request(req.url, {
    method: req.method,
    headers,
    body: bodyText,
  });
}

function parseSseData(sse: string): unknown[] {
  const out: unknown[] = [];
  for (const block of sse.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // Non-JSON SSE comment/keepalive — ignore.
    }
  }
  return out;
}

async function finalize(
  res: Response,
  clientWantsEventStream: boolean,
  extraHeaders?: Record<string, string>
): Promise<Response> {
  const isSse = (res.headers.get("content-type") ?? "").includes(
    "text/event-stream"
  );

  if (clientWantsEventStream || !isSse) {
    if (!extraHeaders) return res;
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }

  const messages = parseSseData(await res.text());
  const payload = messages.length === 1 ? messages[0] : messages;
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  }
  return new Response(JSON.stringify(payload), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

export function withX402Gate(
  handler: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const cfg = getNotaryConfig();
    if (!cfg) return handler(req);

    const resourceUrl = req.url;

    if (req.method !== "POST") {
      const res = await handler(req);
      if (req.method === "GET" && (res.status === 406 || res.status === 405)) {
        return build402Response(cfg, resourceUrl);
      }
      return res;
    }

    const bodyText = await req.text();
    let parsed: unknown = null;
    let parseOk = false;
    try {
      parsed = JSON.parse(bodyText);
      parseOk = true;
    } catch {
      // Malformed JSON — reply immediately (forwarding would hang SSE).
    }
    if (!parseOk) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error: request body is not valid JSON." },
        }),
        { status: 400, headers: { "content-type": "application/json", "cache-control": "no-store" } }
      );
    }
    const messages: JsonRpcCall[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? [parsed as JsonRpcCall]
        : [];

    const clientWantsEventStream = acceptsEventStream(
      req.headers.get("accept")
    );

    const gated = cfg.gateAll || messages.some(isPaidCall);
    if (!gated) {
      const res = await handler(handlerRequest(req, bodyText));
      return finalize(res, clientWantsEventStream);
    }

    const payment = decodePaymentHeader(req);
    const toolName = paidToolIn(messages);
    const amount = priceForTool(toolName, cfg);
    if (!payment) {
      return build402Response(cfg, resourceUrl, undefined, amount);
    }

    const reqs = buildAccepts(cfg, amount)[0];
    const verifier = getVerifier(cfg);
    const verdict = await verifier.verify(payment, reqs);
    if (!verdict.valid) {
      return build402Response(
        cfg,
        resourceUrl,
        `invalid payment: ${verdict.reason}`,
        amount
      );
    }

    const settlement = await verifier.settle(payment, reqs);
    if (!settlement.success) {
      return build402Response(
        cfg,
        resourceUrl,
        `settlement failed: ${settlement.errorReason ?? "unknown"}`,
        amount
      );
    }

    const res = await handler(handlerRequest(req, bodyText));

    return finalize(res, clientWantsEventStream, {
      "payment-response": encodePaymentResponseHeader({
        status: settlement.transaction ? "settled" : "verified",
        transaction: settlement.transaction,
        amount: amount.toString(),
        payer: verdict.payer,
      }),
    });
  };
}
