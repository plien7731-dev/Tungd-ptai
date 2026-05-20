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
    <div class="stats" id="stats-row"></div>

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
    background: var(--card); border: 1px solid rgba(255,255,255,0.15);
    border-radius: 12px; padding: 12px 24px;
    font-weight: 800; font-size: 15px; z-index: 999;
    animation: toastIn 0.3s ease, toastOut 0.3s ease 2.2s forwards;
    white-space: nowrap; box-shadow: 0 8px 30px rgba(0,0,0,0.5);
  }
  .toast.win { border-color: var(--green); color: var(--green); }
  .toast.lose { border-color: var(--red); color: #ff6666; }
  .toast.info { border-color: var(--gold); color: var(--gold2); }
  @keyframes toastIn { from { opacity: 0; top: 60px; } to { opacity: 1; top: 70px; } }
  @keyframes toastOut { from { opacity: 1; } to { opacity: 0; pointer-events: none; } }

  /* ===== HISTORY ===== */
  .history-item {
    background: var(--card2); border-radius: 12px; padding: 12px 16px; margin-bottom: 8px;
    display: flex; align-items: center; justify-content: space-between;
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
    text-align: center; font-size: 64px; font-weight: 900; color: var(--gold2);
    text-shadow: 0 0 30px rgba(255,215,0,0.6); margin: 16px 0;
    transition: color 0.3s;
  }
  .plane-multiplier.danger { color: #ff4444; text-shadow: 0 0 30px rgba(255,68,68,0.6); }
  .plane-graph {
    background: rgba(0,0,0,0.4); border-radius: 16px; height: 160px; margin-bottom: 16px;
    position: relative; overflow: hidden; border: 1px solid rgba(255,255,255,0.05);
  }
  .plane-emoji { position: absolute; font-size: 32px; transition: all 0.5s ease; filter: drop-shadow(0 0 10px rgba(255,215,0,0.8)); }
  .plane-trail { position: absolute; bottom: 0; left: 0; width: 0%; height: 2px; background: linear-gradient(90deg, transparent, var(--gold2)); transition: width 0.5s; }
  .plane-crashed { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 48px; background: rgba(255,0,0,0.1); border-radius: 16px; animation: flashRed 0.5s; }
  @keyframes flashRed { 0% { background: rgba(255,0,0,0.5); } 100% { background: rgba(255,0,0,0.1); } }
  .plane-status { text-align: center; font-size: 14px; font-weight: 700; color: var(--muted); margin-bottom: 16px; min-height: 20px; }

  /* ===== PARACHUTE ===== */
  .parachute-area {
    position: relative;
    background: linear-gradient(180deg, #0a1628 0%, #1a3a6e 50%, #2d6a4f 100%);
    border-radius: 20px; height: 240px; overflow: hidden; margin-bottom: 16px;
  }
  .sky-stars { position: absolute; inset: 0; overflow: hidden; }
  .star { position: absolute; background: white; border-radius: 50%; animation: twinkle 2s infinite alternate; }
  @keyframes twinkle { from { opacity: 0.3; } to { opacity: 1; } }
  .parachute-jumper { position: absolute; left: 50%; transform: translateX(-50%); font-size: 44px; filter: drop-shadow(0 4px 8px rgba(0,0,0,0.5)); transition: bottom 0.4s ease; }
  .parachute-ground { position: absolute; bottom: 0; left: 0; width: 100%; height: 30px; background: #2d6a4f; border-top: 4px solid #40916c; }
  .parachute-height { position: absolute; top: 12px; right: 12px; background: rgba(0,0,0,0.5); border-radius: 8px; padding: 4px 10px; font-weight: 800; font-size: 13px; color: var(--gold2); border: 1px solid rgba(255,215,0,0.2); }
  .parachute-instructions { background: var(--card2); border-radius: 14px; padding: 12px; font-size: 12px; color: var(--muted); line-height: 1.5; margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.04); }

  /* ===== WHEEL GAME ===== */
  .wheel-wrapper { position: relative; width: 240px; height: 240px; margin: 20px auto; }
  .wheel-pointer { position: absolute; top: -10px; left: 50%; transform: translateX(-50%); font-size: 28px; z-index: 10; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5)); }
  .wheel-canvas { width: 100%; height: 100%; border-radius: 50%; box-shadow: 0 6px 25px rgba(0,0,0,0.6); border: 6px solid #1e1e2a; transition: transform 4s cubic-bezier(0.1, 0.8, 0.25, 1); }
</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-logo">🏦 MB <span>Game</span></div>
  <div style="display:flex;align-items:center;gap:10px">
    <div class="balance-display" id="nav-balance">₫0</div>
    <div class="user-avatar" id="nav-avatar">T</div>
  </div>
</div>

<div class="page active" id="page-home">
  <div class="banner">
    <p>Chào mừng quay trở lại,</p>
    <h2 id="home-username">Lê Thanh Tùng</h2>
    <div class="balance-big" id="home-balance">₫0</div>
    <p style="opacity:0.6;font-size:11px" id="home-uid">Mã tài khoản: LT001</p>
  </div>

  <div class="wallet-actions">
    <div class="wallet-btn deposit" onclick="openModal('modal-deposit')">
      <div class="wb-icon">🏦</div>
      <div class="wb-label">Nạp Tiền</div>
    </div>
    <div class="wallet-btn withdraw" onclick="openModal('modal-withdraw')">
      <div class="wb-icon">🏧</div>
      <div class="wb-label">Rút Tiền</div>
    </div>
  </div>

  <div class="section-title">Trò Chơi Siêu Tốc</div>
  <div class="games-grid">
    <div class="game-card hot" onclick="switchPage('taixiu')">
      <span class="gc-icon">🎲</span>
      <div class="gc-name">Tài Xỉu 60s</div>
      <div class="gc-desc">Truyền thống, xanh chín</div>
    </div>
    <div class="game-card hot" onclick="switchPage('airplane')">
      <span class="gc-icon">🚀</span>
      <div class="gc-name">Phi Cơ Nhảy Dù</div>
      <div class="gc-desc">Càng bay cao x càng to</div>
    </div>
    <div class="game-card new" onclick="switchPage('parachute')">
      <span class="gc-icon">🪂</span>
      <div class="gc-name">Căn Cánh Nhảy Dù</div>
      <div class="gc-desc">Đáp đất an toàn nhận thưởng</div>
    </div>
    <div class="game-card" onclick="switchPage('wheel')">
      <span class="gc-icon">🎡</span>
      <div class="gc-name">Vòng Quay May Mắn</div>
      <div class="gc-desc">Thử vận may, 100% trúng</div>
    </div>
  </div>
</div>

<div class="page" id="page-taixiu">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
    <div class="section-title" style="margin:0">🎲 Trò chơi Tài Xỉu</div>
    <button class="qa-btn" style="padding:4px 10px;font-size:12px" onclick="switchPage('home')">↩ Quay lại</button>
  </div>
  <div class="game-area">
    <div id="tx-dice-view">
      <div class="dice-container">
        <div class="die" id="die1">⚀</div>
        <div class="die" id="die2">⚄</div>
        <div class="die" id="die3">⚃</div>
      </div>
      <div id="tx-result-box" style="text-align:center; min-height:80px">
        <div class="dice-total" id="tx-total">10</div>
        <div class="dice-result-label xiu" id="tx-label">XỈU</div>
      </div>
    </div>

    <div style="margin-top:24px">
      <div class="bet-choices">
        <div class="bet-choice tai-btn" id="btn-choice-tai" onclick="selectBet('tai')">TÀI<br><span style="font-size:11px;opacity:0.6;font-weight:600">x1.98 (11-17)</span></div>
        <div class="bet-choice xiu-btn" id="btn-choice-xiu" onclick="selectBet('xiu')">XỈU<br><span style="font-size:11px;opacity:0.6;font-weight:600">x1.98 (4-10)</span></div>
      </div>

      <div class="amount-input-group">
        <span>₫</span>
        <input type="number" id="tx-amount" placeholder="Nhập số tiền cược" min="1000" value="10000">
      </div>
      <div class="quick-amounts">
        <button class="qa-btn" onclick="setTxAmt(10000)">10K</button>
        <button class="qa-btn" onclick="setTxAmt(50000)">50K</button>
        <button class="qa-btn" onclick="setTxAmt(100000)">100K</button>
        <button class="qa-btn" onclick="setTxAmt(500000)">500K</button>
        <button class="qa-btn" onclick="setTxAmt(state.balance)">Tất tay</button>
      </div>

      <button class="btn-primary" id="tx-submit" onclick="playTaiXiu()">🎲 Đặt Cược</button>
    </div>
  </div>
</div>

<div class="page" id="page-airplane">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
    <div class="section-title" style="margin:0">🚀 Phi Cơ Nhảy Dù (Crash)</div>
    <button class="qa-btn" style="padding:4px 10px;font-size:12px" onclick="switchPage('home')">↩ Quay lại</button>
  </div>
  <div class="game-area">
    <div class="plane-graph" id="plane-screen">
      <div class="sky-stars" id="plane-stars"></div>
      <div class="plane-trail" id="plane-trail"></div>
      <div class="plane-emoji" id="plane-jumper" style="bottom:10px; left:10px;">🚀</div>
      <div id="plane-crash-overlay"></div>
    </div>
    <div class="plane-multiplier" id="plane-mult">1.00x</div>
    <div class="plane-status" id="plane-status">Sẵn sàng cất cánh</div>

    <div id="plane-controls">
      <div class="amount-input-group">
        <span>₫</span>
        <input type="number" id="plane-amount" placeholder="Tiền cược" min="1000" value="10000">
      </div>
      <button class="btn-primary" id="btn-plane-start" onclick="startAirplane()">🚀 Cất Cánh</button>
      <button class="btn-primary" id="btn-plane-cashout" style="display:none; background:linear-gradient(135deg, var(--green), #007e33)" onclick="cashoutAirplane()">🪂 Nhảy Dù (Chốt Lời)</button>
    </div>
  </div>
</div>

<div class="page" id="page-parachute">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
    <div class="section-title" style="margin:0">🪂 Căn Cánh Nhảy Dù</div>
    <button class="qa-btn" style="padding:4px 10px;font-size:12px" onclick="switchPage('home')">↩ Quay lại</button>
  </div>
  <div class="parachute-area" id="para-screen">
    <div class="sky-stars" id="para-stars"></div>
    <div class="parachute-jumper" id="para-jumper" style="bottom: 200px;">🧍</div>
    <div class="parachute-ground"></div>
    <div class="parachute-height" id="para-height-val">Độ cao: 2000m</div>
  </div>
  <div class="plane-multiplier" id="para-mult" style="font-size:36px; margin:8px 0">Tỷ lệ: 1.00x</div>
  <div class="plane-status" id="para-status">Ấn mở dù ở thời điểm thích hợp!</div>
  <div class="parachute-instructions">
    💡 <strong>Luật chơi:</strong> Nhân vật sẽ rơi tự do từ độ cao 2000m. Độ cao giảm dần thì tỷ lệ thưởng càng tăng! Bạn cần bấm <strong>"MỞ DÙ"</strong> trước khi chạm đất. Nếu bấm quá muộn khi đã chạm đất, bạn sẽ thua sạch!
  </div>
  <div class="amount-input-group">
    <span>₫</span>
    <input type="number" id="para-amount" placeholder="Tiền cược" min="1000" value="10000">
  </div>
  <button class="btn-primary" id="btn-para-start" onclick="startParachute()">🪂 Bắt Đầu Rơi</button>
  <button class="btn-primary" id="btn-para-deploy" style="display:none; background:linear-gradient(135deg, #00cbff, #007ca3)" onclick="deployParachute()">🪂 MỞ DÙ NGAY</button>
</div>

<div class="page" id="page-wheel">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
    <div class="section-title" style="margin:0">🎡 Vòng Quay May Mắn</div>
    <button class="qa-btn" style="padding:4px 10px;font-size:12px" onclick="switchPage('home')">↩ Quay lại</button>
  </div>
  <div class="game-area" style="text-align:center">
    <div class="wheel-wrapper">
      <div class="wheel-pointer">▼</div>
      <canvas class="wheel-canvas" id="wheel-canvas" width="300" height="300"></canvas>
    </div>
    <div class="plane-status" id="wheel-status" style="margin-top:10px">Chi phí: 20,000đ / lượt quay</div>

    <div class="amount-input-group" style="display:none">
      <input type="number" id="wheel-amount" value="20000">
    </div>
    <button class="btn-primary" id="btn-wheel-spin" onclick="spinWheel()">🎡 Quay Ngay (-20K)</button>
  </div>
</div>

<div class="page" id="page-history">
  <div class="section-title">📋 Lịch sử trò chơi</div>
  <div style="display:flex;gap:6px;margin-bottom:14px">
    <button class="qa-btn" style="flex:1" onclick="filterHistory('all')">Tất cả</button>
    <button class="qa-btn" style="flex:1" onclick="filterHistory('win')">Thắng</button>
    <button class="qa-btn" style="flex:1" onclick="filterHistory('lose')">Thua</button>
  </div>
  <div id="history-list"></div>
</div>

<div class="bottom-nav">
  <div class="nav-item active" id="nav-home" onclick="switchPage('home')">
    <span class="nav-icon">🏠</span>
    <span class="nav-label">Trang Chủ</span>
  </div>
  <div class="nav-item" id="nav-taixiu" onclick="switchPage('taixiu')">
    <span class="nav-icon">🎲</span>
    <span class="nav-label">Tài Xỉu</span>
  </div>
  <div class="nav-item" id="nav-history" onclick="switchPage('history')">
    <span class="nav-icon">📋</span>
    <span class="nav-label">Lịch Sự</span>
  </div>
</div>

<div class="modal-overlay" id="modal-deposit">
  <div class="modal">
    <div class="modal-title">
      <span>🏦 Nạp Tiền Chuyển Khoản</span>
      <button class="modal-close" onclick="closeModal('modal-deposit')">✕</button>
    </div>
    <div style="text-align:center; background:rgba(255,255,255,0.03); padding:16px; border-radius:14px; border:1px dashed rgba(255,255,255,0.1); margin-bottom:16px">
      <p style="font-size:12px;color:var(--muted)">Hệ thống nạp tự động qua SePay</p>
      <p style="font-size:13px; margin-top:8px">Nội dung chuyển khoản bắt buộc:</p>
      <p style="font-size:24px; font-weight:900; color:var(--red); letter-spacing:1px; margin:6px 0" id="deposit-content-code">NAP LT001</p>
      <p style="font-size:11px; color:var(--gold)">⚠️ Sai nội dung sẽ không được cộng tiền tự động!</p>
    </div>
    <div style="font-size:14px; line-height:1.6; background:var(--card2); padding:14px; border-radius:12px">
      <p>🏦 Ngân hàng: <strong>MB Bank (Quân Đội)</strong></p>
      <p>🔢 Số tài khoản: <strong>0971918513</strong></p>
      <p>👤 Chủ tài khoản: <strong>LE THANH TUNG</strong></p>
    </div>
    <button class="btn-primary" style="margin-top:16px" onclick="closeModal('modal-deposit')">Tôi đã chuyển tiền</button>
  </div>
</div>

<div class="modal-overlay" id="modal-withdraw">
  <div class="modal">
    <div class="modal-title">
      <span>🏧 Rút Tiền Về MB Bank</span>
      <button class="modal-close" onclick="closeModal('modal-withdraw')">✕</button>
    </div>
    <div class="amount-input-group">
      <span>🎰</span>
      <input type="text" id="wd-bank" value="MB Bank" disabled>
    </div>
    <div class="amount-input-group">
      <span>🔢</span>
      <input type="text" id="wd-acc" value="0971918513" placeholder="Số tài khoản nhận">
    </div>
    <div class="amount-input-group">
      <span>₫</span>
      <input type="number" id="wd-amount" placeholder="Số tiền cần rút" min="10000">
    </div>
    <p style="font-size:11px;color:var(--muted);margin-bottom:16px">⚠️ Hạn mức rút tối thiểu: 10,000đ. Hệ thống xử lý thủ công trong vòng 5-30 phút.</p>
    <button class="btn-primary" onclick="submitWithdraw()">📤 Gửi Yêu Cầu Rút</button>
  </div>
</div>

<script>
// STATE MANAGEMENT
const state = {
  uid: 'LT001',
  username: 'Lê Thanh Tùng',
  phone: '0971918513',
  balance: 500000, 
  totalDeposit: 0,
  totalWithdraw: 0,
  wins: 0,
  losses: 0,
  history: [
    { game: '🎮 Tài Xỉu', detail: 'Đặt Xỉu ₫20,000', amount: 20000, win: true, time: new Date(Date.now()-60000) },
    { game: '🚀 Phi Cơ', detail: 'Chốt lời x1.85', amount: 15000, win: true, time: new Date(Date.now()-120000) }
  ]
};

let currentFilter = 'all';
let selectedTxChoice = null;

async function loadUserFromServer() {
  try {
    const res = await fetch('/api/user/' + state.uid);
    const data = await res.json();
    if (data.success) {
      state.username = data.user.name;
      state.phone = data.user.phone;
      state.balance = data.user.balance;
      state.totalDeposit = data.user.totalDeposit;
      state.totalWithdraw = data.user.totalWithdraw;
      state.wins = data.user.wins;
      state.losses = data.user.losses;
      updateUI();
    }
  } catch(e) { console.log('Chại chế độ offline/local storage'); }
}

setInterval(async () => {
  try {
    const res = await fetch('/api/notifications/' + state.uid);
    const data = await res.json();
    if (data.success && data.notifications.length > 0) {
      data.notifications.forEach(n => {
        if (n.type === 'deposit_success') {
          showToast('🏦 Hệ thống đã nhận ' + fmt(n.amount) + '! Số dư đã cộng.', 'info');
          loadUserFromServer();
        }
      });
    }
  } catch(e){}
}, 4000);

function fmt(n) { return '₫' + Math.abs(parseInt(n)||0).toLocaleString('vi-VN'); }

function updateUI() {
  document.getElementById('nav-balance').textContent = fmt(state.balance);
  document.getElementById('home-balance').textContent = fmt(state.balance);
  document.getElementById('home-username').textContent = state.username;
  document.getElementById('home-uid').textContent = 'Mã tài khoản: ' + state.uid;
  document.getElementById('deposit-content-code').textContent = 'NAP ' + state.uid;
  document.getElementById('nav-avatar').textContent = (state.username || 'U').charAt(0).toUpperCase();
}

function switchPage(pageID) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const p = document.getElementById('page-' + pageID);
  if(p) p.classList.add('active');

  const n = document.getElementById('nav-' + pageID);
  if(n) n.classList.add('active');

  if (pageID === 'history') renderHistory(currentFilter);
  if (pageID === 'wheel') initWheel();
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function showToast(msg, type='info') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function setTxAmt(a) { document.getElementById('tx-amount').value = parseInt(a); }
function selectBet(choice) {
  selectedTxChoice = choice;
  document.getElementById('btn-choice-tai').classList.remove('selected');
  document.getElementById('btn-choice-xiu').classList.remove('selected');
  document.getElementById('btn-choice-' + choice).classList.add('selected');
}

function playTaiXiu() {
  const amt = parseInt(document.getElementById('tx-amount').value) || 0;
  if (!selectedTxChoice) { showToast('Vui lòng chọn Tài hoặc Xỉu!', 'info'); return; }
  if (amt < 1000) { showToast('Cược tối thiểu 1,000đ', 'info'); return; }
  if (amt > state.balance) { showToast('Số dư không đủ!', 'lose'); return; }

  state.balance -= amt;
  updateUI();

  const d1 = document.getElementById('die1');
  const d2 = document.getElementById('die2');
  const d3 = document.getElementById('die3');
  d1.classList.add('rolling'); d2.classList.add('rolling'); d3.classList.add('rolling');
  document.getElementById('tx-submit').disabled = true;

  setTimeout(() => {
    d1.classList.remove('rolling'); d2.classList.remove('rolling'); d3.classList.remove('rolling');
    document.getElementById('tx-submit').disabled = false;

    const v1 = Math.floor(Math.random()*6)+1;
    const v2 = Math.floor(Math.random()*6)+1;
    const v3 = Math.floor(Math.random()*6)+1;
    const diceEmojis = ['','⚀','⚁','⚂','⚃','⚄','⚅'];
    d1.textContent = diceEmojis[v1];
    d2.textContent = diceEmojis[v2];
    d3.textContent = diceEmojis[v3];

    const total = v1 + v2 + v3;
    const resultText = total >= 11 ? 'tai' : 'xiu';

    document.getElementById('tx-total').textContent = total;
    const lbl = document.getElementById('tx-label');
    lbl.className = 'dice-result-label ' + resultText;
    lbl.textContent = resultText.toUpperCase();

    const isWin = selectedTxChoice === resultText;
    let winAmt = 0;
    if (isWin) {
      winAmt = Math.floor(amt * 1.98);
      state.balance += winAmt;
      state.wins++;
      showToast('🎉 Thắng +' + fmt(winAmt), 'win');
    } else {
      state.losses++;
      showToast('💥 Thua -' + fmt(amt), 'lose');
    }

    state.history.unshift({
      game: '🎲 Tài Xỉu',
      detail: 'Đặt ' + (selectedTxChoice==='tai'?'Tài':'Xỉu') + ' [' + v1 + ',' + v2 + ',' + v3 + ']',
      amount: isWin ? winAmt : amt,
      win: isWin,
      time: new Date()
    });
    updateUI();
    syncBalanceWithServer();
  }, 1200);
}

let planeInterval = null;
let planeMultiplier = 1.0;
let planeBetAmount = 0;
let isPlayingPlane = false;

function startAirplane() {
  const amt = parseInt(document.getElementById('plane-amount').value) || 0;
  if (amt < 1000) { showToast('Cược tối thiểu 1,000đ', 'info'); return; }
  if (amt > state.balance) { showToast('Số dư không đủ!', 'lose'); return; }

  state.balance -= amt;
  planeBetAmount = amt;
  isPlayingPlane = true;
  planeMultiplier = 1.0;
  updateUI();

  document.getElementById('btn-plane-start').style.display = 'none';
  document.getElementById('btn-plane-cashout').style.display = 'block';
  document.getElementById('plane-mult').classList.remove('danger');
  document.getElementById('plane-mult').textContent = '1.00x';
  document.getElementById('plane-status').textContent = '🛫 Phi cơ đang cất cánh...';

  const jumper = document.getElementById('plane-jumper');
  jumper.style.bottom = '10px'; jumper.style.left = '10px';
  jumper.textContent = '🚀';

  document.getElementById('plane-crash-overlay').className = '';

  const crashPoint = (Math.random() * 5 + 1.1) + (Math.random() < 0.15 ? Math.random()*10 : 0);

  planeInterval = setInterval(() => {
    planeMultiplier += 0.04 * (planeMultiplier * 0.4);
    document.getElementById('plane-mult').textContent = planeMultiplier.toFixed(2) + 'x';

    let progress = Math.min((planeMultiplier - 1) / 5, 1);
    jumper.style.bottom = (10 + progress * 100) + 'px';
    jumper.style.left = (10 + progress * 260) + 'px';

    if (planeMultiplier >= crashPoint) {
      clearInterval(planeInterval);
      isPlayingPlane = false;
      document.getElementById('btn-plane-start').style.display = 'block';
      document.getElementById('btn-plane-cashout').style.display = 'none';
      document.getElementById('plane-mult').classList.add('danger');
      document.getElementById('plane-mult').textContent = 'CRASHED @ ' + planeMultiplier.toFixed(2) + 'x';
      document.getElementById('plane-status').textContent = '💥 Máy bay phát nổ!';
      jumper.textContent = '💥';
      showToast('💥 Phi cơ nổ tung! Bạn mất ' + fmt(planeBetAmount), 'lose');

      state.history.unshift({ game: '🚀 Phi Cơ', detail: 'Nổ máy bay @ ' + planeMultiplier.toFixed(2) + 'x', amount: planeBetAmount, win: false, time: new Date() });
      state.losses++;
      syncBalanceWithServer();
    }
  }, 100);
}

function cashoutAirplane() {
  if (!isPlayingPlane) return;
  clearInterval(planeInterval);
  isPlayingPlane = false;

  const winAmt = Math.floor(planeBetAmount * planeMultiplier);
  state.balance += winAmt;
  updateUI();

  document.getElementById('btn-plane-start').style.display = 'block';
  document.getElementById('btn-plane-cashout').style.display = 'none';
  document.getElementById('plane-status').textContent = '🪂 Bạn đã nhảy dù thành công ở ' + planeMultiplier.toFixed(2) + 'x';

  showToast('🎉 Chốt lời thành công +' + fmt(winAmt), 'win');
  state.history.unshift({ game: '🚀 Phi Cơ', detail: 'Nhảy dù thành công x' + planeMultiplier.toFixed(2), amount: winAmt, win: true, time: new Date() });
  state.wins++;
  syncBalanceWithServer();
}

let paraInterval = null;
let paraHeight = 2000;
let paraBetAmount = 0;
let isFalling = false;
let isParaDeployed = false;

function startParachute() {
  const amt = parseInt(document.getElementById('para-amount').value) || 0;
  if (amt < 1000) { showToast('Cược tối thiểu 1,000đ', 'info'); return; }
  if (amt > state.balance) { showToast('Số dư không đủ!', 'lose'); return; }

  state.balance -= amt;
  paraBetAmount = amt;
  isFalling = true;
  isParaDeployed = false;
  paraHeight = 2000;
  updateUI();

  document.getElementById('btn-para-start').style.display = 'none';
  document.getElementById('btn-para-deploy').style.display = 'block';
  document.getElementById('para-mult').textContent = 'Tỷ lệ: 1.00x';
  document.getElementById('para-status').textContent = '🧍 Nhân vật đang rơi tự do...';

  const jumper = document.getElementById('para-jumper');
  jumper.style.bottom = '180px';
  jumper.textContent = '🧍';

  paraInterval = setInterval(() => {
    let fallSpeed = isParaDeployed ? 25 : 65;
    paraHeight -= fallSpeed;
    if (paraHeight < 0) paraHeight = 0;

    document.getElementById('para-height-val').textContent = 'Độ cao: ' + paraHeight + 'm';

    let currentMult = 1.0 + ((2000 - paraHeight) / 500);
    if (!isParaDeployed) currentMult *= 1.2; 
    document.getElementById('para-mult').textContent = 'Tỷ lệ: ' + currentMult.toFixed(2) + 'x';

    jumper.style.bottom = (30 + (paraHeight / 2000) * 150) + 'px';

    if (paraHeight === 0) {
      clearInterval(paraInterval);
      isFalling = false;
      document.getElementById('btn-para-start').style.display = 'block';
      document.getElementById('btn-para-deploy').style.display = 'none';

      if (isParaDeployed) {
        const finalMult = currentMult;
        const winAmt = Math.floor(paraBetAmount * finalMult);
        state.balance += winAmt;
        updateUI();
        document.getElementById('para-status').textContent = '🟩 Tiếp đất an toàn! Hệ số x' + finalMult.toFixed(2);
        showToast('🎉 Landing an toàn +' + fmt(winAmt), 'win');
        state.history.unshift({ game: '🪂 Nhảy Dù', detail: 'Đáp đất an toàn x' + finalMult.toFixed(2), amount: winAmt, win: true, time: new Date() });
        state.wins++;
      } else {
        document.getElementById('para-status').textContent = '💥 Chạm đất quá mạnh! Thua cuộc.';
        jumper.textContent = '💥';
        showToast('💥 Chưa mở dù đã chạm đất! -' + fmt(paraBetAmount), 'lose');
        state.history.unshift({ game: '🪂 Nhảy Dù', detail: 'Rơi tự do chạm đất ngã tử vong', amount: paraBetAmount, win: false, time: new Date() });
        state.losses++;
      }
      syncBalanceWithServer();
    }
  }, 150);
}

function deployParachute() {
  if (!isFalling || isParaDeployed) return;
  isParaDeployed = true;
  document.getElementById('para-status').textContent = '🪂 Đã mở dù! Đang giảm tốc đáp đất...';
  document.getElementById('para-jumper').textContent = '🪂';
  document.getElementById('btn-para-deploy').disabled = true;
  setTimeout(() => { document.getElementById('btn-para-deploy').style.display = 'none'; document.getElementById('btn-para-deploy').disabled = false; }, 200);
}

const wheelColors = ['#d0021b', '#16161e', '#f5a623', '#2196f3', '#00c851', '#7b0010', '#ffd700', '#444444'];
const wheelLabels = ['Mất lượt', 'Thưởng 5K', 'X2 Tiền Cược', 'Thưởng 20K', 'May mắn +50K', 'Chia đôi', ' Jackpot 200K', 'Thưởng 10K'];

function initWheel() {
  const canvas = document.getElementById('wheel-canvas');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,300,300);
  const arc = Math.PI / (wheelLabels.length / 2);

  for (let i = 0; i < wheelLabels.length; i++) {
    const angle = i * arc;
    ctx.fillStyle = wheelColors[i];
    ctx.beginPath();
    ctx.arc(150, 150, 140, angle, angle + arc, false);
    ctx.lineTo(150, 150);
    ctx.fill();

    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px sans-serif';
    ctx.translate(150, 150);
    ctx.rotate(angle + arc / 2);
    ctx.textAlign = 'right';
    ctx.fillText(wheelLabels[i], 130, 5);
    ctx.restore();
  }
}

let isSpinning = false;
function spinWheel() {
  if (isSpinning) return;
  const cost = 20000;
  if (state.balance < cost) { showToast('Số dư không đủ 20,000đ để quay!', 'lose'); return; }

  state.balance -= cost;
  isSpinning = true;
  updateUI();

  const canvas = document.getElementById('wheel-canvas');
  const randomDeg = Math.floor(Math.random() * 360) + 2880; 
  canvas.style.transform = 'rotate(' + randomDeg + 'deg)';

  document.getElementById('btn-wheel-spin').disabled = true;
  document.getElementById('wheel-status').textContent = '🎡 Vòng quay đang đảo nhanh...';

  setTimeout(() => {
    isSpinning = false;
    document.getElementById('btn-wheel-spin').disabled = false;

    const actualDeg = randomDeg % 360;
    const prizeIndex = Math.floor(((360 - actualDeg + 270) % 360) / (360 / wheelLabels.length));
    const prizeText = wheelLabels[prizeIndex];

    document.getElementById('wheel-status').textContent = '🎁 Kết quả: ' + prizeText;

    let winAmt = 0;
    let detailMsg = 'Quay vòng quay: ' + prizeText;
    let isWin = true;

    if (prizeText.includes('5K')) winAmt = 5000;
    else if (prizeText.includes('10K')) winAmt = 10000;
    else if (prizeText.includes('20K')) winAmt = 20000;
    else if (prizeText.includes('50K')) winAmt = 50000;
    else if (prizeText.includes('200K')) winAmt = 200000;
    else if (prizeText.includes('X2')) winAmt = cost * 2;
    else if (prizeText.includes('Chia đôi')) winAmt = cost / 2;
    else { winAmt = 0; isWin = false; } 

    state.balance += winAmt;
    if (winAmt > cost) { showToast('🎉 Trúng thưởng lớn: ' + prizeText, 'win'); state.wins++; }
    else if (winAmt === cost) { showToast('🤝 Huề vốn: ' + prizeText, 'info'); }
    else { showToast('💥 May mắn lần sau: ' + prizeText, 'lose'); state.losses++; }

    state.history.unshift({ game: '🎡 Vòng Quay', detail: detailMsg, amount: winAmt, win: isWin, time: new Date() });
    updateUI();
    syncBalanceWithServer();
  }, 4000);
}

function renderHistory(filter) {
  const list = document.getElementById('history-list');
  list.innerHTML = '';

  let filtered = state.history;
  if (filter === 'win') filtered = state.history.filter(h => h.win);
  if (filter === 'lose') filtered = state.history.filter(h => !h.win);

  if (!filtered.length) {
    list.innerHTML = '<p style="text-align:center;color:var(--muted);font-size:13px;padding:20px">Chưa có lịch sử giao dịch nào.</p>';
    return;
  }

  filtered.forEach(h => {
    const div = document.createElement('div');
    div.className = 'history-item ' + (h.win ? 'win' : 'lose');
    div.innerHTML = `
      <div class="hi-left">
        <div class="hi-game">${h.game}</div>
        <div class="hi-detail">${h.detail}</div>
      </div>
      <div class="hi-amount ${h.win ? 'win' : 'lose'}">${h.win ? '+' : '-'}${fmt(h.amount)}</div>
    `;
    list.appendChild(div);
  });
}

function filterHistory(type) { renderHistory(type); }

async function submitWithdraw() {
  const bank = document.getElementById('wd-bank').value;
  const acc = document.getElementById('wd-acc').value;
  const amt = parseInt(document.getElementById('wd-amount').value) || 0;

  if (!acc) { showToast('Nhập số tài khoản nhận!', 'lose'); return; }
  if (amt < 10000) { showToast('Số tiền rút tối thiểu 10,000đ!', 'lose'); return; }

  try {
    const res = await fetch('/api/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userID: state.uid, amount: amt })
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
    if (amt > state.balance) { showToast('Số dư không đủ!', 'lose'); return; }
    state.balance -= amt;
    state.totalWithdraw += amt;
    closeModal('modal-withdraw');
    updateUI();
    showToast('🏧 Rút ' + fmt(amt) + ' đã gửi (offline)', 'info');
  }
}

async function syncBalanceWithServer() {
  try {
    await fetch('/admin/setbalance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-pass': 'tungdeptraivip' },
      body: JSON.stringify({ userID: state.uid, amount: state.balance, note: 'Game Auto Sync' })
    });
  } catch(e){}
}

loadUserFromServer();
updateUI();
</script>
</body>
</html>
`;

app.get('/', (req, res) => res.send(HTML));
app.get('/index.html', (req, res) => res.send(HTML));

const port = process.env.PORT || CONFIG.PORT || 3000;
app.listen(port, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   MB Game Server đang chạy tại port ' + port + ' ║');
  console.log('╚══════════════════════════════════════════╝');
});
