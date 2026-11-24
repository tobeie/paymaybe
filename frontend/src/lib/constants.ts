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

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const SHARD_VALUE_LAMPORTS = 100n;

export type ItemIconKey = "cup" | "hoodie" | "ticket" | "box";

export interface CatalogItem {
  id: number;
  name: string;
  icon: ItemIconKey;
  priceLamports: bigint;
  priceDisplay: string;
  description: string;
}

// Fixed catalog — must match ITEM_PRICES_LAMPORTS in programs/pay-maybe/src/lib.rs
export const ITEMS: readonly CatalogItem[] = [
  {
    id: 0,
    name: "Ephemeral Espresso",
    icon: "cup",
    priceLamports: 20_000_000n,
    priceDisplay: "0.02 SOL",
    description: "Single-origin, brewed fast. Gone before the block finishes.",
  },
  {
    id: 1,
    name: "Sub-100ms Hoodie",
    icon: "hoodie",
    priceLamports: 50_000_000n,
    priceDisplay: "0.05 SOL",
    description: "A limited drop, quicker than you can blink.",
  },
  {
    id: 2,
    name: "Hacker House Pass",
    icon: "ticket",
    priceLamports: 100_000_000n,
    priceDisplay: "0.10 SOL",
    description: "A seat at the build table, held in your wallet.",
  },
  {
    id: 3,
    name: "Mystery Rollup Box",
    icon: "box",
    priceLamports: 150_000_000n,
    priceDisplay: "0.15 SOL",
    description: "A sealed collectible. It opens when it settles.",
  },
] as const;

export type TierKey = "free" | "half" | "quarter" | "none";

export interface TierSpec {
  key: TierKey;
  lo: number;
  hi: number;
  bps: number;
  shards: number;
  stamp: string;
  sub: string;
  mini: string;
}

// Exact match to StoreVault.tier_odds_bps = [7500, 1800, 600, 100] in programs/pay-maybe/src/lib.rs
export const TIERS: Record<TierKey, TierSpec> = {
  free: { key: "free", lo: 9900, hi: 9999, bps: 10000, shards: 10, stamp: "Free", sub: "full refund", mini: "Free" },
  half: { key: "half", lo: 9300, hi: 9899, bps: 5000, shards: 25, stamp: "50% off", sub: "cashback", mini: "50%" },
  quarter: { key: "quarter", lo: 7500, hi: 9299, bps: 2500, shards: 50, stamp: "25% off", sub: "cashback", mini: "25%" },
  none: { key: "none", lo: 0, hi: 7499, bps: 0, shards: 100, stamp: "+100 shards", sub: "thanks for shopping", mini: "+100" },
};

export function tierOfBps(rebateBps: number): TierSpec {
  if (rebateBps >= 10000) return TIERS.free;
  if (rebateBps >= 5000) return TIERS.half;
  if (rebateBps >= 2500) return TIERS.quarter;
  return TIERS.none;
}

export function tierOfRoll(rollBps: number): TierSpec {
  if (rollBps >= 9900) return TIERS.free;
  if (rollBps >= 9300) return TIERS.half;
  if (rollBps >= 7500) return TIERS.quarter;
  return TIERS.none;
}

export function formatSol(lamports: bigint | number, decimals = 4): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(decimals);
}

export function formatSolShort(lamports: bigint | number): string {
  const v = Number(lamports) / LAMPORTS_PER_SOL;
  return (v >= 1 ? v.toFixed(2) : v.toFixed(3)).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatRoll(rollBps: number): string {
  const s = String(Math.max(0, Math.min(9999, Math.trunc(rollBps)))).padStart(4, "0");
  return `${s[0]},${s.slice(1)}`;
}

export function shortKey(s: string): string {
  if (s.length <= 10) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;

export function formatReceiptDate(ts: number): string {
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = MONTHS[d.getMonth()];
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd} ${mm} ${yyyy}  ${hh}:${mi}`;
}

export function explorerTxUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

export function explorerTeeTxUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(TEE_RPC)}`;
}

export function explorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}
