use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7");

/// Protocol fee: 1% (100 basis points)
const PROTOCOL_FEE_BPS: u64 = 100;
/// Auto-approve window: 3 days in seconds
const AUTO_APPROVE_SECONDS: i64 = 3 * 24 * 60 * 60;

#[program]
pub mod clawscrow {
    use super::*;

    /// Buyer creates an escrow, depositing payment + buyer collateral into the vault.
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        escrow_id: u64,
        payment_amount: u64,
        collateral_amount: u64,
        description_hash: [u8; 32],
    ) -> Result<()> {
        require!(payment_amount > 0, ClawscrowError::InvalidAmount);
        require!(collateral_amount > 0, ClawscrowError::InvalidAmount);

        let escrow = &mut ctx.accounts.escrow;
        escrow.escrow_id = escrow_id;
        escrow.buyer = ctx.accounts.buyer.key();
        escrow.seller = Pubkey::default();
        escrow.arbitrator = ctx.accounts.arbitrator.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.payment_amount = payment_amount;
        escrow.collateral_amount = collateral_amount;
        escrow.description_hash = description_hash;
        escrow.delivery_hash = [0u8; 32];
        escrow.state = EscrowState::Open;
        escrow.created_at = Clock::get()?.unix_timestamp;
        escrow.delivered_at = 0;
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;

        // Transfer payment + collateral from buyer to vault
        let total = payment_amount.checked_add(collateral_amount).unwrap();
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            total,
        )?;

        emit!(EscrowCreated {
            escrow_id,
            buyer: escrow.buyer,
            arbitrator: escrow.arbitrator,
            payment_amount,
            collateral_amount,
        });

        Ok(())
    }

    /// Seller accepts the escrow and deposits their collateral.
    pub fn accept_escrow(ctx: Context<AcceptEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Open, ClawscrowError::InvalidState);

        escrow.seller = ctx.accounts.seller.key();
        escrow.state = EscrowState::Active;

        // Transfer seller collateral to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.seller_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            escrow.collateral_amount,
        )?;

        emit!(EscrowAccepted {
            escrow_id: escrow.escrow_id,
            seller: escrow.seller,
        });

        Ok(())
    }

    /// Seller delivers work by submitting a content hash.
    pub fn deliver(ctx: Context<Deliver>, delivery_hash: [u8; 32]) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Active, ClawscrowError::InvalidState);
        require!(ctx.accounts.seller.key() == escrow.seller, ClawscrowError::Unauthorized);

        escrow.delivery_hash = delivery_hash;
        escrow.state = EscrowState::Delivered;
        escrow.delivered_at = Clock::get()?.unix_timestamp;

        emit!(WorkDelivered {
            escrow_id: escrow.escrow_id,
            delivery_hash,
        });

        Ok(())
    }

    /// Buyer approves delivery, or anyone can call after auto-approve window.
    /// Seller receives: payment + both collaterals.
    pub fn approve(ctx: Context<Approve>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Delivered, ClawscrowError::InvalidState);

        let caller = ctx.accounts.caller.key();
        let now = Clock::get()?.unix_timestamp;

        // Either buyer approves, or auto-approve after 3 days
        if caller != escrow.buyer {
            require!(
                now >= escrow.delivered_at + AUTO_APPROVE_SECONDS,
                ClawscrowError::ReviewPeriodActive
            );
        }

        escrow.state = EscrowState::Approved;

        // Total in vault: payment + 2 * collateral
        let total = escrow.payment_amount + 2 * escrow.collateral_amount;

        // Transfer all to seller
        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let seeds = &[
            b"vault",
            escrow_id_bytes.as_ref(),
            &[escrow.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.seller_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            total,
        )?;

        emit!(EscrowApproved {
            escrow_id: escrow.escrow_id,
        });

        Ok(())
    }

    /// Buyer raises a dispute during review period.
    pub fn dispute(ctx: Context<Dispute>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Delivered, ClawscrowError::InvalidState);
        require!(ctx.accounts.buyer.key() == escrow.buyer, ClawscrowError::Unauthorized);

        let now = Clock::get()?.unix_timestamp;
        require!(
            now < escrow.delivered_at + AUTO_APPROVE_SECONDS,
            ClawscrowError::ReviewPeriodExpired
        );

        escrow.state = EscrowState::Disputed;

        emit!(EscrowDisputed {
            escrow_id: escrow.escrow_id,
        });

        Ok(())
    }

    /// Arbitrator resolves dispute. Winner gets payment + both collaterals minus 1% fee.
    pub fn arbitrate(ctx: Context<Arbitrate>, winner_is_buyer: bool) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Disputed, ClawscrowError::InvalidState);
        require!(
            ctx.accounts.arbitrator.key() == escrow.arbitrator,
            ClawscrowError::Unauthorized
        );

        escrow.state = EscrowState::Resolved;

        let total = escrow.payment_amount + 2 * escrow.collateral_amount;
        let fee = total * PROTOCOL_FEE_BPS / 10_000;
        let winner_amount = total - fee;

        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let seeds = &[
            b"vault",
            escrow_id_bytes.as_ref(),
            &[escrow.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Pay winner
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.winner_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            winner_amount,
        )?;

        // Pay protocol fee
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.protocol_fee_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            fee,
        )?;

        emit!(EscrowResolved {
            escrow_id: escrow.escrow_id,
            winner_is_buyer,
            fee,
        });

        Ok(())
    }
}

// ─── Accounts ───────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: Arbitrator pubkey, stored in escrow. Not signing here.
    pub arbitrator: UncheckedAccount<'info>,

    /// CHECK: Token mint for USDC.
    pub mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = buyer,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [b"escrow", escrow_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        init,
        payer = buyer,
        token::mint = mint,
        token::authority = vault,
        seeds = [b"vault", escrow_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = buyer_token_account.owner == buyer.key(),
        constraint = buyer_token_account.mint == mint.key(),
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AcceptEscrow<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"vault", escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = seller_token_account.owner == seller.key(),
        constraint = seller_token_account.mint == escrow.mint,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Deliver<'info> {
    pub seller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct Approve<'info> {
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"vault", escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = seller_token_account.owner == escrow.seller,
        constraint = seller_token_account.mint == escrow.mint,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Dispute<'info> {
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct Arbitrate<'info> {
    pub arbitrator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"vault", escrow.escrow_id.to_le_bytes().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The winner's token account (buyer or seller, decided by arbitrator).
    #[account(
        mut,
        constraint = winner_token_account.mint == escrow.mint,
    )]
    pub winner_token_account: Account<'info, TokenAccount>,

    /// Protocol fee destination.
    #[account(
        mut,
        constraint = protocol_fee_account.mint == escrow.mint,
    )]
    pub protocol_fee_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ─── State ──────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub escrow_id: u64,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub arbitrator: Pubkey,
    pub mint: Pubkey,
    pub payment_amount: u64,
    pub collateral_amount: u64,
    pub description_hash: [u8; 32],
    pub delivery_hash: [u8; 32],
    pub state: EscrowState,
    pub created_at: i64,
    pub delivered_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowState {
    Open,
    Active,
    Delivered,
    Approved,
    Disputed,
    Resolved,
}

// ─── Events ─────────────────────────────────────────────────────────────────

#[event]
pub struct EscrowCreated {
    pub escrow_id: u64,
    pub buyer: Pubkey,
    pub arbitrator: Pubkey,
    pub payment_amount: u64,
    pub collateral_amount: u64,
}

#[event]
pub struct EscrowAccepted {
    pub escrow_id: u64,
    pub seller: Pubkey,
}

#[event]
pub struct WorkDelivered {
    pub escrow_id: u64,
    pub delivery_hash: [u8; 32],
}

#[event]
pub struct EscrowApproved {
    pub escrow_id: u64,
}

#[event]
pub struct EscrowDisputed {
    pub escrow_id: u64,
}

#[event]
pub struct EscrowResolved {
    pub escrow_id: u64,
    pub winner_is_buyer: bool,
    pub fee: u64,
}

// ─── Errors ─────────────────────────────────────────────────────────────────

#[error_code]
pub enum ClawscrowError {
    #[msg("Invalid amount: must be greater than zero")]
    InvalidAmount,
    #[msg("Invalid state for this operation")]
    InvalidState,
    #[msg("Unauthorized caller")]
    Unauthorized,
    #[msg("Review period is still active")]
    ReviewPeriodActive,
    #[msg("Review period has expired")]
    ReviewPeriodExpired,
}
