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
  onError: error => {
    showScreen('screen-setup');
    if ($('room-share-dialog').open) $('room-share-dialog').close();
    $('custom-survey-modal').style.display = 'none';
    closeSidebar();
    $('mobile-menu-btn').setAttribute('aria-expanded', 'false');
    window.EduTalkEmojiPicker?.close();
    window.EduTalkClassroomLayout?.closeParticipants();
    clearInterval(expiryIntervalId);
    const message = error.message || error.error || '강의실에 연결하지 못했습니다.';
    showError('setup-error', message);
    showToast(message, 5000);
    prepareSetup();
  }
});
window.EduTalkSession = connection;
socket.on('connect', () => { mySocketId = socket.id; });

// ── State ──────────────────────────────────────────────────────────────────
let roomCode = '';
let lectureName = '';
let surveys = [];
let resources = [];
let expiryIntervalId = null;
let ownedRoom = null;
let setupBusy = false;
let wbStarted = false;

// ── Screen management ──────────────────────────────────────────────────────
function showScreen(id) {
  ['screen-setup','screen-room'].forEach(s => {
    const el = $(s);
    if (el) el.classList.toggle('hidden', s !== id);
  });
}

// ── Public room creation and browser ownership ────────────────────────────
function showError(id, msg) {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}

async function hostSession() {
  const data = await eduRequestJson('/api/host/session', {}, 15000);
  if (!data.ok || !data.token) throw new Error(data.error || '이 PC의 강의실 정보를 확인하지 못했습니다.');
  return data;
}

function showOwnedRoom(room) {
  ownedRoom = room || null;
  $('setup-lecture-group').classList.toggle('hidden', !!ownedRoom);
  $('owned-room-info').classList.toggle('hidden', !ownedRoom);
  $('owned-room-info').textContent = ownedRoom ? `${ownedRoom.lectureName} · 방 코드 ${ownedRoom.roomCode}` : '';
  $('setup-subtitle').textContent = ownedRoom ? '내 강의실로 돌아가기' : '강의실 만들기';
  $('setup-btn').textContent = ownedRoom ? '내 강의실로 돌아가기' : '강의실 열기';
}

async function prepareSetup() {
  if (setupBusy) return;
  setupBusy = true;
  $('setup-btn').disabled = true;
  $('setup-loading').classList.remove('hidden');
  try {
    const session = await hostSession();
    showOwnedRoom(session.room);
  } catch (error) {
    showError('setup-error', error.message);
  } finally {
    setupBusy = false;
    $('setup-loading').classList.add('hidden');
    $('setup-btn').disabled = false;
  }
}

$('setup-btn').addEventListener('click', doSetup);
$('setup-lecture').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) doSetup();
});

async function doSetup() {
  if (setupBusy || connection.joining) return;
  setupBusy = true;
  $('setup-btn').disabled = true;
  $('setup-error').style.display = 'none';
  try {
    // Another tab may already have created or deleted the browser's room.
    const session = await hostSession();
    showOwnedRoom(session.room);
    let target = session.room;
    if (!target) {
      const name = $('setup-lecture').value.trim();
      if (!name) { showError('setup-error', '강의 이름을 입력하세요.'); $('setup-lecture').focus(); return; }
      target = await eduRequestJson('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lectureName: name })
      }, 15000);
      if (!target.ok) throw new Error(target.error || '강의실을 만들지 못했습니다.');
    }
    roomCode = target.roomCode;
    lectureName = target.lectureName;
    showOwnedRoom({ roomCode, lectureName });
    const targetCode = roomCode;
    connection.join(async () => ({ roomCode: targetCode, token: (await hostSession()).token }));
  } catch (error) {
    showError('setup-error', error.message);
    // Recover an owned room even if creation succeeded but its response was lost.
    try { showOwnedRoom((await hostSession()).room); } catch (_) {}
  } finally {
    setupBusy = false;
    $('setup-btn').disabled = false;
  }
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

function closeSidebar() {
  $('sidebar').classList.remove('open');
  sidebarOverlay.classList.remove('visible');
  $('mobile-menu-btn').setAttribute('aria-expanded', 'false');
}

$('mobile-menu-btn').addEventListener('click', () => {
  const open = $('sidebar').classList.toggle('open');
  sidebarOverlay.classList.toggle('visible', open);
  $('mobile-menu-btn').setAttribute('aria-expanded', String(open));
});

sidebarOverlay.addEventListener('click', () => {
  $('sidebar').classList.remove('open');
  sidebarOverlay.classList.remove('visible');
  $('mobile-menu-btn').setAttribute('aria-expanded', 'false');
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('sidebar').classList.contains('open')) {
    closeSidebar();
    $('mobile-menu-btn').setAttribute('aria-expanded', 'false');
    $('mobile-menu-btn').focus();
  }
});

// ── Share code, link and QR ───────────────────────────────────────────────
function participationLink() {
  return `${window.location.origin}/student.html?code=${roomCode}`;
}

async function copyText(value, successMessage) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(value);
    showToast(successMessage);
  } catch (_) {
    showShareDialog();
    $('room-share-link').focus();
    $('room-share-link').select();
    showToast('아래 참여 링크를 길게 누르거나 Ctrl+C로 복사하세요.', 5000);
  }
}

$('copy-code-btn').addEventListener('click', () => copyText(roomCode, '방 코드가 복사되었습니다!'));
$('share-link-btn').addEventListener('click', () => copyText(participationLink(), '참여 링크가 복사되었습니다!'));
$('copy-share-link-btn').addEventListener('click', () => copyText(participationLink(), '참여 링크가 복사되었습니다!'));

function showShareDialog() {
  if (!roomCode) return;
  $('room-share-code').textContent = roomCode;
  $('room-share-name').textContent = lectureName;
  $('room-share-link').value = participationLink();
  $('qr-error').classList.add('hidden');
  $('room-qr-image').classList.remove('hidden');
  $('room-qr-image').src = `/api/room/${roomCode}/qr.svg`;
  if (!$('room-share-dialog').open) $('room-share-dialog').showModal();
}

$('close-qr-btn').addEventListener('click', () => $('room-share-dialog').close());
$('room-qr-image').addEventListener('error', () => {
  $('room-qr-image').classList.add('hidden');
  $('qr-error').classList.remove('hidden');
});
$('room-share-dialog').addEventListener('click', event => {
  if (event.target !== $('room-share-dialog')) return;
  const bounds = event.target.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.target.close();
});

// ── Exit ───────────────────────────────────────────────────────────────────
$('exit-btn').addEventListener('click', () => {
  if (confirm('강의실에서 나가시겠습니까? 이 PC에서 다시 돌아올 수 있습니다.')) {
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
$('persistent-qr-button').addEventListener('click', showShareDialog);

// ── Socket: instructor joined ──────────────────────────────────────────────
socket.on('instructor:joined', data => {
  connection.acceptSnapshot(data);
  roomCode = data.roomCode;
  lectureName = data.lectureName || lectureName;

  showScreen('screen-room');
  updateRoomInvite(roomCode);
  $('room-lecture-name').textContent = lectureName;
  $('room-lecture-name').title = lectureName;

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
  $('chat-participant-count').textContent = students.length;
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
    feed.innerHTML = `<div class="empty-state"><div class="empty-icon">📊</div><p>아직 진행한 설문이 없습니다<br>위의 도구로 설문을 시작하세요</p></div>`;
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
  // 방장 자료 목록: 항목 전체를 새 창 링크로 만들어 클릭 시 바로 열리게 함
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

// ── App error ──────────────────────────────────────────────────────────────
socket.on('app:error', error => {
  const { message, code } = error;
  if (error.event === 'instructor:join') { connection.failJoin(error); return; }
  if (code === 'AUTH') {
    connection.stop();
    showScreen('screen-setup');
    showError('setup-error', message);
    prepareSetup();
    return;
  }
  // 입장 전(설정 화면) 단계의 오류는 설정 화면에 표시하고 머무름
  if (!$('screen-setup').classList.contains('hidden')) {
    showError('setup-error', message);
  } else {
    showToast('오류: ' + message);
  }
});

prepareSetup();
