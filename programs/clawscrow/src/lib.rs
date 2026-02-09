use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, Mint};

declare_id!("7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7");

#[program]
pub mod clawscrow {
    use super::*;

    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        escrow_id: u64,
        description: String,
        payment_amount: u64,
        buyer_collateral: u64,
        seller_collateral: u64,
        deadline_ts: i64,
    ) -> Result<()> {
        require!(payment_amount > 0, ClawscrowError::InvalidAmount);
        require!(description.len() <= 500, ClawscrowError::DescriptionTooLong);
        require!(deadline_ts > Clock::get()?.unix_timestamp, ClawscrowError::InvalidDeadline);

        let escrow = &mut ctx.accounts.escrow;
        escrow.escrow_id = escrow_id;
        escrow.buyer = ctx.accounts.buyer.key();
        escrow.seller = Pubkey::default();
        escrow.arbitrator = ctx.accounts.arbitrator.key();
        escrow.payment_amount = payment_amount;
        escrow.buyer_collateral = buyer_collateral;
        escrow.seller_collateral = seller_collateral;
        escrow.deadline_ts = deadline_ts;
        escrow.description = description;
        escrow.state = EscrowState::Created;
        escrow.delivery_hash = [0u8; 32];
        escrow.created_at = Clock::get()?.unix_timestamp;
        escrow.delivered_at = 0;
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;

        let total = payment_amount.checked_add(buyer_collateral)
            .ok_or(ClawscrowError::Overflow)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            total,
        )?;

        emit!(EscrowCreated {
            escrow_id,
            buyer: ctx.accounts.buyer.key(),
            payment_amount,
            buyer_collateral,
            seller_collateral,
        });

        Ok(())
    }

    pub fn accept_escrow(ctx: Context<AcceptEscrow>, escrow_id: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Created, ClawscrowError::InvalidState);
        require!(escrow.escrow_id == escrow_id, ClawscrowError::InvalidState);
        let collateral = escrow.seller_collateral;
        let eid = escrow.escrow_id;

        escrow.seller = ctx.accounts.seller.key();
        escrow.state = EscrowState::Accepted;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.seller_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            collateral,
        )?;

        emit!(EscrowAccepted { escrow_id: eid, seller: ctx.accounts.seller.key() });

        Ok(())
    }

    pub fn deliver(ctx: Context<Deliver>, delivery_hash: [u8; 32]) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Accepted, ClawscrowError::InvalidState);
        require!(ctx.accounts.seller.key() == escrow.seller, ClawscrowError::Unauthorized);

        escrow.delivery_hash = delivery_hash;
        escrow.state = EscrowState::Delivered;
        escrow.delivered_at = Clock::get()?.unix_timestamp;

        emit!(WorkDelivered { escrow_id: escrow.escrow_id, delivery_hash });

        Ok(())
    }

    pub fn approve(ctx: Context<Resolve>, escrow_id: u64) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Delivered, ClawscrowError::InvalidState);
        require!(ctx.accounts.signer.key() == escrow.buyer, ClawscrowError::Unauthorized);
        require!(escrow.escrow_id == escrow_id, ClawscrowError::InvalidState);

        let payment = escrow.payment_amount;
        let seller_col = escrow.seller_collateral;
        let buyer_col = escrow.buyer_collateral;
        let bump = escrow.bump;

        let id_bytes = escrow_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"escrow", id_bytes.as_ref(), &[bump]];
        let signer_seeds = &[seeds];

        let seller_total = payment.checked_add(seller_col).ok_or(ClawscrowError::Overflow)?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.seller_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            seller_total,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.buyer_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            buyer_col,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.state = EscrowState::Approved;

        emit!(EscrowApproved { escrow_id });

        Ok(())
    }

    pub fn raise_dispute(ctx: Context<DisputeCtx>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Delivered, ClawscrowError::InvalidState);
        require!(ctx.accounts.buyer.key() == escrow.buyer, ClawscrowError::Unauthorized);

        escrow.state = EscrowState::Disputed;

        emit!(EscrowDisputed { escrow_id: escrow.escrow_id });

        Ok(())
    }

    pub fn arbitrate(ctx: Context<Arbitrate>, escrow_id: u64, ruling: Ruling) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Disputed, ClawscrowError::InvalidState);
        require!(ctx.accounts.arbitrator.key() == escrow.arbitrator, ClawscrowError::Unauthorized);
        require!(escrow.escrow_id == escrow_id, ClawscrowError::InvalidState);

        let payment = escrow.payment_amount;
        let buyer_col = escrow.buyer_collateral;
        let seller_col = escrow.seller_collateral;
        let bump = escrow.bump;

        let id_bytes = escrow_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"escrow", id_bytes.as_ref(), &[bump]];
        let signer_seeds = &[seeds];

        let total_pool = payment
            .checked_add(buyer_col).ok_or(ClawscrowError::Overflow)?
            .checked_add(seller_col).ok_or(ClawscrowError::Overflow)?;

        let arb_fee = buyer_col / 100;
        let winner_amount = total_pool.checked_sub(arb_fee).ok_or(ClawscrowError::Overflow)?;

        let winner_token = match ruling {
            Ruling::BuyerWins => ctx.accounts.buyer_token.to_account_info(),
            Ruling::SellerWins => ctx.accounts.seller_token.to_account_info(),
        };

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: winner_token,
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            winner_amount,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.arbitrator_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            arb_fee,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.state = match ruling {
            Ruling::BuyerWins => EscrowState::ResolvedBuyer,
            Ruling::SellerWins => EscrowState::ResolvedSeller,
        };

        emit!(DisputeResolved { escrow_id, ruling });

        Ok(())
    }

    pub fn auto_approve(ctx: Context<Resolve>, escrow_id: u64) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Delivered, ClawscrowError::InvalidState);
        require!(escrow.escrow_id == escrow_id, ClawscrowError::InvalidState);

        let review_period: i64 = 3 * 24 * 60 * 60;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= escrow.delivered_at + review_period, ClawscrowError::ReviewPeriodActive);

        let payment = escrow.payment_amount;
        let seller_col = escrow.seller_collateral;
        let buyer_col = escrow.buyer_collateral;
        let bump = escrow.bump;

        let id_bytes = escrow_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"escrow", id_bytes.as_ref(), &[bump]];
        let signer_seeds = &[seeds];

        let seller_total = payment.checked_add(seller_col).ok_or(ClawscrowError::Overflow)?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.seller_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            seller_total,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.buyer_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            buyer_col,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.state = EscrowState::Approved;

        emit!(EscrowApproved { escrow_id });

        Ok(())
    }
}

// === ACCOUNTS ===

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

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
        token::mint = usdc_mint,
        token::authority = escrow,
        seeds = [b"vault", escrow_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer_token: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,

    /// CHECK: Arbitrator pubkey stored in escrow
    pub arbitrator: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct AcceptEscrow<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow_id.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"vault", escrow_id.to_le_bytes().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub seller_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Deliver<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct DisputeCtx<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct Resolve<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow_id.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"vault", escrow_id.to_le_bytes().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer_token: Account<'info, TokenAccount>,

    #[account(mut)]
    pub seller_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct Arbitrate<'info> {
    #[account(mut)]
    pub arbitrator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow_id.to_le_bytes().as_ref()],
        bump = escrow.bump,
        has_one = arbitrator,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [b"vault", escrow_id.to_le_bytes().as_ref()],
        bump = escrow.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer_token: Account<'info, TokenAccount>,

    #[account(mut)]
    pub seller_token: Account<'info, TokenAccount>,

    #[account(mut)]
    pub arbitrator_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// === STATE ===

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub escrow_id: u64,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub arbitrator: Pubkey,
    pub payment_amount: u64,
    pub buyer_collateral: u64,
    pub seller_collateral: u64,
    pub deadline_ts: i64,
    #[max_len(500)]
    pub description: String,
    pub state: EscrowState,
    pub delivery_hash: [u8; 32],
    pub created_at: i64,
    pub delivered_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum EscrowState {
    Created,
    Accepted,
    Delivered,
    Approved,
    Disputed,
    ResolvedBuyer,
    ResolvedSeller,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum Ruling {
    BuyerWins,
    SellerWins,
}

// === EVENTS ===

#[event]
pub struct EscrowCreated {
    pub escrow_id: u64,
    pub buyer: Pubkey,
    pub payment_amount: u64,
    pub buyer_collateral: u64,
    pub seller_collateral: u64,
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
pub struct DisputeResolved {
    pub escrow_id: u64,
    pub ruling: Ruling,
}

// === ERRORS ===

#[error_code]
pub enum ClawscrowError {
    #[msg("Invalid escrow state for this operation")]
    InvalidState,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Description too long")]
    DescriptionTooLong,
    #[msg("Invalid deadline")]
    InvalidDeadline,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Review period still active")]
    ReviewPeriodActive,
}
