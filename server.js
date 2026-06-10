const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// 관리자 = Supabase instructors 테이블에 등록된 아래 이메일 계정.
// 관리자 페이지 로그인 시 이 계정의 비밀번호로 인증한다 (승인 상태와 무관).
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'buddykorea79@gmail.com').toLowerCase();

const MAX_ROOMS = 5;              // 동시에 개설 가능한 최대 방 개수
const ROOM_CAPACITY = 50;         // 방당 최대 학생 수
const MAX_WHITEBOARD_SEGMENTS = 100000;  // 화이트보드 누적 세그먼트 상한 (메모리 보호)
const MAX_MESSAGES = 500;         // 방별 채팅 보관 상한 (메모리 보호, 초과 시 오래된 것부터 삭제)

// ── Supabase (강사 계정 영속화) ───────────────────────────────────────────────
// 환경변수 SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 가 없으면 인메모리 전용으로 동작
// (재시작 시 계정 초기화 — 로컬 개발용).
//
// Supabase 테이블 생성 SQL (프로젝트 SQL 에디터에서 한 번만 실행):
//   CREATE TABLE IF NOT EXISTS instructors (
//     id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
//     name       TEXT    NOT NULL,
//     email      TEXT    UNIQUE NOT NULL,
//     salt       TEXT    NOT NULL,
//     pass_hash  TEXT    NOT NULL,
//     status     TEXT    NOT NULL DEFAULT 'pending',
//     created_at BIGINT  NOT NULL,
//     approved_at BIGINT
//   );
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null;

if (!supabase) {
  console.warn('Supabase not configured — instructor accounts stored in-memory only (data lost on restart)');
}

// ── Instructor accounts (인메모리 캐시 + Supabase write-through) ─────────────
let instructorAccounts = [];

function dbToAccount(r) {
  return {
    id: r.id, name: r.name, email: r.email,
    salt: r.salt, passHash: r.pass_hash,
    status: r.status, createdAt: r.created_at, approvedAt: r.approved_at ?? null
  };
}

async function loadInstructorAccounts() {
  if (!supabase) return;
  const { data, error } = await supabase.from('instructors').select('*');
  if (error) { console.error('Supabase load error:', error.message); return; }
  instructorAccounts = (data || []).map(dbToAccount);
  console.log(`Loaded ${instructorAccounts.length} instructor accounts from Supabase`);
}

loadInstructorAccounts().catch(e => console.error('Supabase init error:', e.message));

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

// 발급된 세션 토큰 (메모리 — 서버 재시작 시 재로그인 필요)
const instructorTokens = new Map(); // token → email
const adminTokens = new Set();

function getInstructorByToken(token) {
  const email = instructorTokens.get(token);
  if (!email) return null;
  const acct = instructorAccounts.find(a => a.email === email);
  return (acct && acct.status === 'approved') ? acct : null;
}

function revokeTokensFor(email) {
  for (const [t, e] of instructorTokens) {
    if (e === email) instructorTokens.delete(t);
  }
}

// ── Uploads ───────────────────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ── In-memory state ───────────────────────────────────────────────────────────
// rooms: { [roomCode]: { lectureName, password, capacity, instructorSocketId,
//   students: Map<socketId,{name,emoji}>, assistants: Map<socketId,{name}>,
//   messages:[], surveys:[], activeSurvey, resources:[], surveyResponses: Map,
//   whiteboard: [] } }
const rooms = new Map();

function getRoom(code) { return rooms.get(code); }

function createRoom(code, lectureName, instructorSocketId, options = {}) {
  rooms.set(code, {
    lectureName,
    password: options.password || null,
    capacity: ROOM_CAPACITY,
    instructorSocketId,
    students: new Map(),
    assistants: new Map(),
    messages: [],
    surveys: [],
    activeSurvey: null,
    resources: [],
    surveyResponses: new Map(),
    whiteboard: []
  });
  return rooms.get(code);
}

// 강사(주강사) 또는 조교인지 — 설문/자료/화이트보드 지우기 등 운영 권한 확인
function canInstruct(room, socketId) {
  if (!room) return false;
  return room.instructorSocketId === socketId || room.assistants.has(socketId);
}

// 메시지 발신자 표시 이름/이모지 결정 (강사 / 조교 / 학생)
function resolveSender(room, socketId, role) {
  if (role === 'instructor') {
    return { name: '강사', emoji: '👨‍🏫' };
  }
  if (role === 'assistant') {
    const a = room.assistants.get(socketId);
    return { name: a ? a.name : '조교', emoji: '🧑‍🏫' };
  }
  const s = room.students.get(socketId);
  return s ? { name: s.name, emoji: s.emoji } : null;
}

// ── Express middleware ────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir, {
  setHeaders: (res, filePath) => {
    // 업로드된 HTML/SVG/JS가 same-origin 으로 실행되는 것(stored XSS) 방지 — 다운로드로 강제
    if (/\.(html?|svg|xml|js|mjs|xhtml)$/i.test(filePath)) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment');
    }
  }
}));

// ── Deploy info (Render 환경변수 활용) ───────────────────────────────────────
const SERVER_START_TIME = new Date().toISOString();
const DEPLOY_COMMIT   = process.env.RENDER_GIT_COMMIT     || null;
const DEPLOY_MSG      = process.env.RENDER_GIT_COMMIT_MESSAGE || null;
const DEPLOY_BRANCH   = process.env.RENDER_GIT_BRANCH     || null;

// ── REST API ──────────────────────────────────────────────────────────────────
// Keep-alive ping — 클라이언트(강사/학생)가 10분마다 호출해 Render 슬립을 방지
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, rooms: rooms.size, ts: Date.now() });
});

app.get('/api/deploy-info', (req, res) => {
  res.json({
    startedAt: SERVER_START_TIME,
    commit:    DEPLOY_COMMIT,
    message:   DEPLOY_MSG,
    branch:    DEPLOY_BRANCH
  });
});

// ── 강사 계정: 등록 (최소 정보 — 이름·이메일·비밀번호, 관리자 승인 후 사용) ────
app.post('/api/instructor/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 30) : '';
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase().slice(0, 100) : '';

  if (!cleanName) return res.status(400).json({ ok: false, error: '이름을 입력하세요.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ ok: false, error: '올바른 이메일 주소를 입력하세요.' });
  }
  if (typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ ok: false, error: '비밀번호는 4자 이상이어야 합니다.' });
  }
  if (instructorAccounts.some(a => a.email === cleanEmail)) {
    return res.status(409).json({ ok: false, error: '이미 등록된 이메일입니다.' });
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const newAccount = {
    id: uuidv4(),
    name: cleanName,
    email: cleanEmail,
    salt,
    passHash: hashPassword(password, salt),
    status: 'pending',
    createdAt: Date.now(),
    approvedAt: null
  };

  if (supabase) {
    const { error } = await supabase.from('instructors').insert({
      id: newAccount.id,
      name: newAccount.name,
      email: newAccount.email,
      salt: newAccount.salt,
      pass_hash: newAccount.passHash,
      status: newAccount.status,
      created_at: newAccount.createdAt,
      approved_at: newAccount.approvedAt
    });
    if (error) {
      if (error.code === '23505') return res.status(409).json({ ok: false, error: '이미 등록된 이메일입니다.' });
      console.error('Supabase register error:', error.message);
      return res.status(500).json({ ok: false, error: '서버 오류가 발생했습니다.' });
    }
  }
  instructorAccounts.push(newAccount);
  res.json({ ok: true, message: '등록이 완료되었습니다. 관리자 승인 후 로그인할 수 있습니다.' });
});

// ── 강사 계정: 로그인 → 세션 토큰 발급 (승인된 계정만) ────────────────────────
app.post('/api/instructor/login', (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const acct = instructorAccounts.find(a => a.email === cleanEmail);

  if (!acct || acct.passHash !== hashPassword(password || '', acct.salt)) {
    return res.status(401).json({ ok: false, error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }
  if (acct.status === 'pending') {
    return res.status(403).json({ ok: false, error: '관리자 승인 대기 중입니다. 승인 후 이용할 수 있습니다.' });
  }
  if (acct.status !== 'approved') {
    return res.status(403).json({ ok: false, error: '사용이 제한된 계정입니다. 관리자에게 문의하세요.' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  instructorTokens.set(token, acct.email);
  res.json({ ok: true, token, name: acct.name, email: acct.email });
});

// ── 관리자: 로그인 — ADMIN_EMAIL 계정의 비밀번호로 인증 ──────────────────────
app.post('/api/admin/auth', (req, res) => {
  const { password } = req.body || {};
  const acct = instructorAccounts.find(a => a.email === ADMIN_EMAIL);
  if (!acct) {
    return res.status(401).json({ ok: false, error: '관리자 계정이 등록되어 있지 않습니다. 강사 등록을 먼저 진행하세요.' });
  }
  if (typeof password !== 'string' || acct.passHash !== hashPassword(password, acct.salt)) {
    return res.status(401).json({ ok: false, error: '관리자 비밀번호가 틀렸습니다.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.add(token);
  res.json({ ok: true, token });
});

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ ok: false, error: '관리자 인증이 필요합니다.' });
  }
  next();
}

// ── 관리자: 강사 목록 조회 ─────────────────────────────────────────────────────
app.get('/api/admin/instructors', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    instructors: instructorAccounts.map(a => ({
      id: a.id, name: a.name, email: a.email,
      status: a.status, createdAt: a.createdAt, approvedAt: a.approvedAt
    }))
  });
});

// ── 관리자: 승인 / 거절 / 보류 ─────────────────────────────────────────────────
app.post('/api/admin/instructors/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ ok: false, error: '잘못된 상태값입니다.' });
  }
  const acct = instructorAccounts.find(a => a.id === req.params.id);
  if (!acct) return res.status(404).json({ ok: false, error: '계정을 찾을 수 없습니다.' });

  const prevStatus = acct.status;
  acct.status = status;
  if (status === 'approved') acct.approvedAt = Date.now();
  else revokeTokensFor(acct.email);

  if (supabase) {
    const update = { status };
    if (status === 'approved') update.approved_at = acct.approvedAt;
    const { error } = await supabase.from('instructors').update(update).eq('id', acct.id);
    if (error) {
      // 롤백
      acct.status = prevStatus;
      console.error('Supabase status update error:', error.message);
      return res.status(500).json({ ok: false, error: '서버 오류가 발생했습니다.' });
    }
  }
  res.json({ ok: true });
});

// ── 관리자: 계정 삭제 ──────────────────────────────────────────────────────────
app.delete('/api/admin/instructors/:id', requireAdmin, async (req, res) => {
  const idx = instructorAccounts.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: '계정을 찾을 수 없습니다.' });
  if (instructorAccounts[idx].email === ADMIN_EMAIL) {
    return res.status(400).json({ ok: false, error: '관리자 계정은 삭제할 수 없습니다.' });
  }

  if (supabase) {
    const { error } = await supabase.from('instructors').delete().eq('id', req.params.id);
    if (error) {
      console.error('Supabase delete error:', error.message);
      return res.status(500).json({ ok: false, error: '서버 오류가 발생했습니다.' });
    }
  }
  const [removed] = instructorAccounts.splice(idx, 1);
  revokeTokensFor(removed.email);
  res.json({ ok: true });
});

// 방 정보 조회 (URL 코드 접근 / 입장 전 비밀번호·정원 안내용)
app.get('/api/room/:code', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.json({ exists: false });
  res.json({
    exists: true,
    lectureName: room.lectureName,
    requiresPassword: !!room.password,
    count: room.students.size,
    capacity: room.capacity,
    full: room.students.size >= room.capacity
  });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({
    url: `/uploads/${req.file.filename}`,
    filename: req.file.originalname
  });
});

app.post('/api/ai/chat', (req, res) => {
  const { messages, model, apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API 키가 필요합니다.' });
  if (!messages || !messages.length) return res.status(400).json({ error: '메시지가 필요합니다.' });

  const modelId = model || 'openai/gpt-3.5-turbo';
  const body = JSON.stringify({ model: modelId, messages });

  const options = {
    hostname: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://edutalk.app',
      'X-Title': 'EduTalk'
    }
  };

  const proxyReq = https.request(options, proxyRes => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (proxyRes.statusCode !== 200) {
          return res.status(proxyRes.statusCode).json({ error: parsed.error?.message || '오류 발생' });
        }
        const content = parsed.choices?.[0]?.message?.content || '';
        res.json({ content });
      } catch (e) {
        res.status(500).json({ error: 'Response parse error' });
      }
    });
  });

  proxyReq.on('error', e => res.status(500).json({ error: e.message }));
  proxyReq.write(body);
  proxyReq.end();
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
// Track socket → room mappings
const socketRoom = new Map();   // socketId → roomCode
const socketRole = new Map();   // socketId → 'instructor' | 'student'

function broadcastStudentList(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;
  const list = Array.from(room.students.entries()).map(([id, s]) => ({
    socketId: id,
    name: s.name,
    emoji: s.emoji
  }));
  io.to(roomCode).emit('student:list', list);
}

function broadcastStaffList(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;
  const list = Array.from(room.assistants.entries()).map(([id, a]) => ({
    socketId: id,
    name: a.name
  }));
  io.to(roomCode).emit('staff:list', list);
}

// 운영진(주강사 + 조교)에게만 이벤트 전송 — 실시간 설문 집계 등 학생에게 노출하지 않을 정보
function emitToStaff(room, event, payload) {
  const ids = [room.instructorSocketId, ...room.assistants.keys()].filter(Boolean);
  ids.forEach(id => {
    const s = io.sockets.sockets.get(id);
    if (s) s.emit(event, payload);
  });
}

function systemMsg(text) {
  return {
    id: uuidv4(),
    type: 'system',
    text,
    timestamp: Date.now()
  };
}

// 방 메시지 저장 — 상한 초과 시 오래된 메시지부터 삭제 (메모리 보호)
function pushMessage(room, msg) {
  room.messages.push(msg);
  if (room.messages.length > MAX_MESSAGES) room.messages.shift();
}

io.on('connection', socket => {
  // ── Instructor join ────────────────────────────────────────────────────────
  socket.on('instructor:join', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { roomCode, lectureName, password, asAssistant, name, token } = payload;

    // 승인된 강사 계정 토큰 확인 (강사·조교 공통)
    const acct = getInstructorByToken(token);
    if (!acct) {
      socket.emit('app:error', { message: '강사 인증이 만료되었거나 유효하지 않습니다. 다시 로그인하세요.', code: 'AUTH' });
      return;
    }

    if (typeof roomCode !== 'string' || !/^\d{6}$/.test(roomCode)) {
      socket.emit('app:error', { message: '올바른 방 코드가 아닙니다.' });
      return;
    }

    let room = getRoom(roomCode);
    let role;

    if (asAssistant) {
      // 보조 강사(조교): 기존 방에만 참여 가능
      if (!room) {
        socket.emit('app:error', { message: '존재하지 않는 방입니다. 방 코드를 확인하세요.' });
        return;
      }
      if (room.password && room.password !== (password || '')) {
        socket.emit('app:error', { message: '방 비밀번호가 일치하지 않습니다.' });
        return;
      }
      const assistantName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 20) : acct.name;
      room.assistants.set(socket.id, { name: assistantName, email: acct.email });
      role = 'assistant';

      const msg = systemMsg(`🧑‍🏫 ${assistantName} 조교님이 참여했습니다.`);
      pushMessage(room, msg);
      io.to(roomCode).emit('message:new', msg);
    } else {
      // 주강사: 신규 개설 또는 재접속(소유권 회수)
      if (!room) {
        if (rooms.size >= MAX_ROOMS) {
          socket.emit('app:error', { message: `동시 개설 가능한 방이 최대 ${MAX_ROOMS}개입니다. 잠시 후 다시 시도하세요.` });
          return;
        }
        room = createRoom(roomCode, lectureName, socket.id, { password });
        room.ownerEmail = acct.email;
      } else {
        // 다른 강사가 만든 방의 코드를 알아내 소유권을 가로채는 것 방지
        if (room.ownerEmail && room.ownerEmail !== acct.email) {
          socket.emit('app:error', { message: '이미 다른 강사가 운영 중인 방 코드입니다. 다른 코드를 사용하세요.' });
          return;
        }
        room.instructorSocketId = socket.id;
      }
      role = 'instructor';
    }

    socketRoom.set(socket.id, roomCode);
    socketRole.set(socket.id, role);
    socket.join(roomCode);

    socket.emit('instructor:joined', {
      roomCode,
      lectureName: room.lectureName,
      role,
      capacity: room.capacity,
      hasPassword: !!room.password,
      students: Array.from(room.students.entries()).map(([id, s]) => ({ socketId: id, name: s.name, emoji: s.emoji })),
      assistants: Array.from(room.assistants.entries()).map(([id, a]) => ({ socketId: id, name: a.name })),
      messages: room.messages,
      surveys: room.surveys,
      resources: room.resources,
      activeSurvey: room.activeSurvey,
      whiteboard: room.whiteboard
    });

    broadcastStaffList(roomCode);
    if (asAssistant) broadcastStudentList(roomCode);
  });

  // ── Student join ───────────────────────────────────────────────────────────
  socket.on('student:join', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { roomCode, password } = payload;

    // 입력 정규화: 이름·이모지 길이 제한
    const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 20) : '';
    const emoji = typeof payload.emoji === 'string' ? payload.emoji.slice(0, 8) : '🙂';
    if (!name) {
      socket.emit('app:error', { message: '닉네임을 입력하세요.' });
      return;
    }

    const room = getRoom(roomCode);
    if (!room) {
      socket.emit('app:error', { message: '존재하지 않는 방입니다.' });
      return;
    }

    // 비밀번호 검증
    if (room.password && room.password !== (password || '')) {
      socket.emit('app:error', { message: '방 비밀번호가 일치하지 않습니다.', code: 'PASSWORD' });
      return;
    }

    // 정원 검증
    if (room.students.size >= room.capacity) {
      socket.emit('app:error', { message: `정원이 가득 찼습니다. (최대 ${room.capacity}명)`, code: 'FULL' });
      return;
    }

    room.students.set(socket.id, { name, emoji });
    socketRoom.set(socket.id, roomCode);
    socketRole.set(socket.id, 'student');
    socket.join(roomCode);

    const msg = systemMsg(`${emoji} ${name}님이 입장했습니다.`);
    pushMessage(room, msg);
    io.to(roomCode).emit('message:new', msg);

    socket.emit('student:joined', {
      roomCode,
      lectureName: room.lectureName,
      messages: room.messages.filter(m => m.id !== msg.id),
      activeSurvey: room.activeSurvey,
      resources: room.resources,
      assistants: Array.from(room.assistants.entries()).map(([id, a]) => ({ socketId: id, name: a.name })),
      whiteboard: room.whiteboard
    });

    broadcastStudentList(roomCode);
    broadcastStaffList(roomCode);
  });

  // ── Chat message ───────────────────────────────────────────────────────────
  socket.on('message:send', ({ text }) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room) return;

    // 서버측 입력 검증: 빈 메시지 무시, 길이 제한
    if (typeof text !== 'string') return;
    const cleanText = text.trim().slice(0, 2000);
    if (!cleanText) return;

    const role = socketRole.get(socket.id);
    const sender = resolveSender(room, socket.id, role);
    if (!sender) return;

    const msg = {
      id: uuidv4(),
      socketId: socket.id,
      type: 'chat',
      senderType: role,
      senderName: sender.name,
      senderEmoji: sender.emoji,
      text: cleanText,
      timestamp: Date.now()
    };
    pushMessage(room, msg);
    io.to(roomCode).emit('message:new', msg);
  });

  // ── File message ───────────────────────────────────────────────────────────
  socket.on('message:file', ({ url, filename }) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room) return;

    // 보안: 서버가 발급한 업로드 경로만 허용 (javascript: 등 악성 링크 주입 차단)
    if (typeof url !== 'string' || !/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return;
    const cleanFilename = (typeof filename === 'string' && filename.trim())
      ? filename.trim().slice(0, 200) : '파일';

    const role = socketRole.get(socket.id);
    const sender = resolveSender(room, socket.id, role);
    if (!sender) return;

    const msg = {
      id: uuidv4(),
      socketId: socket.id,
      type: 'file',
      senderType: role,
      senderName: sender.name,
      senderEmoji: sender.emoji,
      url,
      filename: cleanFilename,
      timestamp: Date.now()
    };
    pushMessage(room, msg);
    io.to(roomCode).emit('message:new', msg);
  });

  // ── Survey: understanding ──────────────────────────────────────────────────
  socket.on('survey:understanding', () => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room || !canInstruct(room, socket.id)) return;

    const survey = {
      id: uuidv4(),
      type: 'understanding',
      question: '잘 이해하셨나요?',
      options: ['이해했어요! 👍', '조금 천천히 부탁해요! 🐢', '못 따라가고 있어요. 😢'],
      results: [0, 0, 0],
      total: 0,
      closed: false,
      timestamp: Date.now()
    };

    room.activeSurvey = survey;
    room.surveys.push(survey);
    room.surveyResponses.set(survey.id, new Map());

    io.to(roomCode).emit('survey:started', survey);
  });

  // ── Survey: custom ────────────────────────────────────────────────────────
  socket.on('survey:create', ({ question, options }) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room || !canInstruct(room, socket.id)) return;

    // 서버측 검증: 잘못된 페이로드(배열 아님 등)로 인한 오류 방지
    if (typeof question !== 'string' || !question.trim()) return;
    if (!Array.isArray(options)) return;
    const cleanOptions = options
      .filter(o => typeof o === 'string' && o.trim())
      .map(o => o.trim().slice(0, 200))
      .slice(0, 10);
    if (cleanOptions.length < 2) return;

    const survey = {
      id: uuidv4(),
      type: 'custom',
      question: question.trim().slice(0, 300),
      options: cleanOptions,
      results: new Array(cleanOptions.length).fill(0),
      total: 0,
      closed: false,
      timestamp: Date.now()
    };

    room.activeSurvey = survey;
    room.surveys.push(survey);
    room.surveyResponses.set(survey.id, new Map());

    io.to(roomCode).emit('survey:started', survey);
  });

  // ── Survey: respond ────────────────────────────────────────────────────────
  socket.on('survey:respond', ({ surveyId, optionIndex }) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room) return;

    const survey = room.surveys.find(s => s.id === surveyId);
    if (!survey || survey.closed) return;

    // optionIndex 범위 검증: 잘못된 인덱스로 집계가 깨지는 것을 방지
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= survey.options.length) return;

    const responses = room.surveyResponses.get(surveyId);
    if (!responses) return;

    // Allow changing vote
    if (responses.has(socket.id)) {
      const prev = responses.get(socket.id);
      survey.results[prev]--;
      survey.total--;
    }

    responses.set(socket.id, optionIndex);
    survey.results[optionIndex]++;
    survey.total++;

    socket.emit('survey:myResponse', { surveyId, optionIndex });

    // 실시간 집계는 운영진(강사+조교)에게만 전송
    emitToStaff(room, 'survey:update', {
      surveyId,
      results: survey.results,
      total: survey.total
    });
  });

  // ── Survey: close ─────────────────────────────────────────────────────────
  socket.on('survey:close', ({ surveyId }) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room || !canInstruct(room, socket.id)) return;

    const survey = room.surveys.find(s => s.id === surveyId);
    if (!survey) return;
    survey.closed = true;
    if (room.activeSurvey && room.activeSurvey.id === surveyId) {
      room.activeSurvey = null;
    }

    io.to(roomCode).emit('survey:closed', { surveyId });
  });

  // ── Survey: share results ─────────────────────────────────────────────────
  socket.on('survey:shareResults', ({ surveyId }) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room || !canInstruct(room, socket.id)) return;

    const survey = room.surveys.find(s => s.id === surveyId);
    if (!survey) return;

    io.to(roomCode).emit('survey:resultsShared', {
      surveyId,
      question: survey.question,
      options: survey.options,
      results: survey.results,
      total: survey.total
    });
  });

  // ── Resource: share ────────────────────────────────────────────────────────
  socket.on('resource:share', ({ type, url, filename, title }) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room || !canInstruct(room, socket.id)) return;

    // 보안: URL 형식 서버측 검증 — javascript: 등 악성 스킴 주입 차단
    if (typeof url !== 'string' || url.length > 2000) return;
    if (type === 'url') {
      if (!/^https?:\/\//i.test(url)) return;
    } else if (type === 'pdf') {
      if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return;
    } else {
      return;
    }

    const resource = {
      id: uuidv4(),
      type,       // 'url' | 'pdf'
      url,
      filename: (typeof filename === 'string' ? filename.slice(0, 200) : null) || null,
      title: (typeof title === 'string' && title.trim() ? title.trim().slice(0, 300) : url),
      timestamp: Date.now()
    };

    room.resources.push(resource);
    io.to(roomCode).emit('resource:shared', resource);
  });

  // ── Whiteboard: draw ─────────────────────────────────────────────────────────
  // 협업 모드 — 강사/조교/학생 누구나 그릴 수 있음. 좌표는 0~1 정규화 값.
  socket.on('whiteboard:draw', (seg) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room) return;

    // 입력 검증: 좌표·속성이 올바른 세그먼트만 허용
    if (!seg || typeof seg !== 'object') return;
    const { x0, y0, x1, y1 } = seg;
    if (![x0, y0, x1, y1].every(n => typeof n === 'number' && n >= 0 && n <= 1)) return;
    const color = typeof seg.color === 'string' ? seg.color.slice(0, 24) : '#1A2E24';
    const width = (typeof seg.width === 'number' && seg.width > 0 && seg.width <= 64) ? seg.width : 3;
    const erase = !!seg.erase;

    const clean = { type: 'stroke', x0, y0, x1, y1, color, width, erase };

    if (room.whiteboard.length < MAX_WHITEBOARD_SEGMENTS) {
      room.whiteboard.push(clean);
    }
    // 그린 본인 제외하고 같은 방에 전파
    socket.to(roomCode).emit('whiteboard:draw', clean);
  });

  // ── Whiteboard: image ────────────────────────────────────────────────────────
  // 이미지 파일 / 화면 캡처를 보드에 삽입. url 은 우리 업로드 경로(/uploads/)만 허용.
  socket.on('whiteboard:image', (img) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room) return;

    if (!img || typeof img !== 'object') return;
    const { url, x, y, w, h } = img;
    // 보안: 서버가 발급한 업로드 경로만 허용 (외부 URL 주입 차단)
    if (typeof url !== 'string' || !/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return;
    if (![x, y].every(n => typeof n === 'number' && n >= 0 && n <= 1)) return;
    if (![w, h].every(n => typeof n === 'number' && n > 0 && n <= 1)) return;

    const item = { type: 'image', id: uuidv4(), url, x, y, w, h };

    if (room.whiteboard.length < MAX_WHITEBOARD_SEGMENTS) {
      room.whiteboard.push(item);
    }
    // 삽입한 본인 포함 전체에 전파 (본인도 동일 좌표로 렌더)
    io.to(roomCode).emit('whiteboard:image', item);
  });

  // ── Whiteboard: clear ─────────────────────────────────────────────────────────
  // 전체 지우기는 강사/조교만 가능
  socket.on('whiteboard:clear', () => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room || !canInstruct(room, socket.id)) return;

    room.whiteboard = [];
    io.to(roomCode).emit('whiteboard:cleared');
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;

    const room = getRoom(roomCode);
    if (!room) return;

    const role = socketRole.get(socket.id);

    if (role === 'student') {
      const s = room.students.get(socket.id);
      if (s) {
        room.students.delete(socket.id);
        const msg = systemMsg(`${s.emoji} ${s.name}님이 퇴장했습니다.`);
        pushMessage(room, msg);
        io.to(roomCode).emit('message:new', msg);
        broadcastStudentList(roomCode);
      }
    } else if (role === 'assistant') {
      const a = room.assistants.get(socket.id);
      if (a) {
        room.assistants.delete(socket.id);
        io.to(roomCode).emit('message:new', systemMsg(`🧑‍🏫 ${a.name} 조교님이 퇴장했습니다.`));
        broadcastStaffList(roomCode);
      }
    } else if (role === 'instructor') {
      // 강사 소켓이 끊기면 stale id 정리 (재접속 시 instructor:join 에서 다시 설정)
      if (room.instructorSocketId === socket.id) {
        room.instructorSocketId = null;
      }
      // Notify students instructor left
      io.to(roomCode).emit('message:new', systemMsg('강사님이 퇴장했습니다.'));
    }

    socketRoom.delete(socket.id);
    socketRole.delete(socket.id);
  });
});

// ── Midnight room cleanup ─────────────────────────────────────────────────────
function scheduleRoomCleanup() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const msUntilMidnight = midnight.getTime() - now.getTime();

  setTimeout(() => {
    const count = rooms.size;
    rooms.clear();
    socketRoom.clear();
    socketRole.clear();
    io.emit('room:expired', { reason: '자정이 지나 오늘의 모든 강의방이 초기화되었습니다.' });
    console.log(`Midnight cleanup: cleared ${count} rooms at ${new Date().toISOString()}`);
    scheduleRoomCleanup();
  }, msUntilMidnight);

  const mins = Math.round(msUntilMidnight / 60000);
  console.log(`Room cleanup scheduled in ${mins} minutes (at midnight)`);
}

scheduleRoomCleanup();

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`EduTalk v3 running on http://localhost:${PORT}`);
});
