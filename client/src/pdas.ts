import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./constants.js";
import type { PDAs } from "./types.js";

export function deriveStoreVault(authority: PublicKey, programId = PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("store"), authority.toBuffer()],
    programId
  );
}

export function deriveBuyerAccount(
  storeVault: PublicKey,
  buyer: PublicKey,
  programId = PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("buyer"), storeVault.toBuffer(), buyer.toBuffer()],
    programId
  );
}

export function derivePDAs(authority: PublicKey, buyer: PublicKey, programId = PROGRAM_ID): PDAs {
  const [storeVault, storeVaultBump] = deriveStoreVault(authority, programId);
  const [buyerAccount, buyerAccountBump] = deriveBuyerAccount(storeVault, buyer, programId);
  return { storeVault, storeVaultBump, buyerAccount, buyerAccountBump };
}
