"use client";
import { Buffer } from "buffer";
import { useState, useCallback, useEffect, useRef } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  GetCommitmentSignature,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  getAuthToken,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  PROGRAM_ID,
  STORE_AUTHORITY,
  STORE_SEED,
  BUYER_SEED,
  PERMISSION_SEED,
  DELEGATION_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  VRF_PROGRAM_ID,
  TEE_VALIDATOR,
  DEFAULT_EPHEMERAL_QUEUE,
  SLOT_HASHES_SYSVAR,
  TEE_RPC,
  ITEMS,
} from "../lib/constants";

// Exact Anchor 1.0.2 discriminators (sha256("global:<ix_name>")[0..8])
const DISC = {
  init_buyer: new Uint8Array([170, 91, 154, 196, 66, 193, 24, 214]),
  deposit_checkout: new Uint8Array([247, 154, 78, 0, 167, 92, 3, 171]),
  delegate_buyer: new Uint8Array([51, 248, 83, 174, 56, 50, 139, 29]),
  enable_privacy: new Uint8Array([41, 169, 68, 23, 204, 42, 113, 59]),
  request_spin: new Uint8Array([186, 157, 114, 217, 55, 116, 223, 114]),
  commit_and_undelegate_buyer: new Uint8Array([65, 6, 85, 41, 85, 190, 235, 151]),
  claim_or_sell_shards: new Uint8Array([17, 85, 56, 128, 207, 170, 117, 197]),
} as const;

const BUYER_ACCOUNT_SIZE = 136;

export type SpinPhase =
  | "idle"
  | "escrowing"
  | "delegating"
  | "privacy"
  | "spinning"
  | "revealing"
  | "done";

export interface SpinResult {
  rebateBps: number;
  rebateLamports: bigint;
  shardsEarned: bigint;
  rollBps: number;
  txSignatures: Record<string, string>;
  privacyVerified: boolean;
}

export interface CheckoutRecord {
  txSig: string;
  status: string;
  itemName: string;
  rebateBps: number;
}

export interface PrivacyCheckOutcome {
  verified: boolean;
  proof: string;
}

export interface PayMaybeState {
  phase: SpinPhase;
  result: SpinResult | null;
  error: string | null;
  txSigs: Record<string, string>;
  privacyProof: string | null;
  privacyVerified: boolean;
  shardBalance: bigint;
  claimableLamports: bigint;
  isBuyerInitialized: boolean;
  lastCheckouts: CheckoutRecord[];
}

function utf8Bytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function u64LE(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function deriveStoreVaultPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [utf8Bytes(STORE_SEED), STORE_AUTHORITY.toBytes()],
    PROGRAM_ID
  )[0];
}

function deriveBuyerAccountPda(storeVault: PublicKey, buyer: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [utf8Bytes(BUYER_SEED), storeVault.toBytes(), buyer.toBytes()],
    PROGRAM_ID
  )[0];
}

function derivePermissionPda(buyerAccount: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [utf8Bytes(PERMISSION_SEED), buyerAccount.toBytes()],
    PERMISSION_PROGRAM_ID
  )[0];
}

function deriveProgramIdentityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([utf8Bytes("identity")], PROGRAM_ID)[0];
}

type DecodedSpinState = "Idle" | "Paid" | "PendingVrf" | "Resolved";

function decodeBuyerAccount(raw: Uint8Array) {
  // Exact 136-byte v2 layout matching BuyerAccount in programs/pay-maybe/src/lib.rs
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const spinStateNum = view.getUint8(73);
  const spinStateMap: DecodedSpinState[] = ["Idle", "Paid", "PendingVrf", "Resolved"];
  return {
    spinState: spinStateMap[spinStateNum] ?? "Idle",
    lastItemId: view.getUint8(74),
    pendingAmount: view.getBigUint64(75, true),
    unsettledEscrowLamports: view.getBigUint64(83, true),
    tierOddsBps: [
      view.getUint16(91, true),
      view.getUint16(93, true),
      view.getUint16(95, true),
      view.getUint16(97, true),
    ] as [number, number, number, number],
    lastRollBps: view.getUint16(99, true),
    lastRebateBps: view.getUint16(101, true),
    claimableRebateLamports: view.getBigUint64(103, true),
    shardBalance: view.getBigUint64(111, true),
    totalCheckouts: view.getBigUint64(119, true),
    totalWonLamports: view.getBigUint64(127, true),
    isPrivate: view.getUint8(135) === 1,
  };
}

export function usePayMaybe() {
  const { connection } = useConnection();
  const wallet = useWallet();

  // Cache TEE auth token per connected wallet pubkey so the buyer signs only once per session
  const teeTokenCache = useRef<{ pubkey: string; token: string; expiresAt: number } | null>(null);

  const [state, setState] = useState<PayMaybeState>({
    phase: "idle",
    result: null,
    error: null,
    txSigs: {},
    privacyProof: null,
    privacyVerified: false,
    shardBalance: 0n,
    claimableLamports: 0n,
    isBuyerInitialized: false,
    lastCheckouts: [],
  });

  const getTeeAuthToken = useCallback(async (): Promise<string> => {
    if (!wallet.publicKey || !wallet.signMessage) {
      throw new Error(
        "Your wallet must support message signing (signMessage) to authenticate with the MagicBlock TEE."
      );
    }
    const pubkeyStr = wallet.publicKey.toBase58();
    const cached = teeTokenCache.current;
    if (cached && cached.pubkey === pubkeyStr && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }
    const { token, expiresAt } = await getAuthToken(TEE_RPC, wallet.publicKey, wallet.signMessage);
    teeTokenCache.current = { pubkey: pubkeyStr, token, expiresAt };
    return token;
  }, [wallet.publicKey, wallet.signMessage]);

  const refreshAccount = useCallback(async () => {
    if (!wallet.publicKey) return;
    try {
      const storeVault = deriveStoreVaultPda();
      const buyerAccount = deriveBuyerAccountPda(storeVault, wallet.publicKey);
      const info = await connection.getAccountInfo(buyerAccount, "confirmed");
      if (info && info.data.length >= BUYER_ACCOUNT_SIZE) {
        const decoded = decodeBuyerAccount(info.data);
        setState((s) => ({
          ...s,
          shardBalance: decoded.shardBalance,
          claimableLamports: decoded.claimableRebateLamports,
          isBuyerInitialized: true,
        }));
      }
    } catch {
      // Non-fatal on initial load
    }
  }, [connection, wallet.publicKey]);

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  const signAndSend = useCallback(
    async (conn: Connection, tx: Transaction, skipPreflight = false): Promise<string> => {
      if (!wallet.publicKey || !wallet.signTransaction) {
        throw new Error("Wallet does not support signing transactions");
      }
      tx.feePayer = wallet.publicKey;
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      const signed = await wallet.signTransaction(tx);
      const sig = await conn.sendRawTransaction(signed.serialize(), {
        skipPreflight,
        preflightCommitment: "confirmed",
      });
      await conn.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed"
      );
      return sig;
    },
    [wallet]
  );

  /**
   * Honest dual-read MagicBlock TEE privacy verification:
   *  1. Stranger read: GET devnet-tee.magicblock.app (NO auth token) -> must return null or 401/403.
   *  2. Owner read:    GET devnet-tee.magicblock.app?token=<jwt>     -> must return live BuyerAccount bytes.
   *
   * ONLY marks verified=true when BOTH hold simultaneously. Never reports errors or undelegated
   * accounts as verified.
   */
  const verifyPrivacy = useCallback(
    async (buyerAccountPubkey?: PublicKey, existingToken?: string): Promise<PrivacyCheckOutcome> => {
      try {
        const storeVault = deriveStoreVaultPda();
        const pda =
          buyerAccountPubkey ??
          (wallet.publicKey ? deriveBuyerAccountPda(storeVault, wallet.publicKey) : null);

        if (!pda) {
          const proof = "Connect your Phantom wallet first to verify your BuyerAccount PDA on TEE.";
          setState((s) => ({ ...s, privacyProof: proof, privacyVerified: false }));
          return { verified: false, proof };
        }

        const token = existingToken ?? (await getTeeAuthToken());

        // 1. Authenticated owner read (proves account is genuinely live inside the TEE)
        const ownerConn = new Connection(`${TEE_RPC}?token=${token}`, "confirmed");
        const ownerInfo = await ownerConn.getAccountInfo(pda, "confirmed");

        if (!ownerInfo || ownerInfo.data.length < BUYER_ACCOUNT_SIZE) {
          const proof = [
            `TEE: ${TEE_RPC}`,
            `PDA: ${pda.toBase58()}`,
            `Owner read (?token=...): null`,
            "",
            "ℹ️ Account is not currently delegated to the MagicBlock TEE (settled on Solana L1).",
            "Start a checkout to verify live Intel TDX access control during an active spin.",
          ].join("\n");
          setState((s) => ({ ...s, privacyProof: proof, privacyVerified: false }));
          return { verified: false, proof };
        }

        const decoded = decodeBuyerAccount(ownerInfo.data);

        // 2. Unauthenticated stranger read against the SAME TEE endpoint (no token)
        let strangerBlocked = false;
        let strangerSummary = "";
        try {
          const strangerConn = new Connection(TEE_RPC, "confirmed");
          const strangerInfo = await strangerConn.getAccountInfo(pda, "confirmed");
          if (strangerInfo === null) {
            strangerBlocked = true;
            strangerSummary = `{ "value": null }`;
          } else {
            strangerBlocked = false;
            strangerSummary = `EXPOSED (${strangerInfo.data.length} bytes visible)`;
          }
        } catch (strangerErr: unknown) {
          const msg = strangerErr instanceof Error ? strangerErr.message : String(strangerErr);
          if (msg.includes("401") || msg.includes("403") || msg.toLowerCase().includes("unauthorized")) {
            strangerBlocked = true;
            strangerSummary = `HTTP 401/403 Denied (${msg.slice(0, 80)})`;
          } else {
            throw strangerErr;
          }
        }

        const verified = strangerBlocked && decoded.isPrivate;
        const proof = verified
          ? [
              `TEE: ${TEE_RPC}`,
              `PDA: ${pda.toBase58()}`,
              `1) Stranger (no token):   ${strangerSummary}`,
              `2) Owner (TEE JWT token): ${ownerInfo.data.length} bytes (spinState=${decoded.spinState}, isPrivate=${decoded.isPrivate})`,
              "",
              "✅ TEE PRIVACY VERIFIED: Permission Program hides active session from strangers while owner reads live state.",
            ].join("\n")
          : [
              `TEE: ${TEE_RPC}`,
              `PDA: ${pda.toBase58()}`,
              `1) Stranger (no token):   ${strangerSummary}`,
              `2) Owner (TEE JWT token): ${ownerInfo.data.length} bytes (spinState=${decoded.spinState}, isPrivate=${decoded.isPrivate})`,
              "",
              "⚠️ PRIVACY NOT ACTIVE: Account is currently readable without authentication.",
            ].join("\n");

        setState((s) => ({ ...s, privacyProof: proof, privacyVerified: verified }));
        return { verified, proof };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const proof = `TEE Privacy Check Failed\nEndpoint: ${TEE_RPC}\nError: ${message}`;
        setState((s) => ({ ...s, privacyProof: proof, privacyVerified: false }));
        return { verified: false, proof };
      }
    },
    [wallet.publicKey, getTeeAuthToken]
  );

  const cancelCheckout = useCallback(() => {
    setState((s) => ({ ...s, phase: "idle" }));
  }, []);

  const checkout = useCallback(
    async (itemId: number) => {
      if (!wallet.publicKey || !wallet.signTransaction) {
        setState((s) => ({
          ...s,
          error: "Please connect your Phantom wallet first",
          phase: "idle",
        }));
        return;
      }

      const item = ITEMS[itemId];
      if (!item) return;

      const storeVault = deriveStoreVaultPda();
      const buyer = wallet.publicKey;
      const buyerAccount = deriveBuyerAccountPda(storeVault, buyer);
      const permissionPda = derivePermissionPda(buyerAccount);

      setState((s) => ({
        ...s,
        phase: "escrowing",
        error: null,
        result: null,
        txSigs: {},
        privacyProof: null,
        privacyVerified: false,
      }));

      try {
        // Verify v2 StoreVault exists on Devnet before charging buyer
        const storeInfo = await connection.getAccountInfo(storeVault, "confirmed");
        if (!storeInfo) {
          throw new Error(
            `StoreVault (${storeVault.toBase58().slice(0, 8)}…) is not initialized on Devnet yet. Run the Deploy & Milestone 0 workflow first.`
          );
        }

        const existingBuyerInfo = await connection.getAccountInfo(buyerAccount, "confirmed");
        const alreadyDelegated =
          existingBuyerInfo !== null && existingBuyerInfo.owner.equals(DELEGATION_PROGRAM_ID);

        const existingDecoded =
          existingBuyerInfo && existingBuyerInfo.data.length >= BUYER_ACCOUNT_SIZE
            ? decodeBuyerAccount(existingBuyerInfo.data)
            : null;

        const prevShards = existingDecoded ? existingDecoded.shardBalance : 0n;
        const txSigs: Record<string, string> = {};

        // TX 1 (Solana L1): init_buyer (if needed) + auto-claim prior rebate (if any) + deposit_checkout + delegate_buyer -> TEE_VALIDATOR
        if (!alreadyDelegated) {
          const l1Tx = new Transaction();

          if (!existingBuyerInfo) {
            l1Tx.add(
              new TransactionInstruction({
                programId: PROGRAM_ID,
                keys: [
                  { pubkey: buyerAccount, isSigner: false, isWritable: true },
                  { pubkey: storeVault, isSigner: false, isWritable: false },
                  { pubkey: buyer, isSigner: true, isWritable: true },
                  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                ],
                data: Buffer.from(DISC.init_buyer),
              })
            );
          }

          // If buyer won cashback on an earlier checkout and didn't manually claim yet,
          // auto-claim it in this same L1 tx so deposit_checkout's escrow invariant passes cleanly.
          if (existingDecoded && existingDecoded.claimableRebateLamports > 0n) {
            l1Tx.add(
              new TransactionInstruction({
                programId: PROGRAM_ID,
                keys: [
                  { pubkey: buyerAccount, isSigner: false, isWritable: true },
                  { pubkey: storeVault, isSigner: false, isWritable: true },
                  { pubkey: buyer, isSigner: true, isWritable: true },
                  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                ],
                data: Buffer.from(concatBytes(DISC.claim_or_sell_shards, u64LE(0n))),
              })
            );
          }

          // Deposit fixed catalog price unless already in Paid state from an interrupted session
          if (!existingDecoded || existingDecoded.spinState !== "Paid") {
            l1Tx.add(
              new TransactionInstruction({
                programId: PROGRAM_ID,
                keys: [
                  { pubkey: buyerAccount, isSigner: false, isWritable: true },
                  { pubkey: storeVault, isSigner: false, isWritable: true },
                  { pubkey: buyer, isSigner: true, isWritable: true },
                  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                ],
                data: Buffer.from(
                  concatBytes(
                    DISC.deposit_checkout,
                    new Uint8Array([item.id]),
                    u64LE(item.priceLamports)
                  )
                ),
              })
            );
          }

          // Delegate BuyerAccount -> MagicBlock TEE Validator (MTEWGuqx...)
          const bufferPda = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(
            buyerAccount,
            PROGRAM_ID
          );
          const delegationRecordPda = delegationRecordPdaFromDelegatedAccount(buyerAccount);
          const delegationMetadataPda = delegationMetadataPdaFromDelegatedAccount(buyerAccount);

          l1Tx.add(
            new TransactionInstruction({
              programId: PROGRAM_ID,
              keys: [
                { pubkey: buyer, isSigner: true, isWritable: true },
                { pubkey: storeVault, isSigner: false, isWritable: false },
                { pubkey: bufferPda, isSigner: false, isWritable: true },
                { pubkey: delegationRecordPda, isSigner: false, isWritable: true },
                { pubkey: delegationMetadataPda, isSigner: false, isWritable: true },
                { pubkey: buyerAccount, isSigner: false, isWritable: true },
                { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: TEE_VALIDATOR, isSigner: false, isWritable: false },
              ],
              data: Buffer.from(DISC.delegate_buyer),
            })
          );

          const l1Sig = await signAndSend(connection, l1Tx, false);
          txSigs.escrowing = l1Sig;
          setState((s) => ({ ...s, phase: "delegating", txSigs: { ...txSigs } }));

          // Wait briefly for TEE validator to sync delegated account
          await sleep(2500);
        }

        // Authenticate with MagicBlock TEE (signed challenge -> JWT query token)
        setState((s) => ({ ...s, phase: "privacy" }));
        const token = await getTeeAuthToken();
        const teeAuthConn = new Connection(`${TEE_RPC}?token=${token}`, "confirmed");

        // TX 2 (MagicBlock TEE — 0 gas): enable_privacy (Permission Program CPI) + request_spin (VRF)
        const clientSeed = new Uint8Array(32);
        crypto.getRandomValues(clientSeed);
        const programIdentity = deriveProgramIdentityPda();

        const erSpinTx = new Transaction()
          .add(
            new TransactionInstruction({
              programId: PROGRAM_ID,
              keys: [
                { pubkey: buyer, isSigner: true, isWritable: true },
                { pubkey: buyerAccount, isSigner: false, isWritable: true },
                { pubkey: permissionPda, isSigner: false, isWritable: true },
                { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: EPHEMERAL_VAULT_ID, isSigner: false, isWritable: true },
                { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
              ],
              data: Buffer.from(DISC.enable_privacy),
            })
          )
          .add(
            new TransactionInstruction({
              programId: PROGRAM_ID,
              keys: [
                { pubkey: buyer, isSigner: true, isWritable: true },
                { pubkey: buyerAccount, isSigner: false, isWritable: true },
                { pubkey: DEFAULT_EPHEMERAL_QUEUE, isSigner: false, isWritable: true },
                { pubkey: programIdentity, isSigner: false, isWritable: false },
                { pubkey: VRF_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: SLOT_HASHES_SYSVAR, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              ],
              data: Buffer.from(concatBytes(DISC.request_spin, clientSeed)),
            })
          );

        const erSpinSig = await signAndSend(teeAuthConn, erSpinTx, true);
        txSigs.spinning = erSpinSig;
        setState((s) => ({ ...s, phase: "spinning", txSigs: { ...txSigs } }));

        // Verify live TEE privacy AFTER enable_privacy has landed on-chain!
        const privacyCheck = await verifyPrivacy(buyerAccount, token);

        // Poll authenticated TEE connection for real #[vrf_callback] callback_resolve_spin
        let resolved: ReturnType<typeof decodeBuyerAccount> | null = null;
        for (let i = 0; i < 30; i++) {
          await sleep(1000);
          const info = await teeAuthConn.getAccountInfo(buyerAccount, "confirmed");
          if (info && info.data.length >= BUYER_ACCOUNT_SIZE) {
            const decoded = decodeBuyerAccount(info.data);
            if (decoded.spinState === "Resolved") {
              resolved = decoded;
              break;
            }
          }
        }

        if (!resolved) {
          throw new Error("Timed out waiting for MagicBlock VRF oracle callback on TEE.");
        }

        // TX 3 (MagicBlock TEE -> Solana L1): close EphemeralPermission + commit_and_undelegate_buyer
        setState((s) => ({ ...s, phase: "revealing" }));
        const erCommitTx = new Transaction().add(
          new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: buyer, isSigner: true, isWritable: true },
              { pubkey: buyerAccount, isSigner: false, isWritable: true },
              { pubkey: permissionPda, isSigner: false, isWritable: true },
              { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: EPHEMERAL_VAULT_ID, isSigner: false, isWritable: true },
              { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
            ],
            data: Buffer.from(DISC.commit_and_undelegate_buyer),
          })
        );

        const erCommitSig = await signAndSend(teeAuthConn, erCommitTx, true);
        const l1SettlementSig = await GetCommitmentSignature(erCommitSig, teeAuthConn);
        txSigs.revealing = l1SettlementSig;

        const shardsEarned =
          resolved.shardBalance >= prevShards
            ? resolved.shardBalance - prevShards
            : resolved.shardBalance;

        const spinResult: SpinResult = {
          rebateBps: resolved.lastRebateBps,
          rebateLamports: resolved.claimableRebateLamports,
          shardsEarned,
          rollBps: resolved.lastRollBps,
          txSignatures: { ...txSigs },
          privacyVerified: privacyCheck.verified,
        };

        setState((s) => ({
          ...s,
          phase: "done",
          result: spinResult,
          txSigs: { ...txSigs },
          shardBalance: resolved.shardBalance,
          claimableLamports: resolved.claimableRebateLamports,
          isBuyerInitialized: true,
          lastCheckouts: [
            {
              txSig: l1SettlementSig,
              status: "Settled on L1",
              itemName: item.name,
              rebateBps: resolved.lastRebateBps,
            },
            ...s.lastCheckouts.slice(0, 4),
          ],
        }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setState((s) => ({ ...s, error: message, phase: "idle" }));
      }
    },
    [wallet, connection, signAndSend, getTeeAuthToken, verifyPrivacy]
  );

  const settleOnL1 = useCallback(
    async (sellShardsAmount: bigint) => {
      if (!wallet.publicKey || !wallet.signTransaction) {
        setState((s) => ({ ...s, error: "Connect Phantom wallet first" }));
        return;
      }
      try {
        setState((s) => ({ ...s, error: null }));
        const storeVault = deriveStoreVaultPda();
        const buyer = wallet.publicKey;
        const buyerAccount = deriveBuyerAccountPda(storeVault, buyer);

        const tx = new Transaction().add(
          new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: buyerAccount, isSigner: false, isWritable: true },
              { pubkey: storeVault, isSigner: false, isWritable: true },
              { pubkey: buyer, isSigner: true, isWritable: true },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: Buffer.from(concatBytes(DISC.claim_or_sell_shards, u64LE(sellShardsAmount))),
          })
        );

        const sig = await signAndSend(connection, tx, false);
        setState((s) => ({
          ...s,
          txSigs: { ...s.txSigs, claim: sig },
          lastCheckouts: [
            {
              txSig: sig,
              status: sellShardsAmount > 0n ? `Sold ${sellShardsAmount} Shards` : "Claimed SOL",
              itemName: sellShardsAmount > 0n ? "Shard Buyback (L1)" : "Cashback Claim (L1)",
              rebateBps: 0,
            },
            ...s.lastCheckouts.slice(0, 4),
          ],
        }));
        await refreshAccount();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setState((s) => ({ ...s, error: message }));
      }
    },
    [wallet, connection, signAndSend, refreshAccount]
  );

  const claimRebate = useCallback(async () => {
    await settleOnL1(0n);
  }, [settleOnL1]);

  const sellShards = useCallback(
    async (amount: bigint) => {
      if (amount <= 0n) return;
      await settleOnL1(amount);
    },
    [settleOnL1]
  );

  return {
    state,
    checkout,
    cancelCheckout,
    claimRebate,
    sellShards,
    verifyPrivacy,
    refreshAccount,
  };
}
