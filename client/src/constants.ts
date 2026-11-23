import { PublicKey } from "@solana/web3.js";

// Program ID — matches target/deploy/pay_maybe-keypair.json
export const PROGRAM_ID = new PublicKey("BxHVeQ7R5LuPLnoL6ySbiDstPChxJcEgPjoHCWgo2erX");
export const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const PERMISSION_PROGRAM_ID = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
export const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");

// Validators
export const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
export const US_VALIDATOR = new PublicKey("MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd");

// VRF Queues
export const DEFAULT_QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
export const DEFAULT_EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");

// Endpoints
export const L1_ENDPOINT = "https://api.devnet.solana.com";
export const US_ER_ENDPOINT = "https://devnet-us.magicblock.app";
export const TEE_ENDPOINT = "https://devnet-tee.magicblock.app";

// Economics
export const SHARD_VALUE_LAMPORTS = 100n;
export const PROTOCOL_FEE_BPS = 1000;

// Rebate tiers
export const TIER_FREE = 10000;
export const TIER_HALF = 5000;
export const TIER_QUARTER = 2500;
export const TIER_NONE = 0;

// Item catalog
export const ITEMS = [
  { id: 0, name: "Espresso Pass", emoji: "☕", priceLamports: 20_000_000n, priceDisplay: "0.02 SOL", description: "Single-origin digital espresso access" },
  { id: 1, name: "Founder Hoodie", emoji: "👟", priceLamports: 50_000_000n, priceDisplay: "0.05 SOL", description: "Limited edition physical drop" },
  { id: 2, name: "VIP Event Ticket", emoji: "🎟", priceLamports: 100_000_000n, priceDisplay: "0.10 SOL", description: "Front-row access, forever on-chain" },
  { id: 3, name: "Mystery Box", emoji: "🎁", priceLamports: 150_000_000n, priceDisplay: "0.15 SOL", description: "Surprise collectible — could be anything" },
] as const;

export function explorerTxUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}
