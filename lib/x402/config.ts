import { z } from "zod";

const CHAIN_SLUGS: Record<string, string> = {
  "x-layer": "eip155:196",
  "xlayer": "eip155:196",
  "x-layer-mainnet": "eip155:196",
  "x-layer-testnet": "eip155:1952",
  "xlayer-testnet": "eip155:1952",
};

function resolveNetwork(): string | undefined {
  const direct = process.env.X402_NETWORK?.trim();
  if (direct) return direct;
  const slug = process.env.X402_CHAIN?.trim().toLowerCase();
  if (slug && CHAIN_SLUGS[slug]) return CHAIN_SLUGS[slug];
  return undefined;
}

const XLAYER_USDT0 = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const XLAYER_RPC = "https://rpc.xlayer.tech";

const envSchema = z.object({
  network: z.string().regex(/^eip155:\d+$/, "network must resolve to CAIP-2, e.g. eip155:196"),
  X402_ASSET: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "X402_ASSET must be a 0x... token address"),
  X402_PAY_TO: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "X402_PAY_TO must be a 0x... address"),
  X402_DOMAIN_NAME: z.string().min(1).default("USD₮0"),
  X402_DOMAIN_VERSION: z.string().min(1).default("1"),
  X402_PRICE: z.string().regex(/^\d+$/, "X402_PRICE must be atomic units (decimal integer)").default("20000"),
  X402_FACILITATOR_URL: z.string().url().default("https://web3.okx.com"),
  X402_RPC: z.string().url().default("https://rpc.xlayer.tech"),
  X402_SETTLE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "X402_SETTLE_KEY must be a 0x... 32-byte private key").optional(),
  X402_GATE_ALL: z.string().optional(),
  X402_USE_FACILITATOR: z.string().optional(),
});

export type OperatorConfig = {
  network: string;
  chainId: number;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  domainName: string;
  domainVersion: string;
  price: bigint;
  facilitatorUrl: string;
  rpcUrl: string;
  settleKey?: `0x${string}`;
  gateAll: boolean;
  useFacilitator: boolean;
};

export function getOperatorConfig(): OperatorConfig | null {
  const network = resolveNetwork();
  const asset = process.env.X402_ASSET;
  const payTo = process.env.X402_PAY_TO;

  if (!asset && !process.env.X402_NETWORK && !process.env.X402_CHAIN) {
    return null;
  }
  if (!asset) return null;

  const missing: string[] = [];
  if (!network) missing.push("X402_NETWORK or X402_CHAIN");
  if (!payTo) missing.push("X402_PAY_TO");
  if (missing.length > 0) {
    throw new Error(`x402 config is partial — X402_ASSET is set but missing: ${missing.join(", ")}`);
  }

  const env = envSchema.parse({
    network,
    X402_ASSET: asset,
    X402_PAY_TO: payTo,
    X402_DOMAIN_NAME: process.env.X402_DOMAIN_NAME || undefined,
    X402_DOMAIN_VERSION: process.env.X402_DOMAIN_VERSION || undefined,
    X402_PRICE: process.env.X402_PRICE || undefined,
    X402_FACILITATOR_URL: process.env.X402_FACILITATOR_URL || undefined,
    X402_RPC: process.env.X402_RPC || undefined,
    X402_SETTLE_KEY: process.env.X402_SETTLE_KEY || undefined,
    X402_GATE_ALL: process.env.X402_GATE_ALL || undefined,
    X402_USE_FACILITATOR: process.env.X402_USE_FACILITATOR || undefined,
  });

  return {
    network: env.network,
    chainId: Number(env.network.split(":")[1]),
    asset: env.X402_ASSET as `0x${string}`,
    payTo: env.X402_PAY_TO as `0x${string}`,
    domainName: env.X402_DOMAIN_NAME,
    domainVersion: env.X402_DOMAIN_VERSION,
    price: BigInt(env.X402_PRICE),
    facilitatorUrl: env.X402_FACILITATOR_URL,
    rpcUrl: env.X402_RPC,
    settleKey: env.X402_SETTLE_KEY as `0x${string}` | undefined,
    gateAll: env.X402_GATE_ALL === "1",
    useFacilitator: env.X402_USE_FACILITATOR === "1",
  };
}