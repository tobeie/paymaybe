import { PublicKey } from "@solana/web3.js";

export enum SpinState {
  Idle = "Idle",
  PendingVrf = "PendingVrf",
  Resolved = "Resolved",
}

export interface StoreVault {
  authority: PublicKey;
  bump: number;
  tierOddsBps: number[];
  totalPoolLamports: bigint;
  totalShardReserve: bigint;
  totalCheckouts: bigint;
  totalPaidOutLamports: bigint;
}

export interface BuyerAccount {
  buyer: PublicKey;
  store: PublicKey;
  bump: number;
  spinState: SpinState;
  lastItemId: number;
  pendingAmount: bigint;
  lastRebateBps: number;
  claimableRebateLamports: bigint;
  shardBalance: bigint;
  totalCheckouts: bigint;
  totalWonLamports: bigint;
  isPrivate: boolean;
}

export interface SpinResult {
  rebateBps: number;
  rebateLamports: bigint;
  shardsEarned: bigint;
  roll: number;
  txSignature: string;
  explorerUrl: string;
}

export interface PDAs {
  storeVault: PublicKey;
  storeVaultBump: number;
  buyerAccount: PublicKey;
  buyerAccountBump: number;
}
