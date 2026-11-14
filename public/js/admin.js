'use strict';

// ── Helpers ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => (!s ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'));

function showToast(msg, duration = 2500) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

function dateStr(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth()+1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── State ──────────────────────────────────────────────────────────────────
let adminToken = '';
let sb = null;   // Supabase 브라우저 클라이언트
let listVersion = 0;
let hasLoadedList = false;
const pendingAccounts = new Set();

function authTimeout(operation) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('인증 확인 시간이 초과되었습니다. 다시 시도하세요.')), 15000); })
  ]).finally(() => clearTimeout(timer));
}

// ── Login (Supabase Google OAuth) ──────────────────────────────────────────
function showLoginState(state) {  // 'loading' | 'form'
  $('login-loading').classList.toggle('hidden', state !== 'loading');
  $('login-form').classList.toggle('hidden', state !== 'form');
}

async function initAuth() {
  try {
    const cfg = await eduRequestJson('/api/config', {}, 15000);
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      showLoginState('form');
      showLoginError('서버에 인증이 설정되지 않았습니다.');
      $('google-login-btn').disabled = true;
      return;
    }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    const { data, error } = await authTimeout(sb.auth.getSession());
    if (error) throw error;
    if (data && data.session) {
      await tryAdminAuth(data.session.access_token);
    } else {
      showLoginState('form');
    }
  } catch (e) {
    showLoginState('form');
    showLoginError(e.message || '서버에 연결할 수 없습니다. 다시 시도하세요.');
  }
}

async function tryAdminAuth(accessToken) {
  try {
    const data = await eduRequestJson('/api/admin/auth', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + accessToken }
    }, 15000);
    if (data.ok) {
      adminToken = data.token;
      $('screen-login').classList.add('hidden');
      $('screen-admin').classList.remove('hidden');
      await loadInstructors();
    } else {
      throw new Error(data.error || '로그인에 실패했습니다.');
    }
  } catch (e) {
    // Supabase auth storage is shared with instructor tabs. An admin-page error
    // must not sign an ongoing class out, including when a non-admin opens it.
    showLoginState('form');
    showLoginError(e.message || '로그인에 실패했습니다. 다시 시도하세요.');
  }
}

$('google-login-btn').addEventListener('click', async () => {
  const button = $('google-login-btn');
  button.disabled = true;
  try {
    if (!sb) await initAuth();
    if (!sb || adminToken) return;
    const { error } = await authTimeout(sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/admin.html', queryParams: { prompt: 'select_account' } }
    }));
    if (error) throw error;
  } catch (error) {
    showLoginError(error.message || 'Google 로그인에 실패했습니다. 다시 시도하세요.');
  } finally {
    button.disabled = false;
  }
});

initAuth();

function showLoginError(msg) {
  const el = $('login-error');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ── Instructor list ────────────────────────────────────────────────────────
$('refresh-btn').addEventListener('click', loadInstructors);

async function api(path, opts = {}) {
  try {
    const data = await eduRequestJson(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': adminToken, ...(opts.headers || {}) }
    }, 30000);
    if (!data.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.');
    return data;
  } catch (error) {
    // The short-lived admin token is independent of the instructor's login.
    if (error.status === 401) {
      adminToken = '';
      listVersion++;
      $('screen-admin').classList.add('hidden');
      $('screen-login').classList.remove('hidden');
      showLoginState('form');
      showLoginError('관리자 인증이 만료되었습니다. 다시 로그인하세요.');
    }
    throw error;
  }
}

async function loadInstructors() {
  const version = ++listVersion;
  $('refresh-btn').disabled = true;
  try {
    const data = await api('/api/admin/instructors');
    if (version === listVersion) renderList(data.instructors || []);
  } catch (error) {
    if (error.status !== 401 && version === listVersion) {
      showToast('목록을 불러오지 못했습니다: ' + error.message, 5000);
      if (!hasLoadedList) $('instructor-rows').innerHTML = `<tr><td colspan="5" class="text-sm text-gray" style="text-align:center;padding:32px">${esc(error.message)}<br>새로고침을 눌러 다시 시도하세요.</td></tr>`;
    }
  } finally {
    if (version === listVersion || !adminToken) $('refresh-btn').disabled = false;
  }
}

const STATUS_LABEL = { pending: '대기', approved: '승인됨', rejected: '거절됨' };

function renderList(list) {
  hasLoadedList = true;
  // 대기 → 승인 → 거절 순, 같은 상태면 최신 등록 먼저
  const order = { pending: 0, approved: 1, rejected: 2 };
  const sorted = [...list].sort((a, b) =>
    (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.createdAt - a.createdAt);

  $('stat-pending').textContent = list.filter(a => a.status === 'pending').length;
  $('stat-approved').textContent = list.filter(a => a.status === 'approved').length;
  $('stat-rejected').textContent = list.filter(a => a.status === 'rejected').length;

  const tbody = $('instructor-rows');
  if (sorted.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-sm text-gray" style="text-align:center;padding:32px">등록된 강사가 없습니다</td></tr>';
    return;
  }

  tbody.innerHTML = sorted.map(a => `
    <tr>
      <td class="fw-600">${esc(a.name)}</td>
      <td>${esc(a.email)}</td>
      <td><span class="status-chip chip-${esc(a.status)}">${STATUS_LABEL[a.status] || esc(a.status)}</span></td>
      <td class="text-xs text-gray">${dateStr(a.createdAt)}</td>
      <td>
        <div class="admin-actions">
          ${a.status !== 'approved' ? `<button class="btn btn-sm btn-primary" style="width:auto" data-action="approved" data-id="${esc(a.id)}">승인</button>` : ''}
          ${a.status !== 'rejected' ? `<button class="btn btn-sm btn-danger" style="width:auto" data-action="rejected" data-id="${esc(a.id)}">거절</button>` : ''}
          <button class="btn btn-sm btn-ghost" style="width:auto" data-action="delete" data-id="${esc(a.id)}" data-email="${esc(a.email)}">삭제</button>
        </div>
      </td>
    </tr>
  `).join('');
  updateBusyAccounts();
}

function updateBusyAccounts() {
  $('instructor-rows').querySelectorAll('button[data-id]').forEach(button => {
    button.disabled = pendingAccounts.has(button.dataset.id);
  });
}

$('instructor-rows').addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  if (button.dataset.action === 'delete') window.removeAccount(button.dataset.id, button.dataset.email);
  else window.setStatus(button.dataset.id, button.dataset.action);
});

window.setStatus = async function (id, status) {
  if (pendingAccounts.has(id)) return;
  pendingAccounts.add(id);
  listVersion++;
  updateBusyAccounts();
  try {
    await api(`/api/admin/instructors/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status })
    });
    showToast(status === 'approved' ? '승인했습니다' : '거절했습니다');
    await loadInstructors();
  } catch (error) {
    if (error.status !== 401) showToast('변경하지 못했습니다: ' + error.message, 5000);
  } finally {
    pendingAccounts.delete(id);
    updateBusyAccounts();
    $('refresh-btn').disabled = false;
  }
};

window.removeAccount = async function (id, email) {
  if (pendingAccounts.has(id)) return;
  if (!confirm(`${email} 계정을 삭제하시겠습니까?`)) return;
  pendingAccounts.add(id);
  listVersion++;
  updateBusyAccounts();
  try {
    await api(`/api/admin/instructors/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showToast('삭제했습니다');
    await loadInstructors();
  } catch (error) {
    if (error.status !== 401) showToast('삭제하지 못했습니다: ' + error.message, 5000);
  } finally {
    pendingAccounts.delete(id);
    updateBusyAccounts();
    $('refresh-btn').disabled = false;
  }
};
