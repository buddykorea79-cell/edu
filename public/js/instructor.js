'use strict';

// ── Helpers ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => (!s ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'));
const timeStr = ts => {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
};

// 텍스트 내 http(s) URL을 새 창에서 열리는 링크로 변환 (XSS 방지: escape 후 치환)
function linkify(text) {
  if (!text) return '';
  const urlRe = /(https?:\/\/[^\s<>"']+)/g;
  let out = '', last = 0, m;
  while ((m = urlRe.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    const url = m[0];
    out += `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="chat-link">${esc(url)}</a>`;
    last = m.index + url.length;
  }
  out += esc(text.slice(last));
  return out;
}

function showToast(msg, duration = 2500) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

// ── Socket ─────────────────────────────────────────────────────────────────
const socket = io({ reconnectionDelay: 1000, reconnectionDelayMax: 10000, timeout: 20000 });
let mySocketId = '';
const connection = new EduTalkConnection(socket, {
  joinEvent: 'instructor:join',
  onNotice: showToast,
  onError: error => { if (error.code === 'AUTH') { showScreen('screen-auth'); showAuthState('login'); showError('auth-error', error.message || error.error); } else { showError('setup-error', error.message || error.error); showToast(error.message || error.error); } }
});
window.EduTalkSession = connection;
socket.on('connect', () => { mySocketId = socket.id; });

// ── State ──────────────────────────────────────────────────────────────────
let roomCode = '';
let lectureName = '';
let surveys = [];
let resources = [];
let expiryIntervalId = null;
let setupMode = 'create';   // 'create' | 'assistant'
let myRole = 'instructor';  // 'instructor' | 'assistant'
let wbStarted = false;

// ── Screen management ──────────────────────────────────────────────────────
function showScreen(id) {
  ['screen-auth','screen-setup','screen-room'].forEach(s => {
    const el = $(s);
    if (el) el.classList.toggle('hidden', s !== id);
  });
}

// ── Auth (Supabase Google OAuth → 관리자 승인 후 사용) ──────────────────────
let sb = null;             // Supabase 브라우저 클라이언트
let myAccountName = '';

// 인증 화면 내 상태 전환: loading | login | pending | rejected
function showAuthState(state) {
  ['auth-loading', 'auth-login', 'auth-pending', 'auth-rejected'].forEach(id => {
    const el = $(id);
    if (el) el.classList.toggle('hidden', id !== 'auth-' + state);
  });
}

// 현재 세션의 access token (supabase-js 가 자동 갱신)
async function currentToken() {
  if (!sb) return '';
  const { data } = await sb.auth.getSession();
  return (data && data.session) ? data.session.access_token : '';
}

async function initAuth() {
  try {
    const cfg = await eduRequestJson('/api/config');
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      showAuthState('login');
      showError('auth-error', '서버에 인증이 설정되지 않았습니다. 관리자에게 문의하세요.');
      $('google-login-btn').disabled = true;
      return;
    }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    const token = await currentToken();
    if (token) await checkProfile(token);
    else showAuthState('login');
  } catch (e) {
    showAuthState('login');
    showError('auth-error', '서버 오류가 발생했습니다.');
  }
}

// 서버에 프로필 확인 (첫 로그인이면 pending 으로 자동 등록됨)
async function checkProfile(token) {
  try {
    const data = await eduRequestJson('/api/instructor/session', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!data.ok) {
      showAuthState('login');
      showError('auth-error', data.error || '인증에 실패했습니다.');
      return;
    }
    myAccountName = data.name || '';
    if (data.status === 'approved') {
      if (!$('setup-assistant-name').value) $('setup-assistant-name').value = myAccountName;
      showScreen('screen-setup');
    } else if (data.status === 'pending') {
      showAuthState('pending');
    } else {
      showAuthState('rejected');
    }
  } catch (e) {
    showAuthState('login');
    showError('auth-error', '서버 오류가 발생했습니다.');
  }
}

$('google-login-btn').addEventListener('click', async () => {
  if (!sb) return;
  await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + '/instructor.html' }
  });
});

async function doLogout() {
  connection.leave();
  if (sb) await sb.auth.signOut();
  showScreen('screen-auth');
  showAuthState('login');
}
$('pending-logout-btn').addEventListener('click', doLogout);
$('rejected-logout-btn').addEventListener('click', doLogout);

initAuth();

function showError(id, msg) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ── Setup ──────────────────────────────────────────────────────────────────
// 역할 토글: 강의실 만들기 / 조교로 참여
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    setupMode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
    const isAssistant = setupMode === 'assistant';
    $('setup-lecture-group').classList.toggle('hidden', isAssistant);
    $('setup-assistant-name-group').classList.toggle('hidden', !isAssistant);
    $('setup-subtitle').textContent = isAssistant ? '조교로 참여하기' : '강의실 만들기';
    $('setup-btn').textContent = isAssistant ? '조교로 입장' : '강의실 열기';
  });
});

$('gen-code-btn').addEventListener('click', () => {
  $('setup-room-code').value = Math.floor(100000 + Math.random() * 900000).toString();
});

$('setup-btn').addEventListener('click', doSetup);
$('setup-lecture').addEventListener('keydown', e => { if (e.key === 'Enter') doSetup(); });
$('setup-assistant-name').addEventListener('keydown', e => { if (e.key === 'Enter') doSetup(); });
$('setup-room-code').addEventListener('keydown', e => { if (e.key === 'Enter') doSetup(); });

async function doSetup() {
  if (connection.joining) return;
  const code = $('setup-room-code').value.trim();
  if (!/^\d{6}$/.test(code)) { showError('setup-error', '6자리 숫자 방 코드를 입력하세요.'); return; }

  const token = await currentToken();
  if (!token) {
    showScreen('screen-auth');
    showAuthState('login');
    showError('auth-error', '로그인이 만료되었습니다. 다시 로그인하세요.');
    return;
  }

  if (setupMode === 'assistant') {
    const aName = $('setup-assistant-name').value.trim();
    if (!aName) { showError('setup-error', '조교 이름을 입력하세요.'); return; }
    roomCode = code;
    myRole = 'assistant';
    connection.join(async () => ({ roomCode, asAssistant: true, name: aName, token: await tokenForJoin() }));
  } else {
    const name = $('setup-lecture').value.trim();
    if (!name) { showError('setup-error', '강의 이름을 입력하세요.'); return; }
    lectureName = name;
    roomCode = code;
    myRole = 'instructor';
    connection.join(async () => ({ roomCode, lectureName, token: await tokenForJoin() }));
  }
}

async function tokenForJoin() {
  const token = await currentToken();
  if (!token) {
    const error = new Error('로그인이 만료되었습니다. 다시 로그인하세요.');
    error.code = 'AUTH';
    throw error;
  }
  return token;
}

// ── Tab switching ──────────────────────────────────────────────────────────
document.querySelectorAll('[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(name) {
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
  if (name === 'whiteboard' && wbStarted) Whiteboard.show();
}

// ── Mobile sidebar ─────────────────────────────────────────────────────────
const sidebarOverlay = document.createElement('div');
sidebarOverlay.className = 'sidebar-overlay';
document.body.appendChild(sidebarOverlay);

$('mobile-menu-btn').addEventListener('click', () => {
  $('sidebar').classList.add('open');
  sidebarOverlay.classList.add('visible');
});

sidebarOverlay.addEventListener('click', () => {
  $('sidebar').classList.remove('open');
  sidebarOverlay.classList.remove('visible');
});

// ── Copy room code ─────────────────────────────────────────────────────────
$('copy-code-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode).then(() => showToast('방 코드가 복사되었습니다!'));
});
$('sb-room-code').addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode).then(() => showToast('방 코드가 복사되었습니다!'));
});

// ── 학생 입장 링크 복사 (URL ?code= 방식) ────────────────────────────────────
$('share-link-btn').addEventListener('click', () => {
  const link = `${window.location.origin}/student.html?code=${roomCode}`;
  navigator.clipboard.writeText(link).then(() => showToast('입장 링크가 복사되었습니다!'));
});

// ── Exit ───────────────────────────────────────────────────────────────────
$('exit-btn').addEventListener('click', () => {
  if (confirm('강의를 종료하시겠습니까?')) {
    connection.leave();
    window.location.href = '/';
  }
});

// ── Chat ───────────────────────────────────────────────────────────────────
const chatFeed = $('chat-feed');
const renderedMessages = new Set();
let sendingChat = false;
let pendingChat = null;

function renderMsg(container, msg, batch = false) {
  if (!msg || (msg.id && renderedMessages.has(msg.id))) return;
  if (msg.id) renderedMessages.add(msg.id);
  const nearBottom = !batch && container.scrollHeight - container.scrollTop - container.clientHeight < 100;
  const div = document.createElement('div');
  if (msg.id) div.dataset.messageId = msg.id;
  if (msg.type === 'system') {
    div.className = 'msg msg-system';
    div.innerHTML = `<span>${esc(msg.text)}</span>`;
  } else {
    const isMe = (msg.participantId && msg.participantId === connection.participantId) || (msg.socketId && msg.socketId === mySocketId);
    div.className = `msg ${isMe ? 'msg-me' : 'msg-other'}`;
    if (msg.type === 'file') {
      div.innerHTML = `${!isMe ? `<div class="msg-sender">${esc((msg.senderEmoji||'') + ' ' + (msg.senderName||''))}</div>` : ''}
        <div class="msg-bubble"><a href="${esc(msg.url)}" target="_blank" rel="noopener noreferrer" class="file-link">📎 ${esc(msg.filename)}</a></div>
        <div class="msg-time">${timeStr(msg.timestamp)}</div>`;
    } else {
      div.innerHTML = `${!isMe ? `<div class="msg-sender">${esc((msg.senderEmoji||'') + ' ' + (msg.senderName||''))}</div>` : ''}
        <div class="msg-bubble">${linkify(msg.text)}</div>
        <div class="msg-time">${timeStr(msg.timestamp)}</div>`;
    }
  }
  container.appendChild(div);
  while (container.children.length > 500) {
    const first = container.firstElementChild;
    renderedMessages.delete(first.dataset.messageId);
    first.remove();
  }
  if (!batch && (nearBottom || msg.participantId === connection.participantId)) container.scrollTop = container.scrollHeight;
}

$('chat-send-btn').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); } });

async function sendChat() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || sendingChat) return;
  if (text.length > 2000) { showToast('메시지는 2,000자까지 입력할 수 있습니다.'); return; }
  if (!pendingChat || pendingChat.text !== text) pendingChat = { text, id: crypto.randomUUID() };
  const draft = input.value;
  sendingChat = true;
  $('chat-send-btn').disabled = true;
  try {
    const message = await connection.send('message:send', { text }, pendingChat.id);
    if (message) renderMsg(chatFeed, message);
    if (input.value === draft) input.value = '';
    pendingChat = null;
  } catch (error) {
    showToast(error.message, 5000);
  } finally {
    sendingChat = false;
    $('chat-send-btn').disabled = false;
  }
}

$('file-upload-btn').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async function() {
  const file = this.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { showToast('파일은 20MB까지 업로드할 수 있습니다.'); this.value = ''; return; }
  const button = $('file-upload-btn');
  button.disabled = true;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const data = await eduRequestJson('/api/upload', { method: 'POST', headers: connection.uploadHeaders(), body: fd }, 60000);
    if (!data.url) throw new Error('파일 업로드에 실패했습니다.');
    const message = await connection.send('message:file', { url: data.url, filename: data.filename });
    if (message) renderMsg(chatFeed, message);
  } catch (error) {
    showToast(error.message, 5000);
  } finally {
    button.disabled = false;
    this.value = '';
  }
});

// ── Room expiry display ────────────────────────────────────────────────────
function updateExpiryDisplay() {
  const el = $('room-expire-info');
  if (!el) return;
  el.textContent = '참여 중인 강의실은 계속 유지됩니다.';
}

// ── Room expired ───────────────────────────────────────────────────────────
socket.on('room:expired', ({ reason }) => {
  connection.stop();
  alert(reason || '강의방이 만료되었습니다. 처음 화면으로 돌아갑니다.');
  socket.disconnect();
  window.location.href = '/';
});

// ── Socket: instructor joined ──────────────────────────────────────────────
socket.on('instructor:joined', data => {
  connection.acceptSnapshot(data);
  roomCode = data.roomCode;
  myRole = data.role || myRole;
  lectureName = data.lectureName || lectureName;

  showScreen('screen-room');
  $('sb-room-code').textContent = roomCode;
  $('sb-lecture-name').textContent = lectureName;

  // 조교 모드 표시
  const badge = $('sb-role-badge');
  if (badge) badge.classList.toggle('hidden', myRole !== 'assistant');

  // 정원 안내
  const capHint = $('capacity-hint');
  if (capHint && data.capacity) capHint.textContent = `/ ${data.capacity}`;

  surveys = data.surveys || [];
  resources = data.resources || [];

  chatFeed.innerHTML = '';
  renderedMessages.clear();
  (data.messages || []).forEach(m => renderMsg(chatFeed, m, true));
  chatFeed.scrollTop = chatFeed.scrollHeight;

  renderStudentList(data.students || []);
  renderStaffList(data.assistants || []);
  renderSurveys();
  renderResources();

  // 화이트보드 초기화 + 누적 내용 재생
  if (!wbStarted) {
    Whiteboard.init({ socket, canClear: true, isReady: () => connection.isReady(), uploadHeaders: () => connection.uploadHeaders() });
    wbStarted = true;
  }
  Whiteboard.load(data.whiteboard || []);

  updateExpiryDisplay();
  if (expiryIntervalId) clearInterval(expiryIntervalId);
  expiryIntervalId = setInterval(updateExpiryDisplay, 60000);

});

// ── Socket: staff (조교) list ───────────────────────────────────────────────
socket.on('staff:list', staff => renderStaffList(staff));

function renderStaffList(staff) {
  const section = $('staff-section');
  const list = $('staff-list');
  const count = $('staff-count');
  if (!section || !list) return;
  if (!staff || staff.length === 0) {
    section.style.display = 'none';
    list.innerHTML = '';
    if (count) count.textContent = '0';
    return;
  }
  section.style.display = '';
  if (count) count.textContent = staff.length;
  list.innerHTML = staff.map(s => `
    <div class="student-item">
      <span class="student-emoji">🧑‍🏫</span>
      <span class="student-name">${esc(s.name)}</span>
    </div>
  `).join('');
}

// ── Socket: messages ───────────────────────────────────────────────────────
socket.on('message:new', msg => renderMsg(chatFeed, msg));

// ── Socket: student list ───────────────────────────────────────────────────
socket.on('student:list', students => renderStudentList(students));

function renderStudentList(students) {
  const list = $('student-list');
  const count = $('student-count');
  count.textContent = students.length;
  if (students.length === 0) {
    list.innerHTML = '<div class="text-sm text-gray" style="padding:6px 20px">아직 학생이 없습니다</div>';
    return;
  }
  list.innerHTML = students.map(s => `
    <div class="student-item">
      <span class="student-emoji">${esc(s.emoji)}</span>
      <span class="student-name">${esc(s.name)}</span>
    </div>
  `).join('');
}

// ── Survey tools ───────────────────────────────────────────────────────────
$('understanding-btn').addEventListener('click', () => {
  if (confirm('이해도 조사를 시작하시겠습니까?')) {
    if (!connection.emit('survey:understanding')) return;
    switchTab('surveys');
  }
});

$('custom-survey-btn').addEventListener('click', () => {
  $('custom-survey-modal').style.display = 'flex';
});

$('cancel-survey-btn').addEventListener('click', () => {
  $('custom-survey-modal').style.display = 'none';
});

$('add-option-btn').addEventListener('click', () => {
  const container = $('option-inputs');
  const count = container.children.length + 1;
  if (count > 10) { showToast('선택지는 최대 10개입니다.'); return; }
  const row = document.createElement('div');
  row.className = 'option-input-row';
  row.innerHTML = `<input type="text" placeholder="선택지 ${count}">
    <button class="remove-option-btn" onclick="removeOption(this)">✕</button>`;
  container.appendChild(row);
});

window.removeOption = function(btn) {
  const container = $('option-inputs');
  if (container.children.length <= 2) { showToast('최소 2개의 선택지가 필요합니다'); return; }
  btn.parentElement.remove();
};

$('create-survey-btn').addEventListener('click', () => {
  const question = $('survey-question').value.trim();
  const inputs = $('option-inputs').querySelectorAll('input');
  const options = Array.from(inputs).map(i => i.value.trim()).filter(Boolean);
  if (!question) { showToast('질문을 입력하세요'); return; }
  if (options.length < 2) { showToast('선택지를 2개 이상 입력하세요'); return; }
  if (!connection.emit('survey:create', { question, options })) return;
  $('custom-survey-modal').style.display = 'none';
  $('survey-question').value = '';
  $('option-inputs').querySelectorAll('input').forEach(i => { i.value = ''; });
  switchTab('surveys');
});

// ── Socket: survey events ──────────────────────────────────────────────────
socket.on('survey:started', survey => {
  if (surveys.some(item => item.id === survey.id)) return;
  surveys.forEach(item => { item.closed = true; });
  surveys.push(survey);
  if (surveys.length > 100) surveys.shift();
  renderSurveys();
  switchTab('surveys');
});

socket.on('survey:update', ({ surveyId, results, total }) => {
  const s = surveys.find(s => s.id === surveyId);
  if (s) { s.results = results; s.total = total; }
  renderSurveys();
});

socket.on('survey:closed', ({ surveyId }) => {
  const s = surveys.find(s => s.id === surveyId);
  if (s) s.closed = true;
  renderSurveys();
});

// ── Render surveys ─────────────────────────────────────────────────────────
let surveyRenderFrame = null;
function renderSurveys() {
  if (surveyRenderFrame !== null) return;
  surveyRenderFrame = requestAnimationFrame(() => {
    surveyRenderFrame = null;
    renderSurveysNow();
  });
}

function renderSurveysNow() {
  const feed = $('surveys-feed');
  if (surveys.length === 0) {
    feed.innerHTML = `<div class="empty-state"><div class="empty-icon">📊</div><p>설문이 없습니다<br>사이드바에서 설문을 시작하세요</p></div>`;
    return;
  }
  feed.innerHTML = '';
  [...surveys].reverse().forEach(survey => {
    const card = document.createElement('div');
    card.className = 'survey-card';
    const total = survey.total || 0;
    const barsHtml = survey.options.map((opt, i) => {
      const count = survey.results[i] || 0;
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      return `<div class="survey-bar-row">
        <div class="survey-bar-label">
          <span class="bar-option">${esc(opt)}</span>
          <span class="bar-count">${count}명 (${pct}%)</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      </div>`;
    }).join('');

    const actionsHtml = `
      <div class="survey-actions">
        ${!survey.closed ? `<button class="btn btn-sm btn-danger" onclick="closeSurvey('${survey.id}')">마감</button>` : ''}
        <button class="btn btn-sm btn-secondary" onclick="shareResults('${survey.id}')">결과공유</button>
      </div>`;

    card.innerHTML = `
      <div class="survey-card-header">
        <div class="survey-question">${esc(survey.question)}</div>
        <span class="survey-status ${survey.closed ? 'status-closed' : 'status-active'}">${survey.closed ? '마감' : '진행중'}</span>
      </div>
      <div class="survey-meta">응답자수: ${total}명</div>
      ${barsHtml}
      ${actionsHtml}`;
    feed.appendChild(card);
  });
}

window.closeSurvey = function(surveyId) {
  connection.emit('survey:close', { surveyId });
};

window.shareResults = function(surveyId) {
  if (!connection.emit('survey:shareResults', { surveyId })) return;
  showToast('결과를 학생들과 공유했습니다');
};

// ── Resources ──────────────────────────────────────────────────────────────
$('resource-url-btn').addEventListener('click', shareUrl);
$('resource-url-input').addEventListener('keydown', e => { if (e.key === 'Enter') shareUrl(); });

function shareUrl() {
  const url = $('resource-url-input').value.trim();
  if (!url) { showToast('URL을 입력하세요'); return; }
  if (!/^https?:\/\//i.test(url)) { showToast('http:// 또는 https://로 시작하는 URL을 입력하세요'); return; }
  if (!connection.emit('resource:share', { type: 'url', url, title: url })) return;
  $('resource-url-input').value = '';
  showToast('자료가 공유되었습니다');
}

$('resource-file-btn').addEventListener('click', () => $('resource-file-input').click());
$('resource-file-input').addEventListener('change', async function() {
  const file = this.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { showToast('파일은 20MB까지 업로드할 수 있습니다.'); this.value = ''; return; }
  $('resource-file-btn').textContent = '업로드 중...';
  $('resource-file-btn').disabled = true;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const data = await eduRequestJson('/api/upload', { method: 'POST', headers: connection.uploadHeaders(), body: fd }, 60000);
    if (data.url) {
      if (!connection.emit('resource:share', { type: 'pdf', url: data.url, filename: data.filename, title: data.filename })) return;
      showToast('PDF가 공유되었습니다');
    }
  } catch(e) {
    showToast(e.message || '파일 업로드 실패');
  } finally {
    $('resource-file-btn').textContent = '📄 PDF 파일 선택';
    $('resource-file-btn').disabled = false;
    this.value = '';
  }
});

socket.on('resource:shared', resource => {
  if (resources.some(item => item.id === resource.id)) return;
  resources.push(resource);
  if (resources.length > 100) resources.shift();
  renderResources();
  switchTab('resources');
});

function renderResources() {
  const section = $('resource-list-section');
  const itemsEl = $('resource-items');
  if (resources.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  // 강사 자료 목록: 항목 전체를 새 창 링크로 만들어 클릭 시 바로 열리게 함
  itemsEl.innerHTML = [...resources].reverse().map(r => `
    <a class="resource-item" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">
      <div class="resource-icon">${r.type === 'pdf' ? '📄' : '🌐'}</div>
      <div class="resource-info">
        <div class="resource-title">${esc(r.title || r.url)}</div>
        <div class="resource-url">${esc(r.url)}</div>
      </div>
      <div class="resource-time">${timeStr(r.timestamp)}</div>
    </a>
  `).join('');
}

// ── AI Chat ────────────────────────────────────────────────────────────────
const aiHistory = [];
let aiSending = false;

$('ai-send-btn').addEventListener('click', sendAiMessage);
$('ai-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendAiMessage(); }
});

function appendAiMsg(role, text) {
  const feed = $('ai-feed');
  const div = document.createElement('div');
  div.className = `ai-msg ${role}`;

  if (role === 'loading') {
    div.className = 'ai-msg loading';
    div.innerHTML = `<div class="ai-bubble"><div class="ai-loading-dots"><span></span><span></span><span></span></div></div>`;
  } else if (role === 'user') {
    div.innerHTML = `<div class="ai-msg-role">나</div><div class="ai-bubble">${esc(text)}</div>`;
  } else if (role === 'assistant') {
    const body = window.renderMarkdown ? window.renderMarkdown(text) : esc(text);
    div.innerHTML = `<div class="ai-msg-role">AI</div><div class="ai-bubble md-body">${body}</div>`;
  } else if (role === 'error') {
    div.innerHTML = `<div class="ai-bubble">⚠ ${esc(text)}</div>`;
  }

  feed.appendChild(div);
  while (feed.children.length > 80) feed.firstElementChild.remove();
  feed.scrollTop = feed.scrollHeight;
  return div;
}

async function sendAiMessage() {
  if (aiSending) return;
  const apiKey = $('ai-api-key').value.trim();
  const model = $('ai-model').value;
  const text = $('ai-input').value.trim();
  if (!apiKey) { showToast('API 키를 입력하세요'); return; }
  if (!text) return;
  if (text.length > 12000) { showToast('질문은 12,000자까지 입력할 수 있습니다.'); return; }
  if (!connection.isReady()) { showToast('강의실 연결 복구 후 다시 시도하세요.'); return; }
  aiSending = true;
  $('ai-input').value = '';
  appendAiMsg('user', text);
  const requestHistory = [...aiHistory, { role: 'user', content: text }];
  while (requestHistory.length > 39 || requestHistory.reduce((sum, item) => sum + item.content.length, 0) > 50000) requestHistory.splice(0, 2);
  $('ai-send-btn').disabled = true;
  const loadingEl = appendAiMsg('loading', '');
  try {
    const data = await eduRequestJson('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...connection.uploadHeaders() },
      body: JSON.stringify({ messages: requestHistory, model, apiKey })
    }, 65000);
    if (typeof data.content !== 'string') throw new Error('AI 응답을 확인할 수 없습니다. 다시 시도하세요.');
    aiHistory.splice(0, aiHistory.length, ...requestHistory, { role: 'assistant', content: data.content });
    appendAiMsg('assistant', data.content);
  } catch (error) {
    appendAiMsg('error', error.message);
    if (!$('ai-input').value) $('ai-input').value = text;
  } finally {
    loadingEl.remove();
    aiSending = false;
    $('ai-send-btn').disabled = false;
  }
}

// ── App error ──────────────────────────────────────────────────────────────
socket.on('app:error', error => {
  const { message, code } = error;
  if (error.event === 'instructor:join') { connection.failJoin(error); return; }
  // 인증 만료/미승인 — 로그인 화면으로
  if (code === 'AUTH') {
    connection.stop();
    showScreen('screen-auth');
    showAuthState('login');
    showError('auth-error', message);
    return;
  }
  // 입장 전(설정 화면) 단계의 오류는 설정 화면에 표시하고 머무름
  if (!$('screen-setup').classList.contains('hidden')) {
    showError('setup-error', message);
  } else {
    showToast('오류: ' + message);
  }
});
