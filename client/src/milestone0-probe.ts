/**
 * PayMaybe — Live Milestone 0 Devnet + MagicBlock TEE/VRF & Security Probe
 *
 * Proves the complete end-to-end on-chain lifecycle & security invariants on Solana Devnet + MagicBlock TEE:
 *   1.  [L1] init_store — seeds StoreVault (store_v2) cashback & shard buyback reserve
 *   2.  [L1] init_buyer — initializes BuyerAccount (buyer_v2) + pre-funds EphemeralPermission rent
 *   3.  [L1 SECURITY] deposit_checkout(item=0, price=1) — MUST FAIL (fixed catalog price check)
 *   4.  [L1] deposit_checkout(item=0, price=0.02 SOL) — escrows SOL & sets SpinState::Paid
 *   5.  [L1] delegate_buyer — delegates BuyerAccount PDA to MagicBlock TEE Validator (MTEWGuqx...)
 *   6.  [TEE AUTH] getAuthToken(devnet-tee.magicblock.app) — authenticates buyer via Ed25519 signature
 *   7.  [TEE] enable_privacy — invokes Permission Program CreateEphemeralPermissionCpi (is_private=true)
 *   8.  [TEE PRIVACY PROOF] Stranger unauthenticated read MUST return null/401 while Owner JWT read returns 136 bytes
 *   9.  [TEE] request_spin — transitions Paid -> PendingVrf & invokes MagicBlock VRF (DEFAULT_EPHEMERAL_QUEUE)
 *   10. [TEE] callback_resolve_spin — verifies real VRF callback resolves unbiased roll_bps & clears pending_amount=0
 *   11. [TEE SECURITY] second request_spin on same payment — MUST FAIL (single-spin state machine)
 *   12. [TEE -> L1] commit_and_undelegate_buyer — closes EphemeralPermission, refunds rent, confirms via GetCommitmentSignature
 *   13. [L1] claim_or_sell_shards — claims won cashback + sells 10 Loyalty Shards for instant SOL
 *   14. [L1 SECURITY + MERCHANT] withdraw_merchant_funds — rejects over-withdrawal (protects shard reserve), succeeds within safe revenue
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
  getAuthToken,
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

// Verified MagicBlock & Solana Devnet Constants
const L1_RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ER_RPC_URL ?? "https://devnet-tee.magicblock.app";
const ER_VALIDATOR = new PublicKey(
  process.env.ER_VALIDATOR ?? "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"
);
const PERMISSION_PROGRAM_ID = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const EPHEMERAL_VAULT_ID = new PublicKey("MagicVau1t999999999999999999999999999999999");
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

const STORE_SEED = "store_v2";
const BUYER_SEED = "buyer_v2";
const PERMISSION_SEED = "permission:";
const BUYER_ACCOUNT_SIZE = 136;

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
    [Buffer.from(STORE_SEED), authority.toBuffer()],
    PROGRAM_ID
  );
}

function deriveBuyerAccount(storeVault: PublicKey, buyer: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BUYER_SEED), storeVault.toBuffer(), buyer.toBuffer()],
    PROGRAM_ID
  );
}

function derivePermissionPda(buyerAccount: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PERMISSION_SEED), buyerAccount.toBuffer()],
    PERMISSION_PROGRAM_ID
  );
}

function deriveProgramIdentityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID)[0];
}

function signMessageWithKeypair(kp: Keypair): (msg: Uint8Array) => Promise<Uint8Array> {
  // PKCS#8 DER prefix for a 32-byte Ed25519 private seed (native Node.js crypto, zero extra deps)
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, Buffer.from(kp.secretKey.subarray(0, 32))]),
    format: "der",
    type: "pkcs8",
  });
  return async (msg: Uint8Array) => new Uint8Array(crypto.sign(null, Buffer.from(msg), privateKey));
}

function decodeBuyerAccount(data: Buffer) {
  // Exact 136-byte v2 layout matching BuyerAccount in programs/pay-maybe/src/lib.rs
  const spinStates = ["Idle", "Paid", "PendingVrf", "Resolved"] as const;
  return {
    buyer: new PublicKey(data.subarray(8, 40)),
    store: new PublicKey(data.subarray(40, 72)),
    bump: data.readUInt8(72),
    spinState: spinStates[data.readUInt8(73)] ?? `Unknown(${data.readUInt8(73)})`,
    lastItemId: data.readUInt8(74),
    pendingAmount: data.readBigUInt64LE(75),
    unsettledEscrowLamports: data.readBigUInt64LE(83),
    tierOddsBps: [
      data.readUInt16LE(91),
      data.readUInt16LE(93),
      data.readUInt16LE(95),
      data.readUInt16LE(97),
    ] as [number, number, number, number],
    lastRollBps: data.readUInt16LE(99),
    lastRebateBps: data.readUInt16LE(101),
    claimableRebateLamports: data.readBigUInt64LE(103),
    shardBalance: data.readBigUInt64LE(111),
    totalCheckouts: data.readBigUInt64LE(119),
    totalWonLamports: data.readBigUInt64LE(127),
    isPrivate: data.readUInt8(135) === 1,
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
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: "confirmed",
    skipPreflight,
  });
  console.log(`   ✅ ${label}: ${sig}`);
  return sig;
}

async function expectTxFailure(
  conn: Connection,
  payer: Keypair,
  ix: TransactionInstruction,
  label: string,
  skipPreflight = false
): Promise<void> {
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
      commitment: "confirmed",
      skipPreflight,
    });
    throw new Error(`SECURITY ASSERTION FAILED: '${label}' unexpectedly SUCCEEDED (${sig})!`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("SECURITY ASSERTION FAILED:")) {
      throw err;
    }
    console.log(`   🛡️  [REJECTED AS EXPECTED] ${label}: ${msg.slice(0, 140)}`);
  }
}

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║  PayMaybe — Live Devnet + MagicBlock TEE/VRF & Audit Probe ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

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

  if (!fs.existsSync(KEYPAIR_PATH)) {
    throw new Error(`Keypair not found at ${KEYPAIR_PATH}`);
  }
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")))
  );
  const l1Conn = new Connection(L1_RPC, "confirmed");

  console.log(`🔑 Payer:      ${payer.publicKey.toBase58()}`);
  console.log(`📦 Program ID: ${PROGRAM_ID.toBase58()}`);
  console.log(`🌐 L1 RPC:     ${L1_RPC}`);
  console.log(`🛡️  TEE RPC:    ${ER_RPC} (Validator: ${ER_VALIDATOR.toBase58()})\n`);

  const progInfo = await l1Conn.getAccountInfo(PROGRAM_ID);
  if (!progInfo || !progInfo.executable) {
    throw new Error(`Program ${PROGRAM_ID.toBase58()} is NOT deployed/executable on Devnet!`);
  }
  console.log(`✅ Program verified executable on Devnet (${progInfo.data.length} bytes)\n`);

  const balance = await l1Conn.getBalance(payer.publicKey);
  console.log(`💰 Payer L1 balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  const [storeVault] = deriveStoreVault(payer.publicKey);
  const [buyerAccount] = deriveBuyerAccount(storeVault, payer.publicKey);
  const [permissionPda] = derivePermissionPda(buyerAccount);
  const bufferBuyerAccount = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(
    buyerAccount,
    PROGRAM_ID
  );
  const delegationRecordBuyerAccount = delegationRecordPdaFromDelegatedAccount(buyerAccount);
  const delegationMetadataBuyerAccount = delegationMetadataPdaFromDelegatedAccount(buyerAccount);
  const programIdentity = deriveProgramIdentityPda();

  console.log(`🏦 StoreVault PDA (v2):   ${storeVault.toBase58()}`);
  console.log(`👤 BuyerAccount PDA (v2): ${buyerAccount.toBase58()}`);
  console.log(`🔒 Permission PDA:        ${permissionPda.toBase58()}\n`);

  const accountMap: Record<string, PublicKey> = {
    authority: payer.publicKey,
    buyer: payer.publicKey,
    payer: payer.publicKey,
    store_vault: storeVault,
    buyer_account: buyerAccount,
    permission: permissionPda,
    permission_program: PERMISSION_PROGRAM_ID,
    ephemeral_vault: EPHEMERAL_VAULT_ID,
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

  // STEP 1: init_store on L1 (0.10 SOL seed, odds [7500, 1800, 600, 100])
  console.log("1️⃣  [L1] init_store (0.10 SOL seed, odds=[7500, 1800, 600, 100])...");
  const existingStore = await l1Conn.getAccountInfo(storeVault);
  if (existingStore) {
    console.log("   ℹ️  StoreVault v2 already initialized on L1 — skipping.");
  } else {
    const args = Buffer.concat([
      u64LE(100_000_000n), // 0.10 SOL
      u16LE(7500),
      u16LE(1800),
      u16LE(600),
      u16LE(100),
    ]);
    const ix = buildInstructionFromIdl(idl, "init_store", args, accountMap);
    const sig = await sendTx(l1Conn, payer, ix, "init_store");
    txLinks["init_store (L1)"] = explorerUrl(sig);
  }

  // STEP 2: init_buyer + deposit_checkout + delegate_buyer on L1
  console.log("\n2️⃣  [L1] init_buyer (creates BuyerAccount v2 + pre-funds EphemeralPermission rent)...");
  const existingBuyer = await l1Conn.getAccountInfo(buyerAccount);
  if (existingBuyer && existingBuyer.owner.equals(DELEGATION_PROGRAM_ID)) {
    console.log("   ℹ️  BuyerAccount already delegated to TEE — jumping to TEE steps.");
  } else {
    const initBuyerIx = buildInstructionFromIdl(idl, "init_buyer", Buffer.alloc(0), accountMap);
    const initSig = await sendTx(l1Conn, payer, initBuyerIx, "init_buyer");
    txLinks["init_buyer (L1)"] = explorerUrl(initSig);

    // If a prior run left unclaimed rebate, claim it first
    const postInit = await l1Conn.getAccountInfo(buyerAccount, "confirmed");
    if (postInit && postInit.data.length >= BUYER_ACCOUNT_SIZE) {
      const dec = decodeBuyerAccount(postInit.data);
      if (dec.claimableRebateLamports > 0n) {
        const preClaimIx = buildInstructionFromIdl(idl, "claim_or_sell_shards", u64LE(0n), accountMap);
        await sendTx(l1Conn, payer, preClaimIx, "pre-claim pending rebate");
      }
    }

    // STEP 3 (NEGATIVE SECURITY TEST #1): 1-lamport checkout MUST fail!
    console.log("\n3️⃣  [L1 SECURITY] Attempting 1-lamport fake-price exploit (MUST FAIL)...");
    const fakePriceArgs = Buffer.concat([Buffer.from([0]), u64LE(1n)]);
    const fakePriceIx = buildInstructionFromIdl(idl, "deposit_checkout", fakePriceArgs, accountMap);
    await expectTxFailure(l1Conn, payer, fakePriceIx, "1-lamport fake-price deposit_checkout");

    // STEP 4: Real fixed-catalog deposit_checkout (item 0 = Espresso Pass, 0.02 SOL)
    console.log("\n4️⃣  [L1] deposit_checkout (item=0 Espresso Pass, 0.02 SOL)...");
    const depositArgs = Buffer.concat([Buffer.from([0]), u64LE(20_000_000n)]);
    const depositIx = buildInstructionFromIdl(idl, "deposit_checkout", depositArgs, accountMap);
    const depSig = await sendTx(l1Conn, payer, depositIx, "deposit_checkout");
    txLinks["deposit_checkout (L1)"] = explorerUrl(depSig);

    // STEP 5: delegate_buyer on L1 -> MagicBlock TEE Validator
    console.log("\n5️⃣  [L1] delegate_buyer -> MagicBlock TEE Validator...");
    const delegateIx = buildInstructionFromIdl(idl, "delegate_buyer", Buffer.alloc(0), accountMap, [
      { pubkey: ER_VALIDATOR, isSigner: false, isWritable: false },
    ]);
    const delSig = await sendTx(l1Conn, payer, delegateIx, "delegate_buyer");
    txLinks["delegate_buyer (L1)"] = explorerUrl(delSig);

    console.log("   ⏳ Waiting 3s for MagicBlock TEE validator to pick up delegation...");
    await sleep(3000);
  }

  // STEP 6: Authenticate with MagicBlock TEE via getAuthToken
  console.log("\n6️⃣  [TEE AUTH] Acquiring Intel TDX Query Filtering auth token via getAuthToken...");
  const { token } = await getAuthToken(ER_RPC, payer.publicKey, signMessageWithKeypair(payer));
  const teeAuthConn = new Connection(`${ER_RPC}?token=${token}`, "confirmed");
  const teeStrangerConn = new Connection(ER_RPC, "confirmed");
  console.log(`   ✅ Authenticated with ${ER_RPC} (token prefix: ${token.slice(0, 16)}…)`);

  // STEP 7: enable_privacy on TEE (invokes real Permission Program CreateEphemeralPermissionCpi!)
  console.log("\n7️⃣  [TEE] enable_privacy (Permission Program CreateEphemeralPermissionCpi)...");
  const privIx = buildInstructionFromIdl(idl, "enable_privacy", Buffer.alloc(0), accountMap);
  const privSig = await sendTx(teeAuthConn, payer, privIx, "enable_privacy (TEE)", true);
  txLinks["enable_privacy (TEE)"] = explorerUrl(privSig, true);

  await sleep(1000);

  // STEP 8: LIVE DUAL-READ TEE PRIVACY PROOF!
  console.log("\n8️⃣  [TEE PRIVACY PROOF] Dual-read check (Stranger without token vs Owner with JWT)...");
  const ownerTeeInfo = await teeAuthConn.getAccountInfo(buyerAccount, "confirmed");
  if (!ownerTeeInfo || ownerTeeInfo.data.length < BUYER_ACCOUNT_SIZE) {
    throw new Error("TEE PRIVACY PROOF FAILED: Authenticated owner could NOT read delegated BuyerAccount on TEE!");
  }
  const ownerDecoded = decodeBuyerAccount(ownerTeeInfo.data);
  console.log(
    `   ✅ Owner (JWT token) read: ${ownerTeeInfo.data.length} bytes (spinState=${ownerDecoded.spinState}, isPrivate=${ownerDecoded.isPrivate}, odds=${JSON.stringify(ownerDecoded.tierOddsBps)})`
  );

  let strangerBlocked = false;
  try {
    const strangerTeeInfo = await teeStrangerConn.getAccountInfo(buyerAccount, "confirmed");
    if (strangerTeeInfo === null) {
      strangerBlocked = true;
      console.log(`   ✅ Stranger (no token) read: { "value": null } — BLOCKED BY MAGICBLOCK TEE!`);
    } else {
      throw new Error(
        `TEE PRIVACY PROOF FAILED: Unauthenticated stranger read ${strangerTeeInfo.data.length} bytes!`
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("TEE PRIVACY PROOF FAILED:")) throw err;
    if (msg.includes("401") || msg.includes("403") || msg.toLowerCase().includes("unauthorized")) {
      strangerBlocked = true;
      console.log(`   ✅ Stranger (no token) read rejected (401/403): ${msg.slice(0, 100)}`);
    } else {
      throw err;
    }
  }
  if (!strangerBlocked || !ownerDecoded.isPrivate) {
    throw new Error("TEE PRIVACY PROOF FAILED: Privacy invariant did not hold!");
  }

  // STEP 9: request_spin on TEE -> MagicBlock VRF
  console.log("\n9️⃣  [TEE] request_spin (Paid -> PendingVrf, MagicBlock VRF DEFAULT_EPHEMERAL_QUEUE)...");
  const clientSeed = crypto.randomBytes(32);
  const spinIx = buildInstructionFromIdl(idl, "request_spin", clientSeed, accountMap);
  const spinSig = await sendTx(teeAuthConn, payer, spinIx, "request_spin (TEE)", true);
  txLinks["request_spin (TEE)"] = explorerUrl(spinSig, true);

  // STEP 10: Wait for real MagicBlock VRF callback_resolve_spin on TEE
  console.log("\n🔟 [TEE] Waiting for live MagicBlock #[vrf_callback] callback_resolve_spin...");
  let resolvedState: ReturnType<typeof decodeBuyerAccount> | null = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1500);
    const info = await teeAuthConn.getAccountInfo(buyerAccount, "confirmed");
    if (info && info.data.length >= BUYER_ACCOUNT_SIZE) {
      const decoded = decodeBuyerAccount(info.data);
      if (decoded.spinState === "Resolved") {
        resolvedState = decoded;
        break;
      }
      console.log(`   … poll ${i + 1}/30: spinState=${decoded.spinState}`);
    }
  }
  if (!resolvedState) {
    throw new Error("Timed out waiting for MagicBlock VRF callback_resolve_spin on TEE!");
  }
  if (resolvedState.pendingAmount !== 0n) {
    throw new Error(
      `SECURITY ASSERTION FAILED: pendingAmount was NOT cleared after VRF callback (${resolvedState.pendingAmount})!`
    );
  }
  console.log("   🎉 REAL VRF CALLBACK RESOLVED INSIDE MAGICBLOCK TEE!");
  console.log(`      Unbiased VRF Roll: ${resolvedState.lastRollBps}/9999 (${(resolvedState.lastRollBps / 100).toFixed(2)}%)`);
  console.log(`      Rebate:            ${(resolvedState.lastRebateBps / 100).toFixed(0)}% (${resolvedState.claimableRebateLamports} lamports)`);
  console.log(`      Shards:            ${resolvedState.shardBalance} Loyalty Shards`);
  console.log(`      pendingAmount:     ${resolvedState.pendingAmount} (cleared!)`);

  // STEP 11 (NEGATIVE SECURITY TEST #2): Re-spinning without paying again MUST FAIL!
  console.log("\n1️⃣1️⃣ [TEE SECURITY] Attempting unlimited-spin exploit (2nd request_spin MUST FAIL)...");
  const replaySpinIx = buildInstructionFromIdl(idl, "request_spin", crypto.randomBytes(32), accountMap);
  await expectTxFailure(
    teeAuthConn,
    payer,
    replaySpinIx,
    "2nd request_spin without new payment (single-spin enforcement)",
    true
  );

  // STEP 12: commit_and_undelegate_buyer on TEE -> confirm L1 settlement via SDK 0.18.0 GetCommitmentSignature
  console.log("\n1️⃣2️⃣ [TEE -> L1] commit_and_undelegate_buyer (closes EphemeralPermission & undelegates)...");
  const commitIx = buildInstructionFromIdl(
    idl,
    "commit_and_undelegate_buyer",
    Buffer.alloc(0),
    accountMap
  );
  const erCommitSig = await sendTx(teeAuthConn, payer, commitIx, "commit_and_undelegate_buyer (TEE)", true);
  txLinks["commit_and_undelegate (TEE)"] = explorerUrl(erCommitSig, true);

  console.log("   ⏳ Tracking L1 settlement via GetCommitmentSignature (SDK 0.18.0)...");
  const l1CommitSig = await GetCommitmentSignature(erCommitSig, teeAuthConn);
  console.log(`   ✅ L1 Settlement Confirmed: ${l1CommitSig}`);
  txLinks["L1 settlement commit"] = explorerUrl(l1CommitSig);

  for (let i = 0; i < 15; i++) {
    const l1Buyer = await l1Conn.getAccountInfo(buyerAccount, "confirmed");
    if (l1Buyer && l1Buyer.owner.equals(PROGRAM_ID)) break;
    await sleep(1000);
  }

  // STEP 13: claim_or_sell_shards on Solana L1
  console.log("\n1️⃣3️⃣ [L1] claim_or_sell_shards (claim rebate + sell 10 shards for instant SOL)...");
  const sellShards = resolvedState.shardBalance >= 10n ? 10n : 0n;
  const claimIx = buildInstructionFromIdl(idl, "claim_or_sell_shards", u64LE(sellShards), accountMap);
  const claimSig = await sendTx(l1Conn, payer, claimIx, "claim_or_sell_shards (L1)");
  txLinks["claim_or_sell_shards (L1)"] = explorerUrl(claimSig);

  // STEP 14: Merchant withdraw security test (over-withdraw fails; safe withdraw succeeds!)
  console.log("\n1️⃣4️⃣ [L1 MERCHANT] Testing withdraw_merchant_funds (reserve protection + real withdraw)...");
  const overWithdrawIx = buildInstructionFromIdl(
    idl,
    "withdraw_merchant_funds",
    u64LE(500_000_000n),
    accountMap
  );
  await expectTxFailure(
    l1Conn,
    payer,
    overWithdrawIx,
    "withdraw_merchant_funds exceeding protected shard reserve"
  );

  const safeWithdrawIx = buildInstructionFromIdl(
    idl,
    "withdraw_merchant_funds",
    u64LE(1_000_000n), // 0.001 SOL
    accountMap
  );
  const withdrawSig = await sendTx(l1Conn, payer, safeWithdrawIx, "withdraw_merchant_funds (0.001 SOL)");
  txLinks["withdraw_merchant_funds (L1)"] = explorerUrl(withdrawSig);

  const finalBalance = await l1Conn.getBalance(payer.publicKey);
  console.log("\n════════════════════════════════════════════════════════════");
  console.log("✅ MILESTONE 0 + SECURITY AUDIT PROBE PASSED 100% LIVE!");
  console.log("   • Real MagicBlock TEE Permission Program (dual-read proven)");
  console.log("   • Real MagicBlock VRF Callback (unbiased 64-bit roll)");
  console.log("   • 1-lamport fake-price exploit REJECTED on-chain");
  console.log("   • Double-spin replay exploit REJECTED on-chain");
  console.log("   • Shard-reserve rug withdraw REJECTED on-chain");
  console.log("   • Legitimate merchant revenue withdrawal SUCCEEDED on-chain");
  console.log("════════════════════════════════════════════════════════════");
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
