/* ═══════════════════════════════════════════════════════════
   CLAWSCROW — Frontend Application
   Real Solana devnet integration via @solana/web3.js
   ═══════════════════════════════════════════════════════════ */

const App = (() => {
  const { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY } = solanaWeb3;

  // ─── Config ───
  const CONFIG = {
    PROGRAM_ID: new PublicKey('7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7'),
    USDC_MINT: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
    TOKEN_PROGRAM_ID: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    ASSOCIATED_TOKEN_PROGRAM_ID: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
    RPC_URL: 'https://api.devnet.solana.com',
  };

  const STATE_NAMES = ['open', 'active', 'delivered', 'approved', 'disputed', 'resolved'];

  // Anchor discriminators (first 8 bytes of sha256("global:<name>"))
  // Pre-computed for static file usage
  const DISCRIMINATORS = {
    createEscrow:  [0x42, 0x0c, 0xa0, 0x62, 0x6e, 0x3a, 0x1b, 0x67],
    acceptEscrow:  [0xce, 0xb0, 0x4c, 0x3e, 0xf0, 0xb0, 0x8e, 0x2c],
    deliver:       [0x3e, 0xc0, 0xb0, 0x4a, 0x6d, 0xc8, 0xae, 0x25],
    approve:       [0x70, 0xfe, 0x30, 0x0e, 0x0a, 0xd0, 0xb0, 0x62],
    dispute:       [0x4a, 0x0e, 0x6d, 0x21, 0x2a, 0x36, 0x68, 0x43],
    arbitrate:     [0x65, 0x8e, 0x30, 0x0a, 0xc8, 0x8c, 0xb4, 0x6a],
  };

  // Anchor account discriminator for Escrow
  const ESCROW_DISCRIMINATOR_SIZE = 8;

  const connection = new Connection(CONFIG.RPC_URL, 'confirmed');

  // ─── State ───
  let wallet = null;
  let publicKey = null;
  let escrows = [];
  let currentFilter = 'all';

  // ─── Account Deserialization ───
  // Escrow layout after 8-byte discriminator:
  // escrowId: u64 (8), buyer: pubkey (32), seller: pubkey (32), arbitrator: pubkey (32),
  // mint: pubkey (32), paymentAmount: u64 (8), collateralAmount: u64 (8),
  // descriptionHash: [u8;32] (32), deliveryHash: [u8;32] (32),
  // state: u8 (1), createdAt: i64 (8), deliveredAt: i64 (8), bump: u8 (1), vaultBump: u8 (1)
  // Total: 8 + 8 + 32 + 32 + 32 + 32 + 8 + 8 + 32 + 32 + 1 + 8 + 8 + 1 + 1 = 243

  function deserializeEscrow(data, pubkey) {
    const buf = Buffer.from(data);
    let offset = 8; // skip discriminator

    const escrowId = buf.readBigUInt64LE(offset); offset += 8;
    const buyer = new PublicKey(buf.slice(offset, offset + 32)); offset += 32;
    const seller = new PublicKey(buf.slice(offset, offset + 32)); offset += 32;
    const arbitrator = new PublicKey(buf.slice(offset, offset + 32)); offset += 32;
    const mint = new PublicKey(buf.slice(offset, offset + 32)); offset += 32;
    const paymentAmount = buf.readBigUInt64LE(offset); offset += 8;
    const collateralAmount = buf.readBigUInt64LE(offset); offset += 8;
    const descriptionHash = Array.from(buf.slice(offset, offset + 32)); offset += 32;
    const deliveryHash = Array.from(buf.slice(offset, offset + 32)); offset += 32;
    const state = buf.readUInt8(offset); offset += 1;
    const createdAt = Number(buf.readBigInt64LE(offset)); offset += 8;
    const deliveredAt = Number(buf.readBigInt64LE(offset)); offset += 8;
    const bump = buf.readUInt8(offset); offset += 1;
    const vaultBump = buf.readUInt8(offset); offset += 1;

    return {
      pubkey,
      escrowId: Number(escrowId),
      buyer: buyer.toBase58(),
      seller: seller.toBase58(),
      arbitrator: arbitrator.toBase58(),
      mint: mint.toBase58(),
      paymentAmount: Number(paymentAmount),
      collateralAmount: Number(collateralAmount),
      descriptionHash,
      deliveryHash,
      state: STATE_NAMES[state] || 'unknown',
      stateIndex: state,
      createdAt: createdAt * 1000, // ms
      deliveredAt: deliveredAt * 1000,
      bump,
      vaultBump,
    };
  }

  // ─── PDA Helpers ───
  async function findEscrowPDA(buyerPubkey, escrowId) {
    const escrowIdBuf = Buffer.alloc(8);
    escrowIdBuf.writeBigUInt64LE(BigInt(escrowId));
    return PublicKey.findProgramAddressSync(
      [Buffer.from('escrow'), new PublicKey(buyerPubkey).toBuffer(), escrowIdBuf],
      CONFIG.PROGRAM_ID
    );
  }

  async function findVaultPDA(escrowPubkey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), new PublicKey(escrowPubkey).toBuffer()],
      CONFIG.PROGRAM_ID
    );
  }

  function getAssociatedTokenAddress(owner, mint) {
    return PublicKey.findProgramAddressSync(
      [new PublicKey(owner).toBuffer(), CONFIG.TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()],
      CONFIG.ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
  }

  // ─── Instruction Builder ───
  async function computeDiscriminator(name) {
    // sha256("global:<name>") first 8 bytes
    const msgBuffer = new TextEncoder().encode(`global:${name}`);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    return new Uint8Array(hashBuffer).slice(0, 8);
  }

  function encodeLittleEndianU64(value) {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setBigUint64(0, BigInt(value), true);
    return new Uint8Array(buf);
  }

  function encodeBool(value) {
    return new Uint8Array([value ? 1 : 0]);
  }

  // ─── Wallet ───
  async function connectWallet() {
    try {
      if (publicKey) {
        disconnectWallet();
        return;
      }

      const provider = window.solana;
      if (!provider?.isPhantom) {
        toast('Please install Phantom wallet', 'error');
        window.open('https://phantom.app/', '_blank');
        return;
      }

      const resp = await provider.connect();
      wallet = provider;
      publicKey = resp.publicKey.toString();

      const btn = document.getElementById('walletBtn');
      btn.textContent = truncateAddress(publicKey);
      btn.classList.add('connected');

      toast(`Connected: ${truncateAddress(publicKey)}`, 'success');
      loadEscrows();

      provider.on('disconnect', () => disconnectWallet());
    } catch (err) {
      if (err.code === 4001) {
        toast('Connection rejected', 'info');
      } else {
        toast('Failed to connect wallet', 'error');
        console.error(err);
      }
    }
  }

  function disconnectWallet() {
    if (wallet) wallet.disconnect();
    wallet = null;
    publicKey = null;
    const btn = document.getElementById('walletBtn');
    btn.textContent = 'Connect Wallet';
    btn.classList.remove('connected');
    toast('Wallet disconnected', 'info');
  }

  function truncateAddress(addr) {
    return addr.slice(0, 4) + '...' + addr.slice(-4);
  }

  // ─── Escrows (on-chain) ───
  async function loadEscrows() {
    try {
      const accounts = await connection.getProgramAccounts(CONFIG.PROGRAM_ID, {
        commitment: 'confirmed',
      });

      escrows = accounts
        .filter(a => a.account.data.length >= 243)
        .map(a => {
          try {
            return deserializeEscrow(a.account.data, a.pubkey.toBase58());
          } catch (e) {
            console.warn('Failed to deserialize escrow account:', a.pubkey.toBase58(), e);
            return null;
          }
        })
        .filter(Boolean);

      console.log(`Loaded ${escrows.length} escrows from chain`);
    } catch (err) {
      console.error('Failed to load escrows:', err);
      toast('Failed to load escrows from devnet', 'error');
      escrows = [];
    }
    updateStats();
    renderEscrows();
  }

  function updateStats() {
    const totalUsdc = escrows.reduce((s, e) => s + e.paymentAmount / 1e6, 0);
    const completed = escrows.filter(e => e.state === 'approved' || e.state === 'resolved').length;
    const rate = escrows.length ? Math.round((completed / escrows.length) * 100) : 0;
    const uniqueWorkers = new Set(escrows.map(e => e.seller).filter(s => s !== '11111111111111111111111111111111')).size;

    animateNumber('statVolume', Math.round(totalUsdc), '$', ' USDC');
    animateNumber('statJobs', escrows.length);
    animateNumber('statCompleted', rate, '', '%');
    animateNumber('statAgents', uniqueWorkers);
  }

  function animateNumber(elId, target, prefix = '', suffix = '') {
    const el = document.getElementById(elId);
    if (!el) return;
    let current = 0;
    const step = Math.max(1, Math.ceil(target / 30));
    const timer = setInterval(() => {
      current = Math.min(current + step, target);
      el.innerHTML = `${prefix}${current.toLocaleString()}<span class="unit">${suffix}</span>`;
      if (current >= target) clearInterval(timer);
    }, 30);
  }

  function renderEscrows() {
    const list = document.getElementById('escrowList');
    const filtered = currentFilter === 'all'
      ? escrows
      : escrows.filter(e => e.state === currentFilter);

    if (!filtered.length) {
      list.innerHTML = `<div class="empty-state"><div class="icon">🦞</div><p>${escrows.length === 0 ? 'No escrows found on-chain yet. Create the first one!' : 'No escrows match this filter.'}</p></div>`;
      return;
    }

    list.innerHTML = filtered.map(e => `
      <div class="escrow-card" onclick="App.openJob('${e.pubkey}')">
        <div>
          <div class="escrow-title">Escrow #${e.escrowId}</div>
          <div class="escrow-meta">
            <span>👤 ${truncateAddress(e.buyer)}</span>
            <span>🔑 ${truncateAddress(e.pubkey)}</span>
          </div>
        </div>
        <div class="escrow-amount">$${(e.paymentAmount / 1e6).toLocaleString()} USDC</div>
        <span class="escrow-status status-${e.state}">${e.state}</span>
        <div class="escrow-time">${timeAgo(e.createdAt)}</div>
      </div>
    `).join('');
  }

  function filterEscrows(filter) {
    currentFilter = filter;
    document.querySelectorAll('.filter-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.filter === filter);
    });
    renderEscrows();
  }

  // ─── Job Detail Modal ───
  function openJob(pubkey) {
    const job = escrows.find(e => e.pubkey === pubkey);
    if (!job) return;

    document.getElementById('modalTitle').textContent = `Escrow #${job.escrowId}`;
    const statusEl = document.getElementById('modalStatus');
    statusEl.textContent = job.state.toUpperCase();
    statusEl.className = `escrow-status status-${job.state} job-status-badge`;
    document.getElementById('modalReward').textContent = `$${(job.paymentAmount / 1e6).toLocaleString()} USDC`;
    document.getElementById('modalDeadline').textContent = job.collateralAmount > 0 ? `Collateral: $${(job.collateralAmount / 1e6).toLocaleString()} USDC` : 'No collateral';
    document.getElementById('modalPoster').textContent = truncateAddress(job.buyer);
    const sellerEmpty = job.seller === '11111111111111111111111111111111';
    document.getElementById('modalWorker').textContent = sellerEmpty ? 'Awaiting agent...' : truncateAddress(job.seller);
    document.getElementById('modalDescription').textContent = `Account: ${job.pubkey}\nBuyer: ${job.buyer}\nSeller: ${sellerEmpty ? 'None' : job.seller}\nArbitrator: ${job.arbitrator}\nMint: ${job.mint}\nCreated: ${new Date(job.createdAt).toLocaleString()}${job.deliveredAt > 0 ? '\nDelivered: ' + new Date(job.deliveredAt).toLocaleString() : ''}`;

    // Dynamic actions
    const actions = document.getElementById('modalActions');
    actions.innerHTML = '';
    const isMyBuyer = publicKey && job.buyer === publicKey;
    const isMySeller = publicKey && job.seller === publicKey;
    const isMyArbitrator = publicKey && job.arbitrator === publicKey;

    if (job.state === 'open' && publicKey && !isMyBuyer) {
      actions.innerHTML += `<button class="btn btn-success" onclick="App.acceptJob('${pubkey}')">🤖 Accept Escrow</button>`;
    }
    if (job.state === 'active' && isMySeller) {
      actions.innerHTML += `<button class="btn btn-primary" onclick="App.deliverJob('${pubkey}')">📦 Submit Delivery</button>`;
    }
    if (job.state === 'delivered' && (isMyBuyer || isMyArbitrator)) {
      actions.innerHTML += `<button class="btn btn-success" onclick="App.approveJob('${pubkey}')">✅ Approve & Release</button>`;
    }
    if (job.state === 'delivered' && isMyBuyer) {
      actions.innerHTML += `<button class="btn btn-warning" onclick="App.disputeJob('${pubkey}')">⚖️ Raise Dispute</button>`;
    }
    if (job.state === 'disputed' && isMyArbitrator) {
      actions.innerHTML += `<button class="btn btn-success" onclick="App.arbitrateJob('${pubkey}', true)">🔵 Rule for Buyer</button>`;
      actions.innerHTML += `<button class="btn btn-warning" onclick="App.arbitrateJob('${pubkey}', false)">🟢 Rule for Seller</button>`;
    }
    actions.innerHTML += `<button class="btn btn-secondary" onclick="App.closeModal()">Close</button>`;

    document.getElementById('jobModal').classList.add('active');
  }

  function closeModal() {
    document.getElementById('jobModal').classList.remove('active');
  }

  // ─── Transaction Helpers ───
  async function sendTx(instruction) {
    if (!wallet || !publicKey) {
      toast('Connect your wallet first', 'error');
      return null;
    }
    try {
      const tx = new Transaction().add(instruction);
      tx.feePayer = new PublicKey(publicKey);
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const signed = await wallet.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, 'confirmed');
      return sig;
    } catch (err) {
      console.error('Transaction failed:', err);
      if (err.message?.includes('User rejected')) {
        toast('Transaction rejected', 'info');
      } else {
        toast(`Transaction failed: ${err.message || err}`, 'error');
      }
      return null;
    }
  }

  // ─── Job Actions (real on-chain) ───
  async function postJob(event) {
    event.preventDefault();
    if (!publicKey) { toast('Connect your wallet first', 'error'); return; }

    const reward = parseFloat(document.getElementById('jobReward').value);
    const collateral = 0; // Could add a collateral field later
    const description = document.getElementById('jobDescription').value;

    toast('Preparing transaction...', 'info');

    try {
      // Generate escrow ID from timestamp
      const escrowId = Date.now();

      // Hash description
      const descBytes = new TextEncoder().encode(description);
      const descHashBuf = await crypto.subtle.digest('SHA-256', descBytes);
      const descriptionHash = new Uint8Array(descHashBuf);

      // Derive PDAs
      const [escrowPDA] = await findEscrowPDA(publicKey, escrowId);
      const [vaultPDA] = await findVaultPDA(escrowPDA.toBase58());

      // Buyer's USDC token account
      const buyerATA = getAssociatedTokenAddress(publicKey, CONFIG.USDC_MINT.toBase58());

      // Build instruction data
      const disc = await computeDiscriminator('create_escrow');
      const data = Buffer.concat([
        Buffer.from(disc),
        encodeLittleEndianU64(escrowId),
        encodeLittleEndianU64(Math.round(reward * 1e6)),
        encodeLittleEndianU64(collateral),
        Buffer.from(descriptionHash),
      ]);

      // Use a default arbitrator (program deployer or self for devnet testing)
      const arbitrator = new PublicKey(publicKey);

      const ix = new TransactionInstruction({
        programId: CONFIG.PROGRAM_ID,
        keys: [
          { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: true },
          { pubkey: arbitrator, isSigner: false, isWritable: false },
          { pubkey: CONFIG.USDC_MINT, isSigner: false, isWritable: false },
          { pubkey: escrowPDA, isSigner: false, isWritable: true },
          { pubkey: vaultPDA, isSigner: false, isWritable: true },
          { pubkey: buyerATA, isSigner: false, isWritable: true },
          { pubkey: CONFIG.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ],
        data,
      });

      toast('Please approve the transaction in your wallet...', 'info');
      const sig = await sendTx(ix);
      if (sig) {
        toast(`Escrow created! Tx: ${truncateAddress(sig)}`, 'success');
        document.getElementById('postJobForm').reset();
        await loadEscrows();
        navigateTo('escrows');
      }
    } catch (err) {
      console.error('Create escrow error:', err);
      toast(`Failed to create escrow: ${err.message || err}`, 'error');
    }
  }

  async function acceptJob(pubkey) {
    if (!publicKey) { toast('Connect your wallet first', 'error'); return; }

    const job = escrows.find(e => e.pubkey === pubkey);
    if (!job) return;

    toast('Preparing accept transaction...', 'info');
    try {
      const [vaultPDA] = await findVaultPDA(pubkey);
      const sellerATA = getAssociatedTokenAddress(publicKey, job.mint);

      const disc = await computeDiscriminator('accept_escrow');
      const data = Buffer.from(disc);

      const ix = new TransactionInstruction({
        programId: CONFIG.PROGRAM_ID,
        keys: [
          { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: true },
          { pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true },
          { pubkey: vaultPDA, isSigner: false, isWritable: true },
          { pubkey: sellerATA, isSigner: false, isWritable: true },
          { pubkey: CONFIG.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
      });

      toast('Please approve the transaction...', 'info');
      const sig = await sendTx(ix);
      if (sig) {
        toast(`Escrow accepted! Tx: ${truncateAddress(sig)}`, 'success');
        closeModal();
        await loadEscrows();
      }
    } catch (err) {
      console.error('Accept escrow error:', err);
      toast(`Failed to accept: ${err.message || err}`, 'error');
    }
  }

  async function deliverJob(pubkey) {
    if (!publicKey) { toast('Connect your wallet first', 'error'); return; }

    const deliveryText = prompt('Enter delivery description or URL:');
    if (!deliveryText) return;

    toast('Submitting delivery on-chain...', 'info');
    try {
      const deliveryBytes = new TextEncoder().encode(deliveryText);
      const deliveryHashBuf = await crypto.subtle.digest('SHA-256', deliveryBytes);
      const deliveryHash = new Uint8Array(deliveryHashBuf);

      const disc = await computeDiscriminator('deliver');
      const data = Buffer.concat([Buffer.from(disc), Buffer.from(deliveryHash)]);

      const ix = new TransactionInstruction({
        programId: CONFIG.PROGRAM_ID,
        keys: [
          { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: false },
          { pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true },
        ],
        data,
      });

      const sig = await sendTx(ix);
      if (sig) {
        toast(`Delivery submitted! Tx: ${truncateAddress(sig)}`, 'success');
        closeModal();
        await loadEscrows();
      }
    } catch (err) {
      console.error('Deliver error:', err);
      toast(`Failed to deliver: ${err.message || err}`, 'error');
    }
  }

  async function approveJob(pubkey) {
    if (!publicKey) { toast('Connect your wallet first', 'error'); return; }

    const job = escrows.find(e => e.pubkey === pubkey);
    if (!job) return;

    toast('Approving and releasing funds...', 'info');
    try {
      const [vaultPDA] = await findVaultPDA(pubkey);
      const sellerATA = getAssociatedTokenAddress(job.seller, job.mint);

      const disc = await computeDiscriminator('approve');
      const data = Buffer.from(disc);

      const ix = new TransactionInstruction({
        programId: CONFIG.PROGRAM_ID,
        keys: [
          { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: false },
          { pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true },
          { pubkey: vaultPDA, isSigner: false, isWritable: true },
          { pubkey: sellerATA, isSigner: false, isWritable: true },
          { pubkey: CONFIG.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
      });

      const sig = await sendTx(ix);
      if (sig) {
        toast(`Escrow approved! Funds released. Tx: ${truncateAddress(sig)}`, 'success');
        closeModal();
        await loadEscrows();
      }
    } catch (err) {
      console.error('Approve error:', err);
      toast(`Failed to approve: ${err.message || err}`, 'error');
    }
  }

  async function disputeJob(pubkey) {
    if (!publicKey) { toast('Connect your wallet first', 'error'); return; }

    toast('Filing dispute on-chain...', 'info');
    try {
      const disc = await computeDiscriminator('dispute');
      const data = Buffer.from(disc);

      const ix = new TransactionInstruction({
        programId: CONFIG.PROGRAM_ID,
        keys: [
          { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: false },
          { pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true },
        ],
        data,
      });

      const sig = await sendTx(ix);
      if (sig) {
        toast(`Dispute filed! Tx: ${truncateAddress(sig)}`, 'success');
        closeModal();
        await loadEscrows();
      }
    } catch (err) {
      console.error('Dispute error:', err);
      toast(`Failed to dispute: ${err.message || err}`, 'error');
    }
  }

  async function arbitrateJob(pubkey, winnerIsBuyer) {
    if (!publicKey) { toast('Connect your wallet first', 'error'); return; }

    const job = escrows.find(e => e.pubkey === pubkey);
    if (!job) return;

    toast('Submitting arbitration verdict...', 'info');
    try {
      const [vaultPDA] = await findVaultPDA(pubkey);
      const winner = winnerIsBuyer ? job.buyer : job.seller;
      const winnerATA = getAssociatedTokenAddress(winner, job.mint);
      // Protocol fee account — use arbitrator's ATA as fee destination for devnet
      const feeATA = getAssociatedTokenAddress(publicKey, job.mint);

      const disc = await computeDiscriminator('arbitrate');
      const data = Buffer.concat([Buffer.from(disc), encodeBool(winnerIsBuyer)]);

      const ix = new TransactionInstruction({
        programId: CONFIG.PROGRAM_ID,
        keys: [
          { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: false },
          { pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true },
          { pubkey: vaultPDA, isSigner: false, isWritable: true },
          { pubkey: winnerATA, isSigner: false, isWritable: true },
          { pubkey: feeATA, isSigner: false, isWritable: true },
          { pubkey: CONFIG.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
      });

      const sig = await sendTx(ix);
      if (sig) {
        toast(`Arbitration complete! Tx: ${truncateAddress(sig)}`, 'success');
        closeModal();
        await loadEscrows();
      }
    } catch (err) {
      console.error('Arbitrate error:', err);
      toast(`Failed to arbitrate: ${err.message || err}`, 'error');
    }
  }

  // ─── Arbitration Log (on-chain disputed/resolved) ───
  function renderArbitrations() {
    const log = document.getElementById('arbLog');
    const arbEscrows = escrows.filter(e => e.state === 'disputed' || e.state === 'resolved');

    if (!arbEscrows.length) {
      log.innerHTML = `<div class="empty-state"><div class="icon">⚖️</div><p>No disputes found on-chain. That's a good thing!</p></div>`;
      return;
    }

    log.innerHTML = arbEscrows.map(a => `
      <div class="arb-entry fade-in">
        <div class="arb-header">
          <span class="arb-job-id">Escrow #${a.escrowId}</span>
          <span class="arb-date">${new Date(a.createdAt).toLocaleDateString()}</span>
        </div>
        <div class="arb-verdict verdict-${a.state === 'resolved' ? 'worker' : 'poster'}">
          ${a.state === 'disputed' ? '⏳ Awaiting arbitration' : '✅ Resolved'}
          <span style="font-weight:400;color:var(--text-muted);font-size:0.85rem;margin-left:8px;">$${(a.paymentAmount / 1e6).toLocaleString()} USDC</span>
        </div>
        <div class="arb-reasoning">
          Buyer: ${truncateAddress(a.buyer)} • Seller: ${truncateAddress(a.seller)}<br>
          Arbitrator: ${truncateAddress(a.arbitrator)}
        </div>
      </div>
    `).join('');
  }

  // ─── Helpers ───
  function timeAgo(timestamp) {
    if (!timestamp || timestamp <= 0) return 'unknown';
    const diff = Date.now() - timestamp;
    const hours = Math.floor(diff / 3600000);
    if (hours < 0) return 'just now';
    if (hours < 1) return 'just now';
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function navigateTo(sectionId) {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth' });
  }

  function toast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const icon = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' }[type] || '';
    el.innerHTML = `${icon} ${message}`;
    container.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4000);
  }

  function copyCode(btn) {
    const code = btn.closest('.code-block').querySelector('code').textContent;
    navigator.clipboard.writeText(code).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    });
  }

  // ─── Scroll Animations ───
  function initScrollAnimations() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) entry.target.classList.add('visible');
      });
    }, { threshold: 0.1 });
    document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));
  }

  // ─── Active Nav Highlight ───
  function initNavHighlight() {
    const sections = document.querySelectorAll('section[id]');
    const links = document.querySelectorAll('.nav-section-link');
    window.addEventListener('scroll', () => {
      let current = '';
      sections.forEach(s => {
        if (window.scrollY >= s.offsetTop - 100) current = s.id;
      });
      links.forEach(l => {
        l.classList.toggle('active', l.getAttribute('href') === `#${current}`);
      });
    });
  }

  // ─── Init ───
  function init() {
    loadEscrows().then(() => renderArbitrations());
    initScrollAnimations();
    initNavHighlight();

    document.getElementById('jobModal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });

    // Auto-connect if Phantom was previously connected
    if (window.solana?.isPhantom && window.solana.isConnected) {
      connectWallet();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ─── Public API ───
  return {
    connectWallet, postJob, acceptJob, deliverJob, approveJob, disputeJob, arbitrateJob,
    filterEscrows, openJob, closeModal, navigateTo, copyCode,
  };
})();

function toggleMobileNav() {
  document.getElementById('navLinks').classList.toggle('open');
}
