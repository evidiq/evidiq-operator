import type { OperatorConfig } from "./config.js";
import { OnchainSettler } from "./settle.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResult,
  VerifyResult,
} from "./types.js";
import { verifyPaymentLocal } from "./verify.js";

/**
 * Payment verification/settlement abstraction.
 * Ported from Evidiq main (lib/x402/facilitator.ts).
 */

export interface PaymentVerifier {
  verify(p: PaymentPayload, reqs: PaymentRequirements): Promise<VerifyResult>;
  settle(p: PaymentPayload, reqs: PaymentRequirements): Promise<SettleResult>;
}

const TESTNET_NETWORKS = new Set(["eip155:1952", "eip155:195"]);

export class LocalVerifier implements PaymentVerifier {
  constructor(private cfg: OperatorConfig) {}

  verify(p: PaymentPayload, reqs: PaymentRequirements): Promise<VerifyResult> {
    return verifyPaymentLocal(p, reqs, this.cfg);
  }

  async settle(
    p: PaymentPayload,
    _reqs: PaymentRequirements
  ): Promise<SettleResult> {
    const payer = p.payload.authorization.from;
    if (this.cfg.price === 0n || TESTNET_NETWORKS.has(this.cfg.network)) {
      return { success: true, transaction: "", payer };
    }
    return {
      success: false,
      transaction: "",
      payer,
      errorReason:
        "nonzero mainnet price requires facilitator settlement (set X402_USE_FACILITATOR=1 once the facilitator API is confirmed)",
    };
  }
}

const FACILITATOR_PATHS = {
  verify: "/verify",
  settle: "/settle",
} as const;

export class FacilitatorClient implements PaymentVerifier {
  private local: LocalVerifier;
  constructor(private cfg: OperatorConfig) {
    this.local = new LocalVerifier(cfg);
  }

  private async post(
    path: string,
    p: PaymentPayload,
    reqs: PaymentRequirements
  ): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${this.cfg.facilitatorUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: p.x402Version,
          paymentPayload: p,
          paymentRequirements: reqs,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async verify(
    p: PaymentPayload,
    reqs: PaymentRequirements
  ): Promise<VerifyResult> {
    const json = await this.post(FACILITATOR_PATHS.verify, p, reqs);
    if (json && typeof json.isValid === "boolean") {
      return json.isValid
        ? { valid: true, payer: p.payload.authorization.from }
        : {
            valid: false,
            reason: String(
              json.invalidReason ?? "facilitator rejected payment"
            ),
          };
    }
    console.warn(
      "x402: facilitator verify unavailable, falling back to local verification"
    );
    return this.local.verify(p, reqs);
  }

  async settle(
    p: PaymentPayload,
    reqs: PaymentRequirements
  ): Promise<SettleResult> {
    const payer = p.payload.authorization.from;
    const json = await this.post(FACILITATOR_PATHS.settle, p, reqs);
    if (json && typeof json.success === "boolean") {
      return {
        success: json.success,
        transaction: String(json.transaction ?? json.txHash ?? ""),
        payer: String(json.payer ?? payer),
        errorReason: json.success
          ? undefined
          : String(json.errorReason ?? "facilitator settlement failed"),
      };
    }
    return {
      success: false,
      transaction: "",
      payer,
      errorReason: "facilitator settle endpoint unavailable",
    };
  }
}

export function getVerifier(cfg: OperatorConfig): PaymentVerifier {
  if (cfg.useFacilitator) return new FacilitatorClient(cfg);
  if (cfg.settleKey) return new OnchainSettler(cfg);
  return new LocalVerifier(cfg);
}
