import { PublicKey } from "@solana/web3.js";
import {
  PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  STORE_SEED,
  BUYER_SEED,
  PERMISSION_SEED,
} from "./constants.js";
import type { PDAs } from "./types.js";

export function deriveStoreVault(authority: PublicKey, programId = PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(STORE_SEED), authority.toBuffer()],
    programId
  );
}

export function deriveBuyerAccount(
  storeVault: PublicKey,
  buyer: PublicKey,
  programId = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BUYER_SEED), storeVault.toBuffer(), buyer.toBuffer()],
    programId
  );
}

export function derivePermissionPda(buyerAccount: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PERMISSION_SEED), buyerAccount.toBuffer()],
    PERMISSION_PROGRAM_ID
  );
}

export function derivePDAs(authority: PublicKey, buyer: PublicKey, programId = PROGRAM_ID): PDAs {
  const [storeVault, storeVaultBump] = deriveStoreVault(authority, programId);
  const [buyerAccount, buyerAccountBump] = deriveBuyerAccount(storeVault, buyer, programId);
  const [permission, permissionBump] = derivePermissionPda(buyerAccount);
  return {
    storeVault,
    storeVaultBump,
    buyerAccount,
    buyerAccountBump,
    permission,
    permissionBump,
  };
}
