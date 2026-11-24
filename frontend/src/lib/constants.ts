import { PublicKey } from "@solana/web3.js";

export const DEFAULT_PROGRAM_ID = "BxHVeQ7R5LuPLnoL6ySbiDstPChxJcEgPjoHCWgo2erX";
export const DEFAULT_STORE_AUTHORITY = "FRFw8oAUQsHn3fZfis4dGcRhAXanoMo77TaKnm6cwLgf";

export const PROGRAM_ID = (() => {
  const id = process.env.NEXT_PUBLIC_PROGRAM_ID || DEFAULT_PROGRAM_ID;
  try {
    return new PublicKey(id);
  } catch {
    return new PublicKey(DEFAULT_PROGRAM_ID);
  }
})();

export const STORE_AUTHORITY = (() => {
  const id = process.env.NEXT_PUBLIC_STORE_AUTHORITY || DEFAULT_STORE_AUTHORITY;
  try {
    return new PublicKey(id);
  } catch {
    return new PublicKey(DEFAULT_STORE_AUTHORITY);
  }
})();

export const STORE_SEED = "store_v2";
export const BUYER_SEED = "buyer_v2";
export const PERMISSION_SEED = "permission:";

export const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const PERMISSION_PROGRAM_ID = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
export const EPHEMERAL_VAULT_ID = new PublicKey("MagicVau1t999999999999999999999999999999999");
export const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
export const US_VALIDATOR = new PublicKey("MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd");
export const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
export const DEFAULT_QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
export const DEFAULT_EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
export const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes111111111111111111111111111");

export const L1_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
export const ER_RPC = "https://devnet-us.magicblock.app";
export const TEE_RPC = "https://devnet-tee.magicblock.app";

export const SHARD_VALUE_LAMPORTS = 100n;

// Fixed catalog — must match ITEM_PRICES_LAMPORTS in programs/pay-maybe/src/lib.rs
export const ITEMS = [
  { id: 0, name: "Espresso Pass",    emoji: "☕", priceLamports: 20_000_000n,  priceDisplay: "0.02 SOL", description: "Single-origin digital espresso access" },
  { id: 1, name: "Founder Hoodie",   emoji: "👟", priceLamports: 50_000_000n,  priceDisplay: "0.05 SOL", description: "Limited edition physical drop" },
  { id: 2, name: "VIP Event Ticket", emoji: "🎟", priceLamports: 100_000_000n, priceDisplay: "0.10 SOL", description: "Front-row access, forever on-chain" },
  { id: 3, name: "Mystery Box",      emoji: "🎁", priceLamports: 150_000_000n, priceDisplay: "0.15 SOL", description: "Surprise collectible — could be anything" },
] as const;

export const ODDS_DISPLAY = "1% FREE · 6% half-off · 18% quarter-off · Loyalty Shards always";

export function explorerTxUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

export function explorerTeeTxUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(TEE_RPC)}`;
}

export function explorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}
