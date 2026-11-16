'use strict';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let adminToken = '';
let sb = null;
let listVersion = 0;
let lastList = null;
let loading = false;
const deletingRooms = new Set();

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function showLoginError(message) {
  $('login-error').textContent = message;
  $('login-error').hidden = !message;
}

function updateAuth() {
  const signedIn = !!adminToken;
  $('login-loading').classList.add('hidden');
  $('login-form').classList.toggle('hidden', signedIn);
  $('google-login-btn').classList.toggle('hidden', signedIn);
  $('logout-btn').classList.toggle('hidden', !signedIn);
  $('admin-badge').classList.toggle('hidden', !signedIn);
  $('created-heading').classList.toggle('hidden', !signedIn);
  $('actions-heading').classList.toggle('hidden', !signedIn);
  if (lastList) renderList(lastList);
}

function authTimeout(operation) {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('인증 확인 시간이 초과되었습니다. 다시 시도하세요.')), 15000);
  })]).finally(() => clearTimeout(timer));
}

async function initAuth() {
  try {
    const config = await eduRequestJson('/api/config', {}, 15000);
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      $('google-login-btn').disabled = true;
      $('google-login-btn').title = '관리자 로그인이 아직 설정되지 않았습니다';
      $('login-form').textContent = '관리자 로그인은 서버 인증 설정 후 사용할 수 있어요.';
      return;
    }
    sb = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    const { data, error } = await authTimeout(sb.auth.getSession());
    if (error) throw error;
    if (data?.session) {
      const result = await eduRequestJson('/api/admin/auth', {
        method: 'POST', headers: { Authorization: 'Bearer ' + data.session.access_token }
      }, 15000);
      if (!result.ok) throw new Error(result.error || '관리자 인증에 실패했습니다.');
      adminToken = result.token;
      updateAuth();
      await loadRooms();
    }
  } catch (error) {
    showLoginError(error.message || '관리자 인증에 실패했습니다.');
  } finally {
    updateAuth();
  }
}

$('google-login-btn').addEventListener('click', async () => {
  $('google-login-btn').disabled = true;
  showLoginError('');
  try {
    if (!sb) await initAuth();
    if (!sb || adminToken) return;
    const { error } = await authTimeout(sb.auth.signInWithOAuth({ provider: 'google',
      options: { redirectTo: window.location.origin + '/admin.html', queryParams: { prompt: 'select_account' } }
    }));
    if (error) throw error;
  } catch (error) { showLoginError(error.message); }
  finally { $('google-login-btn').disabled = !sb; }
});

$('logout-btn').addEventListener('click', async () => {
  $('logout-btn').disabled = true;
  try {
    try { await api('/api/admin/logout', { method: 'POST' }); }
    catch (error) { if (error.status !== 401) throw error; }
    adminToken = '';
    listVersion++;
    updateAuth();
    if (sb) {
      const { error } = await authTimeout(sb.auth.signOut({ scope: 'local' }));
      if (error) throw error;
    }
  } catch (error) { showLoginError(error.message); }
  finally { $('logout-btn').disabled = false; await loadRooms(); }
});

async function api(path, options = {}) {
  try {
    const result = await eduRequestJson(path, { ...options,
      headers: { 'Content-Type': 'application/json', ...(adminToken ? { 'X-Admin-Token': adminToken } : {}), ...options.headers }
    }, 15000);
    if (!result.ok) throw new Error(result.error || '요청을 처리하지 못했습니다.');
    return result;
  } catch (error) {
    if (error.status === 401 && adminToken) {
      adminToken = '';
      listVersion++;
      updateAuth();
      showLoginError('관리자 인증이 만료되었습니다. 다시 로그인하세요.');
    }
    throw error;
  }
}

async function loadRooms() {
  const version = ++listVersion;
  loading = true;
  $('refresh-btn').disabled = true;
  try {
    const result = await api(adminToken ? '/api/admin/rooms' : '/api/rooms');
    if (version !== listVersion) return;
    lastList = result;
    renderList(result);
    $('list-status').textContent = '방금 갱신했어요 · 15초마다 자동 갱신';
  } catch (error) {
    if (error.status === 401) { await loadRooms(); return; }
    if (version !== listVersion) return;
    $('list-status').textContent = '현황을 갱신하지 못했습니다. 새로고침으로 다시 시도하세요.';
    showToast('목록을 불러오지 못했습니다: ' + error.message);
    if (!lastList) $('room-rows').innerHTML = `<tr><td colspan="${adminToken ? 5 : 3}" class="room-empty">현황을 불러오지 못했습니다.</td></tr>`;
  } finally {
    if (version === listVersion) {
      loading = false;
      $('refresh-btn').disabled = false;
    }
  }
}

function renderList(data) {
  $('stat-rooms').textContent = data.roomCount;
  $('stat-limit').textContent = data.roomLimit;
  $('stat-participants').textContent = data.totalParticipants;
  $('room-rows').innerHTML = data.rooms.length ? data.rooms.map(room => `<tr>
    <td>${esc(room.lectureName)}</td><td>${esc(room.roomCode)}</td><td>${room.participantCount} / ${room.capacity}명</td>
    ${adminToken ? `<td class="admin-date">${Number.isFinite(room.createdAt) ? esc(new Date(room.createdAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })) + ' <span class="text-xs">KST</span>' : '—'}</td>
      <td><button type="button" class="btn btn-sm btn-danger" data-code="${esc(room.roomCode)}" data-name="${esc(room.lectureName)}" ${deletingRooms.has(room.roomCode) ? 'disabled' : ''}>삭제</button></td>` : ''}
    </tr>`).join('') : `<tr><td colspan="${adminToken ? 5 : 3}" class="room-empty">아직 열린 강의실이 없어요.<br>홈에서 첫 강의실을 만들어 보세요.</td></tr>`;
}

async function removeRoom(code, name) {
  if (!adminToken || deletingRooms.has(code)) return;
  if (!confirm(`“${name}” 강의실을 삭제할까요?\n참여 중인 모든 연결이 종료되며 대화와 자료 목록이 삭제됩니다.`)) return;
  deletingRooms.add(code);
  if (lastList) renderList(lastList);
  try {
    await api('/api/admin/rooms/' + encodeURIComponent(code), { method: 'DELETE' });
    showToast('강의실을 삭제했습니다.');
    await loadRooms();
  } catch (error) {
    if (error.status !== 401) showToast('삭제하지 못했습니다: ' + error.message);
    if (error.status === 401 || error.status === 404) await loadRooms();
  } finally {
    deletingRooms.delete(code);
    if (lastList) renderList(lastList);
  }
}

$('refresh-btn').addEventListener('click', loadRooms);
$('room-rows').addEventListener('click', event => {
  const button = event.target.closest('button[data-code]');
  if (button && !button.disabled) removeRoom(button.dataset.code, button.dataset.name);
});
loadRooms();
initAuth();
setInterval(() => { if (!document.hidden && !loading) loadRooms(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !loading) loadRooms(); });
