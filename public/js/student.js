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

// ── Emojis ─────────────────────────────────────────────────────────────────
const EMOJIS = ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐸','🐙','🦋'];
let selectedEmoji = EMOJIS[0];

const emojiGrid = $('emoji-grid');
EMOJIS.forEach((emoji, i) => {
  const btn = document.createElement('button');
  btn.className = 'emoji-btn' + (i === 0 ? ' selected' : '');
  btn.textContent = emoji;
  btn.addEventListener('click', () => {
    document.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedEmoji = emoji;
  });
  emojiGrid.appendChild(btn);
});

// ── Socket ─────────────────────────────────────────────────────────────────
const socket = io();
let mySocketId = '';
socket.on('connect', () => {
  mySocketId = socket.id;
  const dot = $('conn-dot');
  if (dot) dot.classList.add('connected');
});
socket.on('disconnect', () => {
  const dot = $('conn-dot');
  if (dot) dot.classList.remove('connected');
});

// ── State ──────────────────────────────────────────────────────────────────
let myName = '';
let myEmoji = selectedEmoji;
let roomCode = '';
let activeSurvey = null;
let myResponses = {};
let sharedResources = [];

// ── Screen management ──────────────────────────────────────────────────────
function showScreen(id) {
  ['screen-join','screen-room'].forEach(s => {
    const el = $(s);
    if (el) el.classList.toggle('hidden', s !== id);
  });
}

// ── Join ───────────────────────────────────────────────────────────────────
$('join-btn').addEventListener('click', doJoin);
$('join-name').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
$('join-room-code').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  const name = $('join-name').value.trim();
  const code = $('join-room-code').value.trim();
  if (!name) { showJoinError('닉네임을 입력하세요.'); return; }
  if (!/^\d{6}$/.test(code)) { showJoinError('6자리 숫자 방 코드를 입력하세요.'); return; }

  myName = name;
  myEmoji = selectedEmoji;
  roomCode = code;

  socket.emit('student:join', { roomCode, name: myName, emoji: myEmoji });
}

function showJoinError(msg) {
  const el = $('join-error');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ── Socket: student joined ─────────────────────────────────────────────────
socket.on('student:joined', data => {
  roomCode = data.roomCode;
  $('sb-room-code').textContent = roomCode;
  $('sb-lecture-name').textContent = data.lectureName;
  $('sb-my-emoji').textContent = myEmoji;
  $('sb-my-name').textContent = myName;

  showScreen('screen-room');

  const feed = $('chat-feed');
  feed.innerHTML = '';
  (data.messages || []).forEach(m => renderMsg(feed, m));

  if (data.activeSurvey) {
    activeSurvey = data.activeSurvey;
    renderActiveSurvey();
  }

  if (data.resources && data.resources.length > 0) {
    sharedResources = data.resources;
    renderStudentResources(false);
  }

  updateExpiryDisplay();
  setInterval(updateExpiryDisplay, 60000);
});

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

socket.on('app:error', ({ message }) => {
  showJoinError(message);
});

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

// ── Exit ───────────────────────────────────────────────────────────────────
$('exit-btn').addEventListener('click', () => {
  if (confirm('강의실을 나가시겠습니까?')) {
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

socket.on('message:new', msg => renderMsg(chatFeed, msg));

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

// ── Student list ───────────────────────────────────────────────────────────
socket.on('student:list', students => {
  const list = $('student-list');
  const count = $('student-count');
  count.textContent = students.length;
  list.innerHTML = students.map(s => `
    <div class="student-item">
      <span class="student-emoji">${esc(s.emoji)}</span>
      <span class="student-name">${esc(s.name)}</span>
    </div>
  `).join('');
});

// ── Survey events ──────────────────────────────────────────────────────────
socket.on('survey:started', survey => {
  activeSurvey = survey;
  renderActiveSurvey();
  switchTab('survey');
  showToast('새 설문이 시작되었습니다!');
});

socket.on('survey:closed', ({ surveyId }) => {
  if (activeSurvey && activeSurvey.id === surveyId) {
    activeSurvey.closed = true;
    renderActiveSurvey();
  }
});

socket.on('survey:myResponse', ({ surveyId, optionIndex }) => {
  myResponses[surveyId] = optionIndex;
  renderActiveSurvey();
});

socket.on('survey:resultsShared', data => {
  showResultsModal(data);
});

function renderActiveSurvey() {
  const emptyEl = $('survey-empty');
  const cardEl = $('active-survey-card');

  if (!activeSurvey) {
    emptyEl.style.display = '';
    cardEl.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  cardEl.style.display = '';

  const myResp = myResponses[activeSurvey.id];
  const hasResponded = myResp !== undefined;

  let optionsHtml;
  if (activeSurvey.closed) {
    optionsHtml = `<div class="survey-response-info">⏹ 설문이 마감되었습니다.</div>`;
  } else if (hasResponded) {
    optionsHtml = `
      <div class="survey-options">
        ${activeSurvey.options.map((opt, i) => `
          <button class="survey-option-btn ${i === myResp ? 'selected' : ''}"
            onclick="respondSurvey(${i})">${esc(opt)}</button>
        `).join('')}
      </div>
      <div class="survey-response-info">✅ 응답이 제출되었습니다. 다른 선택지를 클릭해 변경할 수 있습니다.</div>`;
  } else {
    optionsHtml = `
      <div class="survey-options">
        ${activeSurvey.options.map((opt, i) => `
          <button class="survey-option-btn" onclick="respondSurvey(${i})">${esc(opt)}</button>
        `).join('')}
      </div>`;
  }

  cardEl.innerHTML = `
    <div class="survey-card">
      <div class="survey-card-header">
        <div class="survey-question">${esc(activeSurvey.question)}</div>
        <span class="survey-status ${activeSurvey.closed ? 'status-closed' : 'status-active'}">
          ${activeSurvey.closed ? '마감' : '진행중'}
        </span>
      </div>
      ${optionsHtml}
    </div>`;
}

window.respondSurvey = function(optionIndex) {
  if (!activeSurvey || activeSurvey.closed) return;
  socket.emit('survey:respond', { surveyId: activeSurvey.id, optionIndex });
};

// ── Survey results modal ───────────────────────────────────────────────────
function showResultsModal(data) {
  $('results-question').textContent = data.question;
  const barsEl = $('results-bars');
  const total = data.total || 0;
  barsEl.innerHTML = data.options.map((opt, i) => {
    const count = data.results[i] || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return `<div class="results-bar-row survey-bar-row">
      <div class="survey-bar-label">
        <span class="bar-option">${esc(opt)}</span>
        <span class="bar-count">${count}명 (${pct}%)</span>
      </div>
      <div class="bar-track"><div class="bar-fill green" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
  $('results-modal').style.display = 'flex';
}

$('results-close-btn').addEventListener('click', () => {
  $('results-modal').style.display = 'none';
});

// ── Resources ──────────────────────────────────────────────────────────────
socket.on('resource:shared', resource => {
  sharedResources.push(resource);
  renderStudentResources(true);
  showToast('📚 새 교육자료가 공유되었습니다!');
  switchTab('resources');
});

function renderStudentResources(isNew) {
  const pane = $('student-resources-pane');
  const emptyEl = $('resources-empty');

  if (sharedResources.length === 0) {
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';

  // Only re-render last item if isNew, otherwise full render
  if (isNew) {
    const r = sharedResources[sharedResources.length - 1];
    const card = createResourceCard(r, true);
    pane.insertBefore(card, emptyEl.nextSibling);
  } else {
    // Full render: remove old cards
    pane.querySelectorAll('.resource-view-card').forEach(el => el.remove());
    [...sharedResources].reverse().forEach(r => {
      pane.insertBefore(createResourceCard(r, false), emptyEl.nextSibling);
    });
  }
}

function createResourceCard(r, badge) {
  const card = document.createElement('div');
  card.className = 'resource-view-card';

  const icon = r.type === 'pdf' ? '📄' : '🌐';
  const badgeHtml = badge ? '<span class="resource-new-badge">NEW</span>' : '';
  const safeUrl = esc(r.url);
  const safeName = esc(r.filename || r.title || (r.type === 'pdf' ? 'document.pdf' : r.url));

  let bodyHtml;
  if (r.type === 'pdf') {
    // embed/object 태그는 일부 브라우저에서 부모 페이지 이동을 유발하므로 사용하지 않음
    bodyHtml = `<div class="resource-view-body" style="padding:var(--space-6)">
      <p class="text-sm text-gray" style="margin:0 0 var(--space-4) 0">PDF 파일이 공유되었습니다. 아래 버튼으로 열거나 다운로드하세요.</p>
      <div class="resource-action-row">
        <a href="${safeUrl}" target="_blank" rel="noopener noreferrer"
           class="btn btn-primary" style="width:auto">
          📄 새 창에서 열기
        </a>
        <a href="${safeUrl}" download="${safeName}"
           class="btn btn-secondary" style="width:auto">
          ⬇ 다운로드
        </a>
      </div>
      <div class="text-xs text-gray" style="margin-top:var(--space-3)">${safeName}</div>
    </div>`;
  } else {
    // iframe: allow-same-origin 제외 → 상위 페이지 접근 차단
    // allow-top-navigation 미포함 → iframe이 부모 페이지 이동 불가
    bodyHtml = `<div class="resource-view-body">
      <iframe
        src="${safeUrl}"
        class="resource-iframe"
        sandbox="allow-scripts allow-forms allow-popups allow-presentation"
        loading="lazy"
        referrerpolicy="no-referrer"
      ></iframe>
    </div>`;
  }

  card.innerHTML = `
    <div class="resource-view-header">
      <span>${icon}</span>
      <div class="resource-view-title">${esc(r.title || r.url)}</div>
      ${badgeHtml}
      <a href="${safeUrl}" target="_blank" rel="noopener noreferrer"
         class="btn btn-sm btn-secondary" style="width:auto;flex-shrink:0">
        🔗 새 탭
      </a>
    </div>
    ${bodyHtml}`;
  return card;
}

// ── Room expired ───────────────────────────────────────────────────────────
socket.on('room:expired', ({ reason }) => {
  alert(reason || '강의방이 만료되었습니다. 처음 화면으로 돌아갑니다.');
  socket.disconnect();
  window.location.href = '/';
});

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
