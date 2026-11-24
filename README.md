# PayMaybe — Confidential "Buy Now, Pay Maybe" Checkout on Solana & MagicBlock

> **MagicBlock Solana Blitz v10 (Nov 20–27, 2026) · Theme: Entertainment Finance**  
> *Every checkout gives you an instant, provably fair chance to get your purchase 100% free — plus tradeable, SOL-backed Loyalty Shards you can sell back to the pool anytime.*

- **Live App (Vercel):** [https://paymaybe-w298.vercel.app/](https://paymaybe-w298.vercel.app/)
- **Live Devnet Program ID:** [`BxHVeQ7R5LuPLnoL6ySbiDstPChxJcEgPjoHCWgo2erX`](https://explorer.solana.com/address/BxHVeQ7R5LuPLnoL6ySbiDstPChxJcEgPjoHCWgo2erX?cluster=devnet)
- **Live Funded StoreVault Authority:** `FRFw8oAUQsHn3fZfis4dGcRhAXanoMo77TaKnm6cwLgf`
- **CI / Milestone 0 Probe (All Green):** [GitHub Actions Run #5](https://github.com/tobeie/paymaybe/actions/runs/45299780458)

---

## 1. The Concept

Directly inspired by MagicBlock CEO Andrea Fortugno's *"Buy Now, Pay Maybe"* Entertainment Finance thesis, **PayMaybe** is a drop-in gamified checkout storefront on Solana where every real purchase triggers a sub-second, provably fair rebate spin inside a **MagicBlock Ephemeral Rollup + MagicBlock VRF**:

1. **Pay Once on Solana L1 (`deposit_checkout` + `delegate_buyer`):**  
   The buyer pays into an **undelegated** Solana L1 `StoreVault` PDA seeded with a cashback & shard-buyback reserve, and delegates only their `BuyerAccount` PDA to MagicBlock ER.
2. **Instant, Gasless VRF Spin on MagicBlock ER (`enable_privacy` + `request_spin` → `callback_resolve_spin`):**  
   Inside MagicBlock ER (`devnet-us.magicblock.app`), MagicBlock VRF (`DEFAULT_EPHEMERAL_QUEUE`) generates RFC 9381 verifiable randomness and invokes our spoof-proof `#[vrf_callback]` in **~100ms (2 ER slots)** with **0 gas** — awarding an instant SOL cashback tier (0%, 25%, 50%, or **100% FREE**) plus guaranteed **Loyalty Shards**.
3. **Instant L1 Settlement & "Sell Anytime" Liquidity (`commit_and_undelegate_buyer` → `claim_or_sell_shards`):**  
   `MagicIntentBundleBuilder::commit_and_undelegate` settles the resolved `BuyerAccount` back to Solana L1 (tracked via `GetCommitmentSignature` on `@magicblock-labs/ephemeral-rollups-sdk@0.18.0`). Buyers can immediately **Claim SOL Cashback** or **Sell Loyalty Shards Anytime** back to the L1 `StoreVault` reserve for instant SOL liquidity.

> **Zero fake simulation:** No `Math.random()`, no mocked outcomes, no hardcoded tx hashes. Every checkout, VRF roll, privacy check, commit, and SOL payout is a live Solana Devnet + MagicBlock ER transaction.

---

## 2. Why MagicBlock Is Load-Bearing

*If you ask: "Couldn't you just do this with Switchboard VRF on Solana L1?" — No:*

| Requirement | Solana L1 Only | PayMaybe on MagicBlock ER + VRF |
|---|---|---|
| **Checkout Spin UX** | 5–15s wait for external L1 oracle + extra tx fees | **~100ms (2 ER slots), 0 gas** inside MagicBlock ER |
| **Consumer Financial Privacy** | Every purchase, spin attempt & win broadcast in real time on L1 | Delegated session isolated on ER/TEE with live unauthenticated RPC verification (`{ "value": null }`) |
| **Custody & Instant Exit** | All state & funds coupled on one layer | Real SOL stays anchored in **undelegated L1 `StoreVault`**; only `BuyerAccount` delegates and commits settlement back for instant "Sell Anytime" payouts |

---

## 3. Architecture & Data Flow

```text
  Buyer (Phantom on Devnet)          Solana L1 (Custody)              MagicBlock ER + VRF
  ─────────────────────────          ───────────────────              ───────────────────
  1. Click "Buy Now" ──────────────► StoreVault PDA (undelegated)
     (init_buyer + deposit_checkout   • Escrows real Devnet SOL
      + delegate_buyer)               • Holds cashback + shard reserve
                                      └─ delegates BuyerAccount PDA ──► BuyerAccount PDA on ER
                                                                        2. enable_privacy (0 gas)
                                                                        3. request_spin (0 gas)
                                                                           └─► MagicBlock VRF Oracle
                                                                        4. #[vrf_callback] callback_resolve_spin
                                                                           • Lands in ~100ms (2 ER slots)
                                                                           • Credits rebate + Loyalty Shards
                                     L1 BuyerAccount restored ◄──────── 5. MagicIntentBundleBuilder
                                     (confirmed via SDK 0.18.0              ::commit_and_undelegate
                                      GetCommitmentSignature)
  6. Claim SOL / Sell Shards ──────► claim_or_sell_shards (L1)
     Anytime                          • Instant SOL transfer from StoreVault
```

### Transparent Odds & "Sell Anytime" Shard Math

| VRF Roll (`randomness[0] % 100`) | Probability | Instant Cashback | Guaranteed Loyalty Shards |
|---:|---:|---:|---:|
| `99` | **1%** | **100% FREE (Full Refund)** | `10` Shards |
| `93–98` | **6%** | **50% Off** | `25` Shards |
| `75–92` | **18%** | **25% Off** | `50` Shards |
| `0–74` | **75%** | `0%` | **`100` Shards** |

- **Real SOL Backing:** Every Loyalty Shard is redeemable anytime on Solana L1 at `100 lamports / shard` directly from `StoreVault.total_shard_reserve` via `claim_or_sell_shards`.

---

## 4. Verified Live Devnet + MagicBlock ER On-Chain Proof (Milestone 0)

Every instruction in our Anchor 1.0.2 program (`programs/pay-maybe/src/lib.rs`) is deployed and verified end-to-end on live Solana Devnet + `devnet-us.magicblock.app`:

| Step | Layer | Instruction | Verified Live Transaction |
|---|---|---|---|
| **0** | Solana Devnet | Program Deploy & Upgrade (`BxHVeQ7R...`) | [`kJYt8qWD...`](https://explorer.solana.com/tx/kJYt8qWDwenV7YnWSYcmnp1YYCt1sJGx1w4eypp4RLHVQSH4Gi4GYXvZHRRxwSyLAMZsJUdzdVDxbWNiPQauqtd?cluster=devnet) |
| **1** | Solana Devnet | `init_store` (Seed Cashback & Shard Reserve) | [`2iDZe7fu...`](https://explorer.solana.com/tx/2iDZe7fuf1GpH2FYxYHKCYN21FhcySJiECsQg3811cXV26VDewTipZv2t5j9PMXzb3xUnMTPiNyHhxs96HQxEWou?cluster=devnet) |
| **2** | Solana Devnet | `init_buyer` (Initialize `BuyerAccount` PDA) | [`VGNQAw8v...`](https://explorer.solana.com/tx/VGNQAw8v4wvMDgD2ZHaLfBZ72rxqmi7smiaTYhzzxrDbLHmT1nSEzJhEcybN2nufWnv7Kq7872peymmAEah8EYo?cluster=devnet) |
| **3** | Solana Devnet | `deposit_checkout` (Escrow 0.02 SOL) | [`mNfnUixq...`](https://explorer.solana.com/tx/mNfnUixqy3B4Lv6vSfwCbsaidzJDTeVS8ydob3zauFHySCMUpf5U8ou5SStzKDoUNsPaiFzwdFnA65T2EdL4C7u?cluster=devnet) |
| **4** | Solana Devnet | `delegate_buyer` → `MUS3hc9T...` (ER) | [`5aEZE9nV...`](https://explorer.solana.com/tx/5aEZE9nV3LW4sFe3KTA4G4hSNuWm3Kr4F8fUGQnGK6UyzbBfGQshUXXGkKAfJZtyKkJqZ3UGqKu5Mea9MYMDDcnE?cluster=devnet) |
| **5** | MagicBlock ER | `enable_privacy` (0 gas) | [`2GUEyr2V...`](https://explorer.solana.com/tx/2GUEyr2VXt18Se84thumaymmZx98JaGCc1t2dVoqFp3ttLrfdLrUew3Cap1jC3CJ6WnzQSyvwVha62pa9u8VuXxZ?cluster=custom&customUrl=https%3A%2F%2Fdevnet-us.magicblock.app) |
| **6** | MagicBlock ER | `request_spin` (MagicBlock VRF Request) | [`2QWuAWpX...`](https://explorer.solana.com/tx/2QWuAWpXTFtPm7rpY7DAqjyGE7s6bi2navx6Uvi14PQL7pGGGPtL2HUTuCk7QbnBmKukMgpkb6kpP1N9nFqfbuqp?cluster=custom&customUrl=https%3A%2F%2Fdevnet-us.magicblock.app) |
| **7** | MagicBlock ER | `#[vrf_callback] callback_resolve_spin` *(+2 slots!)* | [`65HE5i6L...`](https://explorer.solana.com/tx/65HE5i6LUC7sDLtW1SMBbYjnTGEa3TwhSeaH5kygg4jzK7ckVALgr7yP75chypLE6RBqfVL8WGZBwAKsMxf9DTR9?cluster=custom&customUrl=https%3A%2F%2Fdevnet-us.magicblock.app) |
| **8** | MagicBlock ER | `commit_and_undelegate_buyer` | [`3k7Aet8N...`](https://explorer.solana.com/tx/3k7Aet8NJGZLhLwpSEeWrUeonEEaPsLNksECajZt1hsjNPTbG4TdyWABLDkqVdnFBeptJ4AXKBb7m7uwfK7qWhov?cluster=custom&customUrl=https%3A%2F%2Fdevnet-us.magicblock.app) |
| **9** | Solana Devnet | L1 Settlement Commit (`GetCommitmentSignature` 0.18.0) | [`5bEAtGfR...`](https://explorer.solana.com/tx/5bEAtGfRu6Wotsx6ato9UYFgkAjRPUoUjp7otdrugzXz25qmfWma4MfonjY67jXj5zuMjdnGUAjgBS16nvKKrfXa?cluster=devnet) |
| **10** | Solana Devnet | `claim_or_sell_shards` (Real SOL Payout) | [`trwV5L7i...`](https://explorer.solana.com/tx/trwV5L7idkteiDVcwhgJHaB7TcDRfuiwZGUiPCEcoBZ39uYuCnm9aMqdMDUyqVwc5wwnxBuSbkaGxRTC6qWzHUo?cluster=devnet) |

---

## 5. Engineering Highlight (Note for MagicBlock Judges)

### Fixing a 271k-CU Runtime Exhaustion Bug in `ephemeral-rollups-sdk v0.18.0`'s `#[vrf_callback]` Macro

During live Devnet testing on `devnet-us.magicblock.app`, the real MagicBlock VRF oracle (`Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz`) invoked `CallbackResolveSpin` immediately, but our program consistently exhausted the entire compute budget before entering the handler body:

```text
Program BxHVeQ7R5LuPLnoL6ySbiDstPChxJcEgPjoHCWgo2erX invoke [2]
Program log: Instruction: CallbackResolveSpin
Program BxHVeQ7R5LuPLnoL6ySbiDstPChxJcEgPjoHCWgo2erX consumed 271190 of 271190 compute units
Program BxHVeQ7R5LuPLnoL6ySbiDstPChxJcEgPjoHCWgo2erX failed: Program failed to complete
```
*(Reproducible live ER tx: `2ZABc5NTEF4J2p7fb9obMunkWDdRDy71QZx3vHLVCvASQ4Zh9c29Lg78vxnFTD6HCLxP4Fsw5B2MmJzwgVJF6L3d`)*

**Root Cause (in `ephemeral-rollups-sdk v0.18.0`, `rust/vrf-macro/src/lib.rs`):**  
When `#[vrf_callback]` auto-injects `vrf_program_identity`, it generates:
```rust
#[account(address = Pubkey::new_from_array(::ephemeral_rollups_sdk::vrf::consts::scoped_vrf_identity_const(&crate::ID).0))]
pub vrf_program_identity: Signer<'info>,
```
Because Anchor expands `#[account(address = <expr>)]` into a regular runtime `if` check **without a `const` item**, Rust evaluates `scoped_vrf_identity_const(&crate::ID)` (pure-software Curve25519 PDA derivation) **at runtime inside SBF**, burning >271,000 CU on every VRF callback.

**Our Fix (`programs/pay-maybe/src/lib.rs`):**  
We promote the scoped VRF identity PDA to a true compile-time `pub const` while keeping `#[vrf_callback]` and the exact same scoped VRF signer constraint (`J5zck4juhYLVSGx7oyQ59t9RzM7vp2KLbNFWY7mFQLGp`):

```rust
pub const SCOPED_VRF_IDENTITY: Pubkey = Pubkey::new_from_array(
    ephemeral_rollups_sdk::vrf::consts::scoped_vrf_identity_const(&crate::ID).0,
);

#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackResolveSpin<'info> {
    #[account(address = SCOPED_VRF_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut)]
    pub buyer_account: Account<'info, BuyerAccount>,
}
```
This drops VRF identity validation from **>271,000 CU to ~0 runtime CU**, allowing `callback_resolve_spin` to settle cleanly 2 ER slots after `request_spin`.

### Validator v1 + v2 Compatibility (`0.18.0` Pin)
- **Rust program:** `ephemeral-rollups-sdk = { version = "0.18", features = ["anchor", "access-control", "vrf"] }` on **Anchor `1.0.2` / Agave `3.1.9` / Rust `1.89`**.
- **Client & Frontend:** Exact-pinned `@magicblock-labs/ephemeral-rollups-sdk@0.18.0` so `GetCommitmentSignature` properly tracks Validator v2 outbox settlement receipts on `devnet-us.magicblock.app` while preserving compatibility with v1 TEE endpoints (`devnet-tee.magicblock.app`).

---

## 6. Repository Layout

```text
paymaybe/
├── programs/pay-maybe/
│   ├── Cargo.toml                 # Anchor 1.0.2 + ephemeral-rollups-sdk 0.18
│   └── src/lib.rs                 # On-chain program (StoreVault + BuyerAccount + VRF + ER)
├── client/
│   └── src/milestone0-probe.ts    # End-to-end Devnet + MagicBlock ER/VRF probe
├── frontend/
│   ├── src/app/page.tsx           # Storefront, Private Spin Modal, Vault Drawer
│   ├── src/hooks/usePayMaybe.ts   # Real Devnet L1 + MagicBlock ER/VRF transaction hook
│   └── src/idl/pay_maybe.json     # Synced compiled Anchor 1.0.2 IDL
└── .github/workflows/
    ├── build.yml                  # CI: Next.js build + Anchor 1.0.2 / Agave 3.1.9 build
    └── deploy-devnet.yml          # 1-click Devnet deploy + IDL sync + live Milestone 0 probe
```

---

## 7. Quickstart (Try Locally or on Vercel)

### Live Demo (Zero Setup)
1. Open **[https://paymaybe-w298.vercel.app/](https://paymaybe-w298.vercel.app/)**.
2. Switch **Phantom** to **Solana Devnet** (Settings → Developer Settings → Testnet Mode).
3. Click **Buy Now** on any item (e.g., **Espresso Pass · 0.02 SOL**).
4. Click **Verify Privacy** in the modal to query the MagicBlock TEE RPC without an auth token (`{ "value": null }`), watch the live MagicBlock VRF callback reveal your tier, and open **Vault** to **Claim SOL** or **Sell Shards → SOL** anytime on L1.

### Run Locally
```bash
# Run frontend locally
cd frontend
npm install --legacy-peer-deps
npm run dev

# Run live Milestone 0 Devnet + MagicBlock ER/VRF probe
cd ../client
npm install --legacy-peer-deps
PROGRAM_ID=BxHVeQ7R5LuPLnoL6ySbiDstPChxJcEgPjoHCWgo2erX npm run probe
```

---

## 8. Built With
- **Solana (Agave 3.1.9)** & **Anchor 1.0.2**
- **MagicBlock Ephemeral Rollups (`ephemeral-rollups-sdk` 0.18 / `@magicblock-labs/ephemeral-rollups-sdk@0.18.0`)**
- **MagicBlock VRF (`Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz`)**
- **Next.js 15 + React 19 + Tailwind CSS + Framer Motion + Solana Wallet Adapter**
