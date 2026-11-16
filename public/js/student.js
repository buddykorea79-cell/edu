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
const socket = io({ reconnectionDelay: 1000, reconnectionDelayMax: 10000, timeout: 20000 });
let mySocketId = '';
const connection = new EduTalkConnection(socket, {
  joinEvent: 'student:join',
  onNotice: showToast,
  onError: error => {
    if (['NOT_FOUND', 'ROOM_NOT_FOUND', 'ROOM_CLOSED', 'FULL', 'REPLACED'].includes(error.code)) {
      showScreen('screen-join');
      $('results-modal').style.display = 'none';
      if ($('room-share-dialog').open) $('room-share-dialog').close();
      window.EduTalkClassroomLayout?.closeParticipants();
      $('sidebar').classList.remove('open');
      sidebarOverlay.classList.remove('visible');
      $('mobile-menu-btn').setAttribute('aria-expanded', 'false');
      window.EduTalkEmojiPicker?.close();
      clearInterval(expiryIntervalId);
    }
    showJoinError(error.message || error.error);
    showToast(error.message || error.error);
  }
});
window.EduTalkSession = connection;
socket.on('connect', () => { mySocketId = socket.id; });

// ── State ──────────────────────────────────────────────────────────────────
let myName = '';
let myEmoji = selectedEmoji;
let roomCode = '';
let activeSurvey = null;
let myResponses = {};
let sharedResources = [];
let expiryIntervalId = null;
let wbStarted = false;

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

// URL ?code=123456 로 접근 시 방 코드 자동 입력 + 방 정보 미리 조회
(function prefillFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (code && /^\d{6}$/.test(code)) {
    $('join-room-code').value = code;
    $('join-link-info').classList.remove('hidden');
    fetchRoomInfo(code);
    $('join-name').focus();
  }
})();

// 방 코드 입력이 끝나면 방 정보(강의명/정원) 조회
$('join-room-code').addEventListener('change', () => {
  $('join-link-info').classList.add('hidden');
  const code = $('join-room-code').value.trim();
  if (/^\d{6}$/.test(code)) fetchRoomInfo(code);
});

async function fetchRoomInfo(code) {
  const infoEl = $('join-room-info');
  try {
    const data = await eduRequestJson(`/api/room/${code}`, {}, 15000);
    if ($('join-room-code').value.trim() !== code) return;
    if (!data.exists) {
      infoEl.style.display = 'block';
      infoEl.style.color = 'var(--color-error)';
      infoEl.textContent = '존재하지 않는 방입니다.';
      return;
    }
    infoEl.style.display = 'block';
    infoEl.style.color = 'var(--color-text-tertiary)';
    const fullTxt = data.full ? ' · 정원 마감' : ` · ${data.count}/${data.capacity}명`;
    infoEl.textContent = `📚 ${data.lectureName}${fullTxt}`;
  } catch (e) {
    infoEl.style.display = 'none';
  }
}

function doJoin() {
  const name = $('join-name').value.trim();
  const code = $('join-room-code').value.trim();
  if (!name) { showJoinError('닉네임을 입력하세요.'); return; }
  if (!/^\d{6}$/.test(code)) { showJoinError('6자리 숫자 방 코드를 입력하세요.'); return; }

  myName = name;
  myEmoji = selectedEmoji;
  roomCode = code;

  connection.join({ roomCode, name: myName, emoji: myEmoji });
}

function showJoinError(msg) {
  const el = $('join-error');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// Keep the invitation outside tab panes so late arrivals can always find it.
function updateRoomInvite(code) {
  $('persistent-room-code').textContent = code;
  const image = $('persistent-room-qr');
  image.alt = `${code}번 강의실 참여 QR 코드`;
  if (image.dataset.roomCode !== code || image.classList.contains('hidden')) {
    image.dataset.roomCode = code;
    image.src = `/api/room/${code}/qr.svg`;
  }
}
$('persistent-room-qr').addEventListener('load', () => {
  $('persistent-room-qr').classList.remove('hidden');
  $('persistent-qr-error').hidden = true;
});
$('persistent-room-qr').addEventListener('error', () => {
  $('persistent-room-qr').classList.add('hidden');
  $('persistent-qr-error').hidden = false;
});

// ── Enlarge the left-hand room invitation ─────────────────────────────────
function showShareDialog() {
  if (!roomCode) return;
  $('room-share-code').textContent = roomCode;
  $('room-share-name').textContent = $('room-lecture-name').textContent;
  $('room-share-link').value = `${window.location.origin}/student.html?code=${roomCode}`;
  $('qr-error').classList.add('hidden');
  $('room-qr-image').classList.remove('hidden');
  $('room-qr-image').src = `/api/room/${roomCode}/qr.svg`;
  if (!$('room-share-dialog').open) $('room-share-dialog').showModal();
}
$('persistent-qr-button').addEventListener('click', showShareDialog);
$('close-qr-btn').addEventListener('click', () => $('room-share-dialog').close());
$('copy-share-link-btn').addEventListener('click', async () => {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText($('room-share-link').value);
    showToast('참여 링크가 복사되었습니다!');
  } catch (_) {
    $('room-share-link').focus();
    $('room-share-link').select();
    showToast('참여 링크를 길게 누르거나 Ctrl+C로 복사하세요.', 5000);
  }
});
$('room-qr-image').addEventListener('error', () => {
  $('room-qr-image').classList.add('hidden');
  $('qr-error').classList.remove('hidden');
});
$('room-share-dialog').addEventListener('click', event => {
  if (event.target !== $('room-share-dialog')) return;
  const bounds = event.target.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.target.close();
});

// ── Socket: student joined ─────────────────────────────────────────────────
socket.on('student:joined', data => {
  connection.acceptSnapshot(data);
  roomCode = data.roomCode;
  updateRoomInvite(roomCode);
  $('room-lecture-name').textContent = data.lectureName;
  $('room-lecture-name').title = data.lectureName;
  $('sb-my-emoji').textContent = myEmoji;
  $('sb-my-name').textContent = myName;

  showScreen('screen-room');

  const feed = $('chat-feed');
  feed.innerHTML = '';
  renderedMessages.clear();
  (data.messages || []).forEach(m => renderMsg(feed, m, true));
  feed.scrollTop = feed.scrollHeight;

  activeSurvey = data.activeSurvey || null;
  myResponses = data.myResponses || {};
  renderActiveSurvey();
  sharedResources = data.resources || [];
  renderStudentResources(false);

  renderStaffList(data.assistants || []);
  renderStudentList(data.students || []);

  // 화이트보드 초기화 + 누적 내용 재생 (학생도 협업 그리기 가능, 전체 지우기는 불가)
  if (!wbStarted) {
    Whiteboard.init({ socket, canClear: false, isReady: () => connection.isReady(), uploadHeaders: () => connection.uploadHeaders() });
    wbStarted = true;
  }
  Whiteboard.load(data.whiteboard || []);

  updateExpiryDisplay();
  if (expiryIntervalId) clearInterval(expiryIntervalId);
  expiryIntervalId = setInterval(updateExpiryDisplay, 60000);

});

// ── Socket: staff (방장·조교) list ───────────────────────────────────────────
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
      <span class="student-name">${esc(s.name)} <span class="text-xs text-gray">조교</span></span>
    </div>
  `).join('');
}

function updateExpiryDisplay() {
  const el = $('room-expire-info');
  if (!el) return;
  el.textContent = '참여 중인 강의실은 계속 유지됩니다.';
}

socket.on('app:error', error => {
  if (error.event === 'student:join') {
    connection.failJoin(error);
  } else {
    showJoinError(error.message);
    showToast(error.message);
  }
});

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

function setSidebarOpen(open) {
  $('sidebar').classList.toggle('open', open);
  sidebarOverlay.classList.toggle('visible', open);
  $('mobile-menu-btn').setAttribute('aria-expanded', String(open));
}
$('mobile-menu-btn').addEventListener('click', () => setSidebarOpen(!$('sidebar').classList.contains('open')));
sidebarOverlay.addEventListener('click', () => setSidebarOpen(false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('sidebar').classList.contains('open')) {
    setSidebarOpen(false);
    $('mobile-menu-btn').focus();
  }
});

// ── Exit ───────────────────────────────────────────────────────────────────
$('exit-btn').addEventListener('click', () => {
  if (confirm('강의실을 나가시겠습니까?')) {
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

socket.on('message:new', msg => renderMsg(chatFeed, msg));

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

// ── Student list ───────────────────────────────────────────────────────────
socket.on('student:list', renderStudentList);
function renderStudentList(students) {
  const list = $('student-list');
  const count = $('student-count');
  count.textContent = students.length;
  $('chat-participant-count').textContent = students.length;
  list.innerHTML = students.map(s => `
    <div class="student-item">
      <span class="student-emoji">${esc(s.emoji)}</span>
      <span class="student-name">${esc(s.name)}</span>
    </div>
  `).join('');
}

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
  connection.emit('survey:respond', { surveyId: activeSurvey.id, optionIndex });
};

// ── Survey results modal ───────────────────────────────────────────────────
function showResultsModal(data) {
  window.EduTalkClassroomLayout?.closeParticipants();
  window.EduTalkEmojiPicker?.close();
  if ($('room-share-dialog').open) $('room-share-dialog').close();
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
  $('results-close-btn').focus();
}

$('results-close-btn').addEventListener('click', () => {
  $('results-modal').style.display = 'none';
});

// ── Resources ──────────────────────────────────────────────────────────────
socket.on('resource:shared', resource => {
  if (sharedResources.some(item => item.id === resource.id)) return;
  sharedResources.push(resource);
  if (sharedResources.length > 100) sharedResources.shift();
  renderStudentResources(true);
  showToast('📚 새 교육자료가 공유되었습니다!');
  switchTab('resources');
});

function renderStudentResources(isNew) {
  const pane = $('student-resources-pane');
  const emptyEl = $('resources-empty');

  if (sharedResources.length === 0) {
    pane.querySelectorAll('.resource-view-card').forEach(el => el.remove());
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';

  // Only re-render last item if isNew, otherwise full render
  if (isNew) {
    const r = sharedResources[sharedResources.length - 1];
    const card = createResourceCard(r, true);
    emptyEl.insertAdjacentElement('afterend', card);
    const cards = pane.querySelectorAll('.resource-view-card');
    if (cards.length > 100) cards[cards.length - 1].remove();
  } else {
    // Full render: remove old cards, then insert each in array order so newest (last) ends up at top
    pane.querySelectorAll('.resource-view-card').forEach(el => el.remove());
    sharedResources.forEach(r => {
      emptyEl.insertAdjacentElement('afterend', createResourceCard(r, false));
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
    // 일부 사이트(구글/유튜브 등)는 X-Frame-Options/CSP로 임베드를 차단하므로
    // 미리보기가 비어 보일 수 있다는 안내와 새 탭 열기 버튼을 함께 제공
    bodyHtml = `<div class="resource-view-body">
      <iframe
        src="${safeUrl}"
        class="resource-iframe"
        sandbox="allow-scripts allow-forms allow-popups allow-presentation"
        loading="lazy"
        referrerpolicy="no-referrer"
      ></iframe>
      <div class="resource-iframe-note">
        <span class="text-xs text-gray">미리보기가 비어 있나요? 일부 사이트는 보안 정책상 임베드를 차단합니다.</span>
        <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-secondary" style="width:auto">🔗 새 탭에서 열기</a>
      </div>
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
  connection.stop();
  alert(reason || '강의방이 만료되었습니다. 처음 화면으로 돌아갑니다.');
  socket.disconnect();
  window.location.href = '/';
});
