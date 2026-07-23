import { recoverTypedDataAddress } from "viem";
import { z } from "zod";
import type { OperatorConfig } from "./config.js";
import type {
  Hex,
  PaymentPayload,
  PaymentRequirements,
  VerifyResult,
} from "./types.js";

/**
 * Local x402 `exact` (EIP-3009 transferWithAuthorization) verification.
 * Ported from Evidiq main (lib/x402/verify.ts).
 * Checks signature + challenge-field match only — NOT on-chain balance or nonce reuse.
 */

const hex = z.custom<Hex>(
  (v) => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v)
);
const address = z.custom<Hex>(
  (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)
);
const uint = z.string().regex(/^\d+$/);

const proofSchema = z.object({
  signature: hex,
  authorization: z.object({
    from: address,
    to: address,
    value: uint,
    validAfter: uint,
    validBefore: uint,
    nonce: hex,
  }),
});

const v2PayloadSchema = z.object({
  x402Version: z.number(),
  accepted: z.object({
    scheme: z.literal("exact"),
    network: z.string(),
  }).passthrough(),
  payload: proofSchema,
});

export function decodePaymentHeader(req: Request): PaymentPayload | null {
  const raw = req.headers.get("payment-signature");
  if (!raw) return null;
  try {
    const json = JSON.parse(Buffer.from(raw.trim(), "base64").toString("utf8"));
    const v2 = v2PayloadSchema.safeParse(json);
    if (!v2.success) return null;
    return {
      x402Version: v2.data.x402Version,
      scheme: v2.data.accepted.scheme,
      network: v2.data.accepted.network,
      payload: v2.data.payload,
    } as PaymentPayload;
  } catch {
    return null;
  }
}

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const CLOCK_SKEW_SECONDS = 6n;

export async function verifyPaymentLocal(
  p: PaymentPayload,
  reqs: PaymentRequirements,
  cfg: OperatorConfig
): Promise<VerifyResult> {
  if (p.scheme !== "exact") {
    return { valid: false, reason: `unsupported scheme "${p.scheme}"` };
  }
  if (p.network !== cfg.network) {
    return {
      valid: false,
      reason: `network mismatch: got ${p.network}, expected ${cfg.network}`,
    };
  }
  const auth = p.payload.authorization;
  if (auth.to.toLowerCase() !== cfg.payTo.toLowerCase()) {
    return { valid: false, reason: `payTo mismatch: got ${auth.to}` };
  }
  const required = reqs.amount;
  if (BigInt(auth.value) < BigInt(required)) {
    return {
      valid: false,
      reason: `value ${auth.value} below required ${required}`,
    };
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(auth.validAfter) > now + CLOCK_SKEW_SECONDS) {
    return { valid: false, reason: "authorization not yet valid (validAfter)" };
  }
  if (BigInt(auth.validBefore) < now - CLOCK_SKEW_SECONDS) {
    return { valid: false, reason: "authorization expired (validBefore)" };
  }
  let recovered: Hex;
  try {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: cfg.domainName,
        version: cfg.domainVersion,
        chainId: cfg.chainId,
        verifyingContract: cfg.asset,
      },
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature: p.payload.signature,
    });
  } catch {
    return { valid: false, reason: "signature recovery failed" };
  }
  if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
    return {
      valid: false,
      reason: `signer ${recovered} does not match authorization.from ${auth.from}`,
    };
  }
  return { valid: true, payer: auth.from };
}
