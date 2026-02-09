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

  const connection = new Connection(CONFIG.RPC_URL, 'confirmed');

  // ─── State ───
  let wallet = null;
  let publicKey = null;
  let escrows = [];
  let currentFilter = 'all';

  // ─── Mock Data (shown on first load) ───
  const MOCK_ESCROWS = [
    {
      pubkey: 'Esc1...mock', escrowId: 1, buyer: '8xK4...buyer1', seller: '3jFn...seller1',
      arbitrator: '7KGm...arb', mint: CONFIG.USDC_MINT.toBase58(),
      paymentAmount: 150_000_000, collateralAmount: 50_000_000,
      state: 'open', stateIndex: 0, createdAt: Date.now() - 3600000 * 2,
      deliveredAt: 0, title: 'Analyze Solana DEX volume data',
    },
    {
      pubkey: 'Esc2...mock', escrowId: 2, buyer: 'AgX7...buyer2', seller: 'Bot3...seller2',
      arbitrator: '7KGm...arb', mint: CONFIG.USDC_MINT.toBase58(),
      paymentAmount: 75_000_000, collateralAmount: 25_000_000,
      state: 'active', stateIndex: 1, createdAt: Date.now() - 3600000 * 8,
      deliveredAt: 0, title: 'Generate smart contract audit report',
    },
    {
      pubkey: 'Esc3...mock', escrowId: 3, buyer: 'Hum1...buyer3', seller: 'AI42...seller3',
      arbitrator: '7KGm...arb', mint: CONFIG.USDC_MINT.toBase58(),
      paymentAmount: 300_000_000, collateralAmount: 100_000_000,
      state: 'delivered', stateIndex: 2, createdAt: Date.now() - 3600000 * 24,
      deliveredAt: Date.now() - 3600000 * 4, title: 'Build token dashboard frontend',
    },
    {
      pubkey: 'Esc4...mock', escrowId: 4, buyer: 'Dev9...buyer4', seller: 'Gpt5...seller4',
      arbitrator: '7KGm...arb', mint: CONFIG.USDC_MINT.toBase58(),
      paymentAmount: 50_000_000, collateralAmount: 15_000_000,
      state: 'approved', stateIndex: 3, createdAt: Date.now() - 3600000 * 48,
      deliveredAt: Date.now() - 3600000 * 36, title: 'Write Anchor program tests',
    },
  ];

  const MOCK_DECISIONS = [
    {
      escrowId: 7, date: '2026-02-08', verdict: 'seller', amount: 120,
      models: 'Claude, GPT, Gemini', reasoning: 'Seller delivered complete work matching spec. Minor formatting issues insufficient for dispute.',
    },
    {
      escrowId: 12, date: '2026-02-06', verdict: 'buyer', amount: 85,
      models: 'Claude, GPT, Grok', reasoning: 'Deliverable was incomplete — missing 2 of 5 required endpoints. Buyer refunded.',
    },
    {
      escrowId: 15, date: '2026-02-04', verdict: 'seller', amount: 200,
      models: 'Claude, Gemini, Grok', reasoning: 'Work exceeded requirements. Buyer dispute lacked evidence of non-compliance.',
    },
  ];

  // ─── Account Deserialization ───
  function deserializeEscrow(data, pubkey) {
    const buf = Buffer.from(data);
    let offset = 8;
    const escrowId = buf.readBigUInt64LE(offset); offset += 8;
    const buyer = new PublicKey(buf.slice(offset, offset + 32)); offset += 32;
    const seller = new PublicKey(buf.slice(offset, offset + 32)); offset += 32;
    const arbitrator = new PublicKey(buf.slice(offset, offset + 32)); offset += 32;
    const mint = new PublicKey(buf.slice(offset, offset + 32)); offset += 32;
    const paymentAmount = buf.readBigUInt64LE(offset); offset += 8;
    const collateralAmount = buf.readBigUInt64LE(offset); offset += 8;
    offset += 32; // descriptionHash
    offset += 32; // deliveryHash
    const state = buf.readUInt8(offset); offset += 1;
    const createdAt = Number(buf.readBigInt64LE(offset)); offset += 8;
    const deliveredAt = Number(buf.readBigInt64LE(offset)); offset += 8;

    return {
      pubkey,
      escrowId: Number(escrowId),
      buyer: buyer.toBase58(),
      seller: seller.toBase58(),
      arbitrator: arbitrator.toBase58(),
      mint: mint.toBase58(),
      paymentAmount: Number(paymentAmount),
      collateralAmount: Number(collateralAmount),
      state: STATE_NAMES[state] || 'unknown',
      stateIndex: state,
      createdAt: createdAt * 1000,
      deliveredAt: deliveredAt * 1000,
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

  async function computeDiscriminator(name) {
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
      if (publicKey) { disconnectWallet(); return; }

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

      // Update status section
      const statusWallet = document.getElementById('statusWallet');
      if (statusWallet) statusWallet.innerHTML = `<span class="status-badge badge-live">● ${truncateAddress(publicKey)}</span>`;

      toast(`Connected: ${truncateAddress(publicKey)}`, 'success');
      loadEscrows();

      provider.on('disconnect', () => disconnectWallet());
    } catch (err) {
      if (err.code === 4001) toast('Connection rejected', 'info');
      else { toast('Failed to connect wallet', 'error'); console.error(err); }
    }
  }

  function disconnectWallet() {
    if (wallet) wallet.disconnect();
    wallet = null; publicKey = null;
    const btn = document.getElementById('walletBtn');
    btn.textContent = 'Connect Phantom';
    btn.classList.remove('connected');
    const statusWallet = document.getElementById('statusWallet');
    if (statusWallet) statusWallet.innerHTML = '<span class="status-badge badge-idle">Not connected</span>';
    toast('Wallet disconnected', 'info');
  }

  function truncateAddress(addr) {
    return addr.slice(0, 4) + '...' + addr.slice(-4);
  }

  // ─── Escrows (on-chain + mock fallback) ───
  async function loadEscrows() {
    try {
      const accounts = await connection.getProgramAccounts(CONFIG.PROGRAM_ID, { commitment: 'confirmed' });
      const onChain = accounts
        .filter(a => a.account.data.length >= 243)
        .map(a => {
          try { return deserializeEscrow(a.account.data, a.pubkey.toBase58()); }
          catch (e) { return null; }
        })
        .filter(Boolean);

      escrows = onChain.length > 0 ? onChain : MOCK_ESCROWS;
      console.log(`Loaded ${onChain.length} on-chain escrows${onChain.length === 0 ? ', using mock data' : ''}`);
    } catch (err) {
      console.error('Failed to load escrows:', err);
      escrows = MOCK_ESCROWS;
    }
    renderEscrows();
  }

  function renderEscrows() {
    const list = document.getElementById('escrowList');
    const filtered = currentFilter === 'all' ? escrows : escrows.filter(e => e.state === currentFilter);

    if (!filtered.length) {
      list.innerHTML = `<div class="empty-state"><div class="icon">🦞</div><p>${escrows.length === 0 ? 'No escrows found. Create the first one!' : 'No escrows match this filter.'}</p></div>`;
      return;
    }

    list.innerHTML = filtered.map(e => `
      <div class="escrow-card" onclick="App.openJob('${e.pubkey}')">
        <div>
          <div class="escrow-title">${e.title || 'Escrow #' + e.escrowId}</div>
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
    document.querySelectorAll('.escrows-toolbar .filter-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.filter === filter);
    });
    renderEscrows();
  }

  // ─── Decision Log ───
  function renderDecisions(filter = 'all') {
    const tbody = document.getElementById('decisionLog');
    if (!tbody) return;
    const filtered = filter === 'all' ? MOCK_DECISIONS : MOCK_DECISIONS.filter(d => d.verdict === filter);

    tbody.innerHTML = filtered.map(d => `
      <div class="decision-row">
        <div class="decision-header">
          <span class="decision-id">Escrow #${d.escrowId}</span>
          <span class="decision-verdict ${d.verdict === 'buyer' ? 'verdict-buyer' : 'verdict-seller'}">${d.verdict === 'buyer' ? '✗ Buyer' : '✓ Seller'}</span>
          <span class="decision-amount">$${d.amount} USDC</span>
          <span class="decision-date">${d.date}</span>
        </div>
        <div class="decision-reasoning">${d.models}: ${d.reasoning}</div>
      </div>
    `).join('');
  }

  function filterDecisions(filter, btn) {
    document.querySelectorAll('.decision-filters .filter-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    renderDecisions(filter);
  }

  // ─── Job Detail Modal ───
  function openJob(pubkey) {
    const job = escrows.find(e => e.pubkey === pubkey);
    if (!job) return;

    document.getElementById('modalTitle').textContent = job.title || `Escrow #${job.escrowId}`;
    const statusEl = document.getElementById('modalStatus');
    statusEl.textContent = job.state.toUpperCase();
    statusEl.className = `escrow-status status-${job.state} job-status-badge`;
    document.getElementById('modalReward').textContent = `$${(job.paymentAmount / 1e6).toLocaleString()} USDC`;
    document.getElementById('modalDeadline').textContent = job.collateralAmount > 0 ? `$${(job.collateralAmount / 1e6).toLocaleString()} USDC` : 'None';
    document.getElementById('modalPoster').textContent = truncateAddress(job.buyer);
    const sellerEmpty = job.seller === '11111111111111111111111111111111';
    document.getElementById('modalWorker').textContent = sellerEmpty ? 'Awaiting agent...' : truncateAddress(job.seller);
    document.getElementById('modalDescription').textContent = `Account: ${job.pubkey}\nBuyer: ${job.buyer}\nSeller: ${sellerEmpty ? 'None' : job.seller}\nCreated: ${new Date(job.createdAt).toLocaleString()}${job.deliveredAt > 0 ? '\nDelivered: ' + new Date(job.deliveredAt).toLocaleString() : ''}`;

    const actions = document.getElementById('modalActions');
    actions.innerHTML = '';
    const isMyBuyer = publicKey && job.buyer === publicKey;
    const isMySeller = publicKey && job.seller === publicKey;

    if (job.state === 'open' && publicKey && !isMyBuyer) {
      actions.innerHTML += `<button class="btn btn-success" onclick="App.acceptJob('${pubkey}')">🤖 Accept Escrow</button>`;
    }
    if (job.state === 'active' && isMySeller) {
      actions.innerHTML += `<button class="btn btn-primary" onclick="App.deliverJob('${pubkey}')">📦 Submit Delivery</button>`;
    }
    if (job.state === 'delivered' && isMyBuyer) {
      actions.innerHTML += `<button class="btn btn-success" onclick="App.approveJob('${pubkey}')">✅ Approve</button>`;
      actions.innerHTML += `<button class="btn btn-warning" onclick="App.disputeJob('${pubkey}')">⚖️ Dispute</button>`;
    }
    actions.innerHTML += `<button class="btn btn-secondary" onclick="App.closeModal()">Close</button>`;

    document.getElementById('jobModal').classList.add('active');
  }

  function closeModal() {
    document.getElementById('jobModal').classList.remove('active');
  }

  // ─── Transaction Helpers ───
  async function sendTx(instruction) {
    if (!wallet || !publicKey) { toast('Connect your wallet first', 'error'); return null; }
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
      if (err.message?.includes('User rejected')) toast('Transaction rejected', 'info');
      else toast(`Transaction failed: ${err.message || err}`, 'error');
      return null;
    }
  }

  // ─── Job Actions (real on-chain) ───
  async function postJob(event) {
    event.preventDefault();
    if (!publicKey) { toast('Connect your wallet first', 'error'); return; }
    const reward = parseFloat(document.getElementById('jobReward').value);
    const description = document.getElementById('jobDescription').value;
    toast('Preparing transaction...', 'info');
    try {
      const escrowId = Date.now();
      const descBytes = new TextEncoder().encode(description);
      const descHashBuf = await crypto.subtle.digest('SHA-256', descBytes);
      const descriptionHash = new Uint8Array(descHashBuf);
      const [escrowPDA] = await findEscrowPDA(publicKey, escrowId);
      const [vaultPDA] = await findVaultPDA(escrowPDA.toBase58());
      const buyerATA = getAssociatedTokenAddress(publicKey, CONFIG.USDC_MINT.toBase58());
      const disc = await computeDiscriminator('create_escrow');
      const data = Buffer.concat([
        Buffer.from(disc), encodeLittleEndianU64(escrowId),
        encodeLittleEndianU64(Math.round(reward * 1e6)),
        encodeLittleEndianU64(0), Buffer.from(descriptionHash),
      ]);
      const ix = new TransactionInstruction({
        programId: CONFIG.PROGRAM_ID,
        keys: [
          { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: true },
          { pubkey: new PublicKey(publicKey), isSigner: false, isWritable: false },
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
      toast('Please approve the transaction in Phantom...', 'info');
      const sig = await sendTx(ix);
      if (sig) {
        toast(`Escrow created! Tx: ${truncateAddress(sig)}`, 'success');
        document.getElementById('postJobForm').reset();
        await loadEscrows();
        navigateTo('escrows');
      }
    } catch (err) {
      console.error('Create escrow error:', err);
      toast(`Failed: ${err.message || err}`, 'error');
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
      const ix = new TransactionInstruction({
        programId: CONFIG.PROGRAM_ID,
        keys: [
          { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: true },
          { pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true },
          { pubkey: vaultPDA, isSigner: false, isWritable: true },
          { pubkey: sellerATA, isSigner: false, isWritable: true },
          { pubkey: CONFIG.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(disc),
      });
      const sig = await sendTx(ix);
      if (sig) { toast(`Accepted! Tx: ${truncateAddress(sig)}`, 'success'); closeModal(); await loadEscrows(); }
    } catch (err) { toast(`Failed: ${err.message || err}`, 'error'); }
  }

  async function deliverJob(pubkey) {
    if (!publicKey) { toast('Connect your wallet first', 'error'); return; }
    const deliveryText = prompt('Enter delivery description or URL:');
    if (!deliveryText) return;
    try {
      const deliveryBytes = new TextEncoder().encode(deliveryText);
      const deliveryHashBuf = await crypto.subtle.digest('SHA-256', deliveryBytes);
      const disc = await computeDiscriminator('deliver');
      const data = Buffer.concat([Buffer.from(disc), new Uint8Array(deliveryHashBuf)]);
      const ix = new TransactionInstruction({
        programId: CONFIG.PROGRAM_ID,
        keys: [
          { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: false },
          { pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true },
        ],
        data,
      });
      const sig = await sendTx(ix);
      if (sig) { toast(`Delivered! Tx: ${truncateAddress(sig)}`, 'success'); closeModal(); await loadEscrows(); }
    } catch (err) { toast(`Failed: ${err.message || err}`, 'error'); }
  }

  async function approveJob(pubkey) {
    if (!publicKey) { toast('Connect your wallet first', 'error'); return; }
    const job = escrows.find(e => e.pubkey === pubkey);
    if (!job) return;
    try {
      const [vaultPDA] = await findVaultPDA(pubkey);
      const sellerATA = getAssociatedTokenAddress(job.seller, job.mint);
      const disc = await computeDiscriminator('approve');
      const ix = new TransactionInstruction({
        programId: CONFIG.PROGRAM_ID,
        keys: [
          { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: false },
          { pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true },
          { pubkey: vaultPDA, isSigner: false, isWritable: true },
          { pubkey: sellerATA, isSigner: false, isWritable: true },
          { pubkey: CONFIG.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(disc),
      });
      const sig = await sendTx(ix);
      if (sig) { toast(`Approved! Funds released. Tx: ${truncateAddress(sig)}`, 'success'); closeModal(); await loadEscrows(); }
    } catch (err) { toast(`Failed: ${err.message || err}`, 'error'); }
  }

  async function disputeJob(pubkey) {
    if (!publicKey) { toast('Connect your wallet first', 'error'); return; }
    try {
      const disc = await computeDiscriminator('dispute');
      const ix = new TransactionInstruction({
        programId: CONFIG.PROGRAM_ID,
        keys: [
          { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: false },
          { pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true },
        ],
        data: Buffer.from(disc),
      });
      const sig = await sendTx(ix);
      if (sig) { toast(`Dispute filed! Tx: ${truncateAddress(sig)}`, 'success'); closeModal(); await loadEscrows(); }
    } catch (err) { toast(`Failed: ${err.message || err}`, 'error'); }
  }

  // ─── Helpers ───
  function timeAgo(timestamp) {
    if (!timestamp || timestamp <= 0) return 'unknown';
    const diff = Date.now() - timestamp;
    const hours = Math.floor(diff / 3600000);
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

  function initNavHighlight() {
    const sections = document.querySelectorAll('section[id]');
    const links = document.querySelectorAll('.nav-section-link');
    window.addEventListener('scroll', () => {
      let current = '';
      sections.forEach(s => {
        if (window.scrollY >= s.offsetTop - 100) current = s.id;
      });
      links.forEach(l => l.classList.toggle('active', l.getAttribute('href') === `#${current}`));
    });
  }

  // ─── Init ───
  function init() {
    loadEscrows();
    renderDecisions();
    initScrollAnimations();
    initNavHighlight();

    document.getElementById('jobModal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });

    if (window.solana?.isPhantom && window.solana.isConnected) {
      connectWallet();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return {
    connectWallet, postJob, acceptJob, deliverJob, approveJob, disputeJob,
    filterEscrows, filterDecisions, openJob, closeModal, navigateTo, copyCode,
  };
})();

function toggleMobileNav() {
  document.getElementById('navLinks').classList.toggle('open');
}
