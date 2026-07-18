/**
 * 0G configuration — ported verbatim from Evidiq main (lib/og/config.ts).
 *
 * Storage/attestation use a single funded EVM key (OG_PRIVATE_KEY) on 0G
 * mainnet (Aristotle, chain 16661). The notary signer reuses the same key as
 * the EVIDIQ attester (see EVIDIQ-RUNBOOK.md §13: 0G attester = notary signer).
 *
 * All optional: when unset, the notary still returns receipts with hashes and
 * Merkle proofs, just without on-chain anchoring or a real signature.
 */

export type OgConfig = {
  privateKey: `0x${string}`;
  storageRpc: string;
  storageIndexer: string;
  computeRpc: string;
  chainId: number;
};

const DEFAULTS = {
  // 0G Mainnet (Aristotle) — Chain ID 16661.
  storageRpc: "https://evmrpc.0g.ai",
  storageIndexer: "https://indexer-storage-turbo.0g.ai",
  computeRpc: "https://evmrpc.0g.ai",
  chainId: 16661,
};

function normalizeKey(raw?: string): `0x${string}` | null {
  if (!raw) return null;
  const key = raw.trim();
  const withPrefix = key.startsWith("0x") ? key : `0x${key}`;
  return /^0x[0-9a-fA-F]{64}$/.test(withPrefix)
    ? (withPrefix as `0x${string}`)
    : null;
}

/** Returns 0G storage/attestation config when a valid key is present. */
export function getOgConfig(): OgConfig | null {
  const privateKey = normalizeKey(process.env.OG_PRIVATE_KEY);
  if (!privateKey) return null;
  const chainId = Number(process.env.OG_CHAIN_ID) || DEFAULTS.chainId;
  return {
    privateKey,
    storageRpc: process.env.OG_STORAGE_RPC?.trim() || DEFAULTS.storageRpc,
    storageIndexer:
      process.env.OG_STORAGE_INDEXER?.trim() || DEFAULTS.storageIndexer,
    computeRpc: process.env.OG_COMPUTE_RPC?.trim() || DEFAULTS.computeRpc,
    chainId,
  };
}
