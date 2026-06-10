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

// ── Login (Supabase Google OAuth) ──────────────────────────────────────────
function showLoginState(state) {  // 'loading' | 'form'
  $('login-loading').classList.toggle('hidden', state !== 'loading');
  $('login-form').classList.toggle('hidden', state !== 'form');
}

async function initAuth() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      showLoginState('form');
      showLoginError('서버에 인증이 설정되지 않았습니다.');
      $('google-login-btn').disabled = true;
      return;
    }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    const { data } = await sb.auth.getSession();
    if (data && data.session) {
      await tryAdminAuth(data.session.access_token);
    } else {
      showLoginState('form');
    }
  } catch (e) {
    showLoginState('form');
    showLoginError('서버 오류가 발생했습니다.');
  }
}

async function tryAdminAuth(accessToken) {
  try {
    const res = await fetch('/api/admin/auth', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    const data = await res.json();
    if (data.ok) {
      adminToken = data.token;
      $('screen-login').classList.add('hidden');
      $('screen-admin').classList.remove('hidden');
      loadInstructors();
    } else {
      // 관리자 계정이 아니면 로그아웃 — 다른 계정으로 다시 시도하도록
      if (sb) await sb.auth.signOut();
      showLoginState('form');
      showLoginError(data.error || '로그인에 실패했습니다.');
    }
  } catch (e) {
    showLoginState('form');
    showLoginError('서버 오류가 발생했습니다.');
  }
}

$('google-login-btn').addEventListener('click', async () => {
  if (!sb) return;
  await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + '/admin.html' }
  });
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
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': adminToken, ...(opts.headers || {}) }
  });
  // 서버 재시작 등으로 admin 토큰 만료 → Google 재로그인 유도
  if (res.status === 401) {
    adminToken = '';
    $('screen-admin').classList.add('hidden');
    $('screen-login').classList.remove('hidden');
    showLoginState('form');
    showLoginError('인증이 만료되었습니다. 다시 로그인하세요.');
    throw new Error('unauthorized');
  }
  return res.json();
}

async function loadInstructors() {
  try {
    const data = await api('/api/admin/instructors');
    if (data.ok) renderList(data.instructors || []);
  } catch (e) { /* 401은 api()에서 처리 */ }
}

const STATUS_LABEL = { pending: '대기', approved: '승인됨', rejected: '거절됨' };

function renderList(list) {
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
          ${a.status !== 'approved' ? `<button class="btn btn-sm btn-primary" style="width:auto" onclick="setStatus('${a.id}','approved')">승인</button>` : ''}
          ${a.status !== 'rejected' ? `<button class="btn btn-sm btn-danger" style="width:auto" onclick="setStatus('${a.id}','rejected')">거절</button>` : ''}
          <button class="btn btn-sm btn-ghost" style="width:auto" onclick="removeAccount('${a.id}','${esc(a.email)}')">삭제</button>
        </div>
      </td>
    </tr>
  `).join('');
}

window.setStatus = async function (id, status) {
  try {
    const data = await api(`/api/admin/instructors/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status })
    });
    if (data.ok) {
      showToast(status === 'approved' ? '승인했습니다' : '거절했습니다');
      loadInstructors();
    } else {
      showToast('오류: ' + (data.error || '처리 실패'));
    }
  } catch (e) { /* handled */ }
};

window.removeAccount = async function (id, email) {
  if (!confirm(`${email} 계정을 삭제하시겠습니까?`)) return;
  try {
    const data = await api(`/api/admin/instructors/${id}`, { method: 'DELETE' });
    if (data.ok) {
      showToast('삭제했습니다');
      loadInstructors();
    } else {
      showToast('오류: ' + (data.error || '처리 실패'));
    }
  } catch (e) { /* handled */ }
};
