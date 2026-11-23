/**
 * PayMaybe — Live Milestone 0 Devnet + MagicBlock ER/VRF Probe
 *
 * Proves the complete end-to-end on-chain lifecycle on Solana Devnet + MagicBlock ER:
 *   1. init_store (L1) — seeds StoreVault cashback & shard buyback reserve
 *   2. init_buyer (L1) — initializes BuyerAccount PDA
 *   3. deposit_checkout (L1) — escrows 0.02 SOL into L1 StoreVault
 *   4. delegate_buyer (L1) — delegates BuyerAccount PDA to MagicBlock ER validator
 *   5. enable_privacy (ER) — activates session privacy flag on ER
 *   6. request_spin (ER) — invokes MagicBlock VRF (DEFAULT_EPHEMERAL_QUEUE)
 *   7. callback_resolve_spin (ER VRF Oracle) — verifies real VRF callback updates BuyerAccount
 *   8. commit_and_undelegate_buyer (ER -> L1) — confirms settlement via GetCommitmentSignature (SDK 0.18.0)
 *   9. claim_or_sell_shards (L1) — transfers real cashback / shard buyback SOL on L1
 *
 * Run:
 *   PROGRAM_ID=BxHVeQ7R5LuPLnoL6ySbiDstPChxJcEgPjoHCWgo2erX npm run probe
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  GetCommitmentSignature,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Verified MagicBlock & Solana Devnet Constants (Nov 2026)
const L1_RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ER_RPC_URL ?? "https://devnet-us.magicblock.app";
const ER_VALIDATOR = new PublicKey(
  process.env.ER_VALIDATOR ?? "MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd"
);
const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const DEFAULT_EPHEMERAL_QUEUE = new PublicKey(
  process.env.VRF_QUEUE ?? "5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc"
);
const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes111111111111111111111111111");

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? "BxHVeQ7R5LuPLnoL6ySbiDstPChxJcEgPjoHCWgo2erX"
);
const KEYPAIR_PATH =
  process.env.PAYER_KEYPAIR_PATH ?? path.join(os.homedir(), ".config", "solana", "id.json");

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  address?: string;
}
interface IdlInstruction {
  name: string;
  discriminator: number[];
  accounts: IdlAccount[];
}
interface IdlJson {
  address: string;
  instructions: IdlInstruction[];
}

function explorerUrl(sig: string, isEr = false): string {
  if (isEr) {
    return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(ER_RPC)}`;
  }
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function u64LE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n, 0);
  return b;
}

function u16LE(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function deriveStoreVault(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("store"), authority.toBuffer()],
    PROGRAM_ID
  );
}

function deriveBuyerAccount(storeVault: PublicKey, buyer: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("buyer"), storeVault.toBuffer(), buyer.toBuffer()],
    PROGRAM_ID
  );
}

function deriveProgramIdentityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID)[0];
}

function decodeBuyerAccount(data: Buffer) {
  // Layout matches BuyerAccount in programs/pay-maybe/src/lib.rs
  // 8 disc | 32 buyer | 32 store | 1 bump | 1 spin_state | 1 last_item_id |
  // 8 pending_amount | 2 last_rebate_bps | 8 claimable_rebate_lamports |
  // 8 shard_balance | 8 total_checkouts | 8 total_won_lamports | 1 is_private
  const spinStates = ["Idle", "PendingVrf", "Resolved"] as const;
  return {
    buyer: new PublicKey(data.subarray(8, 40)),
    store: new PublicKey(data.subarray(40, 72)),
    bump: data.readUInt8(72),
    spinState: spinStates[data.readUInt8(73)] ?? `Unknown(${data.readUInt8(73)})`,
    lastItemId: data.readUInt8(74),
    pendingAmount: data.readBigUInt64LE(75),
    lastRebateBps: data.readUInt16LE(83),
    claimableRebateLamports: data.readBigUInt64LE(85),
    shardBalance: data.readBigUInt64LE(93),
    totalCheckouts: data.readBigUInt64LE(101),
    totalWonLamports: data.readBigUInt64LE(109),
    isPrivate: data.readUInt8(117) === 1,
  };
}

function buildInstructionFromIdl(
  idl: IdlJson,
  ixName: string,
  argsData: Buffer,
  accountMap: Record<string, PublicKey>,
  remainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = []
): TransactionInstruction {
  const ixDef = idl.instructions.find((i) => i.name === ixName);
  if (!ixDef) {
    throw new Error(`Instruction '${ixName}' not found in IDL`);
  }

  const keys = ixDef.accounts.map((acc) => {
    const pubkey =
      accountMap[acc.name] ??
      (acc.address ? new PublicKey(acc.address) : undefined);
    if (!pubkey) {
      throw new Error(
        `Missing account '${acc.name}' for instruction '${ixName}'. Available map keys: ${Object.keys(accountMap).join(", ")}`
      );
    }
    return {
      pubkey,
      isSigner: Boolean(acc.signer),
      isWritable: Boolean(acc.writable),
    };
  });

  keys.push(...remainingAccounts);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data: Buffer.concat([Buffer.from(ixDef.discriminator), argsData]),
  });
}

async function sendTx(
  conn: Connection,
  payer: Keypair,
  ix: TransactionInstruction,
  label: string,
  skipPreflight = false
): Promise<string> {
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: "confirmed",
    skipPreflight,
  });
  console.log(`   ✅ ${label}: ${sig}`);
  return sig;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   PayMaybe — Live Milestone 0 Devnet + ER Probe      ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // Load compiled IDL
  const idlCandidates = [
    path.join(__dirname, "idl", "pay_maybe.json"),
    path.join(__dirname, "..", "..", "target", "idl", "pay_maybe.json"),
  ];
  const idlPath = idlCandidates.find((p) => fs.existsSync(p));
  if (!idlPath) {
    throw new Error(`Compiled IDL not found. Checked: ${idlCandidates.join(", ")}`);
  }
  const idl: IdlJson = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  console.log(`📄 Loaded IDL from ${idlPath}`);
  console.log(
    `   Instructions: ${idl.instructions.map((i) => `${i.name}(${i.accounts.map((a) => a.name).join(",")})`).join("\n                 ")}\n`
  );

  // Load keypair
  if (!fs.existsSync(KEYPAIR_PATH)) {
    throw new Error(`Keypair not found at ${KEYPAIR_PATH}`);
  }
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")))
  );
  const l1Conn = new Connection(L1_RPC, "confirmed");
  const erConn = new Connection(ER_RPC, "confirmed");

  console.log(`🔑 Payer:      ${payer.publicKey.toBase58()}`);
  console.log(`📦 Program ID: ${PROGRAM_ID.toBase58()}`);
  console.log(`🌐 L1 RPC:     ${L1_RPC}`);
  console.log(`⚡ ER RPC:     ${ER_RPC} (Validator: ${ER_VALIDATOR.toBase58()})\n`);

  // Verify program is deployed on Devnet
  const progInfo = await l1Conn.getAccountInfo(PROGRAM_ID);
  if (!progInfo || !progInfo.executable) {
    throw new Error(`Program ${PROGRAM_ID.toBase58()} is NOT deployed/executable on Devnet!`);
  }
  console.log(`✅ Program verified executable on Devnet (${progInfo.data.length} bytes)\n`);

  const balance = await l1Conn.getBalance(payer.publicKey);
  console.log(`💰 Payer L1 balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  const [storeVault] = deriveStoreVault(payer.publicKey);
  const [buyerAccount] = deriveBuyerAccount(storeVault, payer.publicKey);
  const bufferBuyerAccount = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(
    buyerAccount,
    PROGRAM_ID
  );
  const delegationRecordBuyerAccount = delegationRecordPdaFromDelegatedAccount(buyerAccount);
  const delegationMetadataBuyerAccount = delegationMetadataPdaFromDelegatedAccount(buyerAccount);
  const programIdentity = deriveProgramIdentityPda();

  console.log(`🏦 StoreVault PDA:   ${storeVault.toBase58()}`);
  console.log(`👤 BuyerAccount PDA: ${buyerAccount.toBase58()}\n`);

  const accountMap: Record<string, PublicKey> = {
    authority: payer.publicKey,
    buyer: payer.publicKey,
    payer: payer.publicKey,
    store_vault: storeVault,
    buyer_account: buyerAccount,
    buffer_buyer_account: bufferBuyerAccount,
    delegation_record_buyer_account: delegationRecordBuyerAccount,
    delegation_metadata_buyer_account: delegationMetadataBuyerAccount,
    owner_program: PROGRAM_ID,
    delegation_program: DELEGATION_PROGRAM_ID,
    magic_context: MAGIC_CONTEXT_ID,
    magic_program: MAGIC_PROGRAM_ID,
    oracle_queue: DEFAULT_EPHEMERAL_QUEUE,
    program_identity: programIdentity,
    vrf_program: VRF_PROGRAM_ID,
    slot_hashes: SLOT_HASHES_SYSVAR,
    system_program: SystemProgram.programId,
  };

  const txLinks: Record<string, string> = {};

  // STEP 1: init_store on L1 (0.1 SOL seed, odds [7500, 1800, 600, 100])
  console.log("1️⃣  [L1] init_store (0.10 SOL cashback & shard reserve)...");
  const existingStore = await l1Conn.getAccountInfo(storeVault);
  if (existingStore) {
    console.log("   ℹ️  StoreVault already initialized on L1 — skipping.");
  } else {
    const args = Buffer.concat([
      u64LE(100_000_000n), // 0.1 SOL
      u16LE(7500),
      u16LE(1800),
      u16LE(600),
      u16LE(100),
    ]);
    const ix = buildInstructionFromIdl(idl, "init_store", args, accountMap);
    const sig = await sendTx(l1Conn, payer, ix, "init_store");
    txLinks["init_store (L1)"] = explorerUrl(sig);
  }

  // STEP 2: init_buyer on L1
  console.log("\n2️⃣  [L1] init_buyer...");
  const existingBuyer = await l1Conn.getAccountInfo(buyerAccount);
  if (existingBuyer && existingBuyer.owner.equals(DELEGATION_PROGRAM_ID)) {
    console.log("   ℹ️  BuyerAccount already delegated to ER — jumping to ER steps.");
  } else {
    const initBuyerIx = buildInstructionFromIdl(idl, "init_buyer", Buffer.alloc(0), accountMap);
    const initSig = await sendTx(l1Conn, payer, initBuyerIx, "init_buyer");
    txLinks["init_buyer (L1)"] = explorerUrl(initSig);

    // STEP 3: deposit_checkout on L1 (item 0 = Espresso Pass, 0.02 SOL)
    console.log("\n3️⃣  [L1] deposit_checkout (item=0 Espresso Pass, 0.02 SOL)...");
    const depositArgs = Buffer.concat([Buffer.from([0]), u64LE(20_000_000n)]);
    const depositIx = buildInstructionFromIdl(idl, "deposit_checkout", depositArgs, accountMap);
    const depSig = await sendTx(l1Conn, payer, depositIx, "deposit_checkout");
    txLinks["deposit_checkout (L1)"] = explorerUrl(depSig);

    // STEP 4: delegate_buyer on L1 -> MagicBlock ER
    console.log("\n4️⃣  [L1] delegate_buyer -> MagicBlock ER...");
    const delegateIx = buildInstructionFromIdl(idl, "delegate_buyer", Buffer.alloc(0), accountMap, [
      { pubkey: ER_VALIDATOR, isSigner: false, isWritable: false },
    ]);
    const delSig = await sendTx(l1Conn, payer, delegateIx, "delegate_buyer");
    txLinks["delegate_buyer (L1)"] = explorerUrl(delSig);

    console.log("   ⏳ Waiting 3s for ER validator to pick up delegation...");
    await sleep(3000);
  }

  // STEP 5: enable_privacy on ER
  console.log("\n5️⃣  [ER] enable_privacy...");
  const privIx = buildInstructionFromIdl(idl, "enable_privacy", Buffer.alloc(0), accountMap);
  const privSig = await sendTx(erConn, payer, privIx, "enable_privacy (ER)", true);
  txLinks["enable_privacy (ER)"] = explorerUrl(privSig, true);

  // STEP 6: request_spin on ER -> MagicBlock VRF
  console.log("\n6️⃣  [ER] request_spin (MagicBlock VRF on DEFAULT_EPHEMERAL_QUEUE)...");
  const clientSeed = crypto.randomBytes(32);
  const spinIx = buildInstructionFromIdl(idl, "request_spin", clientSeed, accountMap);
  const spinSig = await sendTx(erConn, payer, spinIx, "request_spin (ER)", true);
  txLinks["request_spin (ER)"] = explorerUrl(spinSig, true);

  // STEP 7: Wait for real MagicBlock VRF callback_resolve_spin on ER
  console.log("\n7️⃣  [ER] Waiting for live MagicBlock #[vrf_callback] callback_resolve_spin...");
  let resolvedState: ReturnType<typeof decodeBuyerAccount> | null = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1500);
    const info = await erConn.getAccountInfo(buyerAccount, "confirmed");
    if (info && info.data.length >= 118) {
      const decoded = decodeBuyerAccount(info.data);
      if (decoded.spinState === "Resolved") {
        resolvedState = decoded;
        break;
      }
      console.log(`   … poll ${i + 1}/30: spinState=${decoded.spinState}`);
    }
  }
  if (!resolvedState) {
    throw new Error("Timed out waiting for MagicBlock VRF callback_resolve_spin on ER!");
  }
  console.log("   🎉 REAL VRF CALLBACK RESOLVED ON ER!");
  console.log(`      Rebate: ${(resolvedState.lastRebateBps / 100).toFixed(0)}% (${resolvedState.claimableRebateLamports} lamports)`);
  console.log(`      Shards: ${resolvedState.shardBalance} Loyalty Shards`);
  console.log(`      Private flag: ${resolvedState.isPrivate}`);

  // STEP 8: commit_and_undelegate_buyer on ER -> confirm L1 settlement via SDK 0.18.0 GetCommitmentSignature
  console.log("\n8️⃣  [ER -> L1] commit_and_undelegate_buyer...");
  const commitIx = buildInstructionFromIdl(
    idl,
    "commit_and_undelegate_buyer",
    Buffer.alloc(0),
    accountMap
  );
  const erCommitSig = await sendTx(erConn, payer, commitIx, "commit_and_undelegate_buyer (ER)", true);
  txLinks["commit_and_undelegate (ER)"] = explorerUrl(erCommitSig, true);

  console.log("   ⏳ Tracking L1 settlement via GetCommitmentSignature (SDK 0.18.0 v1/v2)...");
  const l1CommitSig = await GetCommitmentSignature(erCommitSig, erConn);
  console.log(`   ✅ L1 Settlement Confirmed: ${l1CommitSig}`);
  txLinks["L1 settlement commit"] = explorerUrl(l1CommitSig);

  // Wait briefly for L1 owner to switch back to PROGRAM_ID
  for (let i = 0; i < 15; i++) {
    const l1Buyer = await l1Conn.getAccountInfo(buyerAccount, "confirmed");
    if (l1Buyer && l1Buyer.owner.equals(PROGRAM_ID)) break;
    await sleep(1000);
  }

  // STEP 9: claim_or_sell_shards on Solana L1 (claim rebate + sell 10 shards back for instant SOL)
  console.log("\n9️⃣  [L1] claim_or_sell_shards (claim rebate + sell 10 shards for instant SOL)...");
  const sellShards = resolvedState.shardBalance >= 10n ? 10n : 0n;
  const claimIx = buildInstructionFromIdl(idl, "claim_or_sell_shards", u64LE(sellShards), accountMap);
  const claimSig = await sendTx(l1Conn, payer, claimIx, "claim_or_sell_shards (L1)");
  txLinks["claim_or_sell_shards (L1)"] = explorerUrl(claimSig);

  const finalBalance = await l1Conn.getBalance(payer.publicKey);
  console.log("\n══════════════════════════════════════════════════════");
  console.log("✅ MILESTONE 0 PASSED — 100% REAL DEVNET + MAGICBLOCK VRF!");
  console.log("══════════════════════════════════════════════════════");
  console.log(`Store Authority: ${payer.publicKey.toBase58()}`);
  console.log(`StoreVault PDA:  ${storeVault.toBase58()}`);
  console.log(`Final Balance:   ${(finalBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);
  console.log("Explorer Proof Links:");
  for (const [step, url] of Object.entries(txLinks)) {
    console.log(`  - ${step}: ${url}`);
  }
}

main().catch((err) => {
  console.error("\n❌ MILESTONE 0 PROBE FAILED:", err);
  process.exit(1);
});
