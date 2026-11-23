# PayMaybe — Hackathon Setup Guide

## ⚡ TL;DR (Fastest Path)

```powershell
# 1. Install Git
winget install --id Git.Git -e --source winget
# (restart terminal)

# 2. Install Rust
winget install --id Rustlang.Rustup -e
# (restart terminal)
rustup toolchain install 1.89 --component rustfmt clippy
rustup default 1.89

# 3. Install Solana CLI (Agave 3.1.9)
Invoke-WebRequest -Uri https://release.anza.xyz/v3.1.9/solana-install-init-x86_64-pc-windows-msvc.exe -OutFile C:\solana-install.exe
C:\solana-install.exe v3.1.9
# Add C:\Users\HP\.local\share\solana\install\active_release\bin to PATH

# 4. Install Anchor
cargo install --git https://github.com/coral-xyz/anchor anchor-cli --tag v1.0.2 --locked

# 5. Generate Devnet keypair + airdrop
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/id.json
solana config set --url devnet
solana airdrop 2

# 6. Build + Deploy
cd C:\Users\HP\Downloads\paymaybe
anchor build
anchor deploy

# 7. Update program ID everywhere
node scripts/update-program-id.mjs <YOUR_PROGRAM_ID>

# 8. Run Milestone 0 Probe
cd client && npm install && npm run probe

# 9. Run Frontend
cd ..\frontend && npm install && npm run dev
```

## Verified MagicBlock Addresses (Nov 2026)

| Item | Address |
|------|---------|
| Delegation Program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| Permission Program | `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1` |
| US ER Validator | `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd` |
| TEE Validator | `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` |
| VRF Program | `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` |
| DEFAULT_QUEUE (L1) | `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh` |
| DEFAULT_EPHEMERAL_QUEUE (ER) | `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` |

| Endpoint | URL |
|----------|-----|
| US ER | https://devnet-us.magicblock.app |
| TEE ER | https://devnet-tee.magicblock.app |
| Devnet L1 | https://api.devnet.solana.com |

## Architecture

```
Buyer                 Solana L1              MagicBlock ER (devnet-us)
  │                      │                          │
  ├─ Pay item price ────►│ StoreVault PDA           │
  │                      │ (escrow held)            │
  ├─ Delegate BuyerPDA ─►│ ──delegate──────────────►│
  │                      │                          │
  │                      │               ┌──────────┤
  │                      │               │ BuyerPDA │ (private session)
  │                      │               │ VRF roll │
  │                      │               └──────────┤
  │                      │                          │
  │◄─ Rebate + Shards ───│◄──commit_and_undelegate──┤
  │                      │                          │
  ├─ Claim / Sell ──────►│                          │
```

## Rebate Tiers

| Roll | Chance | Rebate | Shards |
|------|--------|--------|--------|
| 99 | 1% | 100% FREE | 10 🔵 |
| 93-98 | 6% | 50% off | 25 🔵 |
| 75-92 | 18% | 25% off | 50 🔵 |
| 0-74 | 75% | 0% | 100 🔵 |

**1 Shard = 100 lamports buyback from StoreVault — sell anytime.**

## Critical Implementation Rules (from Build Spec)

1. ✅ Always use `UncheckedAccount` on `#[account(mut, del)]` fields
2. ✅ Always call `account.exit(&crate::ID)?` BEFORE `MagicIntentBundleBuilder::commit_and_undelegate`
3. ✅ Always use `#[vrf_callback]` on the VRF consumer context
4. ✅ SDK pinned to `ephemeral-rollups-sdk = { version = "0.18" }`
5. ✅ ZERO fake simulation — no Math.random(), no hardcoded tx hashes

## Troubleshooting

**"Program not found on devnet"** — Run `anchor deploy` and update program ID with `node scripts/update-program-id.mjs`

**"Account already exists"** — The StoreVault or BuyerAccount was already initialized. The probe skips re-init automatically.

**"VRF callback timeout"** — devnet-us VRF oracle may be slow. Increase poll timeout in probe or check https://devnet-us.magicblock.app status.

**Frontend wallet not connecting** — Make sure Phantom is set to Devnet mode (Settings → Developer Settings → Testnet Mode or change network to Devnet).
