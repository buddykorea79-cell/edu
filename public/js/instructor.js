'use strict';

// ── Helpers ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => (!s ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'));
const timeStr = ts => {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
};

function showToast(msg, duration = 2500) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

// ── Socket ─────────────────────────────────────────────────────────────────
const socket = io();
let mySocketId = '';
socket.on('connect', () => {
  mySocketId = socket.id;
  const dot = $('conn-dot');
  if (dot) { dot.classList.add('connected'); }
});
socket.on('disconnect', () => {
  const dot = $('conn-dot');
  if (dot) { dot.classList.remove('connected'); }
});

// ── State ──────────────────────────────────────────────────────────────────
let roomCode = '';
let lectureName = '';
let surveys = [];
let resources = [];

// ── Screen management ──────────────────────────────────────────────────────
function showScreen(id) {
  ['screen-auth','screen-setup','screen-room'].forEach(s => {
    const el = $(s);
    if (el) el.classList.toggle('hidden', s !== id);
  });
}

// ── Auth ───────────────────────────────────────────────────────────────────
$('auth-password').addEventListener('keydown', e => { if (e.key === 'Enter') doAuth(); });
$('auth-btn').addEventListener('click', doAuth);

async function doAuth() {
  const pw = $('auth-password').value.trim();
  if (!pw) return;
  $('auth-btn').disabled = true;
  $('auth-btn').textContent = '확인 중...';
  try {
    const res = await fetch('/api/instructor/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    const data = await res.json();
    if (data.ok) {
      showScreen('screen-setup');
    } else {
      showError('auth-error', data.error || '비밀번호가 틀렸습니다.');
    }
  } catch(e) {
    showError('auth-error', '서버 오류가 발생했습니다.');
  }
  $('auth-btn').disabled = false;
  $('auth-btn').textContent = '로그인';
}

function showError(id, msg) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ── Setup ──────────────────────────────────────────────────────────────────
$('gen-code-btn').addEventListener('click', () => {
  $('setup-room-code').value = Math.floor(100000 + Math.random() * 900000).toString();
});

$('setup-btn').addEventListener('click', doSetup);
$('setup-lecture').addEventListener('keydown', e => { if (e.key === 'Enter') doSetup(); });
$('setup-room-code').addEventListener('keydown', e => { if (e.key === 'Enter') doSetup(); });

function doSetup() {
  const name = $('setup-lecture').value.trim();
  const code = $('setup-room-code').value.trim();
  if (!name) { showError('setup-error', '강의 이름을 입력하세요.'); return; }
  if (!/^\d{6}$/.test(code)) { showError('setup-error', '6자리 숫자 방 코드를 입력하세요.'); return; }
  lectureName = name;
  roomCode = code;
  enterRoom();
}

function enterRoom() {
  showScreen('screen-room');
  $('sb-room-code').textContent = roomCode;
  $('sb-lecture-name').textContent = lectureName;
  socket.emit('instructor:join', { roomCode, lectureName });
}

// ── Tab switching ──────────────────────────────────────────────────────────
document.querySelectorAll('[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(name) {
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
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

// ── Exit ───────────────────────────────────────────────────────────────────
$('exit-btn').addEventListener('click', () => {
  if (confirm('강의를 종료하시겠습니까?')) {
    socket.disconnect();
    window.location.href = '/';
  }
});

// ── Chat ───────────────────────────────────────────────────────────────────
const chatFeed = $('chat-feed');

function renderMsg(container, msg) {
  const div = document.createElement('div');
  if (msg.type === 'system') {
    div.className = 'msg msg-system';
    div.innerHTML = `<span>${esc(msg.text)}</span>`;
  } else {
    const isMe = msg.socketId && msg.socketId === mySocketId;
    div.className = `msg ${isMe ? 'msg-me' : 'msg-other'}`;
    if (msg.type === 'file') {
      div.innerHTML = `${!isMe ? `<div class="msg-sender">${esc((msg.senderEmoji||'') + ' ' + (msg.senderName||''))}</div>` : ''}
        <div class="msg-bubble"><a href="${esc(msg.url)}" target="_blank" class="file-link">📎 ${esc(msg.filename)}</a></div>
        <div class="msg-time">${timeStr(msg.timestamp)}</div>`;
    } else {
      div.innerHTML = `${!isMe ? `<div class="msg-sender">${esc((msg.senderEmoji||'') + ' ' + (msg.senderName||''))}</div>` : ''}
        <div class="msg-bubble">${esc(msg.text)}</div>
        <div class="msg-time">${timeStr(msg.timestamp)}</div>`;
    }
  }
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

$('chat-send-btn').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });

function sendChat() {
  const text = $('chat-input').value.trim();
  if (!text) return;
  socket.emit('message:send', { text });
  $('chat-input').value = '';
}

$('file-upload-btn').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async function() {
  const file = this.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.url) {
      socket.emit('message:file', { url: data.url, filename: data.filename });
    }
  } catch(e) {
    showToast('파일 업로드 실패');
  }
  this.value = '';
});

// ── Room expiry display ────────────────────────────────────────────────────
function updateExpiryDisplay() {
  const el = $('room-expire-info');
  if (!el) return;
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const diff = midnight - now;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  el.textContent = `방 유지: 오늘 자정까지 (${h}시간 ${m}분 남음)`;
}

// ── Room expired ───────────────────────────────────────────────────────────
socket.on('room:expired', ({ reason }) => {
  alert(reason || '강의방이 만료되었습니다. 처음 화면으로 돌아갑니다.');
  socket.disconnect();
  window.location.href = '/';
});

// ── Socket: instructor joined ──────────────────────────────────────────────
socket.on('instructor:joined', data => {
  surveys = data.surveys || [];
  resources = data.resources || [];

  chatFeed.innerHTML = '';
  (data.messages || []).forEach(m => renderMsg(chatFeed, m));

  renderStudentList(data.students || []);
  renderSurveys();
  renderResources();

  updateExpiryDisplay();
  setInterval(updateExpiryDisplay, 60000);
});

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
    socket.emit('survey:understanding');
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
  socket.emit('survey:create', { question, options });
  $('custom-survey-modal').style.display = 'none';
  $('survey-question').value = '';
  $('option-inputs').querySelectorAll('input').forEach(i => { i.value = ''; });
  switchTab('surveys');
});

// ── Socket: survey events ──────────────────────────────────────────────────
socket.on('survey:started', survey => {
  surveys.push(survey);
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
function renderSurveys() {
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
  socket.emit('survey:close', { surveyId });
};

window.shareResults = function(surveyId) {
  socket.emit('survey:shareResults', { surveyId });
  showToast('결과를 학생들과 공유했습니다');
};

// ── Resources ──────────────────────────────────────────────────────────────
$('resource-url-btn').addEventListener('click', shareUrl);
$('resource-url-input').addEventListener('keydown', e => { if (e.key === 'Enter') shareUrl(); });

function shareUrl() {
  const url = $('resource-url-input').value.trim();
  if (!url) { showToast('URL을 입력하세요'); return; }
  if (!/^https?:\/\//i.test(url)) { showToast('http:// 또는 https://로 시작하는 URL을 입력하세요'); return; }
  socket.emit('resource:share', { type: 'url', url, title: url });
  $('resource-url-input').value = '';
  showToast('자료가 공유되었습니다');
}

$('resource-file-btn').addEventListener('click', () => $('resource-file-input').click());
$('resource-file-input').addEventListener('change', async function() {
  const file = this.files[0];
  if (!file) return;
  $('resource-file-btn').textContent = '업로드 중...';
  $('resource-file-btn').disabled = true;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.url) {
      socket.emit('resource:share', { type: 'pdf', url: data.url, filename: data.filename, title: data.filename });
      showToast('PDF가 공유되었습니다');
    }
  } catch(e) {
    showToast('파일 업로드 실패');
  }
  $('resource-file-btn').textContent = '📄 PDF 파일 선택';
  $('resource-file-btn').disabled = false;
  this.value = '';
});

socket.on('resource:shared', resource => {
  resources.push(resource);
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
  itemsEl.innerHTML = [...resources].reverse().map(r => `
    <div class="resource-item">
      <div class="resource-icon">${r.type === 'pdf' ? '📄' : '🌐'}</div>
      <div class="resource-info">
        <div class="resource-title">${esc(r.title || r.url)}</div>
        <div class="resource-url">${esc(r.url)}</div>
      </div>
      <div class="resource-time">${timeStr(r.timestamp)}</div>
    </div>
  `).join('');
}

// ── AI Chat ────────────────────────────────────────────────────────────────
const aiHistory = [];

$('ai-send-btn').addEventListener('click', sendAiMessage);
$('ai-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAiMessage(); }
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
    div.innerHTML = `<div class="ai-msg-role">AI</div><div class="ai-bubble">${esc(text)}</div>`;
  } else if (role === 'error') {
    div.innerHTML = `<div class="ai-bubble">⚠ ${esc(text)}</div>`;
  }

  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
  return div;
}

async function sendAiMessage() {
  const apiKey = $('ai-api-key').value.trim();
  const model = $('ai-model').value;
  const text = $('ai-input').value.trim();
  if (!apiKey) { showToast('API 키를 입력하세요'); return; }
  if (!text) return;
  $('ai-input').value = '';
  appendAiMsg('user', text);
  aiHistory.push({ role: 'user', content: text });
  $('ai-send-btn').disabled = true;
  const loadingEl = appendAiMsg('loading', '');
  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: aiHistory, model, apiKey })
    });
    const data = await res.json();
    loadingEl.remove();
    if (!res.ok) {
      appendAiMsg('error', data.error || '오류 발생');
    } else {
      aiHistory.push({ role: 'assistant', content: data.content });
      appendAiMsg('assistant', data.content);
    }
  } catch(e) {
    loadingEl.remove();
    appendAiMsg('error', e.message);
  }
  $('ai-send-btn').disabled = false;
}

// ── App error ──────────────────────────────────────────────────────────────
socket.on('app:error', ({ message }) => {
  showToast('오류: ' + message);
});
