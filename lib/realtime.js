'use strict';

const crypto = require('crypto');

const LIMITS = Object.freeze({ rooms: 5, capacity: 50, messages: 500, surveys: 100,
  resources: 100, boardItems: 10000, boardImages: 32, dedup: 2000 });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanString = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const validCode = code => typeof code === 'string' && /^\d{6}$/.test(code);
const validUpload = url => typeof url === 'string' && /^\/uploads\/[A-Za-z0-9._-]+$/.test(url);

// All room identities survive a transport reconnect. The private session secret is
// never included in room broadcasts, messages, student lists or survey results.
function createRealtime(io, { authenticateInstructor = async () => null,
  reconnectGraceMs = 120000, idleTtlMs = 6 * 60 * 60 * 1000,
  cleanupIntervalMs = 60000 } = {}) {
  const rooms = new Map();
  const socketRoom = new Map();
  const socketRole = new Map();
  const identityKey = crypto.randomBytes(32);
  const revokedUsers = new Set();
  const metrics = { totalConnections: 0, roomJoins: 0, rejoins: 0, disconnects: 0 };
  // Fixed reason names prevent arbitrary connection details entering logs or
  // creating an unbounded set of metric labels.
  const disconnectReasons = Object.fromEntries([
    'transport error', 'transport close', 'forced close', 'ping timeout',
    'parse error', 'server shutting down', 'forced server close',
    'client namespace disconnect', 'server namespace disconnect', 'other',
  ].map(reason => [reason, 0]));
  let stopped = false;

  function getRoom(code) { return rooms.get(code); }
  function createRoom(code, lectureName, instructorSocketId = null) {
    const room = {
      lectureName: cleanString(lectureName, 100) || '강의실', capacity: LIMITS.capacity,
      instructorSocketId, ownerId: null, students: new Map(), assistants: new Map(),
      members: new Map(), studentSessions: new Map(), messages: [], surveys: [],
      activeSurvey: null, resources: [], surveyResponses: new Map(), whiteboard: [],
      whiteboardImages: 0, messageReceipts: new Map(), rate: {},
      lastActivity: Date.now(), createdAt: Date.now(),
    };
    rooms.set(code, room);
    return room;
  }
  function findOwnedRoom(ownerId) {
    if (typeof ownerId !== 'string' || !ownerId) return null;
    for (const [roomCode, room] of rooms) {
      if (room.ownerId === ownerId) return { roomCode, lectureName: room.lectureName };
    }
    return null;
  }
  // Creation is separate from reconnecting. A deleted room must never reappear
  // because an older tab retries its socket join. These synchronous checks also
  // enforce limits across simultaneous requests and multiple browser tabs.
  function createOwnedRoom(ownerId, lectureName) {
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 256) {
      return { ok: false, code: 'AUTH', error: '기기 정보를 확인할 수 없습니다. 새로고침 후 다시 시도하세요.' };
    }
    const name = cleanString(lectureName, 100);
    if (!name) return { ok: false, code: 'INVALID', error: '강의실 이름을 입력하세요.' };
    cleanupRooms();
    const existing = findOwnedRoom(ownerId);
    if (existing) return { ok: false, code: 'ROOM_EXISTS', error: '이 기기에서 이미 개설한 강의실이 있습니다.', ...existing };
    if (rooms.size >= LIMITS.rooms) return { ok: false, code: 'ROOM_LIMIT', error: `동시에 열 수 있는 강의실은 ${LIMITS.rooms}개입니다.` };
    let code;
    do { code = String(crypto.randomInt(1000000)).padStart(6, '0'); } while (rooms.has(code));
    const room = createRoom(code, name);
    room.ownerId = ownerId;
    return { ok: true, roomCode: code, lectureName: room.lectureName };
  }
  function deleteRoom(code, message = '관리자가 강의실을 삭제했습니다.') {
    const room = rooms.get(code);
    if (!room) return false;
    io.to(code).emit('room:closed', { roomCode: code, message });
    // Invalidate before touching sockets, so queued handlers cannot use this room.
    rooms.delete(code);
    for (const member of room.members.values()) clearTimeout(member.disconnectTimer);
    for (const [socketId, roomCode] of socketRoom) {
      if (roomCode !== code) continue;
      socketRoom.delete(socketId);
      socketRole.delete(socketId);
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) continue;
      socket.data.joinVersion++;
      socket.data.participantId = null;
      socket.data.userId = null;
      socket.leave(code);
    }
    room.members.clear();
    room.students.clear();
    room.assistants.clear();
    room.studentSessions.clear();
    room.instructorSocketId = null;
    return true;
  }
  function touch(room) { room.lastActivity = Date.now(); }
  function rateLimit(container, key, perSecond, burst, cost = 1) {
    const now = Date.now();
    const bucket = container[key] || { tokens: burst, at: now };
    bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.at) * perSecond / 1000);
    bucket.at = now;
    container[key] = bucket;
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }
  function studentList(room) {
    return Array.from(room.students.entries()).map(([socketId, m]) => ({
      socketId, participantId: m.participantId, name: m.name, emoji: m.emoji, connected: m.connected,
    }));
  }
  function staffList(room) {
    return Array.from(room.assistants.entries()).map(([socketId, m]) => ({
      socketId, participantId: m.participantId, name: m.name, connected: m.connected,
    }));
  }
  function broadcastLists(code, room) {
    io.to(code).emit('student:list', studentList(room));
    io.to(code).emit('staff:list', staffList(room));
  }
  function pushMessage(room, message) {
    room.messages.push(message);
    if (room.messages.length > LIMITS.messages) room.messages.shift();
    touch(room);
  }
  function announce(code, room, text) {
    const msg = { id: crypto.randomUUID(), type: 'system', text, timestamp: Date.now() };
    pushMessage(room, msg);
    io.to(code).emit('message:new', msg);
  }
  function current(socket) {
    const roomCode = socketRoom.get(socket.id);
    const room = rooms.get(roomCode);
    const member = room?.members.get(socket.data.participantId);
    if (!room || !member?.connected || member.socketId !== socket.id) return null;
    return { roomCode, room, member };
  }
  function getHttpSession(socketId, token) {
    if (typeof socketId !== 'string' || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const socket = io.sockets.sockets.get(socketId);
    if (!socket?.connected || !socket.data.uploadToken || token.length !== socket.data.uploadToken.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(socket.data.uploadToken))) return null;
    const ctx = current(socket);
    return ctx ? { room: ctx.room, roomCode: ctx.roomCode, participantId: ctx.member.participantId, socketId } : null;
  }
  function removeMember(code, room, member, notify = true) {
    clearTimeout(member.disconnectTimer);
    room.students.delete(member.socketId);
    room.assistants.delete(member.socketId);
    room.members.delete(member.participantId);
    if (member.sessionId) room.studentSessions.delete(member.sessionId);
    if (room.instructorSocketId === member.socketId) room.instructorSocketId = null;
    if (notify) announce(code, room, `${member.emoji} ${member.name}님이 퇴장했습니다.`);
    broadcastLists(code, room);
  }
  function detach(socket, { reserve = false, notify = true } = {}) {
    if (stopped) { reserve = false; notify = false; }
    const ctx = current(socket);
    socketRoom.delete(socket.id);
    socketRole.delete(socket.id);
    socket.data.participantId = null;
    socket.data.userId = null;
    if (!ctx) return;
    const { roomCode, room, member } = ctx;
    socket.leave(roomCode);
    member.connected = false;
    if (room.instructorSocketId === socket.id) room.instructorSocketId = null;
    touch(room);
    if (reserve) {
      member.disconnectTimer = setTimeout(() => {
        if (!member.connected && rooms.get(roomCode) === room) removeMember(roomCode, room, member, notify);
      }, reconnectGraceMs);
      member.disconnectTimer.unref();
      broadcastLists(roomCode, room);
    } else removeMember(roomCode, room, member, notify);
  }
  function replaceConnection(roomCode, room, member, nextSocket) {
    clearTimeout(member.disconnectTimer);
    if (member.socketId && member.socketId !== nextSocket.id) {
      const previous = io.sockets.sockets.get(member.socketId);
      if (previous) {
        socketRoom.delete(previous.id);
        socketRole.delete(previous.id);
        previous.data.participantId = null;
        previous.data.userId = null;
        previous.leave(roomCode);
        previous.emit('session:replaced', { message: '다른 연결에서 이 강의실에 다시 입장했습니다.' });
        previous.disconnect(true);
      }
      room.students.delete(member.socketId);
      room.assistants.delete(member.socketId);
    }
  }
  function attach(socket, code, room, member) {
    const old = current(socket);
    if (!old || old.room !== room || old.member !== member) {
      metrics.roomJoins++;
      if (member.socketId) metrics.rejoins++;
    }
    if (old && (old.room !== room || old.member !== member)) detach(socket);
    replaceConnection(code, room, member, socket);
    member.socketId = socket.id;
    member.connected = true;
    member.disconnectTimer = null;
    room.members.set(member.participantId, member);
    if (member.role === 'student') {
      room.students.set(socket.id, member);
      room.studentSessions.set(member.sessionId, member);
    } else if (member.role === 'assistant') room.assistants.set(socket.id, member);
    else room.instructorSocketId = socket.id;
    socketRoom.set(socket.id, code);
    socketRole.set(socket.id, member.role);
    socket.data.participantId = member.participantId;
    socket.data.userId = member.userId || null;
    socket.join(code);
    touch(room);
  }
  function snapshot(socket, code, room, member) {
    const myResponses = {};
    for (const [id, responses] of room.surveyResponses) {
      if (responses.has(member.participantId)) myResponses[id] = responses.get(member.participantId);
    }
    let activeSurvey = room.activeSurvey;
    if (activeSurvey && member.role === 'student') {
      const { id, type, question, options, closed, timestamp } = activeSurvey;
      activeSurvey = { id, type, question, options, closed, timestamp };
    }
    const data = {
      roomCode: code, lectureName: room.lectureName, role: member.role,
      participantId: member.participantId, uploadToken: socket.data.uploadToken,
      capacity: room.capacity, students: studentList(room), assistants: staffList(room),
      messages: room.messages, resources: room.resources,
      activeSurvey, myResponses, whiteboard: room.whiteboard,
      whiteboardLimits: { maxItems: LIMITS.boardItems, maxImages: LIMITS.boardImages },
    };
    if (member.role === 'student') data.sessionId = member.sessionId;
    else data.surveys = room.surveys;
    socket.emit(member.role === 'student' ? 'student:joined' : 'instructor:joined', data);
  }
  function fail(socket, event, ack, code, message) {
    const error = { ok: false, code, error: message, message, event };
    if (typeof ack === 'function') ack(error);
    // High-frequency drawing rejection must not itself flood the room/client.
    if (rateLimit(socket.data.errorRate, code, 1, 1)) socket.emit('app:error', error);
    return false;
  }
  function success(ack, data = {}) { if (typeof ack === 'function') ack({ ok: true, ...data }); }
  function startSurvey(code, room, survey) {
    if (room.activeSurvey) {
      room.activeSurvey.closed = true;
      io.to(code).emit('survey:closed', { surveyId: room.activeSurvey.id });
    }
    room.activeSurvey = survey;
    room.surveys.push(survey);
    room.surveyResponses.set(survey.id, new Map());
    if (room.surveys.length > LIMITS.surveys) {
      const old = room.surveys.shift();
      room.surveyResponses.delete(old.id);
    }
    touch(room);
    io.to(code).emit('survey:started', survey);
  }
  function normalizeStroke(seg) {
    if (!isObject(seg)) return null;
    const { x0, y0, x1, y1 } = seg;
    if (![x0, y0, x1, y1].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) return null;
    return { type: 'stroke', x0, y0, x1, y1,
      color: typeof seg.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(seg.color) ? seg.color : '#1A2E24',
      width: Number.isFinite(seg.width) && seg.width > 0 && seg.width <= 64 ? seg.width : 3,
      erase: seg.erase === true };
  }

  io.on('connection', socket => {
    metrics.totalConnections++;
    socket.data.uploadToken = crypto.randomBytes(32).toString('hex');
    socket.data.rate = {};
    socket.data.errorRate = {};
    socket.data.joinVersion = 0;
    // Promise rejection and malformed arguments must never terminate the process.
    function handle(event, callback, { payload = true, joined = true, staff = false } = {}) {
      socket.on(event, (...args) => {
        const ack = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
        const body = args[0];
        if (payload && !isObject(body) && event !== 'whiteboard:drawBatch') {
          return fail(socket, event, ack, 'INVALID', '요청 형식이 올바르지 않습니다.');
        }
        Promise.resolve().then(() => {
          if (!socket.connected) return;
          const ctx = current(socket);
          if (joined && !ctx) return fail(socket, event, ack, 'NOT_JOINED', '강의실 연결을 복구한 뒤 다시 시도하세요.');
          if (staff && ctx.member.role === 'student') return fail(socket, event, ack, 'FORBIDDEN', '운영진만 사용할 수 있습니다.');
          return callback(body, ack, ctx);
        }).catch(error => {
          console.error(`Socket handler ${event}:`, error.code || error.message);
          fail(socket, event, ack, error.code === 'AUTH_UNAVAILABLE' ? 'AUTH_UNAVAILABLE' : 'SERVER_ERROR',
            '서버 연결을 처리하지 못했습니다. 잠시 후 다시 시도하세요.');
        });
      });
    }
    handle('student:join', (body, ack) => {
      socket.data.joinVersion++;
      if (!rateLimit(socket.data.rate, 'join', 1, 10)) return fail(socket, 'student:join', ack, 'RATE_LIMIT', '잠시 후 다시 입장하세요.');
      const code = body.roomCode;
      const name = cleanString(body.name, 20);
      if (!validCode(code) || !name) return fail(socket, 'student:join', ack, 'INVALID', '이름과 6자리 방 코드를 확인하세요.');
      const room = rooms.get(code);
      if (!room) return fail(socket, 'student:join', ack, 'NOT_FOUND', '강의실을 찾을 수 없습니다. 방장에게 방 상태를 확인하세요.');
      let sessionId = body.sessionId;
      if (sessionId !== undefined && (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(sessionId))) {
        return fail(socket, 'student:join', ack, 'INVALID', '입장 정보가 올바르지 않습니다. 새로고침 후 다시 입장하세요.');
      }
      if (!sessionId) sessionId = current(socket)?.member.sessionId || crypto.randomBytes(32).toString('hex');
      let member = room.studentSessions.get(sessionId);
      const isNew = !member;
      if (!member && room.students.size >= room.capacity) return fail(socket, 'student:join', ack, 'FULL', `정원이 가득 찼습니다. (최대 ${room.capacity}명)`);
      if (!member) member = {
        participantId: 'student:' + crypto.createHmac('sha256', identityKey).update(code + ':' + sessionId).digest('hex').slice(0, 32),
        sessionId, role: 'student', name, emoji: cleanString(body.emoji, 8) || '🙂', rate: {},
      };
      attach(socket, code, room, member);
      // Snapshot precedes new events, so reset-on-join cannot drop the join notice.
      snapshot(socket, code, room, member);
      if (isNew) announce(code, room, `${member.emoji} ${member.name}님이 입장했습니다.`);
      broadcastLists(code, room);
      success(ack);
    }, { joined: false });

    handle('instructor:join', async (body, ack) => {
      const version = ++socket.data.joinVersion;
      if (!rateLimit(socket.data.rate, 'join', 0.5, 5)) return fail(socket, 'instructor:join', ack, 'RATE_LIMIT', '잠시 후 다시 입장하세요.');
      if (!validCode(body.roomCode) || typeof body.token !== 'string' || body.token.length > 16384) {
        return fail(socket, 'instructor:join', ack, 'INVALID', '방 코드와 인증 정보를 확인하세요.');
      }
      const account = await authenticateInstructor(body.token);
      if (!socket.connected || version !== socket.data.joinVersion) return;
      if (!account || typeof account.userId !== 'string' || !account.userId || account.status !== 'approved' || revokedUsers.has(account.userId)) return fail(socket, 'instructor:join', ack, 'AUTH', '기기 인증이 만료되었습니다. 새로고침 후 다시 입장하세요.');
      const code = body.roomCode;
      if (body.asAssistant === true) return fail(socket, 'instructor:join', ack, 'FORBIDDEN', '강의실을 개설한 기기에서만 방장으로 입장할 수 있습니다.');
      const role = 'instructor';
      const room = rooms.get(code);
      if (!room) return fail(socket, 'instructor:join', ack, 'NOT_FOUND', '종료되었거나 존재하지 않는 강의실입니다.');
      if (room.ownerId !== account.userId) return fail(socket, 'instructor:join', ack, 'FORBIDDEN', '강의실을 개설한 기기에서만 방장으로 입장할 수 있습니다.');
      const participantId = 'staff:' + account.userId;
      let member = room.members.get(participantId);
      member ||= { participantId, userId: account.userId, role, name: '방장', emoji: '👨‍🏫', rate: {} };
      attach(socket, code, room, member);
      snapshot(socket, code, room, member);
      broadcastLists(code, room);
      success(ack);
    }, { joined: false });

    function sendMessage(type, body, ack, { roomCode, room, member }) {
      const event = type === 'chat' ? 'message:send' : 'message:file';
      const clientMessageId = body.clientMessageId;
      if (clientMessageId !== undefined && (typeof clientMessageId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(clientMessageId))) {
        return fail(socket, event, ack, 'INVALID', '메시지 식별자가 올바르지 않습니다.');
      }
      const receiptKey = clientMessageId && member.participantId + ':' + clientMessageId;
      const previous = receiptKey && room.messageReceipts.get(receiptKey);
      if (previous) return success(ack, { messageId: previous.id, message: previous });
      const text = cleanString(body.text, 2000);
      if (type === 'chat' && !text) return fail(socket, event, ack, 'INVALID', '메시지를 입력하세요.');
      if (type === 'file' && !validUpload(body.url)) return fail(socket, event, ack, 'INVALID', '파일 경로가 올바르지 않습니다.');
      if (!rateLimit(member.rate, 'message', 5, 20)) return fail(socket, event, ack, 'RATE_LIMIT', '메시지를 너무 빠르게 보내고 있습니다. 잠시 후 다시 시도하세요.');
      const msg = {
        id: crypto.randomUUID(), clientMessageId, socketId: socket.id, participantId: member.participantId,
        type, senderType: member.role, senderName: member.name, senderEmoji: member.emoji, timestamp: Date.now(),
        ...(type === 'chat' ? { text } : { url: body.url, filename: cleanString(body.filename, 200) || '파일' }),
      };
      pushMessage(room, msg);
      if (receiptKey) {
        room.messageReceipts.set(receiptKey, msg);
        if (room.messageReceipts.size > LIMITS.dedup) room.messageReceipts.delete(room.messageReceipts.keys().next().value);
      }
      io.to(roomCode).emit('message:new', msg);
      success(ack, { messageId: msg.id, message: msg });
    }
    handle('message:send', (body, ack, ctx) => sendMessage('chat', body, ack, ctx));
    handle('message:file', (body, ack, ctx) => sendMessage('file', body, ack, ctx));

    handle('survey:understanding', (body, ack, { roomCode, room, member }) => {
      if (!rateLimit(member.rate, 'survey', 1, 5)) return fail(socket, 'survey:understanding', ack, 'RATE_LIMIT', '잠시 후 다시 시도하세요.');
      startSurvey(roomCode, room, { id: crypto.randomUUID(), type: 'understanding', question: '잘 이해하셨나요?',
        options: ['이해했어요! 👍', '조금 천천히 부탁해요! 🐢', '못 따라가고 있어요. 😢'], results: [0, 0, 0], total: 0, closed: false, timestamp: Date.now() });
      success(ack);
    }, { payload: false, staff: true });
    handle('survey:create', (body, ack, { roomCode, room, member }) => {
      const question = cleanString(body.question, 300);
      if (!question || !Array.isArray(body.options) || body.options.length > 10) return fail(socket, 'survey:create', ack, 'INVALID', '질문과 2~10개 선택지를 입력하세요.');
      const options = body.options.map(o => cleanString(o, 200)).filter(Boolean);
      if (options.length < 2) return fail(socket, 'survey:create', ack, 'INVALID', '선택지는 2개 이상 필요합니다.');
      if (!rateLimit(member.rate, 'survey', 1, 5)) return fail(socket, 'survey:create', ack, 'RATE_LIMIT', '잠시 후 다시 시도하세요.');
      startSurvey(roomCode, room, { id: crypto.randomUUID(), type: 'custom', question, options,
        results: new Array(options.length).fill(0), total: 0, closed: false, timestamp: Date.now() });
      success(ack);
    }, { staff: true });
    handle('survey:respond', (body, ack, { room, member }) => {
      const { surveyId, optionIndex } = body;
      const survey = room.activeSurvey;
      if (!survey || survey.id !== surveyId || survey.closed || !Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= survey.options.length) {
        return fail(socket, 'survey:respond', ack, 'INVALID', '진행 중인 설문과 선택지를 확인하세요.');
      }
      if (!rateLimit(member.rate, 'vote', 3, 6)) return fail(socket, 'survey:respond', ack, 'RATE_LIMIT', '잠시 후 다시 응답하세요.');
      const responses = room.surveyResponses.get(surveyId);
      const previous = responses.get(member.participantId);
      if (previous !== undefined) survey.results[previous]--;
      else survey.total++;
      responses.set(member.participantId, optionIndex);
      survey.results[optionIndex]++;
      touch(room);
      socket.emit('survey:myResponse', { surveyId, optionIndex });
      for (const m of room.members.values()) if (m.connected && m.role !== 'student') {
        io.to(m.socketId).emit('survey:update', { surveyId, results: survey.results, total: survey.total });
      }
      success(ack);
    });
    handle('survey:close', (body, ack, { roomCode, room }) => {
      const survey = room.surveys.find(s => s.id === body.surveyId);
      if (!survey) return fail(socket, 'survey:close', ack, 'INVALID', '설문을 찾을 수 없습니다.');
      survey.closed = true;
      if (room.activeSurvey === survey) room.activeSurvey = null;
      touch(room);
      io.to(roomCode).emit('survey:closed', { surveyId: survey.id });
      success(ack);
    }, { staff: true });
    handle('survey:shareResults', (body, ack, { roomCode, room, member }) => {
      const survey = room.surveys.find(s => s.id === body.surveyId);
      if (!survey) return fail(socket, 'survey:shareResults', ack, 'INVALID', '설문을 찾을 수 없습니다.');
      if (!rateLimit(member.rate, 'share', 1, 5)) return fail(socket, 'survey:shareResults', ack, 'RATE_LIMIT', '잠시 후 다시 공유하세요.');
      io.to(roomCode).emit('survey:resultsShared', { surveyId: survey.id, question: survey.question, options: survey.options, results: survey.results, total: survey.total });
      success(ack);
    }, { staff: true });
    handle('resource:share', (body, ack, { roomCode, room, member }) => {
      const { type, url } = body;
      if (typeof url !== 'string' || url.length > 2000 || !(type === 'url' ? /^https?:\/\//i.test(url) : type === 'pdf' && validUpload(url))) {
        return fail(socket, 'resource:share', ack, 'INVALID', '자료 주소를 확인하세요.');
      }
      if (!rateLimit(member.rate, 'share', 1, 5)) return fail(socket, 'resource:share', ack, 'RATE_LIMIT', '잠시 후 다시 공유하세요.');
      if (room.resources.length >= LIMITS.resources) return fail(socket, 'resource:share', ack, 'RESOURCE_LIMIT', '강의실당 공유 자료는 최대 100개입니다.');
      const resource = { id: crypto.randomUUID(), type, url, filename: cleanString(body.filename, 200) || null,
        title: cleanString(body.title, 300) || url, timestamp: Date.now() };
      room.resources.push(resource);
      touch(room);
      io.to(roomCode).emit('resource:shared', resource);
      success(ack);
    }, { staff: true });

    function draw(items, ack, ctx, legacy) {
      const event = legacy ? 'whiteboard:draw' : 'whiteboard:drawBatch';
      const { roomCode, room, member } = ctx;
      if (!Array.isArray(items) || items.length < 1 || items.length > 16) return fail(socket, event, ack, 'INVALID', '그리기 데이터가 올바르지 않습니다.');
      const segments = items.map(normalizeStroke);
      if (segments.some(s => !s)) return fail(socket, event, ack, 'INVALID', '그리기 좌표가 올바르지 않습니다.');
      if (room.whiteboard.length + segments.length > LIMITS.boardItems) return fail(socket, event, ack, 'BOARD_FULL', '화이트보드가 가득 찼습니다. 운영진에게 전체 지우기를 요청하세요.');
      if (!rateLimit(member.rate, 'draw', 200, 400, segments.length) || !rateLimit(room.rate, 'draw', 1500, 3000, segments.length)) {
        return fail(socket, event, ack, 'RATE_LIMIT', '그리기 요청이 많습니다. 잠시 후 다시 그려 주세요.');
      }
      room.whiteboard.push(...segments);
      touch(room);
      if (legacy) socket.to(roomCode).emit('whiteboard:draw', segments[0]);
      else io.to(roomCode).emit('whiteboard:drawBatch', segments);
      success(ack, { accepted: segments.length });
    }
    handle('whiteboard:draw', (body, ack, ctx) => draw([body], ack, ctx, true));
    handle('whiteboard:drawBatch', (body, ack, ctx) => draw(body, ack, ctx, false));
    handle('whiteboard:image', (body, ack, { roomCode, room, member }) => {
      const { url, x, y, w, h } = body;
      if (!validUpload(url) || ![x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 1) || ![w, h].every(n => Number.isFinite(n) && n > 0 && n <= 1)) {
        return fail(socket, 'whiteboard:image', ack, 'INVALID', '이미지와 위치를 확인하세요.');
      }
      if (room.whiteboard.length >= LIMITS.boardItems || room.whiteboardImages >= LIMITS.boardImages) return fail(socket, 'whiteboard:image', ack, 'BOARD_FULL', '화이트보드 이미지가 가득 찼습니다. 운영진에게 전체 지우기를 요청하세요.');
      if (!rateLimit(member.rate, 'image', 0.5, 3)) return fail(socket, 'whiteboard:image', ack, 'RATE_LIMIT', '잠시 후 다시 이미지를 추가하세요.');
      const item = { type: 'image', id: crypto.randomUUID(), url, x, y, w, h };
      room.whiteboard.push(item);
      room.whiteboardImages++;
      touch(room);
      io.to(roomCode).emit('whiteboard:image', item);
      success(ack);
    });
    handle('whiteboard:clear', (body, ack, { roomCode, room, member }) => {
      if (!rateLimit(member.rate, 'clear', 1, 3)) return fail(socket, 'whiteboard:clear', ack, 'RATE_LIMIT', '잠시 후 다시 시도하세요.');
      room.whiteboard = [];
      room.whiteboardImages = 0;
      touch(room);
      io.to(roomCode).emit('whiteboard:cleared');
      success(ack);
    }, { payload: false, staff: true });
    handle('room:leave', (body, ack) => {
      socket.data.joinVersion++;
      detach(socket);
      success(ack);
    }, { payload: false, joined: false });
    socket.on('disconnect', reason => {
      metrics.disconnects++;
      const label = Object.hasOwn(disconnectReasons, reason) ? reason : 'other';
      disconnectReasons[label]++;
      socket.data.joinVersion++;
      detach(socket, { reserve: reason !== 'client namespace disconnect' && reason !== 'server namespace disconnect' });
    });
  });

  function cleanupRooms(now = Date.now()) {
    for (const [code, room] of rooms) {
      if ([...room.members.values()].some(m => m.connected) || now - room.lastActivity < idleTtlMs) continue;
      deleteRoom(code, '오랫동안 사용하지 않은 강의실이 종료되었습니다.');
    }
  }
  function revokeInstructor(userId) {
    revokedUsers.add(userId);
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.userId !== userId) continue;
      socket.emit('app:error', { code: 'AUTH', event: 'instructor:join', message: '방장 인증이 만료되었습니다. 새로고침 후 다시 입장하세요.' });
      detach(socket);
      socket.disconnect(true);
    }
    for (const [code, room] of rooms) {
      for (const member of room.members.values()) if (member.userId === userId) removeMember(code, room, member);
    }
  }
  let cleanupTimer = null;
  function startCleanup() {
    if (!cleanupTimer) cleanupTimer = setInterval(cleanupRooms, cleanupIntervalMs);
    cleanupTimer.unref();
  }
  function close() {
    stopped = true;
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    for (const room of rooms.values()) for (const member of room.members.values()) clearTimeout(member.disconnectTimer);
  }
  function allowInstructor(userId) { revokedUsers.delete(userId); }
  function getMetrics() {
    return { ...metrics, activeConnections: io.sockets.sockets.size, activeRoomMembers: socketRoom.size,
      rooms: rooms.size, disconnectReasons: { ...disconnectReasons } };
  }
  return { rooms, getRoom, createRoom, createOwnedRoom, findOwnedRoom, deleteRoom, getHttpSession, revokeInstructor, allowInstructor, socketRoom, socketRole, cleanupRooms, startCleanup, close, getMetrics, limits: LIMITS };
}

module.exports = { createRealtime, LIMITS };
