use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::access_control::instructions::{
    CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
};
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, EphemeralPermission, Member, ACCOUNT_SIGNATURES_FLAG, AUTHORITY_FLAG,
    PERMISSION_SEED, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral, vrf, vrf_callback};
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use ephemeral_rollups_sdk::vrf::instructions::{
    create_request_randomness_ix, RequestRandomnessParams,
};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;

declare_id!("BxHVeQ7R5LuPLnoL6ySbiDstPChxJcEgPjoHCWgo2erX");

// Compile-time scoped VRF identity PDA (avoids runtime pure-Rust curve25519 CU exhaustion in vrf_callback)
pub const SCOPED_VRF_IDENTITY: Pubkey = Pubkey::new_from_array(
    ephemeral_rollups_sdk::vrf::consts::scoped_vrf_identity_const(&crate::ID).0,
);

// PDA seed prefixes (v2 hardened layout)
pub const STORE_SEED: &[u8] = b"store_v2";
pub const BUYER_SEED: &[u8] = b"buyer_v2";

// Fixed on-chain storefront catalog prices in lamports (must match frontend ITEMS).
// Prevents buyers from supplying 1 lamport to farm Loyalty Shards.
pub const ITEM_PRICES_LAMPORTS: [u64; 4] = [
    20_000_000,  // 0: Espresso Pass    (0.02 SOL)
    50_000_000,  // 1: Founder Hoodie   (0.05 SOL)
    100_000_000, // 2: VIP Event Ticket (0.10 SOL)
    150_000_000, // 3: Mystery Box      (0.15 SOL)
];

// Rebate tiers in basis points (out of 10,000)
pub const TIER_FREE: u16 = 10_000;   // 100% FREE
pub const TIER_HALF: u16 = 5_000;    // 50% off
pub const TIER_QUARTER: u16 = 2_500; // 25% off
pub const TIER_NONE: u16 = 0;        // 0% rebate (earns 100 Loyalty Shards)

// Loyalty Shard economics
pub const SHARD_VALUE_LAMPORTS: u64 = 100; // 1 Loyalty Shard = 100 lamports instant L1 buyback
pub const MAX_SHARDS_PER_SPIN: u64 = 100;
pub const MAX_SHARD_PAYOUT_PER_SPIN: u64 = MAX_SHARDS_PER_SPIN * SHARD_VALUE_LAMPORTS; // 10,000 lamports

fn ensure_ephemeral_permission_rent<'info>(
    buyer: &AccountInfo<'info>,
    buyer_account: &AccountInfo<'info>,
    system_program: &Pubkey,
) -> Result<()> {
    let perm_rent = ephemeral_rollups_sdk::ephemeral_accounts::rent(
        EphemeralPermission::size_of(1) as u32,
    );
    let min_total = Rent::get()?
        .minimum_balance(BuyerAccount::SIZE)
        .saturating_add(perm_rent);
    let current = buyer_account.lamports();
    if current < min_total {
        let top_up = min_total.saturating_sub(current);
        transfer(
            CpiContext::new(
                *system_program,
                Transfer {
                    from: buyer.clone(),
                    to: buyer_account.clone(),
                },
            ),
            top_up,
        )?;
    }
    Ok(())
}

#[ephemeral]
#[program]
pub mod pay_maybe {
    use super::*;

    /// Instruction 1 (Solana L1): Initializes StoreVault PDA and seeds cashback & shard reserve.
    pub fn init_store(
        ctx: Context<InitStore>,
        rebate_seed_lamports: u64,
        tier_odds_bps: [u16; 4], // [none, quarter, half, free] — must sum to 10,000
    ) -> Result<()> {
        let sum: u32 = tier_odds_bps.iter().map(|&x| x as u32).sum();
        require!(sum == 10_000, PayMaybeError::InvalidOdds);

        let store = &mut ctx.accounts.store_vault;
        store.authority = ctx.accounts.authority.key();
        store.bump = ctx.bumps.store_vault;
        store.tier_odds_bps = tier_odds_bps;
        store.total_pool_lamports = rebate_seed_lamports;
        store.total_shard_reserve = rebate_seed_lamports / 2;
        store.active_escrow_lamports = 0;
        store.total_checkouts = 0;
        store.total_paid_out_lamports = 0;

        if rebate_seed_lamports > 0 {
            let cpi_ctx = CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.store_vault.to_account_info(),
                },
            );
            transfer(cpi_ctx, rebate_seed_lamports)?;
        }

        msg!(
            "StoreVault initialized. Cashback pool: {} lamports, odds: {:?}",
            rebate_seed_lamports,
            tier_odds_bps
        );
        Ok(())
    }

    /// Instruction 2a (Solana L1): Idempotently initializes BuyerAccount PDA and pre-funds
    /// rent for its ER-local EphemeralPermission on the MagicBlock TEE validator.
    pub fn init_buyer(ctx: Context<InitBuyer>) -> Result<()> {
        if ctx.accounts.buyer_account.buyer == Pubkey::default() {
            let buyer_account = &mut ctx.accounts.buyer_account;
            buyer_account.buyer = ctx.accounts.buyer.key();
            buyer_account.store = ctx.accounts.store_vault.key();
            buyer_account.bump = ctx.bumps.buyer_account;
            buyer_account.spin_state = SpinState::Idle;
            buyer_account.last_item_id = 0;
            buyer_account.pending_amount = 0;
            buyer_account.unsettled_escrow_lamports = 0;
            buyer_account.tier_odds_bps = ctx.accounts.store_vault.tier_odds_bps;
            buyer_account.last_roll_bps = 0;
            buyer_account.last_rebate_bps = 0;
            buyer_account.claimable_rebate_lamports = 0;
            buyer_account.shard_balance = 0;
            buyer_account.total_checkouts = 0;
            buyer_account.total_won_lamports = 0;
            buyer_account.is_private = false;
        }

        ensure_ephemeral_permission_rent(
            &ctx.accounts.buyer.to_account_info(),
            &ctx.accounts.buyer_account.to_account_info(),
            &ctx.accounts.system_program.key(),
        )?;

        msg!("BuyerAccount ready for {}", ctx.accounts.buyer.key());
        Ok(())
    }

    /// Instruction 2b (Solana L1): Escrows fixed catalog checkout payment into L1 StoreVault
    /// and transitions BuyerAccount -> SpinState::Paid (strictly 1 spin per payment).
    pub fn deposit_checkout(
        ctx: Context<DepositCheckout>,
        item_id: u8,
        price_lamports: u64,
    ) -> Result<()> {
        let expected_price = *ITEM_PRICES_LAMPORTS
            .get(item_id as usize)
            .ok_or(PayMaybeError::InvalidItem)?;
        require!(price_lamports == expected_price, PayMaybeError::InvalidPrice);

        {
            let buyer_account = &ctx.accounts.buyer_account;
            require!(
                buyer_account.spin_state == SpinState::Idle
                    || buyer_account.spin_state == SpinState::Resolved,
                PayMaybeError::SpinAlreadyPending
            );
            require!(
                buyer_account.pending_amount == 0,
                PayMaybeError::SpinAlreadyPending
            );
            require!(
                buyer_account.claimable_rebate_lamports == 0,
                PayMaybeError::UnclaimedRebatePending
            );
        }

        ensure_ephemeral_permission_rent(
            &ctx.accounts.buyer.to_account_info(),
            &ctx.accounts.buyer_account.to_account_info(),
            &ctx.accounts.system_program.key(),
        )?;

        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.store_vault.to_account_info(),
            },
        );
        transfer(cpi_ctx, price_lamports)?;

        let store = &mut ctx.accounts.store_vault;
        let buyer_account = &mut ctx.accounts.buyer_account;

        // Release any prior 0%-rebate checkout escrow if buyer skipped claim_or_sell_shards
        if buyer_account.unsettled_escrow_lamports > 0 {
            store.active_escrow_lamports = store
                .active_escrow_lamports
                .saturating_sub(buyer_account.unsettled_escrow_lamports);
            buyer_account.unsettled_escrow_lamports = 0;
        }

        store.total_checkouts = store.total_checkouts.saturating_add(1);
        store.total_pool_lamports = store.total_pool_lamports.saturating_add(price_lamports);
        store.active_escrow_lamports = store.active_escrow_lamports.saturating_add(price_lamports);
        store.total_shard_reserve = store
            .total_shard_reserve
            .saturating_add(MAX_SHARD_PAYOUT_PER_SPIN);

        buyer_account.last_item_id = item_id;
        buyer_account.pending_amount = price_lamports;
        buyer_account.unsettled_escrow_lamports = price_lamports;
        buyer_account.tier_odds_bps = store.tier_odds_bps;
        buyer_account.spin_state = SpinState::Paid;

        emit!(CheckoutStarted {
            buyer: ctx.accounts.buyer.key(),
            item_id,
            price_lamports,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Instruction 2c (Solana L1): Idempotently delegates BuyerAccount PDA to MagicBlock TEE/ER validator.
    /// Uses UncheckedAccount on #[account(mut, del)] per MagicBlock Rule #2.
    pub fn delegate_buyer(ctx: Context<DelegateBuyer>) -> Result<()> {
        if ctx.accounts.buyer_account.owner == &ephemeral_rollups_sdk::id() {
            msg!("BuyerAccount already delegated");
            return Ok(());
        }

        let store_key = ctx.accounts.store_vault.key();
        let buyer_key = ctx.accounts.buyer.key();
        let seeds: &[&[u8]] = &[BUYER_SEED, store_key.as_ref(), buyer_key.as_ref()];

        ctx.accounts.delegate_buyer_account(
            &ctx.accounts.buyer,
            seeds,
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;

        msg!("BuyerAccount delegated to MagicBlock TEE/ER");
        Ok(())
    }

    /// Instruction 3 (MagicBlock TEE): Creates or updates the real MagicBlock Permission Program
    /// EphemeralPermission PDA via CPI so only the authenticated buyer can read their ER state.
    pub fn enable_privacy(ctx: Context<EnablePrivacy>) -> Result<()> {
        let store_key = ctx.accounts.buyer_account.store;
        let buyer_key = ctx.accounts.buyer.key();
        let bump = ctx.accounts.buyer_account.bump;
        let signers: &[&[u8]] = &[BUYER_SEED, store_key.as_ref(), buyer_key.as_ref(), &[bump]];

        let members = vec![Member {
            flags: AUTHORITY_FLAG
                | TX_LOGS_FLAG
                | TX_BALANCES_FLAG
                | TX_MESSAGE_FLAG
                | ACCOUNT_SIGNATURES_FLAG,
            pubkey: buyer_key,
        }];

        if ctx.accounts.permission.lamports() == 0 {
            CreateEphemeralPermissionCpi {
                payer: ctx.accounts.buyer_account.to_account_info(),
                permissioned_account: ctx.accounts.buyer_account.to_account_info(),
                permission: ctx.accounts.permission.to_account_info(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                args: EphemeralMembersArgs {
                    is_private: true,
                    members,
                },
            }
            .invoke_signed(&[signers])?;
        } else {
            UpdateEphemeralPermissionCpi {
                payer: ctx.accounts.buyer_account.to_account_info(),
                permissioned_account: ctx.accounts.buyer_account.to_account_info(),
                permission: ctx.accounts.permission.to_account_info(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                authority: ctx.accounts.buyer_account.to_account_info(),
                authority_is_signer: false,
                args: EphemeralMembersArgs {
                    is_private: true,
                    members,
                },
            }
            .invoke_signed(&[signers])?;
        }

        ctx.accounts.buyer_account.is_private = true;
        emit!(PrivacyEnabled {
            buyer: buyer_key,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Instruction 4 (MagicBlock TEE / ER VRF): Consumes Paid state -> PendingVrf and requests
    /// verifiable randomness from MagicBlock VRF. Strictly enforces 1 spin per paid checkout.
    pub fn request_spin(ctx: Context<RequestSpin>, client_seed: [u8; 32]) -> Result<()> {
        {
            let buyer_account = &mut ctx.accounts.buyer_account;
            require!(
                buyer_account.spin_state == SpinState::Paid,
                PayMaybeError::NoPaidCheckout
            );
            require!(
                buyer_account.pending_amount > 0,
                PayMaybeError::NoPaidCheckout
            );
            buyer_account.spin_state = SpinState::PendingVrf;
        }

        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.buyer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: crate::ID,
            callback_discriminator: instruction::CallbackResolveSpin::DISCRIMINATOR.to_vec(),
            caller_seed: client_seed,
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: ctx.accounts.buyer_account.key(),
                is_signer: false,
                is_writable: true,
            }]),
            ..Default::default()
        });

        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.buyer.to_account_info(), &ix)?;

        msg!(
            "VRF randomness requested for buyer {}",
            ctx.accounts.buyer.key()
        );
        Ok(())
    }

    /// Instruction 5 (MagicBlock VRF Callback): Protected by #[vrf_callback] + SCOPED_VRF_IDENTITY.
    /// Enforces PendingVrf -> Resolved, immediately zeroes pending_amount, and evaluates unbiased
    /// 64-bit randomness against StoreVault's configured tier_odds_bps.
    pub fn callback_resolve_spin(
        ctx: Context<CallbackResolveSpin>,
        randomness: [u8; 32],
    ) -> Result<()> {
        let buyer_account = &mut ctx.accounts.buyer_account;
        require!(
            buyer_account.spin_state == SpinState::PendingVrf,
            PayMaybeError::InvalidSpinState
        );
        require!(
            buyer_account.pending_amount > 0,
            PayMaybeError::NoPaidCheckout
        );

        let price = buyer_account.pending_amount;
        buyer_account.pending_amount = 0;
        buyer_account.spin_state = SpinState::Resolved;

        // Unbiased 64-bit uniform roll in [0, 9999] (modulo bias < 5.5e-16)
        let mut seed_bytes = [0u8; 8];
        seed_bytes.copy_from_slice(&randomness[0..8]);
        let roll_bps = (u64::from_le_bytes(seed_bytes) % 10_000) as u16;

        // tier_odds_bps = [none_bps, quarter_bps, half_bps, free_bps], sum == 10,000
        let [none_bps, quarter_bps, half_bps, _free_bps] = buyer_account.tier_odds_bps;
        let t_quarter = none_bps;
        let t_half = t_quarter.saturating_add(quarter_bps);
        let t_free = t_half.saturating_add(half_bps);

        let (rebate_bps, shards): (u16, u64) = if roll_bps >= t_free {
            (TIER_FREE, 10)    // default 1.00%  -> 100% FREE + 10 shards
        } else if roll_bps >= t_half {
            (TIER_HALF, 25)    // default 6.00%  -> 50% off   + 25 shards
        } else if roll_bps >= t_quarter {
            (TIER_QUARTER, 50) // default 18.00% -> 25% off   + 50 shards
        } else {
            (TIER_NONE, 100)   // default 75.00% -> 0% rebate + 100 shards
        };

        let rebate_lamports = price.saturating_mul(rebate_bps as u64) / 10_000;

        buyer_account.claimable_rebate_lamports = buyer_account
            .claimable_rebate_lamports
            .saturating_add(rebate_lamports);
        buyer_account.shard_balance = buyer_account.shard_balance.saturating_add(shards);
        buyer_account.last_roll_bps = roll_bps;
        buyer_account.last_rebate_bps = rebate_bps;
        buyer_account.total_won_lamports = buyer_account
            .total_won_lamports
            .saturating_add(rebate_lamports);
        buyer_account.total_checkouts = buyer_account.total_checkouts.saturating_add(1);

        emit!(SpinResolved {
            buyer: buyer_account.buyer,
            rebate_bps,
            rebate_lamports,
            shards_earned: shards,
            roll_bps,
        });
        Ok(())
    }

    /// Instruction 5b (MagicBlock TEE / ER): Closes active EphemeralPermission (refunding its
    /// rent to BuyerAccount), calls exit(&crate::ID)? per MagicBlock Rule #3, and commits +
    /// undelegates BuyerAccount back to Solana L1.
    pub fn commit_and_undelegate_buyer(ctx: Context<CommitAndUndelegateBuyer>) -> Result<()> {
        let store_key = ctx.accounts.buyer_account.store;
        let buyer_key = ctx.accounts.buyer.key();
        let bump = ctx.accounts.buyer_account.bump;
        let signers: &[&[u8]] = &[BUYER_SEED, store_key.as_ref(), buyer_key.as_ref(), &[bump]];

        if ctx.accounts.permission.lamports() > 0 {
            CloseEphemeralPermissionCpi {
                payer: ctx.accounts.buyer_account.to_account_info(),
                permissioned_account: ctx.accounts.buyer_account.to_account_info(),
                permission: ctx.accounts.permission.to_account_info(),
                vault: ctx.accounts.ephemeral_vault.to_account_info(),
                magic_program: ctx.accounts.magic_program.to_account_info(),
                permission_program: ctx.accounts.permission_program.to_account_info(),
                authority: ctx.accounts.buyer_account.to_account_info(),
                authority_is_signer: false,
            }
            .invoke_signed(&[signers])?;
        }

        ctx.accounts.buyer_account.is_private = false;
        ctx.accounts.buyer_account.exit(&crate::ID)?;

        MagicIntentBundleBuilder::new(
            ctx.accounts.buyer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.buyer_account.to_account_info()])
        .build_and_invoke()?;

        Ok(())
    }

    /// Instruction 6 (Solana L1): Claims won SOL cashback and/or sells Loyalty Shards back to StoreVault.
    pub fn claim_or_sell_shards(
        ctx: Context<ClaimOrSellShards>,
        sell_shards_amount: u64,
    ) -> Result<()> {
        let buyer_account = &mut ctx.accounts.buyer_account;
        let store = &mut ctx.accounts.store_vault;

        require!(
            buyer_account.spin_state == SpinState::Idle
                || buyer_account.spin_state == SpinState::Resolved,
            PayMaybeError::SpinAlreadyPending
        );

        let mut total_payout: u64 = 0;

        if buyer_account.claimable_rebate_lamports > 0 {
            total_payout = total_payout.saturating_add(buyer_account.claimable_rebate_lamports);
            buyer_account.claimable_rebate_lamports = 0;
        }

        if sell_shards_amount > 0 {
            require!(
                buyer_account.shard_balance >= sell_shards_amount,
                PayMaybeError::InsufficientShards
            );
            let shard_payout = sell_shards_amount.saturating_mul(SHARD_VALUE_LAMPORTS);
            require!(
                store.total_shard_reserve >= shard_payout,
                PayMaybeError::InsufficientPoolReserve
            );
            buyer_account.shard_balance -= sell_shards_amount;
            store.total_shard_reserve -= shard_payout;
            total_payout = total_payout.saturating_add(shard_payout);
        }

        if total_payout > 0 {
            let rent_min = Rent::get()?.minimum_balance(StoreVault::SIZE);
            let store_info = store.to_account_info();
            let buyer_info = ctx.accounts.buyer.to_account_info();
            require!(
                store_info.lamports().saturating_sub(rent_min) >= total_payout,
                PayMaybeError::InsufficientPoolReserve
            );
            **store_info.try_borrow_mut_lamports()? -= total_payout;
            **buyer_info.try_borrow_mut_lamports()? += total_payout;
            store.total_paid_out_lamports =
                store.total_paid_out_lamports.saturating_add(total_payout);
        }

        if buyer_account.unsettled_escrow_lamports > 0 {
            store.active_escrow_lamports = store
                .active_escrow_lamports
                .saturating_sub(buyer_account.unsettled_escrow_lamports);
            buyer_account.unsettled_escrow_lamports = 0;
        }

        buyer_account.spin_state = SpinState::Idle;
        buyer_account.pending_amount = 0;

        msg!("Settled {} lamports on Solana L1", total_payout);
        Ok(())
    }

    /// Instruction 7 (Solana L1): Allows StoreVault authority to withdraw earned merchant revenue
    /// while strictly protecting vault rent, Loyalty Shard buyback reserve, and active buyer escrows.
    pub fn withdraw_merchant_funds(
        ctx: Context<WithdrawMerchantFunds>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, PayMaybeError::InvalidAmount);

        let store = &mut ctx.accounts.store_vault;
        let rent_min = Rent::get()?.minimum_balance(StoreVault::SIZE);
        let protected = rent_min
            .saturating_add(store.total_shard_reserve)
            .saturating_add(store.active_escrow_lamports);

        let store_info = store.to_account_info();
        let authority_info = ctx.accounts.authority.to_account_info();
        let withdrawable = store_info.lamports().saturating_sub(protected);
        require!(
            amount <= withdrawable,
            PayMaybeError::InsufficientWithdrawableFunds
        );

        **store_info.try_borrow_mut_lamports()? -= amount;
        **authority_info.try_borrow_mut_lamports()? += amount;

        let remaining_lamports = store_info.lamports();
        emit!(MerchantWithdrawn {
            authority: ctx.accounts.authority.key(),
            amount,
            remaining_lamports,
        });
        msg!(
            "Merchant withdrew {} lamports ({} lamports remaining in StoreVault)",
            amount,
            remaining_lamports
        );
        Ok(())
    }
}

// =================== ACCOUNTS ===================

#[account]
pub struct StoreVault {
    pub authority: Pubkey,            // 32 (offset 8..40)
    pub bump: u8,                     // 1  (offset 40)
    pub tier_odds_bps: [u16; 4],      // 8  (offset 41..49)
    pub total_pool_lamports: u64,     // 8  (offset 49..57)
    pub total_shard_reserve: u64,     // 8  (offset 57..65)
    pub active_escrow_lamports: u64,  // 8  (offset 65..73)
    pub total_checkouts: u64,         // 8  (offset 73..81)
    pub total_paid_out_lamports: u64, // 8  (offset 81..89)
}

impl StoreVault {
    pub const SIZE: usize = 8 + 32 + 1 + 8 + 8 + 8 + 8 + 8 + 8; // 89 bytes
}

#[account]
pub struct BuyerAccount {
    pub buyer: Pubkey,                  // 32 (offset 8..40)
    pub store: Pubkey,                  // 32 (offset 40..72)
    pub bump: u8,                       // 1  (offset 72)
    pub spin_state: SpinState,          // 1  (offset 73)
    pub last_item_id: u8,               // 1  (offset 74)
    pub pending_amount: u64,            // 8  (offset 75..83)
    pub unsettled_escrow_lamports: u64, // 8  (offset 83..91)
    pub tier_odds_bps: [u16; 4],        // 8  (offset 91..99)
    pub last_roll_bps: u16,             // 2  (offset 99..101)
    pub last_rebate_bps: u16,           // 2  (offset 101..103)
    pub claimable_rebate_lamports: u64, // 8  (offset 103..111)
    pub shard_balance: u64,             // 8  (offset 111..119)
    pub total_checkouts: u64,           // 8  (offset 119..127)
    pub total_won_lamports: u64,        // 8  (offset 127..135)
    pub is_private: bool,               // 1  (offset 135)
}

impl BuyerAccount {
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 1 + 1 + 8 + 8 + 8 + 2 + 2 + 8 + 8 + 8 + 8 + 1; // 136 bytes
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum SpinState {
    #[default]
    Idle,       // 0
    Paid,       // 1
    PendingVrf, // 2
    Resolved,   // 3
}

// =================== CONTEXTS ===================

#[derive(Accounts)]
pub struct InitStore<'info> {
    #[account(
        init,
        payer = authority,
        space = StoreVault::SIZE,
        seeds = [STORE_SEED, authority.key().as_ref()],
        bump
    )]
    pub store_vault: Account<'info, StoreVault>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitBuyer<'info> {
    #[account(
        init_if_needed,
        payer = buyer,
        space = BuyerAccount::SIZE,
        seeds = [BUYER_SEED, store_vault.key().as_ref(), buyer.key().as_ref()],
        bump
    )]
    pub buyer_account: Account<'info, BuyerAccount>,
    #[account(seeds = [STORE_SEED, store_vault.authority.as_ref()], bump = store_vault.bump)]
    pub store_vault: Account<'info, StoreVault>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositCheckout<'info> {
    #[account(
        mut,
        seeds = [BUYER_SEED, store_vault.key().as_ref(), buyer.key().as_ref()],
        bump = buyer_account.bump
    )]
    pub buyer_account: Account<'info, BuyerAccount>,
    #[account(
        mut,
        seeds = [STORE_SEED, store_vault.authority.as_ref()],
        bump = store_vault.bump
    )]
    pub store_vault: Account<'info, StoreVault>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateBuyer<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: StoreVault PDA used only for buyer PDA seed derivation
    pub store_vault: UncheckedAccount<'info>,
    /// CHECK: BuyerAccount PDA being delegated — MUST be UncheckedAccount on #[account(mut, del)]
    #[account(mut, del)]
    pub buyer_account: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct EnablePrivacy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        mut,
        seeds = [BUYER_SEED, buyer_account.store.as_ref(), buyer.key().as_ref()],
        bump = buyer_account.bump
    )]
    pub buyer_account: Account<'info, BuyerAccount>,
    /// CHECK: Verified by MagicBlock Permission Program; derived with PERMISSION_SEED
    #[account(
        mut,
        seeds = [PERMISSION_SEED, buyer_account.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: MagicBlock Permission Program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: MagicBlock Ephemeral Vault collecting ER-local permission rent
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: MagicBlock Magic Program
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestSpin<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        mut,
        seeds = [BUYER_SEED, buyer_account.store.as_ref(), buyer.key().as_ref()],
        bump = buyer_account.bump
    )]
    pub buyer_account: Account<'info, BuyerAccount>,
    /// CHECK: MagicBlock VRF oracle queue
    #[account(mut)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackResolveSpin<'info> {
    /// Scoped VRF identity PDA, bound to this program (evaluated at compile time -> 0 runtime CU).
    #[account(address = SCOPED_VRF_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut)]
    pub buyer_account: Account<'info, BuyerAccount>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegateBuyer<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        mut,
        seeds = [BUYER_SEED, buyer_account.store.as_ref(), buyer.key().as_ref()],
        bump = buyer_account.bump
    )]
    pub buyer_account: Account<'info, BuyerAccount>,
    /// CHECK: Ephemeral permission PDA (closed if active so rent refunds to buyer_account)
    #[account(
        mut,
        seeds = [PERMISSION_SEED, buyer_account.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: MagicBlock Permission Program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: MagicBlock Ephemeral Vault
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimOrSellShards<'info> {
    #[account(
        mut,
        seeds = [BUYER_SEED, store_vault.key().as_ref(), buyer.key().as_ref()],
        bump = buyer_account.bump
    )]
    pub buyer_account: Account<'info, BuyerAccount>,
    #[account(
        mut,
        seeds = [STORE_SEED, store_vault.authority.as_ref()],
        bump = store_vault.bump
    )]
    pub store_vault: Account<'info, StoreVault>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawMerchantFunds<'info> {
    #[account(
        mut,
        has_one = authority @ PayMaybeError::Unauthorized,
        seeds = [STORE_SEED, authority.key().as_ref()],
        bump = store_vault.bump
    )]
    pub store_vault: Account<'info, StoreVault>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

// =================== EVENTS ===================

#[event]
pub struct PrivacyEnabled {
    pub buyer: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct CheckoutStarted {
    pub buyer: Pubkey,
    pub item_id: u8,
    pub price_lamports: u64,
    pub timestamp: i64,
}

#[event]
pub struct SpinResolved {
    pub buyer: Pubkey,
    pub rebate_bps: u16,
    pub rebate_lamports: u64,
    pub shards_earned: u64,
    pub roll_bps: u16,
}

#[event]
pub struct MerchantWithdrawn {
    pub authority: Pubkey,
    pub amount: u64,
    pub remaining_lamports: u64,
}

// =================== ERRORS ===================

#[error_code]
pub enum PayMaybeError {
    #[msg("Tier odds bps must sum to 10000")]
    InvalidOdds,
    #[msg("Invalid catalog item id")]
    InvalidItem,
    #[msg("Invalid price: must match fixed on-chain catalog price")]
    InvalidPrice,
    #[msg("Invalid amount: must be > 0")]
    InvalidAmount,
    #[msg("Spin already pending — wait for VRF callback or settle current checkout")]
    SpinAlreadyPending,
    #[msg("No paid checkout available to spin — pay on L1 first")]
    NoPaidCheckout,
    #[msg("Invalid spin state for VRF callback")]
    InvalidSpinState,
    #[msg("Claim pending cashback rebate before starting a new checkout")]
    UnclaimedRebatePending,
    #[msg("Insufficient shard balance")]
    InsufficientShards,
    #[msg("Insufficient pool reserve for payout")]
    InsufficientPoolReserve,
    #[msg("Insufficient withdrawable merchant funds above protected reserves")]
    InsufficientWithdrawableFunds,
    #[msg("Unauthorized")]
    Unauthorized,
}
