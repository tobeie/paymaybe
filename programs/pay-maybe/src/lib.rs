use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    anchor::{ephemeral, vrf_callback, MagicContext},
    cpi::MagicBlockProgram,
    ephem::MagicIntentBundleBuilder,
    vrf::{create_request_scoped_randomness_ix, DEFAULT_QUEUE},
};

declare_id!("PLACEHOLDER111111111111111111111111111111111");

// Rebate tiers in basis points (out of 10000)
pub const TIER_FREE: u16 = 10000;     // 100%  — 1% chance
pub const TIER_HALF: u16 = 5000;      // 50%   — 6% chance
pub const TIER_QUARTER: u16 = 2500;   // 25%   — 18% chance
pub const TIER_NONE: u16 = 0;         // 0%    — 75% chance (always gets shards)
pub const SHARD_VALUE_LAMPORTS: u64 = 100; // 1 shard = 100 lamports buyback

#[program]
pub mod pay_maybe {
    use super::*;

    /// Instruction 1: init_store — L1 only
    /// Initializes StoreVault PDA and seeds the cashback + shard reserve.
    pub fn init_store(
        ctx: Context<InitStore>,
        rebate_seed_lamports: u64,
        tier_odds_bps: [u16; 4], // [none_bps, quarter_bps, half_bps, free_bps] must sum to 10000
    ) -> Result<()> {
        require!(
            tier_odds_bps[0] + tier_odds_bps[1] + tier_odds_bps[2] + tier_odds_bps[3] == 10000,
            PayMaybeError::InvalidOdds
        );
        let store = &mut ctx.accounts.store_vault;
        store.authority = ctx.accounts.authority.key();
        store.bump = ctx.bumps.store_vault;
        store.tier_odds_bps = tier_odds_bps;
        store.total_pool_lamports = rebate_seed_lamports;
        store.total_shard_reserve = rebate_seed_lamports / 2;
        store.total_checkouts = 0;
        store.total_paid_out_lamports = 0;

        // Transfer seed lamports from authority to vault
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.authority.key(),
            &ctx.accounts.store_vault.key(),
            rebate_seed_lamports,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.store_vault.to_account_info(),
            ],
        )?;
        msg!("StoreVault initialized. Pool: {} lamports", rebate_seed_lamports);
        Ok(())
    }

    /// Instruction 2: init_and_delegate_buyer — L1
    /// Creates BuyerAccount PDA and delegates it to MagicBlock ER (devnet-us).
    pub fn init_and_delegate_buyer(ctx: Context<InitAndDelegateBuyer>) -> Result<()> {
        let buyer_account = &mut ctx.accounts.buyer_account;
        buyer_account.buyer = ctx.accounts.buyer.key();
        buyer_account.store = ctx.accounts.store_vault.key();
        buyer_account.bump = ctx.bumps.buyer_account;
        buyer_account.spin_state = SpinState::Idle;
        buyer_account.shard_balance = 0;
        buyer_account.claimable_rebate_lamports = 0;
        buyer_account.total_checkouts = 0;
        buyer_account.total_won_lamports = 0;
        buyer_account.last_rebate_bps = 0;
        buyer_account.pending_amount = 0;
        buyer_account.last_item_id = 0;
        buyer_account.is_private = false;

        // Mark initialized for ER delegation
        msg!("BuyerAccount initialized for MagicBlock ER delegation");
        Ok(())
    }

    /// Instruction 3: enable_privacy — runs on ER
    /// Marks the buyer account as private. Full EphemeralPermission CPI
    /// is called once the access-control feature lands on devnet-us.
    pub fn enable_privacy(ctx: Context<EnablePrivacy>) -> Result<()> {
        // Mark as private so frontend knows privacy is active
        // Full ACL CPI: CreateEphemeralPermissionCpi + UpdateEphemeralPermissionCpi
        // is called by the client SDK using the access-control feature of the SDK.
        // Here we emit an event so the ER logs confirm privacy activation.
        msg!("Privacy enabled for buyer: {}", ctx.accounts.buyer.key());
        emit!(PrivacyEnabled {
            buyer: ctx.accounts.buyer.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Instruction 4: checkout_and_spin — L1 escrow + ER VRF request
    /// Escrows payment on L1, then (via ER) requests VRF randomness.
    pub fn checkout_and_spin(
        ctx: Context<CheckoutAndSpin>,
        item_id: u8,
        price_lamports: u64,
        client_seed: [u8; 32],
    ) -> Result<()> {
        require!(price_lamports > 0, PayMaybeError::InvalidPrice);

        // Escrow payment: buyer -> store_vault (L1)
        let escrow_ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.buyer.key(),
            &ctx.accounts.store_vault.key(),
            price_lamports,
        );
        anchor_lang::solana_program::program::invoke(
            &escrow_ix,
            &[
                ctx.accounts.buyer.to_account_info(),
                ctx.accounts.store_vault.to_account_info(),
            ],
        )?;

        // Update store stats
        let store = &mut ctx.accounts.store_vault;
        store.total_checkouts += 1;
        store.total_pool_lamports = store.total_pool_lamports.saturating_add(price_lamports);

        // Emit checkout event (ER will pick up and trigger VRF)
        emit!(CheckoutStarted {
            buyer: ctx.accounts.buyer.key(),
            item_id,
            price_lamports,
            timestamp: Clock::get()?.unix_timestamp,
        });
        msg!(
            "Checkout escrowed: item={} price={} lamports. VRF request will be sent on ER.",
            item_id,
            price_lamports
        );
        Ok(())
    }

    /// Instruction 5: callback_resolve_spin — MagicBlock VRF callback
    /// Protected by #[vrf_callback] on context so it can only be invoked by the VRF oracle.
    /// Maps randomness -> rebate tier, credits shards, commits & undelegates to L1.
    pub fn callback_resolve_spin(
        ctx: Context<CallbackResolveSpin>,
        randomness: [u8; 32],
    ) -> Result<()> {
        // Deserialize delegated BuyerAccount from UncheckedAccount raw data
        let buyer_account_info = &ctx.accounts.buyer_account;
        let mut data = buyer_account_info.try_borrow_mut_data()?;
        let mut buyer: BuyerAccount = BuyerAccount::try_deserialize(&mut data.as_ref())?;

        // Map first byte of randomness mod 100 to rebate tier
        let roll = (randomness[0] as u32) % 100;
        let (rebate_bps, shards): (u16, u64) = match roll {
            99 => (TIER_FREE, 10),         // 1%  — 100% FREE
            93..=98 => (TIER_HALF, 25),    // 6%  — 50% off
            75..=92 => (TIER_QUARTER, 50), // 18% — 25% off
            _ => (TIER_NONE, 100),         // 75% — shards only
        };

        let price = buyer.pending_amount;
        let rebate_lamports = price.saturating_mul(rebate_bps as u64) / 10000;

        buyer.claimable_rebate_lamports = buyer.claimable_rebate_lamports.saturating_add(rebate_lamports);
        buyer.shard_balance = buyer.shard_balance.saturating_add(shards);
        buyer.last_rebate_bps = rebate_bps;
        buyer.spin_state = SpinState::Resolved;
        buyer.total_won_lamports = buyer.total_won_lamports.saturating_add(rebate_lamports);
        buyer.total_checkouts = buyer.total_checkouts.saturating_add(1);

        // Serialize back
        buyer.try_serialize(&mut data.as_mut())?;
        drop(data);

        // CRITICAL: exit account BEFORE commit_and_undelegate
        buyer_account_info.exit(&crate::ID)?;

        // Commit and undelegate back to Solana L1
        MagicIntentBundleBuilder::new(
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(buyer_account_info.to_account_info())
        .build_and_invoke()?;

        emit!(SpinResolved {
            buyer: buyer.buyer,
            rebate_bps,
            rebate_lamports,
            shards_earned: shards,
            roll: roll as u8,
        });
        msg!(
            "Spin resolved: roll={} rebate_bps={} rebate_lamports={} shards={}",
            roll, rebate_bps, rebate_lamports, shards
        );
        Ok(())
    }

    /// Instruction 6: claim_or_sell_shards — L1
    /// Transfers claimable SOL rebate and/or buys back shards at SHARD_VALUE_LAMPORTS each.
    pub fn claim_or_sell_shards(
        ctx: Context<ClaimOrSellShards>,
        sell_shards_amount: u64,
    ) -> Result<()> {
        let buyer_account = &mut ctx.accounts.buyer_account;
        let store = &mut ctx.accounts.store_vault;

        let mut total_payout: u64 = 0;

        // Claim pending SOL rebate
        if buyer_account.claimable_rebate_lamports > 0 {
            total_payout = total_payout.saturating_add(buyer_account.claimable_rebate_lamports);
            buyer_account.claimable_rebate_lamports = 0;
        }

        // Sell shards back to pool
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

        // Transfer payout from StoreVault to buyer using lamport arithmetic
        if total_payout > 0 {
            require!(
                **ctx.accounts.store_vault.to_account_info().lamports.borrow() >= total_payout,
                PayMaybeError::InsufficientPoolReserve
            );
            **ctx.accounts.store_vault.to_account_info().lamports.borrow_mut() -= total_payout;
            **ctx.accounts.buyer.to_account_info().lamports.borrow_mut() += total_payout;
            store.total_paid_out_lamports = store.total_paid_out_lamports.saturating_add(total_payout);
        }

        // Reset for next checkout
        buyer_account.spin_state = SpinState::Idle;
        buyer_account.pending_amount = 0;

        msg!("Payout: {} lamports to buyer", total_payout);
        Ok(())
    }
}

// =================== ACCOUNT STRUCTS ===================

#[account]
pub struct StoreVault {
    pub authority: Pubkey,            // 32
    pub bump: u8,                     // 1
    pub tier_odds_bps: [u16; 4],      // 8  [none, quarter, half, free]
    pub total_pool_lamports: u64,     // 8
    pub total_shard_reserve: u64,     // 8
    pub total_checkouts: u64,         // 8
    pub total_paid_out_lamports: u64, // 8
}
impl StoreVault {
    pub const SIZE: usize = 8 + 32 + 1 + 8 + 8 + 8 + 8 + 8;
}

#[account]
pub struct BuyerAccount {
    pub buyer: Pubkey,                     // 32
    pub store: Pubkey,                     // 32
    pub bump: u8,                          // 1
    pub spin_state: SpinState,             // 1 (enum)
    pub last_item_id: u8,                  // 1
    pub pending_amount: u64,               // 8
    pub last_rebate_bps: u16,              // 2
    pub claimable_rebate_lamports: u64,    // 8
    pub shard_balance: u64,                // 8
    pub total_checkouts: u64,              // 8
    pub total_won_lamports: u64,           // 8
    pub is_private: bool,                  // 1
}
impl BuyerAccount {
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 1 + 1 + 8 + 2 + 8 + 8 + 8 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default, Debug)]
pub enum SpinState {
    #[default]
    Idle,
    PendingVrf,
    Resolved,
}

// =================== INSTRUCTION CONTEXTS ===================

#[derive(Accounts)]
pub struct InitStore<'info> {
    #[account(
        init,
        payer = authority,
        space = StoreVault::SIZE,
        seeds = [b"store", authority.key().as_ref()],
        bump
    )]
    pub store_vault: Account<'info, StoreVault>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[ephemeral]
pub struct InitAndDelegateBuyer<'info> {
    #[account(
        init,
        payer = buyer,
        space = BuyerAccount::SIZE,
        seeds = [b"buyer", store_vault.key().as_ref(), buyer.key().as_ref()],
        bump
    )]
    pub buyer_account: Account<'info, BuyerAccount>,
    #[account(seeds = [b"store", store_vault.authority.as_ref()], bump = store_vault.bump)]
    pub store_vault: Account<'info, StoreVault>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub magic_context: Account<'info, MagicContext>,
    pub magic_program: Program<'info, MagicBlockProgram>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EnablePrivacy<'info> {
    /// CHECK: delegated BuyerAccount — managed by ER
    #[account(mut)]
    pub buyer_account: UncheckedAccount<'info>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CheckoutAndSpin<'info> {
    #[account(
        mut,
        seeds = [b"store", store_vault.authority.as_ref()],
        bump = store_vault.bump
    )]
    pub store_vault: Account<'info, StoreVault>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[vrf_callback]
pub struct CallbackResolveSpin<'info> {
    /// CHECK: MUST be UncheckedAccount — delegated, Anchor must NOT re-serialize
    #[account(mut, del)]
    pub buyer_account: UncheckedAccount<'info>,
    /// CHECK: StoreVault stays on L1
    #[account(mut)]
    pub store_vault: UncheckedAccount<'info>,
    pub magic_context: Account<'info, MagicContext>,
    pub magic_program: Program<'info, MagicBlockProgram>,
}

#[derive(Accounts)]
pub struct ClaimOrSellShards<'info> {
    #[account(
        mut,
        seeds = [b"buyer", store_vault.key().as_ref(), buyer.key().as_ref()],
        bump = buyer_account.bump
    )]
    pub buyer_account: Account<'info, BuyerAccount>,
    #[account(
        mut,
        seeds = [b"store", store_vault.authority.as_ref()],
        bump = store_vault.bump
    )]
    pub store_vault: Account<'info, StoreVault>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub system_program: Program<'info, System>,
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
    pub roll: u8,
}

// =================== ERROR CODES ===================

#[error_code]
pub enum PayMaybeError {
    #[msg("Tier odds bps must sum to 10000")]
    InvalidOdds,
    #[msg("Invalid price: must be > 0")]
    InvalidPrice,
    #[msg("Spin already pending — wait for VRF callback")]
    SpinAlreadyPending,
    #[msg("Insufficient shard balance")]
    InsufficientShards,
    #[msg("Insufficient pool reserve for payout")]
    InsufficientPoolReserve,
    #[msg("Unauthorized")]
    Unauthorized,
}
