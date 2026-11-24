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
  SHARD_VALUE_LAMPORTS,
  ITEMS,
  formatSol,
  formatSolShort,
  formatRoll,
  shortKey,
  explorerTxUrl,
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
  itemId: number;
  receiptNo: string;
  priceLamports: bigint;
  rebateBps: number;
  rebateLamports: bigint;
  netLamports: bigint;
  shardsEarned: bigint;
  rollBps: number;
  txSignatures: Record<string, string>;
  privacyVerified: boolean;
  settledAt: number;
}

export interface ReceiptHistoryItem {
  receiptNo: string;
  itemId: number;
  rollBps: number;
  rebateBps: number;
  priceLamports: string;
  rebateLamports: string;
  shardsEarned: string;
  escrowSig: string;
  teeSig: string;
  settleSig: string;
  at: number;
}

export interface CarbonSnapshot {
  pda: string;
  yourCopy: string;
  strangerCopy: string;
  verified: boolean;
  note: string;
  checkedAt: number;
}

export interface ToastItem {
  id: number;
  title: string;
  lines: string[];
  txUrl?: string;
  txLabel?: string;
}

export interface PayMaybeState {
  phase: SpinPhase;
  activeItemId: number | null;
  result: SpinResult | null;
  error: string | null;
  txSigs: Record<string, string>;
  carbon: CarbonSnapshot | null;
  walletBalanceLamports: bigint;
  shardBalance: bigint;
  claimableLamports: bigint;
  totalCheckoutsOnChain: number;
  isBuyerInitialized: boolean;
  history: ReceiptHistoryItem[];
  toasts: ToastItem[];
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

export function deriveStoreVaultPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [utf8Bytes(STORE_SEED), STORE_AUTHORITY.toBytes()],
    PROGRAM_ID
  )[0];
}

export function deriveBuyerAccountPda(storeVault: PublicKey, buyer: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [utf8Bytes(BUYER_SEED), storeVault.toBytes(), buyer.toBytes()],
    PROGRAM_ID
  )[0];
}

export function derivePermissionPda(buyerAccount: PublicKey): PublicKey {
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

function historyStorageKey(pubkey: string): string {
  return `paymaybe-devnet-history-v2:${pubkey}`;
}

function loadHistory(pubkey: string): ReceiptHistoryItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(historyStorageKey(pubkey));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReceiptHistoryItem[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(pubkey: string, items: ReceiptHistoryItem[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(historyStorageKey(pubkey), JSON.stringify(items.slice(0, 40)));
  } catch {
    // Ignore storage quota errors
  }
}

export function usePayMaybe() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const teeTokenCache = useRef<{ pubkey: string; token: string; expiresAt: number } | null>(null);
  const toastSeq = useRef(0);
  const lastConnectedPubkey = useRef<string | null>(null);

  const [state, setState] = useState<PayMaybeState>({
    phase: "idle",
    activeItemId: null,
    result: null,
    error: null,
    txSigs: {},
    carbon: null,
    walletBalanceLamports: 0n,
    shardBalance: 0n,
    claimableLamports: 0n,
    totalCheckoutsOnChain: 0,
    isBuyerInitialized: false,
    history: [],
    toasts: [],
  });

  const pushToast = useCallback(
    (title: string, lines: string[], txUrl?: string, txLabel?: string) => {
      const id = ++toastSeq.current;
      setState((s) => ({
        ...s,
        toasts: [...s.toasts, { id, title, lines, txUrl, txLabel }],
      }));
      setTimeout(() => {
        setState((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) }));
      }, 4200);
    },
    []
  );

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
    if (!wallet.publicKey) {
      setState((s) => ({
        ...s,
        walletBalanceLamports: 0n,
        shardBalance: 0n,
        claimableLamports: 0n,
        totalCheckoutsOnChain: 0,
        isBuyerInitialized: false,
        history: [],
      }));
      return;
    }
    const pubkeyStr = wallet.publicKey.toBase58();
    const storedHistory = loadHistory(pubkeyStr);

    try {
      const storeVault = deriveStoreVaultPda();
      const buyerAccount = deriveBuyerAccountPda(storeVault, wallet.publicKey);
      const [bal, info] = await Promise.all([
        connection.getBalance(wallet.publicKey, "confirmed"),
        connection.getAccountInfo(buyerAccount, "confirmed"),
      ]);

      if (info && info.data.length >= BUYER_ACCOUNT_SIZE) {
        const decoded = decodeBuyerAccount(info.data);
        setState((s) => ({
          ...s,
          walletBalanceLamports: BigInt(bal),
          shardBalance: decoded.shardBalance,
          claimableLamports: decoded.claimableRebateLamports,
          totalCheckoutsOnChain: Number(decoded.totalCheckouts),
          isBuyerInitialized: true,
          history: storedHistory,
        }));
      } else {
        setState((s) => ({
          ...s,
          walletBalanceLamports: BigInt(bal),
          shardBalance: 0n,
          claimableLamports: 0n,
          totalCheckoutsOnChain: 0,
          isBuyerInitialized: false,
          history: storedHistory,
        }));
      }

      if (lastConnectedPubkey.current !== pubkeyStr) {
        lastConnectedPubkey.current = pubkeyStr;
        pushToast("WALLET CONNECTED", [
          shortKey(pubkeyStr),
          `${formatSolShort(bal)} DEVNET SOL`,
        ]);
      }
    } catch {
      setState((s) => ({ ...s, history: storedHistory }));
    }
  }, [connection, wallet.publicKey, pushToast]);

  useEffect(() => {
    if (!wallet.publicKey) {
      lastConnectedPubkey.current = null;
    }
    void refreshAccount();
  }, [wallet.publicKey, refreshAccount]);

  const signAndSend = useCallback(
    async (conn: Connection, tx: Transaction, skipPreflight = false): Promise<string> => {
      if (!wallet.publicKey || !wallet.signTransaction) {
        throw new Error("Wallet does not support signing transactions.");
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
   * Honest dual-read MagicBlock TEE privacy comparison ("Your copy" vs "A stranger's copy"):
   *  1. Owner read:    GET devnet-tee.magicblock.app?token=<jwt> -> decoded BuyerAccount
   *  2. Stranger read: GET devnet-tee.magicblock.app             -> must return null or 401/403
   * Never fabricates a "null" or "verified" result from a catch block or undelegated account.
   */
  const verifyPrivacy = useCallback(
    async (buyerAccountPubkey?: PublicKey, existingToken?: string): Promise<CarbonSnapshot> => {
      const storeVault = deriveStoreVaultPda();
      const pda =
        buyerAccountPubkey ??
        (wallet.publicKey ? deriveBuyerAccountPda(storeVault, wallet.publicKey) : null);

      if (!pda || !wallet.publicKey) {
        const snap: CarbonSnapshot = {
          pda: "",
          yourCopy: "Wallet not connected.",
          strangerCopy: "Connect a wallet first to read your buyer account PDA.",
          verified: false,
          note: "Connect your wallet to run a live dual read against devnet-tee.magicblock.app.",
          checkedAt: Date.now(),
        };
        setState((s) => ({ ...s, carbon: snap }));
        return snap;
      }

      const pdaStr = pda.toBase58();
      try {
        const token = existingToken ?? (await getTeeAuthToken());
        const ownerConn = new Connection(`${TEE_RPC}?token=${token}`, "confirmed");
        const ownerInfo = await ownerConn.getAccountInfo(pda, "confirmed");

        if (!ownerInfo || ownerInfo.data.length < BUYER_ACCOUNT_SIZE) {
          const snap: CarbonSnapshot = {
            pda: pdaStr,
            yourCopy: `getAccountInfo(${shortKey(pdaStr)})\n→ null\n\nAccount is currently settled\non Solana L1, not in the TEE.`,
            strangerCopy: `getAccountInfo(${shortKey(pdaStr)})\n→ (skipped)\n\nAccount is not delegated\nto the private rollup right now.`,
            verified: false,
            note: "Not currently delegated to the MagicBlock TEE. Start a spin to compare live reads while active.",
            checkedAt: Date.now(),
          };
          setState((s) => ({ ...s, carbon: snap }));
          return snap;
        }

        const decoded = decodeBuyerAccount(ownerInfo.data);
        const item = ITEMS[decoded.lastItemId] ?? ITEMS[0];
        const yourCopy = [
          `getAccountInfo(${shortKey(pdaStr)})`,
          `→ BuyerAccount (${ownerInfo.data.length} bytes) {`,
          `  buyer: ${shortKey(wallet.publicKey.toBase58())}`,
          `  item: ${item.name}`,
          `  pending: ${formatSol(decoded.pendingAmount)} SOL`,
          `  spin_state: ${decoded.spinState}`,
          decoded.spinState === "Resolved" ? `  roll: ${formatRoll(decoded.lastRollBps)}` : null,
          `  is_private: ${decoded.isPrivate}`,
          `}`,
        ]
          .filter(Boolean)
          .join("\n");

        let strangerBlocked = false;
        let strangerCopy = "";
        try {
          const strangerConn = new Connection(TEE_RPC, "confirmed");
          const strangerInfo = await strangerConn.getAccountInfo(pda, "confirmed");
          if (strangerInfo === null) {
            strangerBlocked = true;
            strangerCopy = [
              `getAccountInfo(${shortKey(pdaStr)})`,
              `→ null`,
              "",
              "Permission Program hides this",
              "account from unauthenticated",
              "readers while the spin runs.",
            ].join("\n");
          } else {
            strangerBlocked = false;
            strangerCopy = [
              `getAccountInfo(${shortKey(pdaStr)})`,
              `→ EXPOSED (${strangerInfo.data.length} bytes)`,
              "",
              "Account is publicly readable",
              "on this RPC right now.",
            ].join("\n");
          }
        } catch (strangerErr: unknown) {
          const msg = strangerErr instanceof Error ? strangerErr.message : String(strangerErr);
          if (msg.includes("401") || msg.includes("403") || msg.toLowerCase().includes("unauthorized")) {
            strangerBlocked = true;
            strangerCopy = [
              `getAccountInfo(${shortKey(pdaStr)})`,
              `→ HTTP 401/403 Denied`,
              "",
              "Unauthenticated read rejected",
              "by the MagicBlock TEE.",
            ].join("\n");
          } else {
            throw strangerErr;
          }
        }

        const verified = strangerBlocked && decoded.isPrivate;
        const snap: CarbonSnapshot = {
          pda: pdaStr,
          yourCopy,
          strangerCopy,
          verified,
          note: verified
            ? `Live dual read from ${TEE_RPC} — with your signed JWT vs without auth.`
            : `Live dual read from ${TEE_RPC} — privacy is not currently enforced on this account.`,
          checkedAt: Date.now(),
        };
        setState((s) => ({ ...s, carbon: snap }));
        return snap;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const snap: CarbonSnapshot = {
          pda: pdaStr,
          yourCopy: `Error reading TEE:\n${message}`,
          strangerCopy: `Privacy check failed.\nErrors are never marked verified.`,
          verified: false,
          note: `Live read error: ${message}`,
          checkedAt: Date.now(),
        };
        setState((s) => ({ ...s, carbon: snap }));
        return snap;
      }
    },
    [wallet.publicKey, getTeeAuthToken]
  );

  const resetCheckoutState = useCallback(() => {
    setState((s) => ({
      ...s,
      phase: "idle",
      activeItemId: null,
      result: null,
      error: null,
      txSigs: {},
      carbon: null,
    }));
  }, []);

  const checkout = useCallback(
    async (itemId: number) => {
      if (!wallet.publicKey || !wallet.signTransaction) {
        setState((s) => ({
          ...s,
          error: "Connect your Phantom wallet first.",
          phase: "idle",
        }));
        return;
      }

      const item = ITEMS[itemId];
      if (!item) return;

      const storeVault = deriveStoreVaultPda();
      const buyer = wallet.publicKey;
      const buyerPubkeyStr = buyer.toBase58();
      const buyerAccount = deriveBuyerAccountPda(storeVault, buyer);
      const permissionPda = derivePermissionPda(buyerAccount);

      setState((s) => ({
        ...s,
        phase: "escrowing",
        activeItemId: item.id,
        error: null,
        result: null,
        txSigs: {},
        carbon: null,
      }));

      try {
        const storeInfo = await connection.getAccountInfo(storeVault, "confirmed");
        if (!storeInfo) {
          throw new Error(
            `StoreVault (${shortKey(storeVault.toBase58())}) is not initialized on Devnet yet.`
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
        const receiptNum = existingDecoded ? Number(existingDecoded.totalCheckouts) + 1 : 1;
        const receiptNo = String(receiptNum).padStart(4, "0");
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
          await sleep(2500);
        }

        // Authenticate with MagicBlock TEE (signed challenge -> JWT)
        setState((s) => ({ ...s, phase: "privacy" }));
        const token = await getTeeAuthToken();
        const teeAuthConn = new Connection(`${TEE_RPC}?token=${token}`, "confirmed");

        // Resume support: if BuyerAccount is already sealed on the TEE (tab closed mid-spin, or the
        // oracle was slow last time), continue exactly where the on-chain state machine left off.
        let resumeState: ReturnType<typeof decodeBuyerAccount> | null = null;
        if (alreadyDelegated) {
          const liveInfo = await teeAuthConn.getAccountInfo(buyerAccount, "confirmed");
          if (liveInfo && liveInfo.data.length >= BUYER_ACCOUNT_SIZE) {
            resumeState = decodeBuyerAccount(liveInfo.data);
          }
          if (!resumeState || resumeState.spinState === "Idle") {
            throw new Error(
              "Your account is sealed on the TEE but has no paid spin to resume. Try again in a few seconds."
            );
          }
          const pendingItem = ITEMS[resumeState.lastItemId];
          if (pendingItem && pendingItem.id !== item.id) {
            throw new Error(
              `You have an unfinished ${pendingItem.name} spin. Open that item and press Pay to finish it first.`
            );
          }
          pushToast("RESUMING SPIN", [item.name.toUpperCase(), `STATE ${resumeState.spinState.toUpperCase()}`]);
        }

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

        // Only send enable_privacy + request_spin when the account is freshly paid. A resumed
        // PendingVrf / Resolved spin must NOT request a second spin (program rejects it anyway).
        let erSpinSig = "";
        if (!resumeState || resumeState.spinState === "Paid") {
          erSpinSig = await signAndSend(teeAuthConn, erSpinTx, true);
          txSigs.spinning = erSpinSig;
        }
        setState((s) => ({ ...s, phase: "spinning", txSigs: { ...txSigs } }));

        // Capture live dual-read TEE privacy proof while BuyerAccount is actively sealed on TEE
        const carbonSnap = await verifyPrivacy(buyerAccount, token);

        // Poll authenticated TEE connection for real #[vrf_callback] callback_resolve_spin
        let resolved: ReturnType<typeof decodeBuyerAccount> | null = null;
        for (let i = 0; i < 60; i++) {
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
          throw new Error(
            "Still waiting on the MagicBlock VRF oracle. Your payment is safe on-chain. Press Pay again to resume this spin."
          );
        }

        const shardsEarned =
          resolved.shardBalance >= prevShards
            ? resolved.shardBalance - prevShards
            : resolved.shardBalance;
        const rebateLamports = resolved.claimableRebateLamports;
        const netLamports =
          item.priceLamports >= rebateLamports ? item.priceLamports - rebateLamports : 0n;

        // Reveal the real on-chain roll & begin landing odometer reel while committing back to L1
        const interimResult: SpinResult = {
          itemId: item.id,
          receiptNo,
          priceLamports: item.priceLamports,
          rebateBps: resolved.lastRebateBps,
          rebateLamports,
          netLamports,
          shardsEarned,
          rollBps: resolved.lastRollBps,
          txSignatures: { ...txSigs },
          privacyVerified: carbonSnap.verified,
          settledAt: Date.now(),
        };
        setState((s) => ({ ...s, phase: "revealing", result: interimResult }));

        // TX 3 (MagicBlock TEE -> Solana L1): close EphemeralPermission + commit_and_undelegate_buyer
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

        const now = Date.now();
        const finalResult: SpinResult = {
          ...interimResult,
          txSignatures: { ...txSigs },
          settledAt: now,
        };

        const newRecord: ReceiptHistoryItem = {
          receiptNo,
          itemId: item.id,
          rollBps: resolved.lastRollBps,
          rebateBps: resolved.lastRebateBps,
          priceLamports: item.priceLamports.toString(),
          rebateLamports: rebateLamports.toString(),
          shardsEarned: shardsEarned.toString(),
          escrowSig: txSigs.escrowing ?? "",
          teeSig: erSpinSig,
          settleSig: l1SettlementSig,
          at: now,
        };

        const nextHistory = [newRecord, ...loadHistory(buyerPubkeyStr)].slice(0, 40);
        saveHistory(buyerPubkeyStr, nextHistory);

        const updatedBal = await connection.getBalance(buyer, "confirmed").catch(() => null);

        setState((s) => ({
          ...s,
          phase: "done",
          result: finalResult,
          txSigs: { ...txSigs },
          walletBalanceLamports:
            updatedBal !== null ? BigInt(updatedBal) : s.walletBalanceLamports,
          shardBalance: resolved.shardBalance,
          claimableLamports: resolved.claimableRebateLamports,
          totalCheckoutsOnChain: Number(resolved.totalCheckouts),
          isBuyerInitialized: true,
          history: nextHistory,
        }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setState((s) => ({ ...s, error: message, phase: "idle" }));
      }
    },
    [wallet, connection, signAndSend, getTeeAuthToken, verifyPrivacy, pushToast]
  );

  const settleOnL1 = useCallback(
    async (sellShardsAmount: bigint) => {
      if (!wallet.publicKey || !wallet.signTransaction) {
        setState((s) => ({ ...s, error: "Connect your wallet first." }));
        return;
      }
      try {
        setState((s) => ({ ...s, error: null }));
        const storeVault = deriveStoreVaultPda();
        const buyer = wallet.publicKey;
        const buyerAccount = deriveBuyerAccountPda(storeVault, buyer);

        const prevClaimable = state.claimableLamports;

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
        setState((s) => ({ ...s, txSigs: { ...s.txSigs, claim: sig } }));

        if (sellShardsAmount > 0n) {
          const payoutLamports = sellShardsAmount * SHARD_VALUE_LAMPORTS;
          pushToast(
            "SHARDS SOLD",
            [
              `${sellShardsAmount.toString()} × 100 LAMPORTS`,
              `+${formatSol(payoutLamports, 7)} SOL`,
            ],
            explorerTxUrl(sig),
            `TX ${shortKey(sig)}`
          );
        } else {
          pushToast(
            "CASHBACK CLAIMED",
            [`${formatSol(prevClaimable)} SOL`],
            explorerTxUrl(sig),
            `TX ${shortKey(sig)}`
          );
        }

        await refreshAccount();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setState((s) => ({ ...s, error: message }));
        pushToast("TRANSACTION FAILED", [message.slice(0, 90)]);
      }
    },
    [wallet, connection, signAndSend, refreshAccount, state.claimableLamports, pushToast]
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
    resetCheckoutState,
    claimRebate,
    sellShards,
    verifyPrivacy,
    refreshAccount,
  };
}
