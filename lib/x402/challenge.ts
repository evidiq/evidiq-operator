import type { NotaryConfig } from "./config.js";
import type {
  PaymentRequirements,
  PaymentResponseHeader,
  X402Resource,
} from "./types.js";

/**
 * x402 v2 challenge construction — ported from Evidiq main (lib/x402/challenge.ts).
 * Base64 of the challenge object goes in the PAYMENT-REQUIRED response header
 * (what OKX marketplace validates), mirrored in the 402 body. x402 v2 only.
 */

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

const RESOURCE_DESCRIPTION =
  "EVIDIQ Operator — x402-gated browser execution for AI agents: dedicated Chromium runtime + GPT-5.6-Terra via 0G Compute. Free tools (health, capabilities, supported_targets, estimate_cost) remain free.";

function buildResource(resourceUrl: string): X402Resource {
  return {
    url: resourceUrl,
    description: RESOURCE_DESCRIPTION,
    mimeType: "application/json",
  };
}

export function buildAccepts(
  cfg: NotaryConfig,
  amountOverride?: bigint
): PaymentRequirements[] {
  const amount = (amountOverride ?? cfg.price).toString();
  return [
    {
      scheme: "exact",
      network: cfg.network,
      asset: cfg.asset,
      amount,
      payTo: cfg.payTo,
      maxTimeoutSeconds: 300,
      extra: { name: cfg.domainName, version: cfg.domainVersion },
    },
  ];
}

type Challenge = {
  x402Version: 2;
  resource: X402Resource;
  accepts: PaymentRequirements[];
};

function challenge(
  cfg: NotaryConfig,
  resourceUrl: string,
  amountOverride?: bigint
): Challenge {
  return {
    x402Version: 2,
    resource: buildResource(resourceUrl),
    accepts: buildAccepts(cfg, amountOverride),
  };
}

function paymentRequiredHeader(
  cfg: NotaryConfig,
  resourceUrl: string,
  amountOverride?: bigint
): string {
  return b64(challenge(cfg, resourceUrl, amountOverride));
}

export function build402Response(
  cfg: NotaryConfig,
  resourceUrl: string,
  error?: string,
  amountOverride?: bigint
): Response {
  const body = {
    ...challenge(cfg, resourceUrl, amountOverride),
    error:
      error ??
      `Payment required. Sign the x402 v2 challenge (PAYMENT-REQUIRED header / accepts[] below) and retry with a PAYMENT-SIGNATURE header. Free tools (health, capabilities, supported_targets, estimate_cost) need no payment.`,
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "payment-required": paymentRequiredHeader(cfg, resourceUrl, amountOverride),
    },
  });
}

export function buildDiscoveryResponse(
  cfg: NotaryConfig,
  resourceUrl: string
): Response {
  // Discovery lists BOTH price tiers so callers can quote the right amount
  // before their first paid call.
  const discovery = {
    x402Version: 2,
    resource: buildResource(resourceUrl),
    accepts: buildAccepts(cfg),
    pricing: [
      { tool: "notarize_inference", amount: cfg.price.toString(), usd: Number(cfg.price) / 1e6 },
      { tool: "notarize_batch", amount: cfg.batchPrice.toString(), usd: Number(cfg.batchPrice) / 1e6 },
      { tool: "verify_attestation", amount: "0", usd: 0, free: true },
      { tool: "get_receipt", amount: "0", usd: 0, free: true },
      { tool: "notary_stats", amount: "0", usd: 0, free: true },
      { tool: "notary_pubkey", amount: "0", usd: 0, free: true },
    ],
  };
  return new Response(JSON.stringify(discovery, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "payment-required": paymentRequiredHeader(cfg, resourceUrl),
    },
  });
}

export function encodePaymentResponseHeader(r: PaymentResponseHeader): string {
  return b64(r);
}
