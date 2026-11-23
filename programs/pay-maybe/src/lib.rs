use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral, vrf, vrf_callback};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use ephemeral_rollups_sdk::vrf::instructions::{
    create_request_scoped_randomness_ix, RequestRandomnessParams,
};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;

declare_id!("BxHVeQ7R5LuPLnoL6ySbiDstPChxJcEgPjoHCWgo2erX");

// Rebate tiers in basis points (out of 10000)
pub const TIER_FREE: u16 = 10_000;      // 100% FREE (1% chance)
pub const TIER_HALF: u16 = 5_000;       // 50% off   (6% chance)
pub const TIER_QUARTER: u16 = 2_500;    // 25% off   (18% chance)
pub const TIER_NONE: u16 = 0;           // 0% rebate (75% chance — always earns Loyalty Shards)
pub const SHARD_VALUE_LAMPORTS: u64 = 100; // 1 Loyalty Shard = 100 lamports instant L1 buyback

#[ephemeral]
#[program]
pub mod pay_maybe {
    use super::*;

    /// Instruction 1 (Solana L1): Initializes StoreVault PDA and seeds the cashback & shard reserve.
    pub fn init_store(
        ctx: Context<InitStore>,
        rebate_seed_lamports: u64,
        tier_odds_bps: [u16; 4], // [none, quarter, half, free] — must sum to 10000
    ) -> Result<()> {
        let sum: u32 = tier_odds_bps.iter().map(|&x| x as u32).sum();
        require!(sum == 10_000, PayMaybeError::InvalidOdds);

        let store = &mut ctx.accounts.store_vault;
        store.authority = ctx.accounts.authority.key();
        store.bump = ctx.bumps.store_vault;
        store.tier_odds_bps = tier_odds_bps;
        store.total_pool_lamports = rebate_seed_lamports;
        store.total_shard_reserve = rebate_seed_lamports / 2;
        store.total_checkouts = 0;
        store.total_paid_out_lamports = 0;

        if rebate_seed_lamports > 0 {
            let cpi_ctx = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.store_vault.to_account_info(),
                },
            );
            transfer(cpi_ctx, rebate_seed_lamports)?;
        }

        msg!(
            "StoreVault initialized. Cashback pool: {} lamports",
            rebate_seed_lamports
        );
        Ok(())
    }

    /// Instruction 2a (Solana L1): Initializes BuyerAccount PDA (and records checkout escrow).
    pub fn init_buyer(ctx: Context<InitBuyer>) -> Result<()> {
        let buyer_account = &mut ctx.accounts.buyer_account;
        buyer_account.buyer = ctx.accounts.buyer.key();
        buyer_account.store = ctx.accounts.store_vault.key();
        buyer_account.bump = ctx.bumps.buyer_account;
        buyer_account.spin_state = SpinState::Idle;
        buyer_account.last_item_id = 0;
        buyer_account.pending_amount = 0;
        buyer_account.last_rebate_bps = 0;
        buyer_account.claimable_rebate_lamports = 0;
        buyer_account.shard_balance = 0;
        buyer_account.total_checkouts = 0;
        buyer_account.total_won_lamports = 0;
        buyer_account.is_private = false;

        msg!("BuyerAccount initialized for {}", buyer_account.buyer);
        Ok(())
    }

    /// Instruction 2b (Solana L1): Escrows checkout payment into undelegated L1 StoreVault.
    pub fn deposit_checkout(
        ctx: Context<DepositCheckout>,
        item_id: u8,
        price_lamports: u64,
    ) -> Result<()> {
        require!(price_lamports > 0, PayMaybeError::InvalidPrice);
        let buyer_account = &mut ctx.accounts.buyer_account;
        require!(
            buyer_account.spin_state != SpinState::PendingVrf,
            PayMaybeError::SpinAlreadyPending
        );

        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.store_vault.to_account_info(),
            },
        );
        transfer(cpi_ctx, price_lamports)?;

        let store = &mut ctx.accounts.store_vault;
        store.total_checkouts = store.total_checkouts.saturating_add(1);
        store.total_pool_lamports = store.total_pool_lamports.saturating_add(price_lamports);

        buyer_account.last_item_id = item_id;
        buyer_account.pending_amount = price_lamports;
        buyer_account.spin_state = SpinState::PendingVrf;

        emit!(CheckoutStarted {
            buyer: ctx.accounts.buyer.key(),
            item_id,
            price_lamports,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Instruction 2c (Solana L1): Delegates BuyerAccount PDA to MagicBlock ER/TEE validator.
    /// Uses UncheckedAccount on #[account(mut, del)] per MagicBlock Rule #2.
    pub fn delegate_buyer(ctx: Context<DelegateBuyer>) -> Result<()> {
        let store_key = ctx.accounts.store_vault.key();
        let buyer_key = ctx.accounts.buyer.key();
        let seeds: &[&[u8]] = &[b"buyer", store_key.as_ref(), buyer_key.as_ref()];

        ctx.accounts.delegate_buyer_account(
            &ctx.accounts.buyer,
            seeds,
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;

        msg!("BuyerAccount delegated to MagicBlock ER");
        Ok(())
    }

    /// Instruction 3 (MagicBlock ER / TEE): Marks session privacy active on ER.
    pub fn enable_privacy(ctx: Context<EnablePrivacy>) -> Result<()> {
        let buyer_account = &mut ctx.accounts.buyer_account;
        buyer_account.is_private = true;
        emit!(PrivacyEnabled {
            buyer: ctx.accounts.buyer.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Instruction 4 (MagicBlock ER / L1 VRF): Requests verifiable randomness from MagicBlock VRF.
    pub fn request_spin(ctx: Context<RequestSpin>, client_seed: [u8; 32]) -> Result<()> {
        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
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

        msg!("VRF randomness requested for buyer {}", ctx.accounts.buyer.key());
        Ok(())
    }

    /// Instruction 5 (MagicBlock VRF Callback): Protected by #[vrf_callback] on context.
    /// Maps verified randomness to rebate tier + Loyalty Shards.
    pub fn callback_resolve_spin(
        ctx: Context<CallbackResolveSpin>,
        randomness: [u8; 32],
    ) -> Result<()> {
        let buyer_account = &mut ctx.accounts.buyer_account;

        let roll = (randomness[0] as u32) % 100;
        let (rebate_bps, shards): (u16, u64) = match roll {
            99 => (TIER_FREE, 10),         // 1%  -> 100% FREE + 10 shards
            93..=98 => (TIER_HALF, 25),    // 6%  -> 50% off   + 25 shards
            75..=92 => (TIER_QUARTER, 50), // 18% -> 25% off   + 50 shards
            _ => (TIER_NONE, 100),         // 75% -> 0% rebate + 100 shards
        };

        let price = buyer_account.pending_amount;
        let rebate_lamports = price.saturating_mul(rebate_bps as u64) / 10_000;

        buyer_account.claimable_rebate_lamports = buyer_account
            .claimable_rebate_lamports
            .saturating_add(rebate_lamports);
        buyer_account.shard_balance = buyer_account.shard_balance.saturating_add(shards);
        buyer_account.last_rebate_bps = rebate_bps;
        buyer_account.spin_state = SpinState::Resolved;
        buyer_account.total_won_lamports = buyer_account
            .total_won_lamports
            .saturating_add(rebate_lamports);
        buyer_account.total_checkouts = buyer_account.total_checkouts.saturating_add(1);

        emit!(SpinResolved {
            buyer: buyer_account.buyer,
            rebate_bps,
            rebate_lamports,
            shards_earned: shards,
            roll: roll as u8,
        });
        Ok(())
    }

    /// Instruction 5b (MagicBlock ER): Commits resolved BuyerAccount and undelegates back to L1.
    /// Calls exit(&crate::ID)? BEFORE MagicIntentBundleBuilder per MagicBlock Rule #3.
    pub fn commit_and_undelegate_buyer(ctx: Context<CommitAndUndelegateBuyer>) -> Result<()> {
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
            let store_info = store.to_account_info();
            let buyer_info = ctx.accounts.buyer.to_account_info();
            require!(
                store_info.lamports() >= total_payout,
                PayMaybeError::InsufficientPoolReserve
            );
            **store_info.try_borrow_mut_lamports()? -= total_payout;
            **buyer_info.try_borrow_mut_lamports()? += total_payout;
            store.total_paid_out_lamports =
                store.total_paid_out_lamports.saturating_add(total_payout);
        }

        buyer_account.spin_state = SpinState::Idle;
        buyer_account.pending_amount = 0;

        msg!("Settled {} lamports on Solana L1", total_payout);
        Ok(())
    }
}

// =================== ACCOUNTS ===================

#[account]
pub struct StoreVault {
    pub authority: Pubkey,            // 32
    pub bump: u8,                     // 1
    pub tier_odds_bps: [u16; 4],      // 8
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
    pub buyer: Pubkey,                  // 32
    pub store: Pubkey,                  // 32
    pub bump: u8,                       // 1
    pub spin_state: SpinState,          // 1
    pub last_item_id: u8,               // 1
    pub pending_amount: u64,            // 8
    pub last_rebate_bps: u16,           // 2
    pub claimable_rebate_lamports: u64, // 8
    pub shard_balance: u64,             // 8
    pub total_checkouts: u64,           // 8
    pub total_won_lamports: u64,        // 8
    pub is_private: bool,               // 1
}

impl BuyerAccount {
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 1 + 1 + 8 + 2 + 8 + 8 + 8 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum SpinState {
    #[default]
    Idle,
    PendingVrf,
    Resolved,
}

// =================== CONTEXTS ===================

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
pub struct InitBuyer<'info> {
    #[account(
        init_if_needed,
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
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositCheckout<'info> {
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
    #[account(
        mut,
        seeds = [b"buyer", buyer_account.store.as_ref(), buyer.key().as_ref()],
        bump = buyer_account.bump
    )]
    pub buyer_account: Account<'info, BuyerAccount>,
    #[account(mut)]
    pub buyer: Signer<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct RequestSpin<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"buyer", buyer_account.store.as_ref(), buyer.key().as_ref()],
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
        seeds = [b"buyer", buyer_account.store.as_ref(), buyer.key().as_ref()],
        bump = buyer_account.bump
    )]
    pub buyer_account: Account<'info, BuyerAccount>,
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

// =================== ERRORS ===================

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
