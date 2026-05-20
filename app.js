const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());

// =============================================
// CONFIG - SỬA CÁC GIÁ TRỊ NÀY TRƯỚC KHI DÙNG
// =============================================
const CONFIG = {
  SEPAY_API_KEY: 'YOUR_SEPAY_API_KEY',        // Lấy từ SePay dashboard
  PORT: 3000,
  TRANSFER_PREFIX: 'NAP',
};

// =============================================
// DATABASE (RAM - restart sẽ mất dữ liệu)
// =============================================
const db = {
  users: {
    'LT001': {
      name: 'Lê Thanh Tùng', phone: '0971918513',
      balance: 0, totalDeposit: 0, totalWithdraw: 0,
      wins: 0, losses: 0, history: [],
    }
  },
  processedTransactions: new Set(),
  pendingNotifications: {},
};

function getUser(id) {
  if (!db.users[id]) db.users[id] = { name: 'User '+id, phone: '', balance: 0, totalDeposit: 0, totalWithdraw: 0, wins: 0, losses: 0, history: [] };
  return db.users[id];
}

// =============================================
// WEBHOOK SEPAY → nhận tiền thật → cộng số dư
// Cấu hình trong SePay dashboard:
//   URL: https://yourdomain.com/webhook/sepay
//   Method: POST
// =============================================
app.post('/webhook/sepay', (req, res) => {
  try {
    const key = req.headers['x-api-key'] || req.headers['authorization'] || '';
    if (key !== CONFIG.SEPAY_API_KEY) return res.status(401).json({ success: false });

    const { id, transferType, transferAmount, content, referenceCode, transactionDate } = req.body;
    console.log('[Webhook]', JSON.stringify(req.body));

    if (transferType !== 'in') return res.json({ success: true, message: 'ignored' });

    const txKey = id || referenceCode || Date.now().toString();
    if (db.processedTransactions.has(txKey)) return res.json({ success: true, message: 'duplicate' });

    const parts = (content || '').toUpperCase().trim().split(/\s+/);
    if (parts[0] !== CONFIG.TRANSFER_PREFIX || !parts[1]) {
      console.log('[Webhook] Không nhận dạng user từ nội dung:', content);
      return res.json({ success: true, message: 'unrecognized' });
    }

    const userID = parts[1];
    const amount = parseInt(transferAmount) || 0;
    if (amount <= 0) return res.json({ success: true, message: 'invalid amount' });

    const user = getUser(userID);
    user.balance += amount;
    user.totalDeposit += amount;
    user.history.unshift({ type: 'deposit', amount, time: transactionDate || new Date().toISOString(), ref: referenceCode });
    db.processedTransactions.add(txKey);

    if (!db.pendingNotifications[userID]) db.pendingNotifications[userID] = [];
    db.pendingNotifications[userID].push({ type: 'deposit_success', amount, ref: referenceCode, time: new Date().toISOString() });

    console.log('[Webhook] ✅ Nạp', amount.toLocaleString() + 'đ cho user', userID, '| Số dư:', user.balance.toLocaleString() + 'đ');
    return res.json({ success: true });
  } catch (e) {
    console.error('[Webhook] Lỗi:', e);
    return res.status(500).json({ success: false });
  }
});

// =============================================
// API
// =============================================
app.get('/api/user/:id', (req, res) => {
  const u = getUser(req.params.id);
  res.json({ success: true, user: { name: u.name, phone: u.phone, balance: u.balance, totalDeposit: u.totalDeposit, totalWithdraw: u.totalWithdraw, wins: u.wins, losses: u.losses } });
});

app.get('/api/notifications/:id', (req, res) => {
  const n = db.pendingNotifications[req.params.id] || [];
  db.pendingNotifications[req.params.id] = [];
  res.json({ success: true, notifications: n });
});

app.post('/api/withdraw', (req, res) => {
  const { userID, amount } = req.body;
  const amt = parseInt(amount) || 0;
  const user = getUser(userID);
  if (amt < 10000) return res.json({ success: false, message: 'Tối thiểu 10,000đ' });
  if (amt > user.balance) return res.json({ success: false, message: 'Số dư không đủ' });
  user.balance -= amt;
  user.totalWithdraw += amt;
  user.history.unshift({ type: 'withdraw', amount: amt, time: new Date().toISOString() });
  console.log('[Withdraw] User', userID, 'rút', amt.toLocaleString() + 'đ | Còn:', user.balance.toLocaleString() + 'đ');
  res.json({ success: true, balance: user.balance });
});

// =============================================
// ADMIN API (mật khẩu: admin123 - đổi lại!)
// =============================================
const ADMIN_PASS = 'tungdeptraivip';

function checkAdmin(req, res) {
  const pass = req.headers['x-admin-pass'] || req.query.pass;
  if (pass !== ADMIN_PASS) { res.status(401).json({ success: false, message: 'Sai mật khẩu admin' }); return false; }
  return true;
}

// Danh sách tất cả user
app.get('/admin/users', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const users = Object.entries(db.users).map(([id, u]) => ({
    id, name: u.name, phone: u.phone,
    balance: u.balance, totalDeposit: u.totalDeposit, totalWithdraw: u.totalWithdraw,
    wins: u.wins, losses: u.losses, historyCount: u.history.length,
  }));
  res.json({ success: true, users });
});

// Lịch sử giao dịch của user
app.get('/admin/history/:id', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const user = db.users[req.params.id];
  if (!user) return res.json({ success: false, message: 'Không tìm thấy user' });
  res.json({ success: true, history: user.history });
});

// Chỉnh số dư user
app.post('/admin/setbalance', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { userID, amount, note } = req.body;
  const user = getUser(userID);
  const old = user.balance;
  user.balance = parseInt(amount) || 0;
  user.history.unshift({ type: 'admin_adjust', oldBalance: old, newBalance: user.balance, note: note || 'Admin chỉnh', time: new Date().toISOString() });
  console.log('[Admin] Chỉnh số dư user', userID, old, '→', user.balance);
  res.json({ success: true, balance: user.balance });
});

// Cộng/trừ tiền user
app.post('/admin/adjustbalance', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { userID, amount, type, note } = req.body; // type: 'add' | 'subtract'
  const user = getUser(userID);
  const amt = parseInt(amount) || 0;
  const old = user.balance;
  if (type === 'add') {
    user.balance += amt;
    user.totalDeposit += amt;
    user.history.unshift({ type: 'admin_add', amount: amt, note: note || 'Admin nạp thủ công', time: new Date().toISOString() });
    // Thông báo cho frontend user
    if (!db.pendingNotifications[userID]) db.pendingNotifications[userID] = [];
    db.pendingNotifications[userID].push({ type: 'deposit_success', amount: amt, ref: 'ADMIN', time: new Date().toISOString() });
  } else {
    if (amt > user.balance) return res.json({ success: false, message: 'Số dư không đủ để trừ' });
    user.balance -= amt;
    user.totalWithdraw += amt;
    user.history.unshift({ type: 'admin_subtract', amount: amt, note: note || 'Admin trừ', time: new Date().toISOString() });
  }
  console.log('[Admin]', type === 'add' ? 'Cộng' : 'Trừ', amt.toLocaleString() + 'đ user', userID, '|', old, '→', user.balance);
  res.json({ success: true, balance: user.balance });
});

// Xóa user
app.delete('/admin/user/:id', (req, res) => {
  if (!checkAdmin(req, res)) return;
  delete db.users[req.params.id];
  res.json({ success: true });
});

// Trang admin HTML
app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MB Game Admin</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: sans-serif; background: #0a0a0f; color: #f0f0f0; min-height: 100vh; }
  .topbar { background: linear-gradient(135deg,#d0021b,#7b0010); padding: 14px 20px; display:flex; align-items:center; justify-content:space-between; }
  .topbar h1 { font-size:18px; font-weight:900; }
  .topbar span { font-size:13px; opacity:0.8; }
  .login-box { max-width:360px; margin:80px auto; background:#16161e; border-radius:16px; padding:32px; }
  .login-box h2 { margin-bottom:20px; font-size:18px; }
  input { width:100%; background:#1e1e2a; border:1px solid rgba(255,255,255,0.1); border-radius:10px; color:white; padding:12px 14px; font-size:15px; margin-bottom:12px; outline:none; }
  .btn { width:100%; background:linear-gradient(135deg,#d0021b,#7b0010); border:none; border-radius:10px; color:white; padding:14px; font-size:15px; font-weight:800; cursor:pointer; }
  .btn:hover { opacity:0.9; }
  .btn-sm { padding:6px 14px; border-radius:8px; border:none; color:white; font-size:12px; font-weight:700; cursor:pointer; }
  .btn-green { background:#00c851; }
  .btn-red { background:#d0021b; }
  .btn-blue { background:#2196f3; }
  .btn-gold { background:#f5a623; color:#000; }
  .container { max-width:960px; margin:0 auto; padding:20px; }
  .card { background:#16161e; border-radius:14px; padding:20px; margin-bottom:16px; border:1px solid rgba(255,255,255,0.06); }
  .card h3 { font-size:15px; margin-bottom:14px; color:#ffd700; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; padding:8px 10px; color:#888; border-bottom:1px solid rgba(255,255,255,0.08); font-weight:700; }
  td { padding:10px 10px; border-bottom:1px solid rgba(255,255,255,0.05); vertical-align:middle; }
  tr:hover td { background:rgba(255,255,255,0.03); }
  .badge { display:inline-block; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:800; }
  .badge-green { background:rgba(0,200,81,0.2); color:#00c851; }
  .badge-red { background:rgba(208,2,27,0.2); color:#ff6666; }
  .badge-blue { background:rgba(33,150,243,0.2); color:#2196f3; }
  .badge-gold { background:rgba(245,166,35,0.2); color:#ffd700; }
  .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:16px; }
  .stat-box { background:#16161e; border-radius:12px; padding:16px; text-align:center; border:1px solid rgba(255,255,255,0.06); }
  .stat-box .val { font-size:22px; font-weight:900; color:#ffd700; }
  .stat-box .lbl { font-size:11px; color:#888; margin-top:4px; }
  .modal-bg { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.8); z-index:100; align-items:center; justify-content:center; }
  .modal-bg.open { display:flex; }
  .modal { background:#16161e; border-radius:16px; padding:24px; width:360px; }
  .modal h3 { margin-bottom:16px; font-size:16px; }
  select { width:100%; background:#1e1e2a; border:1px solid rgba(255,255,255,0.1); border-radius:10px; color:white; padding:12px 14px; font-size:14px; margin-bottom:12px; outline:none; }
  .flex { display:flex; gap:8px; }
  .alert { padding:10px 14px; border-radius:10px; margin-bottom:12px; font-size:13px; font-weight:700; }
  .alert-green { background:rgba(0,200,81,0.15); color:#00c851; border:1px solid rgba(0,200,81,0.3); }
  .alert-red { background:rgba(208,2,27,0.15); color:#ff6666; border:1px solid rgba(208,2,27,0.3); }
</style>
</head>
<body>
<div class="topbar">
  <h1>⭐ MB Game Admin</h1>
  <span id="admin-info">Chưa đăng nhập</span>
</div>

<div id="login-screen">
  <div class="login-box">
    <h2>🔐 Đăng nhập Admin</h2>
    <input type="password" id="pass-input" placeholder="Mật khẩu admin" onkeydown="if(event.key==='Enter')doLogin()">
    <div id="login-err" style="color:#ff6666;font-size:13px;margin-bottom:10px;display:none">Sai mật khẩu!</div>
    <button class="btn" onclick="doLogin()">Đăng nhập</button>
  </div>
</div>

<div id="admin-screen" style="display:none">
  <div class="container">
    <!-- STATS -->
    <div class="stats" id="stats-row"></div>

    <!-- USER TABLE -->
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <h3>👥 Danh Sách User</h3>
        <button class="btn-sm btn-blue" onclick="loadUsers()">🔄 Làm mới</button>
      </div>
      <div id="alert-box" style="display:none"></div>
      <div style="overflow-x:auto">
        <table id="user-table">
          <thead><tr>
            <th>ID</th><th>Tên</th><th>Số dư</th><th>Tổng nạp</th><th>Tổng rút</th><th>Thắng</th><th>Thua</th><th>Thao tác</th>
          </tr></thead>
          <tbody id="user-tbody"></tbody>
        </table>
      </div>
    </div>

    <!-- HISTORY -->
    <div class="card" id="history-card" style="display:none">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <h3 id="history-title">📋 Lịch Sử</h3>
        <button class="btn-sm" style="background:#555" onclick="document.getElementById('history-card').style.display='none'">✕ Đóng</button>
      </div>
      <div style="overflow-x:auto">
        <table>
          <thead><tr><th>Loại</th><th>Số tiền</th><th>Ghi chú</th><th>Thời gian</th></tr></thead>
          <tbody id="history-tbody"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- MODAL CHỈNH SỐ DƯ -->
<div class="modal-bg" id="modal-adjust">
  <div class="modal">
    <h3>💰 Chỉnh Số Dư - <span id="modal-username"></span></h3>
    <div style="font-size:13px;color:#888;margin-bottom:12px">Số dư hiện tại: <strong id="modal-curbal" style="color:#ffd700"></strong></div>
    <select id="adjust-type">
      <option value="add">➕ Cộng tiền (nạp thủ công)</option>
      <option value="subtract">➖ Trừ tiền</option>
      <option value="set">✏️ Đặt số dư cụ thể</option>
    </select>
    <input type="number" id="adjust-amount" placeholder="Số tiền (VD: 100000)" min="0">
    <input type="text" id="adjust-note" placeholder="Ghi chú (VD: nạp thủ công)">
    <div id="adjust-alert" style="display:none;margin-bottom:10px"></div>
    <div class="flex">
      <button class="btn" onclick="doAdjust()">✅ Xác nhận</button>
      <button class="btn" style="background:#333" onclick="closeModal()">Huỷ</button>
    </div>
  </div>
</div>

<script>
let adminPass = '';
let currentAdjustUser = null;

function fmt(n) { return '₫' + Math.abs(parseInt(n)||0).toLocaleString('vi-VN'); }

function showAlert(msg, type='green') {
  const el = document.getElementById('alert-box');
  el.className = 'alert alert-' + type;
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 3000);
}

async function api(url, opts={}) {
  opts.headers = { ...(opts.headers||{}), 'x-admin-pass': adminPass, 'Content-Type': 'application/json' };
  const r = await fetch(url, opts);
  return r.json();
}

async function doLogin() {
  const pass = document.getElementById('pass-input').value;
  adminPass = pass;
  const data = await api('/admin/users').catch(() => null);
  if (!data || !data.success) {
    document.getElementById('login-err').style.display = 'block';
    return;
  }
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('admin-screen').style.display = 'block';
  document.getElementById('admin-info').textContent = '✅ Đã đăng nhập';
  renderUsers(data.users);
  renderStats(data.users);
  setInterval(loadUsers, 10000); // auto refresh 10s
}

async function loadUsers() {
  const data = await api('/admin/users');
  if (data.success) { renderUsers(data.users); renderStats(data.users); }
}

function renderStats(users) {
  const totalBal = users.reduce((s,u) => s + u.balance, 0);
  const totalDep = users.reduce((s,u) => s + u.totalDeposit, 0);
  const totalWd = users.reduce((s,u) => s + u.totalWithdraw, 0);
  document.getElementById('stats-row').innerHTML = \`
    <div class="stat-box"><div class="val">\${users.length}</div><div class="lbl">Tổng user</div></div>
    <div class="stat-box"><div class="val" style="color:#00c851">\${fmt(totalDep)}</div><div class="lbl">Tổng nạp</div></div>
    <div class="stat-box"><div class="val" style="color:#f5a623">\${fmt(totalWd)}</div><div class="lbl">Tổng rút</div></div>
    <div class="stat-box"><div class="val">\${fmt(totalBal)}</div><div class="lbl">Tổng số dư</div></div>
  \`;
}

function renderUsers(users) {
  const tbody = document.getElementById('user-tbody');
  if (!users.length) { tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#888;padding:20px">Chưa có user</td></tr>'; return; }
  tbody.innerHTML = users.map(u => \`
    <tr>
      <td><span class="badge badge-blue">\${u.id}</span></td>
      <td><strong>\${u.name}</strong><br><span style="color:#888;font-size:11px">\${u.phone}</span></td>
      <td><strong style="color:#ffd700">\${fmt(u.balance)}</strong></td>
      <td style="color:#00c851">\${fmt(u.totalDeposit)}</td>
      <td style="color:#f5a623">\${fmt(u.totalWithdraw)}</td>
      <td><span class="badge badge-green">\${u.wins}</span></td>
      <td><span class="badge badge-red">\${u.losses}</span></td>
      <td>
        <div class="flex">
          <button class="btn-sm btn-gold" onclick="openAdjust('\${u.id}','\${u.name}',\${u.balance})">💰 Sửa</button>
          <button class="btn-sm btn-blue" onclick="viewHistory('\${u.id}','\${u.name}')">📋</button>
        </div>
      </td>
    </tr>
  \`).join('');
}

function openAdjust(id, name, bal) {
  currentAdjustUser = id;
  document.getElementById('modal-username').textContent = name;
  document.getElementById('modal-curbal').textContent = fmt(bal);
  document.getElementById('adjust-amount').value = '';
  document.getElementById('adjust-note').value = '';
  document.getElementById('adjust-alert').style.display = 'none';
  document.getElementById('modal-adjust').classList.add('open');
}

function closeModal() { document.getElementById('modal-adjust').classList.remove('open'); }

async function doAdjust() {
  const type = document.getElementById('adjust-type').value;
  const amount = parseInt(document.getElementById('adjust-amount').value) || 0;
  const note = document.getElementById('adjust-note').value || '';
  if (amount <= 0) { showAdjustAlert('Nhập số tiền hợp lệ!', 'red'); return; }

  let data;
  if (type === 'set') {
    data = await api('/admin/setbalance', { method:'POST', body: JSON.stringify({ userID: currentAdjustUser, amount, note }) });
  } else {
    data = await api('/admin/adjustbalance', { method:'POST', body: JSON.stringify({ userID: currentAdjustUser, amount, type, note }) });
  }

  if (data.success) {
    closeModal();
    showAlert('✅ Đã cập nhật số dư: ' + fmt(data.balance));
    loadUsers();
  } else {
    showAdjustAlert(data.message || 'Lỗi!', 'red');
  }
}

function showAdjustAlert(msg, type) {
  const el = document.getElementById('adjust-alert');
  el.className = 'alert alert-' + type;
  el.textContent = msg;
  el.style.display = 'block';
}

async function viewHistory(id, name) {
  const data = await api('/admin/history/' + id);
  if (!data.success) return;
  document.getElementById('history-title').textContent = '📋 Lịch Sử - ' + name;
  const typeMap = { deposit:'🏦 Nạp CK', withdraw:'🏧 Rút', admin_add:'➕ Admin nạp', admin_subtract:'➖ Admin trừ', admin_adjust:'✏️ Admin chỉnh', win:'🎮 Thắng', loss:'🎮 Thua' };
  const colorMap = { deposit:'badge-green', withdraw:'badge-gold', admin_add:'badge-green', admin_subtract:'badge-red', admin_adjust:'badge-blue', win:'badge-green', loss:'badge-red' };
  document.getElementById('history-tbody').innerHTML = data.history.length ? data.history.map(h => \`
    <tr>
      <td><span class="badge \${colorMap[h.type]||'badge-blue'}">\${typeMap[h.type]||h.type}</span></td>
      <td style="color:#ffd700;font-weight:800">\${fmt(h.amount||0)}</td>
      <td style="color:#888;font-size:12px">\${h.note||h.ref||h.content||'-'}</td>
      <td style="color:#888;font-size:12px">\${new Date(h.time).toLocaleString('vi-VN')}</td>
    </tr>
  \`).join('') : '<tr><td colspan="4" style="text-align:center;color:#888;padding:20px">Chưa có lịch sử</td></tr>';
  document.getElementById('history-card').style.display = 'block';
  document.getElementById('history-card').scrollIntoView({ behavior:'smooth' });
}

document.getElementById('pass-input').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });
</script>
</body>
</html>`);
});

// =============================================
// SERVE FRONTEND (HTML nhúng thẳng vào đây)
// =============================================
const HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>MB Game - Le Thanh Tung</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');

  :root {
    --red: #d0021b;
    --dark-red: #9b0014;
    --gold: #f5a623;
    --gold2: #ffd700;
    --dark: #0a0a0f;
    --card: #16161e;
    --card2: #1e1e2a;
    --text: #f0f0f0;
    --muted: #888;
    --green: #00c851;
    --blue: #2196f3;
  }

  * { margin:0; padding:0; box-sizing:border-box; }

  body {
    font-family: 'Nunito', sans-serif;
    background: var(--dark);
    color: var(--text);
    min-height: 100vh;
    overflow-x: hidden;
    max-width: 480px;
    margin: 0 auto;
    position: relative;
  }

  /* ===== TOP BAR ===== */
  .topbar {
    background: linear-gradient(135deg, var(--red), var(--dark-red));
    padding: 12px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
    box-shadow: 0 2px 20px rgba(208,2,27,0.5);
  }
  .topbar-logo {
    display: flex; align-items: center; gap: 8px;
    font-size: 20px; font-weight: 900; color: white;
  }
  .topbar-logo span { color: var(--gold2); }
  .balance-display {
    background: rgba(0,0,0,0.3);
    border-radius: 20px;
    padding: 6px 14px;
    font-size: 14px;
    font-weight: 800;
    color: var(--gold2);
    border: 1px solid rgba(255,215,0,0.3);
  }
  .user-avatar {
    width: 36px; height: 36px;
    background: var(--gold);
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-weight: 900; font-size: 14px; color: white;
  }

  /* ===== NAV ===== */
  .bottom-nav {
    position: fixed; bottom: 0; left: 50%; transform: translateX(-50%);
    width: 100%; max-width: 480px;
    background: var(--card);
    border-top: 1px solid rgba(255,255,255,0.08);
    display: flex;
    padding: 8px 0 12px;
    z-index: 100;
  }
  .nav-item {
    flex: 1; display: flex; flex-direction: column; align-items: center;
    gap: 3px; cursor: pointer; padding: 4px;
    transition: all 0.2s;
  }
  .nav-item .nav-icon { font-size: 22px; }
  .nav-item .nav-label { font-size: 10px; color: var(--muted); font-weight: 700; }
  .nav-item.active .nav-label { color: var(--red); }
  .nav-item.active .nav-icon { filter: drop-shadow(0 0 6px var(--red)); }

  /* ===== PAGES ===== */
  .page { display: none; padding: 16px 16px 90px; }
  .page.active { display: block; }

  /* ===== HOME ===== */
  .banner {
    background: linear-gradient(135deg, #d0021b 0%, #7b0010 100%);
    border-radius: 16px;
    padding: 20px;
    margin-bottom: 20px;
    position: relative;
    overflow: hidden;
  }
  .banner::after {
    content: '🌟';
    position: absolute; right: 20px; top: 50%; transform: translateY(-50%);
    font-size: 60px; opacity: 0.2;
  }
  .banner h2 { font-size: 22px; font-weight: 900; }
  .banner p { font-size: 13px; color: rgba(255,255,255,0.8); margin-top: 4px; }
  .banner .balance-big {
    font-size: 32px; font-weight: 900; color: var(--gold2);
    margin: 8px 0;
  }

  .wallet-actions {
    display: grid; grid-template-columns: 1fr 1fr;
    gap: 10px; margin-bottom: 20px;
  }
  .wallet-btn {
    background: var(--card2);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 14px;
    padding: 16px;
    cursor: pointer;
    transition: all 0.2s;
    text-align: center;
  }
  .wallet-btn:hover { transform: scale(1.02); border-color: var(--gold); }
  .wallet-btn .wb-icon { font-size: 28px; margin-bottom: 6px; }
  .wallet-btn .wb-label { font-size: 14px; font-weight: 800; }
  .wallet-btn.deposit .wb-icon { color: var(--green); }
  .wallet-btn.withdraw .wb-icon { color: var(--gold); }

  .section-title {
    font-size: 16px; font-weight: 900;
    margin-bottom: 12px;
    display: flex; align-items: center; gap: 8px;
  }
  .section-title::before { content: ''; width: 4px; height: 18px; background: var(--red); border-radius: 2px; }

  .games-grid {
    display: grid; grid-template-columns: 1fr 1fr;
    gap: 12px; margin-bottom: 20px;
  }
  .game-card {
    background: var(--card2);
    border-radius: 16px;
    padding: 16px;
    cursor: pointer;
    border: 1px solid rgba(255,255,255,0.06);
    transition: all 0.25s;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .game-card:hover { transform: translateY(-3px); box-shadow: 0 8px 25px rgba(0,0,0,0.4); }
  .game-card .gc-icon { font-size: 40px; margin-bottom: 8px; display: block; }
  .game-card .gc-name { font-size: 14px; font-weight: 800; }
  .game-card .gc-desc { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .game-card.hot::after {
    content: 'HOT 🔥';
    position: absolute; top: 8px; right: -2px;
    background: var(--red);
    font-size: 9px; font-weight: 900;
    padding: 2px 8px; border-radius: 4px 0 0 4px;
  }
  .game-card.new::after {
    content: 'MỚI ✨';
    position: absolute; top: 8px; right: -2px;
    background: var(--blue);
    font-size: 9px; font-weight: 900;
    padding: 2px 8px; border-radius: 4px 0 0 4px;
  }

  /* ===== MODAL ===== */
  .modal-overlay {
    display: none;
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0.85);
    align-items: flex-end; justify-content: center;
  }
  .modal-overlay.open { display: flex; }
  .modal {
    background: var(--card);
    border-radius: 24px 24px 0 0;
    padding: 24px;
    width: 100%; max-width: 480px;
    max-height: 85vh;
    overflow-y: auto;
    animation: slideUp 0.3s ease;
  }
  @keyframes slideUp {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }
  .modal-title {
    font-size: 20px; font-weight: 900;
    margin-bottom: 20px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .modal-close {
    background: rgba(255,255,255,0.1);
    border: none; color: white;
    width: 32px; height: 32px; border-radius: 50%;
    cursor: pointer; font-size: 16px;
  }

  /* ===== AMOUNT INPUT ===== */
  .amount-input-group {
    background: var(--card2);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 14px;
    padding: 14px 16px;
    margin-bottom: 16px;
    display: flex; align-items: center; gap: 10px;
  }
  .amount-input-group span { color: var(--gold2); font-size: 18px; font-weight: 900; }
  .amount-input-group input {
    background: none; border: none; outline: none;
    color: white; font-size: 20px; font-weight: 800;
    width: 100%; font-family: inherit;
  }

  .quick-amounts {
    display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px;
  }
  .qa-btn {
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 8px; padding: 8px 14px;
    color: white; font-size: 13px; font-weight: 700;
    cursor: pointer; transition: all 0.2s;
  }
  .qa-btn:hover { background: var(--red); border-color: var(--red); }

  .btn-primary {
    width: 100%;
    background: linear-gradient(135deg, var(--red), var(--dark-red));
    border: none; border-radius: 14px;
    color: white; font-size: 16px; font-weight: 900;
    padding: 16px; cursor: pointer;
    transition: all 0.2s;
    font-family: inherit;
  }
  .btn-primary:hover { transform: scale(1.01); box-shadow: 0 4px 20px rgba(208,2,27,0.5); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

  /* ===== TAI XIU GAME ===== */
  .game-area {
    background: var(--card2);
    border-radius: 20px;
    padding: 20px;
    margin-bottom: 16px;
  }

  .dice-container {
    display: flex; justify-content: center; gap: 16px;
    margin: 20px 0;
    min-height: 80px;
    align-items: center;
  }
  .die {
    width: 72px; height: 72px;
    background: white;
    border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    font-size: 44px;
    box-shadow: 0 4px 15px rgba(0,0,0,0.5);
    transition: all 0.3s;
    user-select: none;
  }
  .die.rolling {
    animation: rollDie 0.1s infinite alternate;
  }
  @keyframes rollDie {
    from { transform: rotate(-8deg) scale(0.95); }
    to { transform: rotate(8deg) scale(1.05); }
  }

  .dice-total {
    text-align: center;
    font-size: 36px; font-weight: 900;
    color: var(--gold2);
    margin-bottom: 8px;
  }
  .dice-result-label {
    text-align: center;
    font-size: 20px; font-weight: 800;
    padding: 8px 24px;
    border-radius: 10px;
    display: inline-block;
    margin: 0 auto;
  }
  .dice-result-label.tai { background: rgba(255,100,0,0.2); color: #ff6400; border: 2px solid #ff6400; }
  .dice-result-label.xiu { background: rgba(33,150,243,0.2); color: #2196f3; border: 2px solid #2196f3; }

  .bet-choices {
    display: grid; grid-template-columns: 1fr 1fr;
    gap: 12px; margin-bottom: 16px;
  }
  .bet-choice {
    padding: 18px;
    border-radius: 16px;
    border: 2px solid rgba(255,255,255,0.1);
    cursor: pointer;
    text-align: center;
    transition: all 0.2s;
    font-size: 20px; font-weight: 900;
  }
  .bet-choice.tai-btn { color: #ff6400; }
  .bet-choice.xiu-btn { color: #2196f3; }
  .bet-choice.selected.tai-btn { background: rgba(255,100,0,0.2); border-color: #ff6400; }
  .bet-choice.selected.xiu-btn { background: rgba(33,150,243,0.2); border-color: #2196f3; }
  .bet-choice:hover { transform: scale(1.02); }

  /* ===== TOAST ===== */
  .toast {
    position: fixed; top: 70px; left: 50%; transform: translateX(-50%);
    background: var(--card);
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 12px;
    padding: 12px 24px;
    font-weight: 800;
    font-size: 15px;
    z-index: 999;
    animation: toastIn 0.3s ease, toastOut 0.3s ease 2.2s forwards;
    white-space: nowrap;
    box-shadow: 0 8px 30px rgba(0,0,0,0.5);
  }
  .toast.win { border-color: var(--green); color: var(--green); }
  .toast.lose { border-color: var(--red); color: #ff6666; }
  .toast.info { border-color: var(--gold); color: var(--gold2); }
  @keyframes toastIn { from { opacity: 0; top: 60px; } to { opacity: 1; top: 70px; } }
  @keyframes toastOut { from { opacity: 1; } to { opacity: 0; pointer-events: none; } }

  /* ===== HISTORY ===== */
  .history-item {
    background: var(--card2);
    border-radius: 12px;
    padding: 12px 16px;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-left: 4px solid transparent;
  }
  .history-item.win { border-left-color: var(--green); }
  .history-item.lose { border-left-color: var(--red); }
  .hi-left { font-size: 13px; }
  .hi-game { font-weight: 800; font-size: 14px; }
  .hi-detail { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .hi-amount { font-weight: 900; font-size: 15px; }
  .hi-amount.win { color: var(--green); }
  .hi-amount.lose { color: #ff6666; }

  /* ===== AIRPLANE GAME ===== */
  .plane-multiplier {
    text-align: center;
    font-size: 64px; font-weight: 900;
    color: var(--gold2);
    text-shadow: 0 0 30px rgba(255,215,0,0.6);
    margin: 16px 0;
    transition: color 0.3s;
  }
  .plane-multiplier.danger { color: #ff4444; text-shadow: 0 0 30px rgba(255,68,68,0.6); }

  .plane-graph {
    background: rgba(0,0,0,0.4);
    border-radius: 16px;
    height: 160px;
    margin-bottom: 16px;
    position: relative;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,0.05);
  }
  .plane-emoji {
    position: absolute;
    font-size: 32px;
    transition: all 0.5s ease;
    filter: drop-shadow(0 0 10px rgba(255,215,0,0.8));
  }
  .plane-trail {
    position: absolute;
    bottom: 0; left: 0;
    width: 0%; height: 2px;
    background: linear-gradient(90deg, transparent, var(--gold2));
    transition: width 0.5s;
  }
  .plane-crashed {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 48px;
    background: rgba(255,0,0,0.1);
    border-radius: 16px;
    animation: flashRed 0.5s;
  }
  @keyframes flashRed {
    0% { background: rgba(255,0,0,0.5); }
    100% { background: rgba(255,0,0,0.1); }
  }

  .plane-status {
    text-align: center; font-size: 14px;
    font-weight: 700; color: var(--muted);
    margin-bottom: 16px;
    min-height: 20px;
  }

  /* ===== PARACHUTE ===== */
  .parachute-area {
    position: relative;
    background: linear-gradient(180deg, #0a1628 0%, #1a3a6e 50%, #2d6a4f 100%);
    border-radius: 20px;
    height: 240px;
    overflow: hidden;
    margin-bottom: 16px;
  }
  .sky-stars {
    position: absolute; inset: 0;
    overflow: hidden;
  }
  .star { position: absolute; background: white; border-radius: 50%; animation: twinkle 2s infinite alternate; }
  @keyframes twinkle { from { opacity: 0.3; } to { opacity: 1; } }

  .parachute-jumper {
    position: absolute;
    left: 50%; transform: translateX(-50%);
    font-size: 36px;
    transition: top 0.8s ease-in;
    filter: drop-shadow(0 0 8px rgba(255,255,255,0.5));
  }
  .ground-line {
    position: absolute; bottom: 0; left: 0; right: 0;
    height: 40px;
    background: linear-gradient(180deg, #2d6a4f, #1b4332);
    display: flex; align-items: center; justify-content: center;
    font-size: 20px;
  }

  .parachute-multiplier {
    text-align: center;
    font-size: 48px; font-weight: 900;
    color: var(--gold2);
    margin: 12px 0;
    text-shadow: 0 0 20px rgba(255,215,0,0.5);
  }

  /* ===== WALLET MODAL ===== */
  .bank-info {
    background: linear-gradient(135deg, #1a1a2e, #16213e);
    border-radius: 16px;
    padding: 16px;
    margin-bottom: 16px;
    border: 1px solid rgba(255,255,255,0.1);
  }
  .bank-info .bank-name {
    font-size: 12px; color: var(--muted); margin-bottom: 6px;
  }
  .bank-info .bank-account {
    font-size: 22px; font-weight: 900; color: var(--gold2);
    letter-spacing: 2px;
  }
  .bank-info .bank-holder {
    font-size: 13px; color: rgba(255,255,255,0.7); margin-top: 4px;
  }
  .bank-info .bank-type {
    display: inline-block;
    background: var(--red);
    font-size: 11px; font-weight: 800;
    padding: 2px 10px; border-radius: 20px;
    margin-top: 8px;
  }

  .profile-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px;
    background: var(--card2);
    border-radius: 12px;
    margin-bottom: 8px;
    border: 1px solid rgba(255,255,255,0.06);
  }
  .profile-row .pr-label { font-size: 13px; color: var(--muted); }
  .profile-row .pr-value { font-size: 14px; font-weight: 800; }

  /* Bet amount row */
  .bet-row {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 16px;
  }
  .bet-row label { font-size: 13px; color: var(--muted); white-space: nowrap; }
  .bet-row input {
    background: var(--card2);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 10px;
    color: white;
    padding: 10px 14px;
    font-size: 16px; font-weight: 800;
    width: 100%; font-family: inherit;
    outline: none;
  }

  .result-box {
    text-align: center;
    padding: 16px;
    border-radius: 14px;
    margin-bottom: 16px;
    font-size: 22px; font-weight: 900;
    display: none;
  }
  .result-box.show { display: block; animation: popIn 0.4s ease; }
  .result-box.win-result { background: rgba(0,200,81,0.15); color: var(--green); border: 2px solid var(--green); }
  .result-box.lose-result { background: rgba(208,2,27,0.15); color: #ff6666; border: 2px solid #ff6666; }
  @keyframes popIn {
    0% { transform: scale(0.8); opacity: 0; }
    60% { transform: scale(1.1); }
    100% { transform: scale(1); opacity: 1; }
  }

  .tab-buttons {
    display: flex; gap: 8px; margin-bottom: 16px;
  }
  .tab-btn {
    flex: 1; padding: 10px;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 10px;
    color: var(--muted); font-size: 14px; font-weight: 700;
    cursor: pointer; transition: all 0.2s;
    font-family: inherit;
  }
  .tab-btn.active { background: var(--red); color: white; border-color: var(--red); }

  .empty-state {
    text-align: center; padding: 40px 20px;
    color: var(--muted); font-size: 14px;
  }
  .empty-state .es-icon { font-size: 48px; margin-bottom: 12px; }
</style>
</head>
<body>

<!-- TOP BAR -->
<div class="topbar">
  <div class="topbar-logo">⭐ <span>MB</span>Game</div>
  <div class="balance-display" id="top-balance">₫0</div>
  <div class="user-avatar">LT</div>
</div>

<!-- PAGES -->

<!-- HOME -->
<div class="page active" id="page-home">
  <div class="banner">
    <p style="font-size:12px;opacity:0.7">Số dư khả dụng</p>
    <div class="balance-big" id="home-balance">₫0</div>
    <h2>Chào Lê Thanh Tùng 👋</h2>
    <p>0971918513 · MB Bank</p>
  </div>

  <div class="wallet-actions">
    <div class="wallet-btn deposit" onclick="openDeposit()">
      <div class="wb-icon">💰</div>
      <div class="wb-label" style="color:var(--green)">Nạp Tiền</div>
    </div>
    <div class="wallet-btn withdraw" onclick="openWithdraw()">
      <div class="wb-icon">🏧</div>
      <div class="wb-label" style="color:var(--gold)">Rút Tiền</div>
    </div>
  </div>

  <div class="section-title">🎮 Chọn Trò Chơi</div>
  <div class="games-grid">
    <div class="game-card hot" onclick="navigate('txpage')">
      <span class="gc-icon">🎲</span>
      <div class="gc-name">Tài Xỉu</div>
      <div class="gc-desc">Đổ 3 xúc xắc</div>
    </div>
    <div class="game-card new" onclick="navigate('planepage')">
      <span class="gc-icon">✈️</span>
      <div class="gc-name">Máy Bay</div>
      <div class="gc-desc">Crash game x100</div>
    </div>
    <div class="game-card new" onclick="navigate('chupage')">
      <span class="gc-icon">🪂</span>
      <div class="gc-name">Nhảy Dù</div>
      <div class="gc-desc">Dừng đúng lúc!</div>
    </div>
    <div class="game-card" onclick="navigate('historypage')">
      <span class="gc-icon">📋</span>
      <div class="gc-name">Lịch Sử</div>
      <div class="gc-desc">Xem kết quả cũ</div>
    </div>
  </div>

  <div class="section-title">📊 Thống Kê Hôm Nay</div>
  <div style="background:var(--card2);border-radius:16px;padding:16px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:center">
    <div>
      <div style="font-size:22px;font-weight:900;color:var(--green)" id="stat-wins">0</div>
      <div style="font-size:11px;color:var(--muted)">Thắng</div>
    </div>
    <div>
      <div style="font-size:22px;font-weight:900;color:#ff6666" id="stat-losses">0</div>
      <div style="font-size:11px;color:var(--muted)">Thua</div>
    </div>
    <div>
      <div style="font-size:22px;font-weight:900;color:var(--gold2)" id="stat-profit">₫0</div>
      <div style="font-size:11px;color:var(--muted)">Lợi nhuận</div>
    </div>
  </div>
</div>

<!-- TAI XIU PAGE -->
<div class="page" id="page-txpage">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
    <button onclick="navigate('home')" style="background:none;border:none;color:white;font-size:22px;cursor:pointer">←</button>
    <h2 style="font-size:18px;font-weight:900">🎲 Tài Xỉu</h2>
  </div>

  <div class="game-area">
    <div style="text-align:center;margin-bottom:8px;color:var(--muted);font-size:13px">Kết Quả</div>
    <div class="dice-container" id="dice-display">
      <div class="die" id="die1">🎲</div>
      <div class="die" id="die2">🎲</div>
      <div class="die" id="die3">🎲</div>
    </div>
    <div style="text-align:center">
      <div class="dice-total" id="dice-total" style="display:none">0</div>
      <div style="display:flex;justify-content:center">
        <div class="dice-result-label" id="tx-result-label" style="display:none">TAI</div>
      </div>
    </div>
    <div class="result-box" id="tx-outcome-box"></div>
  </div>

  <div class="section-title">Đặt Cược</div>
  <div class="bet-row">
    <label>Số tiền:</label>
    <input type="number" id="tx-bet-amount" placeholder="10,000" min="1000" step="1000" value="10000">
  </div>
  <div class="quick-amounts">
    <button class="qa-btn" onclick="setBet('tx',10000)">10K</button>
    <button class="qa-btn" onclick="setBet('tx',50000)">50K</button>
    <button class="qa-btn" onclick="setBet('tx',100000)">100K</button>
    <button class="qa-btn" onclick="setBet('tx',500000)">500K</button>
  </div>

  <div class="bet-choices">
    <div class="bet-choice tai-btn" id="tx-tai" onclick="selectTX('tai')">
      🔴 TÀI<br><span style="font-size:12px;font-weight:600">11 - 18</span>
    </div>
    <div class="bet-choice xiu-btn" id="tx-xiu" onclick="selectTX('xiu')">
      🔵 XỈU<br><span style="font-size:12px;font-weight:600">3 - 10</span>
    </div>
  </div>

  <button class="btn-primary" id="tx-roll-btn" onclick="rollTX()">🎲 LẮC XÚC XẮC</button>
</div>

<!-- PLANE GAME PAGE -->
<div class="page" id="page-planepage">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
    <button onclick="navigate('home')" style="background:none;border:none;color:white;font-size:22px;cursor:pointer">←</button>
    <h2 style="font-size:18px;font-weight:900">✈️ Máy Bay</h2>
  </div>

  <div class="game-area">
    <div class="plane-graph" id="plane-graph">
      <div class="sky-stars" id="plane-stars"></div>
      <div class="plane-trail" id="plane-trail"></div>
      <div class="plane-emoji" id="plane-emoji" style="bottom:20px;left:20px">✈️</div>
      <div class="plane-crashed" id="plane-crashed" style="display:none">💥</div>
    </div>
    <div class="plane-multiplier" id="plane-mult">1.00×</div>
    <div class="plane-status" id="plane-status">Đặt cược và bắt đầu bay!</div>
  </div>

  <div class="bet-row">
    <label>Số tiền:</label>
    <input type="number" id="plane-bet-amount" placeholder="10,000" min="1000" step="1000" value="10000">
  </div>
  <div class="quick-amounts">
    <button class="qa-btn" onclick="setBet('plane',10000)">10K</button>
    <button class="qa-btn" onclick="setBet('plane',50000)">50K</button>
    <button class="qa-btn" onclick="setBet('plane',100000)">100K</button>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
    <button class="btn-primary" id="plane-start-btn" onclick="startPlane()" style="background:linear-gradient(135deg,#00c851,#007a33)">🚀 BẮT ĐẦU</button>
    <button class="btn-primary" id="plane-cash-btn" onclick="cashOutPlane()" disabled style="background:linear-gradient(135deg,#f5a623,#c47d00)">💰 RÚT TIỀN</button>
  </div>
</div>

<!-- PARACHUTE PAGE -->
<div class="page" id="page-chupage">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
    <button onclick="navigate('home')" style="background:none;border:none;color:white;font-size:22px;cursor:pointer">←</button>
    <h2 style="font-size:18px;font-weight:900">🪂 Nhảy Dù</h2>
  </div>

  <div class="parachute-area" id="parachute-area">
    <div class="sky-stars" id="chu-stars"></div>
    <div class="parachute-jumper" id="chu-jumper" style="top:-60px">🪂</div>
    <div class="ground-line">🌳🌲🌳🌲🏠🌲🌳</div>
  </div>

  <div class="parachute-multiplier" id="chu-mult">1.00×</div>
  <div class="plane-status" id="chu-status">Nhảy dù và đổ bộ đúng lúc!</div>

  <div class="bet-row">
    <label>Số tiền:</label>
    <input type="number" id="chu-bet-amount" placeholder="10,000" min="1000" step="1000" value="10000">
  </div>
  <div class="quick-amounts">
    <button class="qa-btn" onclick="setBet('chu',10000)">10K</button>
    <button class="qa-btn" onclick="setBet('chu',50000)">50K</button>
    <button class="qa-btn" onclick="setBet('chu',100000)">100K</button>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
    <button class="btn-primary" id="chu-start-btn" onclick="startChu()" style="background:linear-gradient(135deg,#00c851,#007a33)">🪂 NHẢY</button>
    <button class="btn-primary" id="chu-land-btn" onclick="landChu()" disabled style="background:linear-gradient(135deg,#f5a623,#c47d00)">🏁 ĐỔ BỘ</button>
  </div>
</div>

<!-- HISTORY PAGE -->
<div class="page" id="page-historypage">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
    <button onclick="navigate('home')" style="background:none;border:none;color:white;font-size:22px;cursor:pointer">←</button>
    <h2 style="font-size:18px;font-weight:900">📋 Lịch Sử</h2>
  </div>

  <div class="tab-buttons">
    <button class="tab-btn active" onclick="filterHistory('all',this)">Tất cả</button>
    <button class="tab-btn" onclick="filterHistory('win',this)">Thắng</button>
    <button class="tab-btn" onclick="filterHistory('lose',this)">Thua</button>
  </div>

  <div id="history-list">
    <div class="empty-state">
      <div class="es-icon">📭</div>
      <div>Chưa có lịch sử giao dịch</div>
    </div>
  </div>
</div>

<!-- PROFILE PAGE -->
<div class="page" id="page-profilepage">
  <div style="text-align:center;padding:20px 0 24px">
    <div style="width:72px;height:72px;background:var(--red);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;margin:0 auto 12px">LT</div>
    <h2 style="font-size:20px;font-weight:900">Lê Thanh Tùng</h2>
    <p style="color:var(--muted);font-size:13px;margin-top:4px">0971918513</p>
  </div>

  <div class="bank-info">
    <div class="bank-name">Ngân hàng liên kết</div>
    <div class="bank-account">0971918513</div>
    <div class="bank-holder">LE THANH TUNG</div>
    <span class="bank-type">MB BANK</span>
  </div>

  <div class="profile-row"><span class="pr-label">Tổng nạp</span><span class="pr-value" id="pr-deposit">₫0</span></div>
  <div class="profile-row"><span class="pr-label">Tổng rút</span><span class="pr-value" id="pr-withdraw">₫0</span></div>
  <div class="profile-row"><span class="pr-label">Ván thắng</span><span class="pr-value" id="pr-wins">0</span></div>
  <div class="profile-row"><span class="pr-label">Ván thua</span><span class="pr-value" id="pr-losses">0</span></div>
  <div class="profile-row"><span class="pr-label">Tỷ lệ thắng</span><span class="pr-value" id="pr-rate">0%</span></div>
</div>

<!-- BOTTOM NAV -->
<div class="bottom-nav">
  <div class="nav-item active" id="nav-home" onclick="navigate('home')">
    <span class="nav-icon">🏠</span>
    <span class="nav-label">Trang chủ</span>
  </div>
  <div class="nav-item" id="nav-txpage" onclick="navigate('txpage')">
    <span class="nav-icon">🎲</span>
    <span class="nav-label">Tài Xỉu</span>
  </div>
  <div class="nav-item" id="nav-planepage" onclick="navigate('planepage')">
    <span class="nav-icon">✈️</span>
    <span class="nav-label">Máy Bay</span>
  </div>
  <div class="nav-item" id="nav-chupage" onclick="navigate('chupage')">
    <span class="nav-icon">🪂</span>
    <span class="nav-label">Nhảy Dù</span>
  </div>
  <div class="nav-item" id="nav-profilepage" onclick="navigate('profilepage')">
    <span class="nav-icon">👤</span>
    <span class="nav-label">Tài khoản</span>
  </div>
</div>

<!-- DEPOSIT MODAL -->
<div class="modal-overlay" id="modal-deposit">
  <div class="modal">
    <div class="modal-title">💰 Nạp Tiền <button class="modal-close" onclick="closeDepositModal()">✕</button></div>

    <!-- BƯỚC 1: Nhập số tiền -->
    <div id="deposit-step1">
      <p style="font-size:13px;color:var(--muted);margin-bottom:16px">Nhập số tiền muốn nạp:</p>
      <div class="amount-input-group">
        <span>₫</span>
        <input type="number" id="deposit-amount" placeholder="100,000" min="10000" step="10000">
      </div>
      <div class="quick-amounts">
        <button class="qa-btn" onclick="setDepAmt(50000)">50K</button>
        <button class="qa-btn" onclick="setDepAmt(100000)">100K</button>
        <button class="qa-btn" onclick="setDepAmt(200000)">200K</button>
        <button class="qa-btn" onclick="setDepAmt(500000)">500K</button>
        <button class="qa-btn" onclick="setDepAmt(1000000)">1TR</button>
      </div>
      <button class="btn-primary" onclick="showDepositQR()">📱 Tạo QR Chuyển Khoản</button>
    </div>

    <!-- BƯỚC 2: Hiện QR chờ thanh toán -->
    <div id="deposit-step2" style="display:none;text-align:center">
      <div style="background:white;border-radius:16px;padding:12px;display:inline-block;margin-bottom:14px">
        <img id="deposit-qr-img" src="" alt="QR Code" style="width:200px;height:200px;display:block">
      </div>
      <div style="background:var(--card2);border-radius:12px;padding:12px 16px;margin-bottom:12px;text-align:left">
        <div style="font-size:12px;color:var(--muted)">Số tiền</div>
        <div style="font-size:22px;font-weight:900;color:var(--gold2)" id="deposit-qr-amount"></div>
        <div style="font-size:12px;color:var(--muted);margin-top:8px">Nội dung chuyển khoản <span style="color:#ff4">(bắt buộc)</span></div>
        <div style="font-size:16px;font-weight:900;color:white;letter-spacing:1px" id="deposit-qr-content"></div>
        <div style="font-size:12px;color:var(--muted);margin-top:8px">Tài khoản</div>
        <div style="font-size:14px;font-weight:800">0971918513 · MB BANK · LE THANH TUNG</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;background:rgba(0,200,81,0.1);border:1px solid rgba(0,200,81,0.3);border-radius:10px;padding:10px 14px;margin-bottom:14px">
        <span style="font-size:20px">⏳</span>
        <span style="font-size:13px;color:var(--green);font-weight:700">Đang chờ thanh toán... Tiền sẽ vào ngay sau khi chuyển khoản thành công.</span>
      </div>
      <button class="btn-primary" onclick="document.getElementById('deposit-step1').style.display='block';document.getElementById('deposit-step2').style.display='none';stopPolling()" style="background:rgba(255,255,255,0.1)">← Quay lại</button>
    </div>
  </div>
</div>

<!-- WITHDRAW MODAL -->
<div class="modal-overlay" id="modal-withdraw">
  <div class="modal">
    <div class="modal-title">🏧 Rút Tiền <button class="modal-close" onclick="closeModal('modal-withdraw')">✕</button></div>
    <p style="font-size:13px;color:var(--muted);margin-bottom:16px">Tiền sẽ về tài khoản MB Bank của bạn:</p>
    <div class="bank-info">
      <div class="bank-name">Tài khoản nhận</div>
      <div class="bank-account">0971918513</div>
      <div class="bank-holder">LE THANH TUNG · MB BANK</div>
    </div>
    <div style="text-align:center;margin-bottom:16px">
      <div style="font-size:12px;color:var(--muted)">Số dư khả dụng</div>
      <div style="font-size:28px;font-weight:900;color:var(--gold2)" id="withdraw-avail">₫0</div>
    </div>
    <div class="amount-input-group">
      <span>₫</span>
      <input type="number" id="withdraw-amount" placeholder="100,000" min="10000" step="10000">
    </div>
    <div class="quick-amounts">
      <button class="qa-btn" onclick="setWdAmt(50000)">50K</button>
      <button class="qa-btn" onclick="setWdAmt(100000)">100K</button>
      <button class="qa-btn" onclick="setWdAmt(200000)">200K</button>
      <button class="qa-btn" onclick="setWdAmt(500000)">500K</button>
      <button class="qa-btn" onclick="setWdAll()">Tất cả</button>
    </div>
    <button class="btn-primary" onclick="doWithdraw()">✅ Xác Nhận Rút</button>
  </div>
</div>

<script>
// ===== STATE =====
let state = {
  balance: 0,
  totalDeposit: 0,
  totalWithdraw: 0,
  wins: 0,
  losses: 0,
  profit: 0,
  history: []
};

// ===== UTILS =====
const fmt = n => '₫' + Math.abs(n).toLocaleString('vi-VN');
const fmtSigned = n => (n >= 0 ? '+' : '-') + fmt(n);

function updateUI() {
  document.getElementById('top-balance').textContent = fmt(state.balance);
  document.getElementById('home-balance').textContent = fmt(state.balance);
  document.getElementById('stat-wins').textContent = state.wins;
  document.getElementById('stat-losses').textContent = state.losses;
  const p = state.profit;
  const pel = document.getElementById('stat-profit');
  pel.textContent = (p >= 0 ? '+' : '-') + fmt(p);
  pel.style.color = p >= 0 ? 'var(--green)' : '#ff6666';
  // profile
  document.getElementById('pr-deposit').textContent = fmt(state.totalDeposit);
  document.getElementById('pr-withdraw').textContent = fmt(state.totalWithdraw);
  document.getElementById('pr-wins').textContent = state.wins;
  document.getElementById('pr-losses').textContent = state.losses;
  const total = state.wins + state.losses;
  document.getElementById('pr-rate').textContent = total ? Math.round(state.wins/total*100)+'%' : '0%';
}

function showToast(msg, type='info') {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

function addHistory(game, detail, amount, win) {
  state.history.unshift({ game, detail, amount, win, time: new Date() });
  if (win) { state.wins++; state.profit += amount; }
  else { state.losses++; state.profit -= amount; }
  updateUI();
  renderHistory('all');
}

// ===== NAVIGATION =====
function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  const ni = document.getElementById('nav-' + page);
  if (ni) ni.classList.add('active');
}

// ===== MODALS =====
function openDeposit() {
  document.getElementById('modal-deposit').classList.add('open');
  document.getElementById('deposit-amount').value = '';
}
function openWithdraw() {
  document.getElementById('withdraw-avail').textContent = fmt(state.balance);
  document.getElementById('modal-withdraw').classList.add('open');
  document.getElementById('withdraw-amount').value = '';
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function setDepAmt(v) { document.getElementById('deposit-amount').value = v; }
function setWdAmt(v) { document.getElementById('withdraw-amount').value = v; }
function setWdAll() { document.getElementById('withdraw-amount').value = state.balance; }

function doDeposit() {
  const amt = parseInt(document.getElementById('deposit-amount').value) || 0;
  if (amt < 10000) { showToast('Nạp tối thiểu 10,000đ', 'info'); return; }
  state.balance += amt;
  state.totalDeposit += amt;
  closeModal('modal-deposit');
  updateUI();
  showToast('✅ Nạp ' + fmt(amt) + ' thành công!', 'win');
}

function doWithdraw() {
  const amt = parseInt(document.getElementById('withdraw-amount').value) || 0;
  if (amt < 10000) { showToast('Rút tối thiểu 10,000đ', 'info'); return; }
  if (amt > state.balance) { showToast('Số dư không đủ!', 'lose'); return; }
  state.balance -= amt;
  state.totalWithdraw += amt;
  closeModal('modal-withdraw');
  updateUI();
  showToast('🏧 Rút ' + fmt(amt) + ' thành công!', 'info');
}

// ===== BET HELPER =====
function setBet(game, amt) {
  const map = { tx: 'tx-bet-amount', plane: 'plane-bet-amount', chu: 'chu-bet-amount' };
  document.getElementById(map[game]).value = amt;
}

// ===== TAI XIU =====
const DICE_FACES = ['⚀','⚁','⚂','⚃','⚄','⚅'];
let txChoice = null;
let txRolling = false;

function selectTX(choice) {
  txChoice = choice;
  document.getElementById('tx-tai').classList.toggle('selected', choice === 'tai');
  document.getElementById('tx-xiu').classList.toggle('selected', choice === 'xiu');
}

function rollTX() {
  if (txRolling) return;
  if (!txChoice) { showToast('Hãy chọn TÀI hoặc XỈU!', 'info'); return; }
  const bet = parseInt(document.getElementById('tx-bet-amount').value) || 0;
  if (bet < 1000) { showToast('Đặt cược tối thiểu 1,000đ', 'info'); return; }
  if (bet > state.balance) { showToast('Số dư không đủ! Hãy nạp tiền.', 'lose'); return; }

  txRolling = true;
  state.balance -= bet;
  updateUI();

  const d1 = document.getElementById('die1');
  const d2 = document.getElementById('die2');
  const d3 = document.getElementById('die3');
  const dtotal = document.getElementById('dice-total');
  const dlabel = document.getElementById('tx-result-label');
  const doutcome = document.getElementById('tx-outcome-box');

  // hide previous result
  dtotal.style.display = 'none';
  dlabel.style.display = 'none';
  doutcome.className = 'result-box';

  // roll animation
  d1.classList.add('rolling');
  d2.classList.add('rolling');
  d3.classList.add('rolling');

  document.getElementById('tx-roll-btn').disabled = true;

  let count = 0;
  const anim = setInterval(() => {
    d1.textContent = DICE_FACES[Math.floor(Math.random() * 6)];
    d2.textContent = DICE_FACES[Math.floor(Math.random() * 6)];
    d3.textContent = DICE_FACES[Math.floor(Math.random() * 6)];
    count++;
    if (count > 15) clearInterval(anim);
  }, 80);

  setTimeout(() => {
    clearInterval(anim);
    const v1 = Math.ceil(Math.random() * 6);
    const v2 = Math.ceil(Math.random() * 6);
    const v3 = Math.ceil(Math.random() * 6);
    const total = v1 + v2 + v3;

    d1.classList.remove('rolling');
    d2.classList.remove('rolling');
    d3.classList.remove('rolling');
    d1.textContent = DICE_FACES[v1-1];
    d2.textContent = DICE_FACES[v2-1];
    d3.textContent = DICE_FACES[v3-1];

    const isTai = total >= 11;
    const result = isTai ? 'tai' : 'xiu';
    const win = result === txChoice;

    dtotal.style.display = 'block';
    dtotal.textContent = total;
    dlabel.style.display = 'block';
    dlabel.textContent = isTai ? 'TÀI' : 'XỈU';
    dlabel.className = 'dice-result-label ' + result;

    if (win) {
      const winAmt = bet * 2;
      state.balance += winAmt;
      doutcome.textContent = '🎉 THẮNG! +' + fmt(bet);
      doutcome.className = 'result-box win-result show';
      showToast('🎉 Thắng ' + fmt(bet) + '!', 'win');
      addHistory('Tài Xỉu', (isTai ? 'TÀI' : 'XỈU') + ' (tổng: ' + total + ')', bet, true);
    } else {
      doutcome.textContent = '😢 THUA! -' + fmt(bet);
      doutcome.className = 'result-box lose-result show';
      showToast('😢 Thua ' + fmt(bet), 'lose');
      addHistory('Tài Xỉu', (isTai ? 'TÀI' : 'XỈU') + ' (tổng: ' + total + ')', bet, false);
    }

    updateUI();
    document.getElementById('tx-roll-btn').disabled = false;
    txRolling = false;
    txChoice = null;
    document.getElementById('tx-tai').classList.remove('selected');
    document.getElementById('tx-xiu').classList.remove('selected');
  }, 1400);
}

// ===== AIRPLANE =====
let planeInterval = null;
let planeMult = 1.0;
let planeBet = 0;
let planeRunning = false;
let planeCrashAt = 1.0;
let planePosX = 0, planePosY = 0;

function generateCrashPoint() {
  // House edge ~5%, exponential distribution
  const r = Math.random();
  if (r < 0.03) return 1.0 + Math.random() * 0.5;
  return Math.max(1.01, 0.99 / (1 - Math.random()));
}

function startPlane() {
  const bet = parseInt(document.getElementById('plane-bet-amount').value) || 0;
  if (bet < 1000) { showToast('Đặt cược tối thiểu 1,000đ', 'info'); return; }
  if (bet > state.balance) { showToast('Số dư không đủ! Hãy nạp tiền.', 'lose'); return; }
  if (planeRunning) return;

  planeBet = bet;
  state.balance -= bet;
  updateUI();
  planeRunning = true;
  planeMult = 1.0;
  planeCrashAt = generateCrashPoint();
  planePosX = 0; planePosY = 0;

  const graph = document.getElementById('plane-graph');
  const plane = document.getElementById('plane-emoji');
  const trail = document.getElementById('plane-trail');
  const crashed = document.getElementById('plane-crashed');
  const multEl = document.getElementById('plane-mult');
  const statusEl = document.getElementById('plane-status');

  crashed.style.display = 'none';
  plane.style.display = 'block';
  plane.style.bottom = '20px';
  plane.style.left = '20px';
  trail.style.width = '0%';
  multEl.className = 'plane-multiplier';

  document.getElementById('plane-start-btn').disabled = true;
  document.getElementById('plane-cash-btn').disabled = false;
  statusEl.textContent = '✈️ Máy bay đang bay... Rút tiền đúng lúc!';

  planeInterval = setInterval(() => {
    planeMult += 0.02 + planeMult * 0.005;

    const progress = Math.min((planeMult - 1) / (planeCrashAt - 1), 1);
    const graphH = graph.offsetHeight - 50;
    const graphW = graph.offsetWidth - 60;

    planePosX = Math.min(progress * graphW + 20, graphW + 10);
    planePosY = Math.min(progress * graphH, graphH);

    plane.style.left = planePosX + 'px';
    plane.style.bottom = (20 + planePosY) + 'px';
    trail.style.width = Math.min(progress * 100, 100) + '%';
    multEl.textContent = planeMult.toFixed(2) + '×';

    if (planeMult > planeCrashAt * 0.8) multEl.classList.add('danger');

    if (planeMult >= planeCrashAt) {
      clearInterval(planeInterval);
      planeRunning = false;
      plane.style.display = 'none';
      crashed.style.display = 'flex';
      multEl.textContent = '💥 ' + planeCrashAt.toFixed(2) + '×';
      multEl.classList.add('danger');
      statusEl.textContent = '💥 Máy bay nổ tại ' + planeCrashAt.toFixed(2) + '×! Bạn đã thua!';
      document.getElementById('plane-start-btn').disabled = false;
      document.getElementById('plane-cash-btn').disabled = true;
      showToast('💥 Máy bay nổ! Thua ' + fmt(planeBet), 'lose');
      addHistory('Máy Bay', 'Nổ tại ' + planeCrashAt.toFixed(2) + '×', planeBet, false);
      updateUI();
    }
  }, 100);
}

function cashOutPlane() {
  if (!planeRunning) return;
  clearInterval(planeInterval);
  planeRunning = false;

  const winAmt = Math.floor(planeBet * planeMult);
  state.balance += winAmt;
  updateUI();

  document.getElementById('plane-status').textContent = '💰 Rút thành công tại ' + planeMult.toFixed(2) + '×! Nhận ' + fmt(winAmt);
  document.getElementById('plane-cash-btn').disabled = true;
  document.getElementById('plane-start-btn').disabled = false;
  document.getElementById('plane-mult').classList.remove('danger');

  const profit = winAmt - planeBet;
  showToast('💰 Rút tại ' + planeMult.toFixed(2) + '×! +' + fmt(profit), 'win');
  addHistory('Máy Bay', 'Rút tại ' + planeMult.toFixed(2) + '×', profit, true);
}

// ===== PARACHUTE =====
let chuInterval = null;
let chuMult = 1.0;
let chuBet = 0;
let chuRunning = false;
let chuCrashAt = 1.0;
let chuJumped = false;

// Create stars
function makeStars(containerId, count=20) {
  const c = document.getElementById(containerId);
  c.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    s.style.cssText = \`
      width:\${1+Math.random()*2}px;
      height:\${1+Math.random()*2}px;
      left:\${Math.random()*100}%;
      top:\${Math.random()*60}%;
      animation-delay:\${Math.random()*2}s
    \`;
    c.appendChild(s);
  }
}
makeStars('plane-stars', 15);
makeStars('chu-stars', 20);

function startChu() {
  const bet = parseInt(document.getElementById('chu-bet-amount').value) || 0;
  if (bet < 1000) { showToast('Đặt cược tối thiểu 1,000đ', 'info'); return; }
  if (bet > state.balance) { showToast('Số dư không đủ! Hãy nạp tiền.', 'lose'); return; }
  if (chuRunning) return;

  chuBet = bet;
  state.balance -= bet;
  updateUI();
  chuRunning = true;
  chuJumped = true;
  chuMult = 1.0;
  chuCrashAt = generateCrashPoint();

  const jumper = document.getElementById('chu-jumper');
  const multEl = document.getElementById('chu-mult');
  const statusEl = document.getElementById('chu-status');

  jumper.style.top = '10px';
  jumper.textContent = '🪂';
  multEl.textContent = '1.00×';
  multEl.style.color = 'var(--gold2)';

  document.getElementById('chu-start-btn').disabled = true;
  document.getElementById('chu-land-btn').disabled = false;
  statusEl.textContent = '🪂 Đang rơi... Nhấn ĐỔ BỘ để hạ cánh an toàn!';

  chuInterval = setInterval(() => {
    chuMult += 0.015 + chuMult * 0.003;
    multEl.textContent = chuMult.toFixed(2) + '×';

    // Move jumper down
    const currentTop = parseFloat(jumper.style.top) || 10;
    const targetTop = 140;
    const progress = Math.min((chuMult - 1) / (chuCrashAt - 1), 1);
    jumper.style.top = Math.min(10 + progress * targetTop, targetTop + 20) + 'px';

    if (chuMult > chuCrashAt * 0.75) multEl.style.color = '#ff4444';

    if (chuMult >= chuCrashAt) {
      clearInterval(chuInterval);
      chuRunning = false;
      jumper.textContent = '💥';
      multEl.textContent = '💥 ' + chuCrashAt.toFixed(2) + '×';
      multEl.style.color = '#ff4444';
      statusEl.textContent = '💥 Dù bị rách tại ' + chuCrashAt.toFixed(2) + '×! Bạn đã thua!';
      document.getElementById('chu-start-btn').disabled = false;
      document.getElementById('chu-land-btn').disabled = true;
      showToast('💥 Dù bị rách! Thua ' + fmt(chuBet), 'lose');
      addHistory('Nhảy Dù', 'Dù rách tại ' + chuCrashAt.toFixed(2) + '×', chuBet, false);
      updateUI();
    }
  }, 100);
}

function landChu() {
  if (!chuRunning) return;
  clearInterval(chuInterval);
  chuRunning = false;

  const winAmt = Math.floor(chuBet * chuMult);
  state.balance += winAmt;
  updateUI();

  const jumper = document.getElementById('chu-jumper');
  jumper.style.top = '140px';
  jumper.textContent = '🏃';

  document.getElementById('chu-status').textContent = '✅ Hạ cánh an toàn tại ' + chuMult.toFixed(2) + '×! Nhận ' + fmt(winAmt);
  document.getElementById('chu-land-btn').disabled = true;
  document.getElementById('chu-start-btn').disabled = false;
  document.getElementById('chu-mult').style.color = 'var(--green)';

  const profit = winAmt - chuBet;
  showToast('✅ Đổ bộ thành công! +' + fmt(profit), 'win');
  addHistory('Nhảy Dù', 'Đổ bộ tại ' + chuMult.toFixed(2) + '×', profit, true);
}

// ===== HISTORY =====
let currentFilter = 'all';

function renderHistory(filter) {
  currentFilter = filter;
  const list = document.getElementById('history-list');
  let items = state.history;
  if (filter === 'win') items = items.filter(h => h.win);
  if (filter === 'lose') items = items.filter(h => !h.win);

  if (!items.length) {
    list.innerHTML = '<div class="empty-state"><div class="es-icon">📭</div><div>Không có kết quả</div></div>';
    return;
  }

  list.innerHTML = items.map(h => \`
    <div class="history-item \${h.win ? 'win' : 'lose'}">
      <div class="hi-left">
        <div class="hi-game">\${h.game}</div>
        <div class="hi-detail">\${h.detail}</div>
      </div>
      <div class="hi-amount \${h.win ? 'win' : 'lose'}">\${h.win ? '+' : '-'}\${fmt(Math.abs(h.amount))}</div>
    </div>
  \`).join('');
}

function filterHistory(filter, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderHistory(filter);
}

// ===== CLOSE MODALS ON OUTSIDE CLICK =====
document.querySelectorAll('.modal-overlay').forEach(mo => {
  mo.addEventListener('click', e => {
    if (e.target === mo) mo.classList.remove('open');
  });
});

// =============================================
// BACKEND API INTEGRATION
// =============================================
const USER_ID = 'LT001'; // ID user đang đăng nhập
const API_BASE = ''; // Để trống nếu cùng domain, hoặc 'http://yourdomain.com'

// Load số dư từ server khi mở app
async function loadUserFromServer() {
  try {
    const res = await fetch(\`\${API_BASE}/api/user/\${USER_ID}\`);
    const data = await res.json();
    if (data.success) {
      state.balance = data.user.balance;
      state.wins = data.user.wins;
      state.losses = data.user.losses;
      state.totalDeposit = data.user.totalDeposit;
      state.totalWithdraw = data.user.totalWithdraw;
      updateUI();
    }
  } catch (e) {
    console.log('Offline mode - dùng local state');
  }
}

// =============================================
// POLLING: Check giao dịch nạp tiền mới từ SePay
// Gọi mỗi 3 giây khi modal nạp tiền đang mở
// =============================================
let pollingInterval = null;

function startPolling() {
  if (pollingInterval) return;
  pollingInterval = setInterval(async () => {
    try {
      const res = await fetch(\`\${API_BASE}/api/notifications/\${USER_ID}\`);
      const data = await res.json();
      if (data.success && data.notifications.length > 0) {
        for (const notif of data.notifications) {
          if (notif.type === 'deposit_success') {
            state.balance += notif.amount;
            state.totalDeposit += notif.amount;
            updateUI();
            closeModal('modal-deposit');
            showToast('✅ Nạp ' + fmt(notif.amount) + ' thành công!', 'win');
            // Thêm vào lịch sử local
            state.history.unshift({
              game: '💰 Nạp tiền',
              detail: 'Chuyển khoản MB Bank',
              amount: notif.amount,
              win: true,
              time: new Date()
            });
            renderHistory(currentFilter);
          }
        }
      }
    } catch (e) { /* offline */ }
  }, 3000);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

// =============================================
// OVERRIDE: Nạp tiền - hiển thị QR + chờ thật
// =============================================
function openDeposit() {
  document.getElementById('modal-deposit').classList.add('open');
  document.getElementById('deposit-amount').value = '';
  document.getElementById('deposit-step1').style.display = 'block';
  document.getElementById('deposit-step2').style.display = 'none';
}

function showDepositQR() {
  const amt = parseInt(document.getElementById('deposit-amount').value) || 0;
  if (amt < 10000) { showToast('Nạp tối thiểu 10,000đ', 'info'); return; }

  // Tạo nội dung chuyển khoản kèm userID
  const transferContent = \`NAP \${USER_ID}\`;
  const qrUrl = \`https://img.vietqr.io/image/MB-0971918513-compact2.jpg?amount=\${amt}&addInfo=\${encodeURIComponent(transferContent)}&accountName=LE%20THANH%20TUNG\`;

  document.getElementById('deposit-qr-img').src = qrUrl;
  document.getElementById('deposit-qr-amount').textContent = fmt(amt);
  document.getElementById('deposit-qr-content').textContent = transferContent;
  document.getElementById('deposit-step1').style.display = 'none';
  document.getElementById('deposit-step2').style.display = 'block';

  // Bắt đầu polling chờ webhook
  startPolling();
  showToast('📱 Quét QR để chuyển khoản...', 'info');
}

function closeDepositModal() {
  closeModal('modal-deposit');
  stopPolling();
}

// =============================================
// OVERRIDE: Rút tiền - gọi API backend
// =============================================
async function doWithdraw() {
  const amt = parseInt(document.getElementById('withdraw-amount').value) || 0;
  if (amt < 10000) { showToast('Rút tối thiểu 10,000đ', 'info'); return; }
  if (amt > state.balance) { showToast('Số dư không đủ!', 'lose'); return; }

  try {
    const res = await fetch(\`\${API_BASE}/api/withdraw\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userID: USER_ID, amount: amt })
    });
    const data = await res.json();

    if (data.success) {
      state.balance = data.balance;
      state.totalWithdraw += amt;
      closeModal('modal-withdraw');
      updateUI();
      showToast('🏧 Yêu cầu rút ' + fmt(amt) + ' đã gửi!', 'info');
      state.history.unshift({ game: '🏧 Rút tiền', detail: 'MB Bank 0971918513', amount: amt, win: false, time: new Date() });
      renderHistory(currentFilter);
    } else {
      showToast(data.message || 'Lỗi rút tiền', 'lose');
    }
  } catch (e) {
    // Offline fallback
    if (amt > state.balance) { showToast('Số dư không đủ!', 'lose'); return; }
    state.balance -= amt;
    state.totalWithdraw += amt;
    closeModal('modal-withdraw');
    updateUI();
    showToast('🏧 Rút ' + fmt(amt) + ' đã gửi (offline)', 'info');
  }
}

// Init
loadUserFromServer();
updateUI();
</script>
</body>
</html>
`;

app.get('/', (req, res) => res.send(HTML));
app.get('/index.html', (req, res) => res.send(HTML));

app.listen(CONFIG.PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   MB Game Server đang chạy!             ║');
  console.log('║   http://localhost:' + CONFIG.PORT + '               ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║   Webhook SePay: POST /webhook/sepay    ║');
  console.log('║   ⚠️  Nhớ sửa SEPAY_API_KEY trước!      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
