/* ═══════════════════════════════════════════════════════════
   CLAWSCROW — Frontend Application
   Solana devnet + Phantom wallet integration
   PDA seeds: [b"escrow", escrow_id_le] and [b"vault", escrow_id_le]
   ═══════════════════════════════════════════════════════════ */

const App = (() => {
  const { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY } = solanaWeb3;

  const CONFIG = {
    PROGRAM_ID: new PublicKey('7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7'),
    USDC_MINT: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
    ARBITRATOR: new PublicKey('DF26XZhyKWH4MeSQ1yfEQxBB22vg2EYWS2BfkX1fCUZb'),
    TOKEN_PROGRAM_ID: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    ASSOCIATED_TOKEN_PROGRAM_ID: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
    RPC_URL: 'https://api.devnet.solana.com',
    API_URL: window.location.origin,
    loaded: false,
  };

  // Fetch runtime config (USDC mint, arbitrator) from backend
  async function loadConfig() {
    if (CONFIG.loaded) return;
    try {
      const res = await fetch(`${CONFIG.API_URL}/api/config`);
      if (res.ok) {
        const data = await res.json();
        if (data.usdcMint) CONFIG.USDC_MINT = new PublicKey(data.usdcMint);
        if (data.arbitrator) CONFIG.ARBITRATOR = new PublicKey(data.arbitrator);
        CONFIG.loaded = true;
        console.log('Config loaded — USDC:', data.usdcMint, 'Arbitrator:', data.arbitrator);
      }
    } catch (e) { console.warn('Config fetch failed, using defaults'); }
  }

  const connection = new Connection(CONFIG.RPC_URL, 'confirmed');

  let wallet = null;
  let publicKey = null;
  let escrows = [];
  let decisions = [];
  let currentFilter = 'all';
  const startTime = Date.now();

  // ─── Buffer polyfill for browser ───
  const toBuffer = (str) => new TextEncoder().encode(str);

  // ─── Borsh Helpers ───
  function u64LE(value) {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setBigUint64(0, BigInt(value), true);
    return new Uint8Array(buf);
  }

  function i64LE(value) {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setBigInt64(0, BigInt(value), true);
    return new Uint8Array(buf);
  }

  function borshString(str) {
    const encoded = new TextEncoder().encode(str);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, encoded.length, true);
    const result = new Uint8Array(4 + encoded.length);
    result.set(len, 0);
    result.set(encoded, 4);
    return result;
  }

  // ─── PDA Derivation (matches on-chain program) ───
  function findEscrowPDA(escrowId) {
    return PublicKey.findProgramAddressSync(
      [toBuffer('escrow'), u64LE(escrowId)],
      CONFIG.PROGRAM_ID
    );
  }

  function findVaultPDA(escrowId) {
    return PublicKey.findProgramAddressSync(
      [toBuffer('vault'), u64LE(escrowId)],
      CONFIG.PROGRAM_ID
    );
  }

  function getAssociatedTokenAddress(owner, mint) {
    return PublicKey.findProgramAddressSync(
      [new PublicKey(owner).toBuffer(), CONFIG.TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()],
      CONFIG.ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
  }

  // ─── Wallet ───
  async function connectWallet() {
    try {
      if (publicKey) { disconnectWallet(); return; }
      const provider = window.solana;
      if (!provider?.isPhantom) {
        toast('Install Phantom wallet', 'error');
        window.open('https://phantom.app/', '_blank');
        return;
      }
      const resp = await provider.connect();
      wallet = provider;
      publicKey = resp.publicKey.toString();
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

  // ─── Transaction Sending ───
  async function sendTx(instruction) {
    if (!wallet) { toast('Connect wallet first', 'error'); return null; }
    try {
      toast('Approve in Phantom...', 'info');
      const tx = new Transaction().add(instruction);
      tx.feePayer = new PublicKey(publicKey);
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const signed = await wallet.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, 'confirmed');
      toast(`TX confirmed: ${trunc(sig)}`, 'success');
      return sig;
    } catch (err) {
      if (err.message?.includes('rejected') || err.code === 4001) toast('Transaction rejected', 'info');
      else toast(`TX failed: ${err.message || err}`, 'error');
      return null;
    }
  }

  // ─── Load Data ───
  async function loadEscrows() {
    try {
      const res = await fetch(`${CONFIG.API_URL}/api/jobs`);
      if (res.ok) {
        const data = await res.json();
        escrows = (data.jobs || []).map(j => ({
          escrowId: j.escrowId,
          buyer: j.buyer || '',
          seller: j.seller || '',
          description: j.description || '',
          paymentAmount: j.paymentAmount || 0,
          buyerCollateral: j.buyerCollateral || 0,
          sellerCollateral: j.sellerCollateral || 0,
          state: j.state || 'unknown',
          createdAt: j.createdAt || 0,
          deliveredAt: j.deliveredAt || 0,
        }));
        escrows.sort((a, b) => b.escrowId - a.escrowId);
      }
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
        decisions = (data.jobs || []).filter(j =>
          j.state === 'disputed' || j.state === 'resolved_buyer' || j.state === 'resolved_seller'
        ).map(j => ({
          escrowId: j.escrowId,
          date: j.createdAt ? new Date(j.createdAt).toLocaleDateString() : '',
          verdict: j.state?.includes('buyer') ? 'buyer' : j.state?.includes('seller') ? 'seller' : 'pending',
          amount: (j.paymentAmount || 0) / 1e6,
          reasoning: j.arbitration?.reasoning || '',
        }));
      }
    } catch { decisions = []; }
    renderDecisions();
  }

  function updateStats() {
    const el = (id) => document.getElementById(id);
    if (el('statEscrows')) el('statEscrows').textContent = escrows.length;
    if (el('statDisputes')) el('statDisputes').textContent = escrows.filter(e =>
      e.state === 'resolved_buyer' || e.state === 'resolved_seller'
    ).length;
    const upMs = Date.now() - startTime;
    const hrs = Math.floor(upMs / 3600000);
    const mins = Math.floor((upMs % 3600000) / 60000);
    if (el('statUptime')) el('statUptime').textContent = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    if (el('connStatus')) el('connStatus').innerHTML = '● Connected';
    if (el('lastPoll')) el('lastPoll').textContent = new Date().toLocaleTimeString();
    if (el('contractEscrows')) el('contractEscrows').textContent = escrows.length;
  }

  // ─── Render ───
  function renderEscrows() {
    const list = document.getElementById('escrowList');
    if (!list) return;
    const filtered = currentFilter === 'all' ? escrows : escrows.filter(e => e.state === currentFilter);
    if (!filtered.length) {
      list.innerHTML = `<p class="empty-state">No escrows found. ${publicKey ? 'Create one or wait for agents!' : 'Connect Phantom wallet to interact.'}</p>`;
      return;
    }
    list.innerHTML = filtered.map(e => {
      const noSeller = !e.seller || e.seller === '11111111111111111111111111111111';
      return `
      <div class="escrow-card" onclick="App.openJob(${e.escrowId})">
        <h4>Escrow #${e.escrowId} <span class="escrow-status status-${e.state}">${e.state}</span></h4>
        ${e.description ? `<p class="escrow-desc">${e.description.length > 120 ? e.description.slice(0, 120) + '…' : e.description}</p>` : ''}
        <div class="escrow-meta">👤 <a href="https://solscan.io/account/${e.buyer}?cluster=devnet" target="_blank" onclick="event.stopPropagation()">${trunc(e.buyer)}</a> → ${noSeller ? '<em>open</em>' : `<a href="https://solscan.io/account/${e.seller}?cluster=devnet" target="_blank" onclick="event.stopPropagation()">${trunc(e.seller)}</a>`}</div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
          <span class="escrow-amount">$${(e.paymentAmount / 1e6).toLocaleString(undefined, {minimumFractionDigits: 2})} USDC</span>
          <span style="font-size:0.75rem;color:var(--text-muted)">${timeAgo(e.createdAt)}</span>
        </div>
      </div>`;
    }).join('');
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
          <span class="decision-verdict ${d.verdict === 'buyer' ? 'verdict-buyer' : 'verdict-seller'}">${d.verdict === 'buyer' ? '✗ Buyer Wins' : '✓ Seller Wins'}</span>
          <span class="decision-amount">$${d.amount.toFixed(2)} USDC</span>
          <span class="decision-date">${d.date}</span>
        </div>
        ${d.reasoning ? `<div class="decision-reasoning">${d.reasoning}</div>` : ''}
      </div>
    `).join('');
  }

  function filterEscrows(filter) {
    currentFilter = filter;
    renderEscrows();
  }

  function filterDecisions() {
    const filter = document.getElementById('decisionFilter')?.value || 'all';
    renderDecisions(filter);
  }

  // ─── Job Modal ───
  async function openJob(escrowId) {
    const job = escrows.find(e => e.escrowId == escrowId);
    if (!job) return;
    const modal = document.getElementById('jobModal');
    if (!modal) return;

    document.getElementById('modalTitle').textContent = `Escrow #${job.escrowId}`;
    document.getElementById('modalStatus').textContent = job.state.toUpperCase();
    document.getElementById('modalStatus').className = `escrow-status status-${job.state}`;
    document.getElementById('modalReward').textContent = `$${(job.paymentAmount / 1e6).toFixed(2)} USDC`;
    document.getElementById('modalDeadline').textContent = `Buyer: $${(job.buyerCollateral / 1e6).toFixed(2)} / Seller: $${(job.sellerCollateral / 1e6).toFixed(2)}`;
    document.getElementById('modalPoster').textContent = trunc(job.buyer);
    const noSeller = !job.seller || job.seller === '11111111111111111111111111111111';
    document.getElementById('modalWorker').textContent = noSeller ? 'Awaiting seller...' : trunc(job.seller);

    let descText = job.description || 'No description';
    descText += `\n\nBuyer: ${job.buyer}\nSeller: ${noSeller ? 'None' : job.seller}\nCreated: ${job.createdAt ? new Date(job.createdAt).toLocaleString() : 'N/A'}`;
    document.getElementById('modalDescription').textContent = descText;

    // Load files
    const filesEl = document.getElementById('modalFiles');
    if (filesEl) {
      try {
        const res = await fetch(`${CONFIG.API_URL}/api/files?escrowId=${job.escrowId}`);
        if (res.ok) {
          const data = await res.json();
          const files = (data.files || []).filter(f => !(f.filename || '').endsWith('.arb'));
          filesEl.innerHTML = files.length > 0
            ? '<h4 style="margin:0.5rem 0">📁 Deliverables</h4>' + files.map(f =>
                `<div class="file-item"><span>📄 ${f.filename || f.id}</span>
                 ${f.encrypted ? `<a href="${CONFIG.API_URL}/api/files/${f.id}/decrypt?escrowId=${job.escrowId}&role=buyer" target="_blank" class="btn btn-sm btn-primary">🔓 Decrypt</a>` : ''}
                 <a href="${CONFIG.API_URL}/api/files/${f.id}?raw=true" target="_blank" class="btn btn-sm btn-outline">⬇ Download</a></div>`
              ).join('')
            : '<p style="color:var(--text-muted);font-size:0.85rem">No files uploaded yet</p>';
        }
      } catch { filesEl.innerHTML = ''; }
    }

    // Actions based on state + wallet
    const actions = document.getElementById('modalActions');
    actions.innerHTML = '';
    const isMyBuyer = publicKey && job.buyer === publicKey;
    const isMySeller = publicKey && job.seller === publicKey;

    if (job.state === 'created' && publicKey && !isMyBuyer) {
      actions.innerHTML += `<button class="btn btn-primary" onclick="App.acceptJob(${job.escrowId})">🤖 Accept Job</button>`;
    }
    if (job.state === 'accepted' && isMySeller) {
      actions.innerHTML += `<button class="btn btn-primary" onclick="App.deliverJob(${job.escrowId})">📦 Deliver</button>`;
    }
    if (job.state === 'delivered' && isMyBuyer) {
      actions.innerHTML += `<button class="btn btn-primary" onclick="App.approveJob(${job.escrowId})">✅ Approve</button>`;
      actions.innerHTML += `<button class="btn btn-outline" onclick="App.disputeJob(${job.escrowId})">⚖️ Dispute</button>`;
    }
    actions.innerHTML += `<button class="btn btn-outline" onclick="App.closeModal()">Close</button>`;

    // Solscan link
    const [escrowPda] = findEscrowPDA(job.escrowId);
    actions.innerHTML += `<a href="https://solscan.io/account/${escrowPda.toBase58()}?cluster=devnet" target="_blank" class="btn btn-outline" style="margin-left:auto">🔗 Solscan</a>`;

    modal.classList.add('active');
  }

  function closeModal() {
    document.getElementById('jobModal')?.classList.remove('active');
    document.getElementById('deliverModal')?.remove();
  }

  // ─── On-Chain Actions via Phantom ───

  async function createEscrowTx(description, paymentUsdc, buyerColUsdc, sellerColUsdc) {
    if (!publicKey) { toast('Connect wallet first', 'error'); return; }

    const escrowId = Date.now();
    const paymentAmount = Math.round(paymentUsdc * 1e6);
    const buyerCollateral = Math.round(buyerColUsdc * 1e6);
    const sellerCollateral = Math.round(sellerColUsdc * 1e6);
    const deadlineTs = Math.floor(Date.now() / 1000) + 86400 * 3; // 3 days

    const [escrowPda] = findEscrowPDA(escrowId);
    const [vaultPda] = findVaultPDA(escrowId);
    const buyerAta = getAssociatedTokenAddress(publicKey, CONFIG.USDC_MINT.toBase58());

    // Borsh serialize: disc + u64 escrowId + string desc + u64 payment + u64 buyerCol + u64 sellerCol + i64 deadline
    const descBytes = borshString(description);
    const data = new Uint8Array(8 + 8 + descBytes.length + 8 + 8 + 8 + 8);
    let offset = 0;
    data.set(CLAWSCROW_IDL.instructions.create_escrow.discriminator, offset); offset += 8;
    data.set(u64LE(escrowId), offset); offset += 8;
    data.set(descBytes, offset); offset += descBytes.length;
    data.set(u64LE(paymentAmount), offset); offset += 8;
    data.set(u64LE(buyerCollateral), offset); offset += 8;
    data.set(u64LE(sellerCollateral), offset); offset += 8;
    data.set(i64LE(deadlineTs), offset);

    const ix = new TransactionInstruction({
      programId: CONFIG.PROGRAM_ID,
      keys: [
        { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: true },  // buyer
        { pubkey: escrowPda, isSigner: false, isWritable: true },                // escrow PDA
        { pubkey: vaultPda, isSigner: false, isWritable: true },                 // vault PDA
        { pubkey: buyerAta, isSigner: false, isWritable: true },                 // buyer_token
        { pubkey: CONFIG.USDC_MINT, isSigner: false, isWritable: false },        // usdc_mint
        { pubkey: CONFIG.ARBITRATOR, isSigner: false, isWritable: false },       // arbitrator
        { pubkey: CONFIG.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token_program
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },      // rent
      ],
      data: data,
    });

    const sig = await sendTx(ix);
    if (sig) {
      toast(`Escrow #${escrowId} created!`, 'success');
      // Register in backend too
      fetch(`${CONFIG.API_URL}/api/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ escrowId, description, buyer: publicKey, paymentAmount, buyerCollateral, sellerCollateral }),
      }).catch(() => {});
      setTimeout(loadEscrows, 2000);
    }
  }

  async function acceptJob(escrowId) {
    if (!publicKey) { toast('Connect wallet first', 'error'); return; }

    const [escrowPda] = findEscrowPDA(escrowId);
    const [vaultPda] = findVaultPDA(escrowId);
    const sellerAta = getAssociatedTokenAddress(publicKey, CONFIG.USDC_MINT.toBase58());

    // Borsh: disc + u64 escrowId
    const data = new Uint8Array(16);
    data.set(CLAWSCROW_IDL.instructions.accept_escrow.discriminator, 0);
    data.set(u64LE(escrowId), 8);

    const ix = new TransactionInstruction({
      programId: CONFIG.PROGRAM_ID,
      keys: [
        { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: true },   // seller
        { pubkey: escrowPda, isSigner: false, isWritable: true },                 // escrow
        { pubkey: vaultPda, isSigner: false, isWritable: true },                  // vault
        { pubkey: sellerAta, isSigner: false, isWritable: true },                 // seller_token
        { pubkey: CONFIG.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },  // token_program
      ],
      data: data,
    });

    const sig = await sendTx(ix);
    if (sig) {
      toast('Job accepted!', 'success');
      closeModal();
      setTimeout(loadEscrows, 2000);
    }
  }

  async function deliverJob(escrowId) {
    const job = escrows.find(e => e.escrowId == escrowId);
    if (!job) return;

    // Create deliver modal
    const existing = document.getElementById('deliverModal');
    if (existing) existing.remove();

    const div = document.createElement('div');
    div.id = 'deliverModal';
    div.className = 'modal-overlay active';
    div.innerHTML = `
      <div class="modal-content" style="max-width:500px">
        <h3>📦 Deliver Work — Escrow #${escrowId}</h3>
        <div style="margin-bottom:1rem">
          <label style="display:block;margin-bottom:4px;font-size:0.85rem;color:var(--text-secondary)">Upload file</label>
          <input type="file" id="deliverFile" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text-primary)">
        </div>
        <div style="margin-bottom:1rem">
          <label style="display:block;margin-bottom:4px;font-size:0.85rem;color:var(--text-secondary)">Or paste text</label>
          <textarea id="deliverText" rows="4" placeholder="Paste deliverable text here..." style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);resize:vertical;font-family:inherit"></textarea>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" onclick="App.submitDelivery(${escrowId})">🚀 Upload & Deliver</button>
          <button class="btn btn-outline" onclick="document.getElementById('deliverModal').remove()">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(div);
  }

  async function submitDelivery(escrowId) {
    const fileInput = document.getElementById('deliverFile');
    const textInput = document.getElementById('deliverText');

    let content, filename;
    if (fileInput?.files?.length > 0) {
      const file = fileInput.files[0];
      filename = file.name;
      const buf = await file.arrayBuffer();
      content = btoa(String.fromCharCode(...new Uint8Array(buf)));
    } else if (textInput?.value?.trim()) {
      filename = 'delivery.txt';
      content = btoa(unescape(encodeURIComponent(textInput.value)));
    } else {
      toast('Upload a file or enter text', 'error');
      return;
    }

    try {
      toast('Uploading...', 'info');
      const uploadRes = await fetch(`${CONFIG.API_URL}/api/files`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content, escrowId: String(escrowId), uploadedBy: publicKey || 'phantom-user' }),
      });
      const uploadData = await uploadRes.json();
      if (!uploadData.ok) { toast(`Upload failed: ${uploadData.error}`, 'error'); return; }

      // Now submit delivery on-chain via Phantom
      const contentHash = uploadData.contentHash || '';
      const hashBytes = new Uint8Array(32);
      const hashEncoded = new TextEncoder().encode(contentHash.slice(0, 32));
      hashBytes.set(hashEncoded);

      const [escrowPda] = findEscrowPDA(escrowId);

      // Borsh: disc + [u8;32] deliveryHash
      const data = new Uint8Array(8 + 32);
      data.set(CLAWSCROW_IDL.instructions.deliver.discriminator, 0);
      data.set(hashBytes, 8);

      const ix = new TransactionInstruction({
        programId: CONFIG.PROGRAM_ID,
        keys: [
          { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: false }, // seller
          { pubkey: escrowPda, isSigner: false, isWritable: true },               // escrow
        ],
        data: data,
      });

      const sig = await sendTx(ix);
      if (sig) {
        // Also update backend
        fetch(`${CONFIG.API_URL}/api/jobs/${escrowId}/deliver`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hash: contentHash, fileId: uploadData.fileId }),
        }).catch(() => {});
        document.getElementById('deliverModal')?.remove();
        toast('Delivered! 🦞', 'success');
        closeModal();
        setTimeout(loadEscrows, 2000);
      }
    } catch (err) {
      toast(`Delivery failed: ${err.message}`, 'error');
    }
  }

  async function approveJob(escrowId) {
    if (!publicKey) { toast('Connect wallet first', 'error'); return; }

    const job = escrows.find(e => e.escrowId == escrowId);
    if (!job) return;

    const [escrowPda] = findEscrowPDA(escrowId);
    const [vaultPda] = findVaultPDA(escrowId);
    const buyerAta = getAssociatedTokenAddress(publicKey, CONFIG.USDC_MINT.toBase58());

    // Find seller token account
    const noSeller = !job.seller || job.seller === '11111111111111111111111111111111';
    if (noSeller) { toast('No seller to pay', 'error'); return; }
    const sellerAta = getAssociatedTokenAddress(job.seller, CONFIG.USDC_MINT.toBase58());

    // Borsh: disc + u64 escrowId
    const data = new Uint8Array(16);
    data.set(CLAWSCROW_IDL.instructions.approve.discriminator, 0);
    data.set(u64LE(escrowId), 8);

    const ix = new TransactionInstruction({
      programId: CONFIG.PROGRAM_ID,
      keys: [
        { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: false },  // signer (buyer)
        { pubkey: escrowPda, isSigner: false, isWritable: true },                 // escrow
        { pubkey: vaultPda, isSigner: false, isWritable: true },                  // vault
        { pubkey: buyerAta, isSigner: false, isWritable: true },                  // buyer_token
        { pubkey: sellerAta, isSigner: false, isWritable: true },                 // seller_token
        { pubkey: CONFIG.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },  // token_program
      ],
      data: data,
    });

    const sig = await sendTx(ix);
    if (sig) {
      toast('Approved! Funds released. 🦞', 'success');
      closeModal();
      setTimeout(loadEscrows, 2000);
    }
  }

  async function disputeJob(escrowId) {
    if (!publicKey) { toast('Connect wallet first', 'error'); return; }

    const [escrowPda] = findEscrowPDA(escrowId);

    // raise_dispute has NO args, just disc
    const data = new Uint8Array(8);
    data.set(CLAWSCROW_IDL.instructions.raise_dispute.discriminator, 0);

    const ix = new TransactionInstruction({
      programId: CONFIG.PROGRAM_ID,
      keys: [
        { pubkey: new PublicKey(publicKey), isSigner: true, isWritable: false }, // buyer
        { pubkey: escrowPda, isSigner: false, isWritable: true },               // escrow
      ],
      data: data,
    });

    const sig = await sendTx(ix);
    if (sig) {
      toast('Dispute filed! AI arbitration will evaluate.', 'success');
      // Trigger backend arbitration
      fetch(`${CONFIG.API_URL}/api/jobs/${escrowId}/dispute`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Dispute raised via Phantom wallet' }),
      }).then(r => r.json()).then(data => {
        if (data.arbitration) {
          toast(`Ruling: ${data.arbitration.finalRuling} (confidence: ${data.arbitration.confidence || 'N/A'})`, 'info');
        }
      }).catch(() => {});
      closeModal();
      setTimeout(loadEscrows, 3000);
    }
  }

  // ─── Create Escrow Form ───
  function showCreateForm() {
    if (!publicKey) { toast('Connect wallet first', 'error'); return; }

    const existing = document.getElementById('createModal');
    if (existing) existing.remove();

    const div = document.createElement('div');
    div.id = 'createModal';
    div.className = 'modal-overlay active';
    div.innerHTML = `
      <div class="modal-content" style="max-width:500px">
        <h3>🦞 Create Escrow</h3>
        <div style="margin-bottom:1rem">
          <label style="display:block;margin-bottom:4px;font-size:0.85rem">Job Description</label>
          <textarea id="createDesc" rows="3" placeholder="Describe what you need done..." style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text-primary);resize:vertical;font-family:inherit"></textarea>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:1rem">
          <div>
            <label style="display:block;margin-bottom:4px;font-size:0.85rem">Payment (USDC)</label>
            <input type="number" id="createPayment" value="5.00" step="0.01" min="0.01" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text-primary)">
          </div>
          <div>
            <label style="display:block;margin-bottom:4px;font-size:0.85rem">Buyer Collateral</label>
            <input type="number" id="createBuyerCol" value="1.00" step="0.01" min="0" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text-primary)">
          </div>
          <div>
            <label style="display:block;margin-bottom:4px;font-size:0.85rem">Seller Collateral</label>
            <input type="number" id="createSellerCol" value="1.00" step="0.01" min="0" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text-primary)">
          </div>
        </div>
        <p style="font-size:0.8rem;color:var(--text-muted);margin-bottom:1rem">
          Total locked: Payment + Buyer Collateral = <strong id="createTotal">$6.00</strong> USDC from your wallet.
          Seller deposits their collateral when accepting.
        </p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" onclick="App.submitCreate()">🦞 Create & Lock Funds</button>
          <button class="btn btn-outline" onclick="document.getElementById('createModal').remove()">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(div);

    // Update total on input change
    const updateTotal = () => {
      const pay = parseFloat(document.getElementById('createPayment')?.value || 0);
      const col = parseFloat(document.getElementById('createBuyerCol')?.value || 0);
      const el = document.getElementById('createTotal');
      if (el) el.textContent = `$${(pay + col).toFixed(2)}`;
    };
    document.getElementById('createPayment')?.addEventListener('input', updateTotal);
    document.getElementById('createBuyerCol')?.addEventListener('input', updateTotal);
  }

  async function submitCreate() {
    const desc = document.getElementById('createDesc')?.value?.trim();
    const payment = parseFloat(document.getElementById('createPayment')?.value);
    const buyerCol = parseFloat(document.getElementById('createBuyerCol')?.value);
    const sellerCol = parseFloat(document.getElementById('createSellerCol')?.value);

    if (!desc) { toast('Enter a description', 'error'); return; }
    if (!payment || payment <= 0) { toast('Enter a valid payment amount', 'error'); return; }

    document.getElementById('createModal')?.remove();
    await createEscrowTx(desc, payment, buyerCol || 0, sellerCol || 0);
  }

  // ─── Helpers ───
  function timeAgo(ts) {
    if (!ts || ts <= 0) return '—';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function toast(msg, type = 'info') {
    const c = document.getElementById('toastContainer');
    if (!c) { console.log(`[${type}] ${msg}`); return; }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4000);
  }

  function copyCode(btn) {
    const code = btn.closest('.curl-block')?.querySelector('code');
    if (code) navigator.clipboard.writeText(code.textContent).then(() => toast('Copied!', 'success'));
  }

  // ─── Init ───
  async function init() {
    document.getElementById('connectWallet')?.addEventListener('click', connectWallet);
    await loadConfig();
    loadEscrows();
    loadDecisions();
    setInterval(() => { loadEscrows(); loadDecisions(); }, 10000);
    // Phantom auto-connect
    if (window.solana?.isPhantom && window.solana.isConnected) {
      window.solana.connect({ onlyIfTrusted: true }).then(resp => {
        wallet = window.solana;
        publicKey = resp.publicKey.toString();
        document.getElementById('connectWallet').innerHTML = `<span id="walletText">${trunc(publicKey)}</span>`;
        document.getElementById('connectWallet').classList.add('connected');
        loadEscrows();
      }).catch(() => {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return {
    connectWallet, showCreateForm, acceptJob, deliverJob, submitDelivery,
    approveJob, disputeJob, filterEscrows, openJob, closeModal,
    copyCode, submitCreate,
  };
})();
