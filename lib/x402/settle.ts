import type { OperatorConfig } from "./config.js";
import type { PaymentVerifier } from "./facilitator.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResult,
  VerifyResult,
} from "./types.js";
import { verifyPaymentLocal } from "./verify.js";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * On-chain x402 settlement for the `exact` (EIP-3009) scheme.
 * Ported from Evidiq main (lib/x402/settle.ts).
 * Explicit LEGACY gas params to avoid X Layer RPC `eth_getBlockByNumber` flakiness.
 */

const EIP3009_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export class OnchainSettler implements PaymentVerifier {
  constructor(private cfg: OperatorConfig) {}

  verify(p: PaymentPayload, reqs: PaymentRequirements): Promise<VerifyResult> {
    return verifyPaymentLocal(p, reqs, this.cfg);
  }

  async settle(
    p: PaymentPayload,
    _reqs: PaymentRequirements
  ): Promise<SettleResult> {
    const auth = p.payload.authorization;
    const payer = auth.from;

    if (this.cfg.price === 0n) {
      return { success: true, transaction: "", payer };
    }
    if (!this.cfg.settleKey) {
      return {
        success: false,
        transaction: "",
        payer,
        errorReason:
          "on-chain settlement requires X402_SETTLE_KEY (a gas-funded X Layer wallet)",
      };
    }

    const chain = defineChain({
      id: this.cfg.chainId,
      name: `xlayer-${this.cfg.chainId}`,
      nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
      rpcUrls: { default: { http: [this.cfg.rpcUrl] } },
    });
    const account = privateKeyToAccount(this.cfg.settleKey);
    const wallet = createWalletClient({
      account,
      chain,
      transport: http(this.cfg.rpcUrl),
    });
    const pub = createPublicClient({ chain, transport: http(this.cfg.rpcUrl) });

    try {
      let gasPrice: bigint;
      try {
        gasPrice = ((await pub.getGasPrice()) * 12n) / 10n;
      } catch {
        gasPrice = 1_000_000_000n;
      }
      const hash = await wallet.writeContract({
        address: this.cfg.asset,
        abi: EIP3009_ABI,
        functionName: "transferWithAuthorization",
        args: [
          auth.from,
          auth.to,
          BigInt(auth.value),
          BigInt(auth.validAfter),
          BigInt(auth.validBefore),
          auth.nonce,
          p.payload.signature,
        ],
        gas: 300_000n,
        gasPrice,
      });
      let receipt: { status: string } | null = null;
      for (let i = 0; i < 40; i++) {
        try {
          receipt = (await pub.getTransactionReceipt({ hash })) as unknown as {
            status: string;
          };
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (receipt && receipt.status !== "success") {
        return {
          success: false,
          transaction: hash,
          payer,
          errorReason: "settlement transaction reverted",
        };
      }
      return { success: true, transaction: hash, payer };
    } catch (e) {
      return {
        success: false,
        transaction: "",
        payer,
        errorReason: `settlement failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }
  }
}
