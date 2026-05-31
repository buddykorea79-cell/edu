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
// rooms: { [roomCode]: { lectureName, instructorSocketId, students: Map<socketId, {name,emoji}>, messages:[], surveys:[], activeSurvey, resources:[], surveyResponses: Map } }
const rooms = new Map();

function getRoom(code) { return rooms.get(code); }

function createRoom(code, lectureName, instructorSocketId) {
  rooms.set(code, {
    lectureName,
    instructorSocketId,
    students: new Map(),
    messages: [],
    surveys: [],
    activeSurvey: null,
    resources: [],
    surveyResponses: new Map()
  });
  return rooms.get(code);
}

// ── Express middleware ────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// ── REST API ──────────────────────────────────────────────────────────────────
app.post('/api/instructor/auth', (req, res) => {
  const { password } = req.body;
  if (password === INSTRUCTOR_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: '비밀번호가 틀렸습니다.' });
  }
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
  socket.on('instructor:join', ({ roomCode, lectureName }) => {
    let room = getRoom(roomCode);
    if (!room) {
      room = createRoom(roomCode, lectureName, socket.id);
    } else {
      room.instructorSocketId = socket.id;
    }

    socketRoom.set(socket.id, roomCode);
    socketRole.set(socket.id, 'instructor');
    socket.join(roomCode);

    socket.emit('instructor:joined', {
      roomCode,
      lectureName: room.lectureName,
      students: Array.from(room.students.entries()).map(([id, s]) => ({ socketId: id, name: s.name, emoji: s.emoji })),
      messages: room.messages,
      surveys: room.surveys,
      resources: room.resources,
      activeSurvey: room.activeSurvey
    });
  });

  // ── Student join ───────────────────────────────────────────────────────────
  socket.on('student:join', ({ roomCode, name, emoji }) => {
    const room = getRoom(roomCode);
    if (!room) {
      socket.emit('app:error', { message: '존재하지 않는 방입니다.' });
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
      resources: room.resources
    });

    broadcastStudentList(roomCode);
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
    let senderName, senderEmoji;

    if (role === 'instructor') {
      senderName = '강사';
      senderEmoji = '👨‍🏫';
    } else {
      const s = room.students.get(socket.id);
      if (!s) return;
      senderName = s.name;
      senderEmoji = s.emoji;
    }

    const msg = {
      id: uuidv4(),
      socketId: socket.id,
      type: 'chat',
      senderType: role,
      senderName,
      senderEmoji,
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
    let senderName, senderEmoji;

    if (role === 'instructor') {
      senderName = '강사';
      senderEmoji = '👨‍🏫';
    } else {
      const s = room.students.get(socket.id);
      if (!s) return;
      senderName = s.name;
      senderEmoji = s.emoji;
    }

    const msg = {
      id: uuidv4(),
      socketId: socket.id,
      type: 'file',
      senderType: role,
      senderName,
      senderEmoji,
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
    if (!room || room.instructorSocketId !== socket.id) return;

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
    if (!room || room.instructorSocketId !== socket.id) return;

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

    const instructor = io.sockets.sockets.get(room.instructorSocketId);
    if (instructor) {
      instructor.emit('survey:update', {
        surveyId,
        results: survey.results,
        total: survey.total
      });
    }
  });

  // ── Survey: close ─────────────────────────────────────────────────────────
  socket.on('survey:close', ({ surveyId }) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room || room.instructorSocketId !== socket.id) return;

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
    if (!room || room.instructorSocketId !== socket.id) return;

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
    if (!room || room.instructorSocketId !== socket.id) return;

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
