#!/usr/bin/env node
/**
 * PayMaybe: Update Program ID across all files after anchor deploy
 * Usage: node scripts/update-program-id.mjs <PROGRAM_ID>
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const newId = process.argv[2];
if (!newId || newId.length < 32) {
  console.error("❌ Usage: node scripts/update-program-id.mjs <PROGRAM_ID>");
  console.error("   Example: node scripts/update-program-id.mjs AbCd1234...");
  process.exit(1);
}

console.log(`🔄 Updating Program ID to: ${newId}\n`);

const PLACEHOLDER = "PLACEHOLDER111111111111111111111111111111111";

function updateFile(relPath, searchFn) {
  const absPath = join(ROOT, relPath);
  try {
    const original = readFileSync(absPath, "utf8");
    const updated = searchFn(original);
    if (updated === original) {
      console.log(`⏭  ${relPath} — no placeholder found, skipping`);
    } else {
      writeFileSync(absPath, updated, "utf8");
      console.log(`✅  ${relPath} — updated`);
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log(`⚠️  ${relPath} — file not found, skipping`);
    } else {
      throw err;
    }
  }
}

// 1. Anchor.toml
updateFile("Anchor.toml", c => c.replaceAll(PLACEHOLDER, newId));

// 2. programs/pay-maybe/src/lib.rs
updateFile("programs/pay-maybe/src/lib.rs", c => c.replaceAll(PLACEHOLDER, newId));

// 3. client/src/constants.ts
updateFile("client/src/constants.ts", c => c.replaceAll(PLACEHOLDER, newId));

// 4. frontend/.env.local (create from example if not exists)
const envPath = join(ROOT, "frontend/.env.local");
try {
  const existing = readFileSync(envPath, "utf8");
  const updated = existing.replace(/NEXT_PUBLIC_PROGRAM_ID=.*/,
    `NEXT_PUBLIC_PROGRAM_ID=${newId}`);
  writeFileSync(envPath, updated, "utf8");
  console.log("✅  frontend/.env.local — updated");
} catch {
  // Create from example
  const example = readFileSync(join(ROOT, "frontend/.env.local.example"), "utf8");
  const content = example.replaceAll(PLACEHOLDER, newId);
  writeFileSync(envPath, content, "utf8");
  console.log("✅  frontend/.env.local — created from example");
}

console.log(`\n🏁 Done! Program ID set to: ${newId}`);
console.log("\nNext steps:");
console.log("  1. anchor build  (re-compile with new declare_id!)");
console.log("  2. anchor deploy (re-deploy)");
console.log("  3. cd client && npm run probe");
console.log("  4. cd frontend && npm run dev");
