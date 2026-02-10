/* ═══════════════════════════════════════════════════════════
   CLAWSCROW — Frontend Application
   Real Solana devnet integration via @solana/web3.js
   No mock data — everything from on-chain or API
   ═══════════════════════════════════════════════════════════ */

const App = (() => {
  const { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY } = solanaWeb3;

  const CONFIG = {
    PROGRAM_ID: new PublicKey('7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7'),
    USDC_MINT: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
    TOKEN_PROGRAM_ID: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    ASSOCIATED_TOKEN_PROGRAM_ID: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
    RPC_URL: 'https://api.devnet.solana.com',
    API_URL: window.location.origin,
  };

  const STATE_NAMES = ['open', 'active', 'delivered', 'approved', 'disputed', 'resolved'];
  const connection = new Connection(CONFIG.RPC_URL, 'confirmed');

  let wallet = null;
  let publicKey = null;
  let escrows = [];
  let decisions = [];
  let currentFilter = 'all';
  const startTime = Date.now();

  // ─── Account Deserialization ───
  function deserializeEscrow(data, pubkey) {
    // Anchor layout: 8 disc + 8 id + 32 buyer + 32 seller + 32 arb
    // + 8 pay + 8 buyCol + 8 selCol + 8 deadline + 4+500 desc
    // + 1 state(@648) + 32 hash(@649) + 8 created(@681) + 8 delivered(@689) + 1 bump + 1 vaultBump
    const buf = Buffer.from(data);
    const escrowId = buf.readBigUInt64LE(8);
    const buyer = new PublicKey(buf.slice(16, 48));
    const seller = new PublicKey(buf.slice(48, 80));
    const arbitrator = new PublicKey(buf.slice(80, 112));
    const paymentAmount = buf.readBigUInt64LE(112);
    const buyerCollateral = buf.readBigUInt64LE(120);
    const sellerCollateral = buf.readBigUInt64LE(128);
    const descLen = Math.min(buf.readUInt32LE(144), 500);
    const description = buf.slice(148, 148 + descLen).toString('utf-8');
    const state = buf.readUInt8(648);
    const createdAt = Number(buf.readBigInt64LE(681));
    const deliveredAt = Number(buf.readBigInt64LE(689));
    return {
      pubkey, escrowId: Number(escrowId),
      buyer: buyer.toBase58(), seller: seller.toBase58(),
      arbitrator: arbitrator.toBase58(), description,
      paymentAmount: Number(paymentAmount),
      buyerCollateral: Number(buyerCollateral),
      sellerCollateral: Number(sellerCollateral),
      state: STATE_NAMES[state] || 'unknown', stateIndex: state,
      createdAt: createdAt * 1000, deliveredAt: deliveredAt * 1000,
    };
  }

  // ─── PDA Helpers ───
  async function findEscrowPDA(buyerPubkey, escrowId) {
    const buf = Buffer.alloc(8); buf.writeBigUInt64LE(BigInt(escrowId));
    return PublicKey.findProgramAddressSync([Buffer.from('escrow'), new PublicKey(buyerPubkey).toBuffer(), buf], CONFIG.PROGRAM_ID);
  }
  async function findVaultPDA(escrowPubkey) {
    return PublicKey.findProgramAddressSync([Buffer.from('vault'), new PublicKey(escrowPubkey).toBuffer()], CONFIG.PROGRAM_ID);
  }
  function getAssociatedTokenAddress(owner, mint) {
    return PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), CONFIG.TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()], CONFIG.ASSOCIATED_TOKEN_PROGRAM_ID)[0];
  }
  async function computeDiscriminator(name) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`global:${name}`));
    return new Uint8Array(buf).slice(0, 8);
  }
  function encodeLittleEndianU64(value) {
    const buf = new ArrayBuffer(8); new DataView(buf).setBigUint64(0, BigInt(value), true); return new Uint8Array(buf);
  }

  // ─── Wallet ───
  async function connectWallet() {
    try {
      if (publicKey) { disconnectWallet(); return; }
      const provider = window.solana;
      if (!provider?.isPhantom) { toast('Install Phantom wallet', 'error'); window.open('https://phantom.app/', '_blank'); return; }
      const resp = await provider.connect();
      wallet = provider; publicKey = resp.publicKey.toString();
      document.getElementById('connectWallet').innerHTML = `<span id="walletText">${trunc(publicKey)}</span>`;
      document.getElementById('connectWallet').classList.add('connected');
      toast(`Connected: ${trunc(publicKey)}`, 'success');
      loadEscrows();
      provider.on('disconnect', disconnectWallet);
    } catch (err) {
      if (err.code === 4001) toast('Rejected', 'info');
      else toast('Connection failed', 'error');
    }
  }
  function disconnectWallet() {
    if (wallet) wallet.disconnect();
    wallet = null; publicKey = null;
    document.getElementById('connectWallet').innerHTML = '<span id="walletText">Connect Wallet</span>';
    document.getElementById('connectWallet').classList.remove('connected');
  }
  function trunc(addr) { return addr ? addr.slice(0, 4) + '...' + addr.slice(-4) : '—'; }

  // ─── Load Data ───
  async function loadEscrows() {
    try {
      const accounts = await connection.getProgramAccounts(CONFIG.PROGRAM_ID, { commitment: 'confirmed' });
      escrows = accounts.filter(a => a.account.data.length >= 243).map(a => {
        try { return deserializeEscrow(a.account.data, a.pubkey.toBase58()); } catch { return null; }
      }).filter(Boolean);
      escrows.sort((a, b) => b.createdAt - a.createdAt);
    } catch (err) {
      console.error('Load escrows failed:', err);
      escrows = [];
    }
    updateStats();
    renderEscrows();
  }

  async function loadDecisions() {
    try {
      const res = await fetch(`${CONFIG.API_URL}/api/jobs`);
      if (res.ok) {
        const data = await res.json();
        decisions = (data.jobs || []).filter(j => j.status === 'disputed' || j.arbitration).map(j => ({
          escrowId: j.escrowId || j.id, date: j.disputedAt || j.updatedAt || '',
          verdict: j.arbitration?.winner || 'pending', amount: j.amount || 0,
          models: j.arbitration?.models?.join(', ') || '', reasoning: j.arbitration?.reasoning || '',
        }));
      }
    } catch { decisions = []; }
    renderDecisions();
  }

  function updateStats() {
    const el = (id) => document.getElementById(id);
    el('statEscrows').textContent = escrows.length;
    el('statDisputes').textContent = escrows.filter(e => e.state === 'resolved').length;
    // Uptime
    const upMs = Date.now() - startTime;
    const hrs = Math.floor(upMs / 3600000); const mins = Math.floor((upMs % 3600000) / 60000);
    el('statUptime').textContent = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    // Connection status
    const connEl = el('connStatus'); if (connEl) connEl.innerHTML = '● Connected';
    const pollEl = el('lastPoll'); if (pollEl) pollEl.textContent = 'just now';
    const escrowCount = el('contractEscrows'); if (escrowCount) escrowCount.textContent = escrows.length;
  }

  // ─── Render ───
  function renderEscrows() {
    const list = document.getElementById('escrowList');
    const filtered = currentFilter === 'all' ? escrows : escrows.filter(e => e.state === currentFilter);
    if (!filtered.length) {
      list.innerHTML = `<p class="empty-state">No escrows found on-chain yet. Connect Phantom wallet and create the first one!</p>`;
      return;
    }
    list.innerHTML = filtered.map(e => `
      <div class="escrow-card" onclick="App.openJob('${e.pubkey}')">
        <h4>Escrow #${e.escrowId} <span class="escrow-status status-${e.state}">${e.state}</span></h4>
        ${e.description ? `<p class="escrow-desc">${e.description.length > 120 ? e.description.slice(0, 120) + '…' : e.description}</p>` : ''}
        <div class="escrow-meta">👤 <a href="https://solscan.io/account/${e.buyer}?cluster=devnet" target="_blank">${trunc(e.buyer)}</a> → <a href="https://solscan.io/account/${e.seller}?cluster=devnet" target="_blank">${trunc(e.seller)}</a></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
          <span class="escrow-amount">$${(e.paymentAmount / 1e6).toLocaleString()} USDC</span>
          <span style="font-size:0.75rem;color:var(--text-muted)">${timeAgo(e.createdAt)}</span>
        </div>
      </div>
    `).join('');
  }

  function renderDecisions(filter = 'all') {
    const el = document.getElementById('decisionLog');
    if (!el) return;
    const filtered = filter === 'all' ? decisions : decisions.filter(d => d.verdict === filter);
    if (!filtered.length) {
      el.innerHTML = `<p class="empty-state">No disputes resolved yet</p>`;
      return;
    }
    el.innerHTML = filtered.map(d => `
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

  function filterEscrows(filter) {
    currentFilter = filter;
    renderEscrows();
  }

  // ─── Job Modal ───
  function openJob(pubkey) {
    const job = escrows.find(e => e.pubkey === pubkey);
    if (!job) return;
    const modal = document.getElementById('jobModal');
    if (!modal) return;
    document.getElementById('modalTitle').textContent = `Escrow #${job.escrowId}`;
    document.getElementById('modalStatus').textContent = job.state.toUpperCase();
    document.getElementById('modalStatus').className = `escrow-status status-${job.state}`;
    document.getElementById('modalReward').textContent = `$${(job.paymentAmount / 1e6).toLocaleString()} USDC`;
    document.getElementById('modalDeadline').textContent = job.collateralAmount > 0 ? `$${(job.collateralAmount / 1e6).toLocaleString()} USDC collateral` : 'None';
    document.getElementById('modalPoster').textContent = trunc(job.buyer);
    const noSeller = job.seller === '11111111111111111111111111111111';
    document.getElementById('modalWorker').textContent = noSeller ? 'Awaiting agent...' : trunc(job.seller);
    document.getElementById('modalDescription').textContent = `Account: ${job.pubkey}\nBuyer: ${job.buyer}\nSeller: ${noSeller ? 'None' : job.seller}\nCreated: ${new Date(job.createdAt).toLocaleString()}`;

    const actions = document.getElementById('modalActions');
    actions.innerHTML = '';
    const isMyBuyer = publicKey && job.buyer === publicKey;
    const isMySeller = publicKey && job.seller === publicKey;
    if (job.state === 'open' && publicKey && !isMyBuyer) actions.innerHTML += `<button class="btn btn-primary" onclick="App.acceptJob('${pubkey}')">🤖 Accept</button>`;
    if (job.state === 'active' && isMySeller) actions.innerHTML += `<button class="btn btn-primary" onclick="App.deliverJob('${pubkey}')">📦 Deliver</button>`;
    if (job.state === 'delivered' && isMyBuyer) {
      actions.innerHTML += `<button class="btn btn-primary" onclick="App.approveJob('${pubkey}')">✅ Approve</button>`;
      actions.innerHTML += `<button class="btn btn-outline" onclick="App.disputeJob('${pubkey}')">⚖️ Dispute</button>`;
    }
    actions.innerHTML += `<button class="btn btn-outline" onclick="App.closeModal()">Close</button>`;
    modal.classList.add('active');
  }
  function closeModal() { document.getElementById('jobModal')?.classList.remove('active'); }

  // ─── Transactions ───
  async function sendTx(instruction) {
    if (!wallet) { toast('Connect wallet first', 'error'); return null; }
    try {
      const tx = new Transaction().add(instruction);
      tx.feePayer = new PublicKey(publicKey);
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const signed = await wallet.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, 'confirmed');
      return sig;
    } catch (err) {
      if (err.message?.includes('rejected')) toast('Transaction rejected', 'info');
      else toast(`TX failed: ${err.message || err}`, 'error');
      return null;
    }
  }

  async function postJob(event) {
    event.preventDefault();
    if (!publicKey) { toast('Connect wallet first', 'error'); return; }
    const reward = parseFloat(document.getElementById('jobReward')?.value);
    const description = document.getElementById('jobDescription')?.value;
    if (!reward || !description) { toast('Fill in all fields', 'error'); return; }
    try {
      const escrowId = Date.now();
      const descHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(description)));
      const [escrowPDA] = await findEscrowPDA(publicKey, escrowId);
      const [vaultPDA] = await findVaultPDA(escrowPDA.toBase58());
      const buyerATA = getAssociatedTokenAddress(publicKey, CONFIG.USDC_MINT.toBase58());
      const disc = await computeDiscriminator('create_escrow');
      const data = Buffer.concat([Buffer.from(disc), encodeLittleEndianU64(escrowId), encodeLittleEndianU64(Math.round(reward * 1e6)), encodeLittleEndianU64(0), Buffer.from(descHash)]);
      const ix = new TransactionInstruction({ programId: CONFIG.PROGRAM_ID, keys: [
        { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: true },
        { pubkey: new PublicKey(publicKey), isSigner: false, isWritable: false },
        { pubkey: CONFIG.USDC_MINT, isSigner: false, isWritable: false },
        { pubkey: escrowPDA, isSigner: false, isWritable: true },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
        { pubkey: buyerATA, isSigner: false, isWritable: true },
        { pubkey: CONFIG.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ], data });
      toast('Approve in Phantom...', 'info');
      const sig = await sendTx(ix);
      if (sig) { toast(`Created! ${trunc(sig)}`, 'success'); loadEscrows(); }
    } catch (err) { toast(`Failed: ${err.message}`, 'error'); }
  }

  async function acceptJob(pubkey) {
    const job = escrows.find(e => e.pubkey === pubkey); if (!job) return;
    const [vaultPDA] = await findVaultPDA(pubkey);
    const sellerATA = getAssociatedTokenAddress(publicKey, job.mint);
    const disc = await computeDiscriminator('accept_escrow');
    const sig = await sendTx(new TransactionInstruction({ programId: CONFIG.PROGRAM_ID, keys: [
      { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true },
      { pubkey: vaultPDA, isSigner: false, isWritable: true },
      { pubkey: sellerATA, isSigner: false, isWritable: true },
      { pubkey: CONFIG.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ], data: Buffer.from(disc) }));
    if (sig) { toast('Accepted!', 'success'); closeModal(); loadEscrows(); }
  }

  async function deliverJob(pubkey) {
    const text = prompt('Delivery description/URL:'); if (!text) return;
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    const disc = await computeDiscriminator('deliver');
    const sig = await sendTx(new TransactionInstruction({ programId: CONFIG.PROGRAM_ID, keys: [
      { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: false },
      { pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true },
    ], data: Buffer.concat([Buffer.from(disc), Buffer.from(hash)]) }));
    if (sig) { toast('Delivered!', 'success'); closeModal(); loadEscrows(); }
  }

  async function approveJob(pubkey) {
    const job = escrows.find(e => e.pubkey === pubkey); if (!job) return;
    const [vaultPDA] = await findVaultPDA(pubkey);
    const sellerATA = getAssociatedTokenAddress(job.seller, job.mint);
    const disc = await computeDiscriminator('approve');
    const sig = await sendTx(new TransactionInstruction({ programId: CONFIG.PROGRAM_ID, keys: [
      { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: false },
      { pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true },
      { pubkey: vaultPDA, isSigner: false, isWritable: true },
      { pubkey: sellerATA, isSigner: false, isWritable: true },
      { pubkey: CONFIG.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ], data: Buffer.from(disc) }));
    if (sig) { toast('Approved! Funds released.', 'success'); closeModal(); loadEscrows(); }
  }

  async function disputeJob(pubkey) {
    const disc = await computeDiscriminator('dispute');
    const sig = await sendTx(new TransactionInstruction({ programId: CONFIG.PROGRAM_ID, keys: [
      { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: false },
      { pubkey: new PublicKey(pubkey), isSigner: false, isWritable: true },
    ], data: Buffer.from(disc) }));
    if (sig) { toast('Dispute filed!', 'success'); closeModal(); loadEscrows(); }
  }

  // ─── Helpers ───
  function timeAgo(ts) {
    if (!ts || ts <= 0) return '—';
    const h = Math.floor((Date.now() - ts) / 3600000);
    return h < 1 ? 'just now' : h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
  }
  function navigateTo(id) { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }
  function toast(msg, type = 'info') {
    const c = document.getElementById('toastContainer');
    if (!c) { console.log(`[${type}] ${msg}`); return; }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4000);
  }
  function copyCurl() {
    const code = document.querySelector('.curl-code code');
    if (code) navigator.clipboard.writeText(code.textContent).then(() => toast('Copied!', 'success'));
  }

  function copyCode(btn) {
    const code = btn.closest('.curl-block')?.querySelector('code');
    if (code) navigator.clipboard.writeText(code.textContent).then(() => toast('Copied!', 'success'));
  }

  // ─── Init ───
  function init() {
    loadEscrows();
    loadDecisions();
    // Auto-refresh every 30s
    setInterval(() => { loadEscrows(); loadDecisions(); }, 30000);
    // Phantom auto-connect
    if (window.solana?.isPhantom && window.solana.isConnected) connectWallet();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { connectWallet, postJob, acceptJob, deliverJob, approveJob, disputeJob, filterEscrows, openJob, closeModal, navigateTo, copyCurl, copyCode };
})();
