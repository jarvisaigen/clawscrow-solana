/* ═══════════════════════════════════════════════════════════
   CLAWSCROW — Frontend Application
   Solana wallet integration + escrow interaction stubs
   ═══════════════════════════════════════════════════════════ */

const App = (() => {
  // ─── Config ───
  const CONFIG = {
    PROGRAM_ID: '7KGm2AoZh2HtqqLx15BXEkt8fS1y9uAS8vXRRTw9Nud7',
    USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Devnet USDC
    CLUSTER: 'devnet',
    RPC_URL: 'https://api.devnet.solana.com',
  };

  // ─── State ───
  let wallet = null;
  let publicKey = null;
  let escrows = [];
  let currentFilter = 'all';

  // ─── Mock Data (replaced by on-chain reads when program is deployed) ───
  const MOCK_ESCROWS = [
    {
      id: 'ESC-001', title: 'Analyze 30-day DEX volume data',
      description: 'Process and analyze 30 days of decentralized exchange volume data across Raydium, Orca, and Jupiter. Deliver a structured JSON report with daily volumes, top pairs, and trend analysis.',
      reward: 150, status: 'open', category: 'data',
      poster: '7xKX...9mPQ', worker: null,
      deadline: '2026-02-11T12:00:00Z', created: '2026-02-09T10:00:00Z'
    },
    {
      id: 'ESC-002', title: 'Build Telegram trading bot',
      description: 'Create a Telegram bot that monitors Solana token launches and sends alerts based on configurable filters (liquidity, holder count, etc).',
      reward: 500, status: 'active', category: 'code',
      poster: '3bFx...7kLm', worker: '9pQr...2nWs',
      deadline: '2026-02-12T18:00:00Z', created: '2026-02-08T14:00:00Z'
    },
    {
      id: 'ESC-003', title: 'Write tokenomics research report',
      description: 'Research and write a comprehensive report on sustainable tokenomics models for AI agent networks. Include case studies from at least 5 projects.',
      reward: 200, status: 'open', category: 'research',
      poster: '5mNx...1qTz', worker: null,
      deadline: '2026-02-14T00:00:00Z', created: '2026-02-09T08:00:00Z'
    },
    {
      id: 'ESC-004', title: 'Optimize MEV strategy script',
      description: 'Review and optimize an existing Jito MEV bundle strategy for Solana. Target: reduce failed bundles by 30% and improve profitability.',
      reward: 1000, status: 'active', category: 'trading',
      poster: '2kWv...8hDj', worker: 'AiBot...Qx7',
      deadline: '2026-02-10T20:00:00Z', created: '2026-02-07T16:00:00Z'
    },
    {
      id: 'ESC-005', title: 'Generate social media content plan',
      description: 'Create a 30-day content calendar for a Solana DeFi protocol launch. Include tweet copy, thread outlines, and meme concepts.',
      reward: 75, status: 'disputed', category: 'content',
      poster: '8rLs...4vKn', worker: 'GPT4...mX9',
      deadline: '2026-02-09T15:00:00Z', created: '2026-02-06T11:00:00Z'
    },
    {
      id: 'ESC-006', title: 'Audit smart contract for vulnerabilities',
      description: 'Perform a security audit on an Anchor program (~800 lines). Check for common vulnerabilities: reentrancy, overflow, PDA validation, authority checks.',
      reward: 2000, status: 'completed', category: 'code',
      poster: '1nBx...6jRt', worker: 'Claude...3k',
      deadline: '2026-02-08T12:00:00Z', created: '2026-02-05T09:00:00Z'
    },
  ];

  const MOCK_ARBITRATIONS = [
    {
      jobId: 'ESC-005', date: '2026-02-09T16:30:00Z',
      verdict: 'worker', confidence: 87,
      reasoning: 'The worker delivered a complete 30-day content calendar with 90 tweet drafts, 8 thread outlines, and 15 meme concepts. While the poster claims the quality was insufficient, the deliverable objectively meets the specification outlined in the job description. The content demonstrates understanding of DeFi terminology and target audience. Verdict: Release funds to worker.',
    },
    {
      jobId: 'ESC-012', date: '2026-02-08T11:00:00Z',
      verdict: 'poster', confidence: 94,
      reasoning: 'The worker submitted a data analysis that only covered 12 days instead of the requested 30 days. Multiple data points contain errors when cross-referenced with on-chain data. The deliverable does not meet the minimum requirements. Verdict: Return funds to poster.',
    },
    {
      jobId: 'ESC-009', date: '2026-02-07T09:15:00Z',
      verdict: 'split', confidence: 72,
      reasoning: 'The worker delivered a functional bot but missed 2 of 5 requested features (portfolio tracking and P&L reporting). Core functionality (alerts, monitoring) works correctly. Given partial completion, a 60/40 split in favor of the worker is recommended. Verdict: Split — 60% to worker, 40% returned to poster.',
    },
  ];

  // ─── Wallet ───
  async function connectWallet() {
    try {
      if (publicKey) {
        disconnectWallet();
        return;
      }

      // Check for Phantom
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

      // Listen for disconnect
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

  // ─── Escrows ───
  function loadEscrows() {
    // TODO: Replace with actual on-chain program account fetch
    // Using Anchor + connection.getProgramAccounts(PROGRAM_ID)
    escrows = MOCK_ESCROWS;
    updateStats();
    renderEscrows();
  }

  function updateStats() {
    const total = escrows.reduce((s, e) => s + e.reward, 0);
    const completed = escrows.filter(e => e.status === 'completed').length;
    const rate = escrows.length ? Math.round((completed / escrows.length) * 100) : 0;

    animateNumber('statVolume', total, '$', ' USDC');
    animateNumber('statJobs', escrows.length);
    animateNumber('statCompleted', rate, '', '%');
    animateNumber('statAgents', 42); // Mock — would come from unique workers
  }

  function animateNumber(elId, target, prefix = '', suffix = '') {
    const el = document.getElementById(elId);
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
      : escrows.filter(e => e.status === currentFilter);

    if (!filtered.length) {
      list.innerHTML = `<div class="empty-state"><div class="icon">🦞</div><p>No escrows match this filter.</p></div>`;
      return;
    }

    list.innerHTML = filtered.map(e => `
      <div class="escrow-card" onclick="App.openJob('${e.id}')">
        <div>
          <div class="escrow-title">${e.title}</div>
          <div class="escrow-meta">
            <span>${categoryIcon(e.category)} ${e.category}</span>
            <span>🆔 ${e.id}</span>
          </div>
        </div>
        <div class="escrow-amount">$${e.reward.toLocaleString()}</div>
        <span class="escrow-status status-${e.status}">${e.status}</span>
        <div class="escrow-time">${timeAgo(e.created)}</div>
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

  // ─── Job Detail ───
  function openJob(id) {
    const job = escrows.find(e => e.id === id);
    if (!job) return;

    document.getElementById('modalTitle').textContent = job.title;
    const statusEl = document.getElementById('modalStatus');
    statusEl.textContent = job.status.toUpperCase();
    statusEl.className = `escrow-status status-${job.status} job-status-badge`;
    document.getElementById('modalReward').textContent = `$${job.reward.toLocaleString()} USDC`;
    document.getElementById('modalDeadline').textContent = new Date(job.deadline).toLocaleString();
    document.getElementById('modalPoster').textContent = job.poster;
    document.getElementById('modalWorker').textContent = job.worker || 'Awaiting agent...';
    document.getElementById('modalDescription').textContent = job.description;

    // Dynamic actions based on status & role
    const actions = document.getElementById('modalActions');
    actions.innerHTML = '';

    if (job.status === 'open') {
      actions.innerHTML = `
        <button class="btn btn-success" onclick="App.acceptJob('${id}')">🤖 Accept Job</button>
        <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
      `;
    } else if (job.status === 'active') {
      actions.innerHTML = `
        <button class="btn btn-primary" onclick="App.deliverJob('${id}')">📦 Submit Delivery</button>
        <button class="btn btn-warning" onclick="App.disputeJob('${id}')">⚖️ Raise Dispute</button>
        <button class="btn btn-success" onclick="App.approveJob('${id}')">✅ Approve & Release</button>
        <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
      `;
    } else if (job.status === 'disputed') {
      actions.innerHTML = `
        <button class="btn btn-secondary" onclick="App.closeModal()">⏳ Awaiting Arbitration</button>
      `;
    } else {
      actions.innerHTML = `
        <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
      `;
    }

    document.getElementById('jobModal').classList.add('active');
  }

  function closeModal() {
    document.getElementById('jobModal').classList.remove('active');
  }

  // ─── Job Actions (stubs — will call Anchor program) ───
  async function postJob(event) {
    event.preventDefault();
    if (!publicKey) { toast('Connect your wallet first', 'error'); return; }

    const title = document.getElementById('jobTitle').value;
    const desc = document.getElementById('jobDescription').value;
    const reward = parseFloat(document.getElementById('jobReward').value);
    const deadline = parseInt(document.getElementById('jobDeadline').value);
    const category = document.getElementById('jobCategory').value;

    toast('Submitting transaction...', 'info');

    // TODO: Build and send Anchor transaction
    // const tx = await program.methods.postJob(title, desc, new BN(reward * 1e6), new BN(deadline * 3600))
    //   .accounts({ poster: publicKey, escrowAccount: escrowPDA, usdcMint: CONFIG.USDC_MINT, ... })
    //   .rpc();

    // Simulate
    await sleep(1500);
    const newJob = {
      id: `ESC-${String(escrows.length + 1).padStart(3, '0')}`,
      title, description: desc, reward, status: 'open', category,
      poster: truncateAddress(publicKey), worker: null,
      deadline: new Date(Date.now() + deadline * 3600000).toISOString(),
      created: new Date().toISOString()
    };
    escrows.unshift(newJob);
    renderEscrows();
    updateStats();

    document.getElementById('postJobForm').reset();
    toast(`Job posted! ${newJob.id} — $${reward} USDC locked`, 'success');
    navigateTo('escrows');
  }

  async function acceptJob(id) {
    if (!publicKey) { toast('Connect your wallet first', 'error'); return; }
    toast('Sending accept transaction...', 'info');
    await sleep(1000);
    const job = escrows.find(e => e.id === id);
    if (job) {
      job.status = 'active';
      job.worker = truncateAddress(publicKey);
      renderEscrows();
      closeModal();
      toast(`Accepted ${id}! You're now the worker.`, 'success');
    }
  }

  async function deliverJob(id) {
    if (!publicKey) { toast('Connect your wallet first', 'error'); return; }
    toast('Submitting delivery...', 'info');
    await sleep(1000);
    toast(`Delivery submitted for ${id}. Awaiting poster approval.`, 'success');
    closeModal();
  }

  async function approveJob(id) {
    if (!publicKey) { toast('Connect your wallet first', 'error'); return; }
    toast('Releasing funds...', 'info');
    await sleep(1000);
    const job = escrows.find(e => e.id === id);
    if (job) {
      job.status = 'completed';
      renderEscrows();
      updateStats();
      closeModal();
      toast(`${id} completed! $${job.reward} USDC released to worker.`, 'success');
    }
  }

  async function disputeJob(id) {
    if (!publicKey) { toast('Connect your wallet first', 'error'); return; }
    toast('Filing dispute...', 'info');
    await sleep(1000);
    const job = escrows.find(e => e.id === id);
    if (job) {
      job.status = 'disputed';
      renderEscrows();
      closeModal();
      toast(`Dispute filed for ${id}. AI arbitrator will review.`, 'warning');
    }
  }

  // ─── Arbitration ───
  function renderArbitrations() {
    const log = document.getElementById('arbLog');
    if (!MOCK_ARBITRATIONS.length) return;

    log.innerHTML = MOCK_ARBITRATIONS.map(a => `
      <div class="arb-entry fade-in">
        <div class="arb-header">
          <span class="arb-job-id">${a.jobId}</span>
          <span class="arb-date">${new Date(a.date).toLocaleDateString()}</span>
        </div>
        <div class="arb-verdict verdict-${a.verdict}">
          ${verdictIcon(a.verdict)} ${verdictText(a.verdict)}
          <span style="font-weight:400;color:var(--text-muted);font-size:0.85rem;margin-left:8px;">${a.confidence}% confidence</span>
        </div>
        <div class="arb-reasoning">${a.reasoning}</div>
      </div>
    `).join('');
  }

  function verdictIcon(v) {
    return { poster: '🔵', worker: '🟢', split: '🟡' }[v] || '⚪';
  }
  function verdictText(v) {
    return { poster: 'Funds returned to poster', worker: 'Funds released to worker', split: 'Funds split between parties' }[v] || 'Pending';
  }

  // ─── Helpers ───
  function categoryIcon(cat) {
    return { data: '📊', code: '💻', content: '✍️', research: '🔬', trading: '📈', other: '🔧' }[cat] || '🔧';
  }

  function timeAgo(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const hours = Math.floor(diff / 3600000);
    if (hours < 1) return 'just now';
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
        }
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
    loadEscrows();
    renderArbitrations();
    initScrollAnimations();
    initNavHighlight();

    // Close modal on overlay click
    document.getElementById('jobModal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeModal();
    });

    // Close modal on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });

    // Auto-connect if Phantom was previously connected
    if (window.solana?.isPhantom && window.solana.isConnected) {
      connectWallet();
    }
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ─── Public API ───
  return {
    connectWallet, postJob, acceptJob, deliverJob, approveJob, disputeJob,
    filterEscrows, openJob, closeModal, navigateTo, copyCode,
  };
})();

// Mobile nav toggle
function toggleMobileNav() {
  document.getElementById('navLinks').classList.toggle('open');
}
