use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer, Mint};

declare_id!("7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7");

#[program]
pub mod clawscrow {
    use super::*;

    /// Create a new escrow job
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
        escrow.bump = ctx.bumps.escrow;

        // Transfer payment + buyer collateral to vault
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

    /// Seller accepts the job and deposits collateral
    pub fn accept_escrow(ctx: Context<AcceptEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Created, ClawscrowError::InvalidState);

        escrow.seller = ctx.accounts.seller.key();
        escrow.state = EscrowState::Accepted;

        // Transfer seller collateral to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.seller_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            escrow.seller_collateral,
        )?;

        emit!(EscrowAccepted {
            escrow_id: escrow.escrow_id,
            seller: ctx.accounts.seller.key(),
        });

        Ok(())
    }

    /// Seller delivers work (stores hash of delivered content)
    pub fn deliver(ctx: Context<Deliver>, delivery_hash: [u8; 32]) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Accepted, ClawscrowError::InvalidState);
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

    /// Buyer approves the delivery — releases payment + collateral
    pub fn approve(ctx: Context<Resolve>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Delivered, ClawscrowError::InvalidState);
        require!(ctx.accounts.signer.key() == escrow.buyer, ClawscrowError::Unauthorized);

        escrow.state = EscrowState::Approved;

        let seeds = &[
            b"escrow",
            &escrow.escrow_id.to_le_bytes(),
            &[escrow.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Pay seller: payment + seller collateral back
        let seller_total = escrow.payment_amount.checked_add(escrow.seller_collateral)
            .ok_or(ClawscrowError::Overflow)?;

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

        // Return buyer collateral
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
            escrow.buyer_collateral,
        )?;

        emit!(EscrowApproved {
            escrow_id: escrow.escrow_id,
        });

        Ok(())
    }

    /// Buyer raises a dispute
    pub fn dispute(ctx: Context<Resolve>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Delivered, ClawscrowError::InvalidState);
        require!(ctx.accounts.signer.key() == escrow.buyer, ClawscrowError::Unauthorized);

        escrow.state = EscrowState::Disputed;

        emit!(EscrowDisputed {
            escrow_id: escrow.escrow_id,
        });

        Ok(())
    }

    /// Arbitrator resolves dispute — winner gets payment + both collaterals (minus fee)
    pub fn arbitrate(
        ctx: Context<Arbitrate>,
        ruling: Ruling,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Disputed, ClawscrowError::InvalidState);
        require!(ctx.accounts.arbitrator.key() == escrow.arbitrator, ClawscrowError::Unauthorized);

        let seeds = &[
            b"escrow",
            &escrow.escrow_id.to_le_bytes(),
            &[escrow.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let total_pool = escrow.payment_amount
            .checked_add(escrow.buyer_collateral)
            .ok_or(ClawscrowError::Overflow)?
            .checked_add(escrow.seller_collateral)
            .ok_or(ClawscrowError::Overflow)?;

        // 1% arbitrator fee from buyer collateral
        let arb_fee = escrow.buyer_collateral / 100;
        let winner_amount = total_pool.checked_sub(arb_fee)
            .ok_or(ClawscrowError::Overflow)?;

        let winner_token = match ruling {
            Ruling::BuyerWins => &ctx.accounts.buyer_token,
            Ruling::SellerWins => &ctx.accounts.seller_token,
        };

        // Pay winner
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: winner_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                signer_seeds,
            ),
            winner_amount,
        )?;

        // Pay arbitrator fee
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

        escrow.state = match ruling {
            Ruling::BuyerWins => EscrowState::ResolvedBuyer,
            Ruling::SellerWins => EscrowState::ResolvedSeller,
        };

        emit!(DisputeResolved {
            escrow_id: escrow.escrow_id,
            ruling: ruling.clone(),
        });

        Ok(())
    }

    /// Auto-approve after review period (anyone can call)
    pub fn auto_approve(ctx: Context<Resolve>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.state == EscrowState::Delivered, ClawscrowError::InvalidState);

        let review_period: i64 = 3 * 24 * 60 * 60; // 3 days
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= escrow.delivered_at + review_period,
            ClawscrowError::ReviewPeriodActive
        );

        escrow.state = EscrowState::Approved;

        let seeds = &[
            b"escrow",
            &escrow.escrow_id.to_le_bytes(),
            &[escrow.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Same as approve — pay seller and return buyer collateral
        let seller_total = escrow.payment_amount.checked_add(escrow.seller_collateral)
            .ok_or(ClawscrowError::Overflow)?;

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
            escrow.buyer_collateral,
        )?;

        emit!(EscrowApproved {
            escrow_id: escrow.escrow_id,
        });

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
pub struct AcceptEscrow<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(mut, has_one = arbitrator)]
    pub escrow: Account<'info, Escrow>,

    #[account(mut, seeds = [b"vault", escrow.escrow_id.to_le_bytes().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub seller_token: Account<'info, TokenAccount>,

    /// CHECK: verified via has_one
    pub arbitrator: UncheckedAccount<'info>,

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
pub struct Resolve<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(mut)]
    pub escrow: Account<'info, Escrow>,

    #[account(mut, seeds = [b"vault", escrow.escrow_id.to_le_bytes().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer_token: Account<'info, TokenAccount>,

    #[account(mut)]
    pub seller_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Arbitrate<'info> {
    #[account(mut)]
    pub arbitrator: Signer<'info>,

    #[account(mut, has_one = arbitrator)]
    pub escrow: Account<'info, Escrow>,

    #[account(mut, seeds = [b"vault", escrow.escrow_id.to_le_bytes().as_ref()], bump)]
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
