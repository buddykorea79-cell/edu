const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const INSTRUCTOR_PASSWORD = fs.readFileSync(
  path.join(__dirname, 'config/instructor_password.txt'),
  'utf8'
).trim();

const MAX_ROOMS = 5;              // 동시에 개설 가능한 최대 방 개수
const ROOM_CAPACITY = 50;         // 방당 최대 학생 수
const MAX_WHITEBOARD_SEGMENTS = 100000;  // 화이트보드 누적 세그먼트 상한 (메모리 보호)

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
app.use('/uploads', express.static(uploadsDir));

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

app.post('/api/instructor/auth', (req, res) => {
  const { password } = req.body;
  if (password === INSTRUCTOR_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: '비밀번호가 틀렸습니다.' });
  }
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

io.on('connection', socket => {
  // ── Instructor join ────────────────────────────────────────────────────────
  socket.on('instructor:join', ({ roomCode, lectureName, password, asAssistant, name }) => {
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
      const assistantName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 20) : '조교';
      room.assistants.set(socket.id, { name: assistantName });
      role = 'assistant';

      const msg = systemMsg(`🧑‍🏫 ${assistantName} 조교님이 참여했습니다.`);
      room.messages.push(msg);
      io.to(roomCode).emit('message:new', msg);
    } else {
      // 주강사: 신규 개설 또는 재접속(소유권 회수)
      if (!room) {
        if (rooms.size >= MAX_ROOMS) {
          socket.emit('app:error', { message: `동시 개설 가능한 방이 최대 ${MAX_ROOMS}개입니다. 잠시 후 다시 시도하세요.` });
          return;
        }
        room = createRoom(roomCode, lectureName, socket.id, { password });
      } else {
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
  socket.on('student:join', ({ roomCode, name, emoji, password }) => {
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
    room.messages.push(msg);
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
    room.messages.push(msg);
    io.to(roomCode).emit('message:new', msg);
  });

  // ── File message ───────────────────────────────────────────────────────────
  socket.on('message:file', ({ url, filename }) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room) return;

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
      filename,
      timestamp: Date.now()
    };
    room.messages.push(msg);
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

    const survey = {
      id: uuidv4(),
      type: 'custom',
      question,
      options,
      results: new Array(options.length).fill(0),
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

    const resource = {
      id: uuidv4(),
      type,       // 'url' | 'pdf'
      url,
      filename: filename || null,
      title: title || url,
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

    const clean = { x0, y0, x1, y1, color, width, erase };

    if (room.whiteboard.length < MAX_WHITEBOARD_SEGMENTS) {
      room.whiteboard.push(clean);
    }
    // 그린 본인 제외하고 같은 방에 전파
    socket.to(roomCode).emit('whiteboard:draw', clean);
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
        room.messages.push(msg);
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
