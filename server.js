const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { createRealtime } = require('./lib/realtime');
const { installHttpServices } = require('./lib/http-services');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');
const { createHostIdentity } = require('./lib/host-identity');
const { LIMITS } = require('./lib/realtime');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 25000, pingTimeout: 60000, maxHttpBufferSize: 128 * 1024,
  perMessageDeflate: false
});

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Google OAuth is used only for the administrator. Room hosts are anonymous.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'buddykorea79@gmail.com').toLowerCase();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
      global: { fetch: (url, options = {}) => fetch(url, {
        ...options,
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000)
      }) }
    })
  : null;

if (!supabase) {
  console.warn('Supabase not configured — administrator login is unavailable (set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY)');
}

// Validate the administrator's Supabase access token.
async function getAuthUser(token) {
  if (!supabase || typeof token !== 'string' || !token || token.length > 16384) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error && (!error.status || error.status >= 500 || error.status === 429)) throw error;
    if (error || !data || !data.user) return null;
    return data.user;
  } catch (e) {
    throw Object.assign(new Error('인증 서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.'), { code: 'AUTH_UNAVAILABLE', status: 503 });
  }
}

// 관리자 페이지용 세션 토큰 (메모리 — 서버 재시작 시 재로그인 필요)
const adminTokens = new Map();
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;

// ── Uploads ───────────────────────────────────────────────────────────────────
const uploadsDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });


// ── Room state and realtime protocol ────────────────────────────────────────
const hostIdentity = createHostIdentity();
const realtime = createRealtime(io, {
  authenticateInstructor: async token => hostIdentity.verify(token)
});
const { rooms, getRoom, createRoom, getHttpSession } = realtime;
// ── Express middleware ────────────────────────────────────────────────────────
app.disable('x-powered-by');
app.set('query parser', 'simple');
app.use(express.json({ limit: '256kb', inflate: false }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
// Serve the exact installed auth client locally; a school network blocking a CDN
// must not prevent administrator login from loading.
app.get('/vendor/supabase.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js'));
});
app.use('/uploads', express.static(uploadsDir, {
  setHeaders: (res, filePath) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
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
// Lightweight health check for Render and diagnostics. Socket heartbeats keep active sessions alive.
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

// 브라우저용 공개 설정 — anon key 는 공개되어도 안전한 키 (RLS/Auth 가 보호)
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: SUPABASE_URL || null,
    supabaseAnonKey: SUPABASE_ANON_KEY || null
  });
});

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The browser's current origin keeps QR links on HTTPS behind Render's proxy.
function requestOrigin(req) {
  if (process.env.PUBLIC_ORIGIN) return new URL(process.env.PUBLIC_ORIGIN).origin;
  const protocol = req.secure || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  return new URL(protocol + '://' + req.get('host')).origin;
}

function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  if ((origin && origin !== requestOrigin(req)) || req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ ok: false, error: '현재 사이트에서 다시 시도하세요.' });
  }
  next();
}

app.get('/api/host/session', sameOrigin, (req, res) => {
  const { token, account } = hostIdentity.session(req, res);
  res.json({ ok: true, token, room: realtime.findOwnedRoom(account.userId), roomLimit: LIMITS.rooms });
});

app.post('/api/rooms', sameOrigin, (req, res) => {
  const account = hostIdentity.verify(hostIdentity.read(req));
  if (!account) return res.status(401).json({ ok: false, code: 'HOST_SESSION', error: '페이지를 새로고침하고 쿠키 허용 여부를 확인하세요.' });
  const lectureName = req.body?.lectureName;
  if (typeof lectureName !== 'string' || !lectureName.trim() || lectureName.trim().length > 100) {
    return res.status(400).json({ ok: false, code: 'INVALID', error: '강의실 이름을 1~100자로 입력하세요.' });
  }
  const result = realtime.createOwnedRoom(account.userId, lectureName);
  res.status(result.ok ? 201 : 409).json(result);
});

function roomSummary(includePrivate = false) {
  const list = Array.from(rooms, ([roomCode, room]) => ({
    roomCode, lectureName: room.lectureName,
    participantCount: [...room.students.values(), ...room.assistants.values()].filter(member => member.connected).length,
    capacity: room.capacity,
    ...(includePrivate ? { createdAt: room.createdAt } : {})
  }));
  return { ok: true, roomLimit: LIMITS.rooms, roomCount: list.length,
    totalParticipants: list.reduce((sum, room) => sum + room.participantCount, 0), rooms: list };
}
app.get('/api/rooms', (req, res) => res.json(roomSummary()));

app.get('/api/room/:code/qr.svg', asyncRoute(async (req, res) => {
  if (!getRoom(req.params.code)) return res.status(404).json({ ok: false, error: '강의실을 찾을 수 없습니다.' });
  const joinUrl = new URL('/student.html', requestOrigin(req));
  joinUrl.searchParams.set('code', req.params.code);
  const svg = await QRCode.toString(joinUrl.href, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 320 });
  res.type('image/svg+xml').send(svg);
}));

// ── 관리자: 로그인 — ADMIN_EMAIL 의 Google 계정으로 인증 ─────────────────────
app.post('/api/admin/auth', asyncRoute(async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = await getAuthUser(token);
  if (!user) {
    return res.status(401).json({ ok: false, error: '인증에 실패했습니다. 다시 로그인하세요.' });
  }
  const usesGoogle = user.app_metadata?.provider === 'google' ||
    user.identities?.some(identity => identity.provider === 'google');
  if ((user.email || '').toLowerCase() !== ADMIN_EMAIL || !usesGoogle) {
    return res.status(403).json({ ok: false, error: '관리자 계정이 아닙니다.' });
  }
  const adminToken = crypto.randomBytes(24).toString('hex');
  for (const [token, expires] of adminTokens) if (expires <= Date.now()) adminTokens.delete(token);
  while (adminTokens.size >= 100) adminTokens.delete(adminTokens.keys().next().value);
  adminTokens.set(adminToken, Date.now() + ADMIN_SESSION_MS);
  res.json({ ok: true, token: adminToken });
}));

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token) || adminTokens.get(token) <= Date.now()) {
    if (token) adminTokens.delete(token);
    return res.status(401).json({ ok: false, error: '관리자 인증이 필요합니다.' });
  }
  next();
}

app.get('/api/admin/rooms', requireAdmin, (req, res) => res.json(roomSummary(true)));
app.delete('/api/admin/rooms/:code', requireAdmin, sameOrigin, (req, res) => {
  if (!realtime.deleteRoom(req.params.code)) return res.status(404).json({ ok: false, error: '이미 삭제되었거나 존재하지 않는 강의실입니다.' });
  res.json({ ok: true });
});
app.post('/api/admin/logout', requireAdmin, sameOrigin, (req, res) => {
  adminTokens.delete(req.headers['x-admin-token']);
  res.json({ ok: true });
});

// 방 정보 조회 (URL 코드 접근 / 입장 전 정원 안내용)
app.get('/api/room/:code', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.json({ exists: false });
  res.json({
    exists: true,
    lectureName: room.lectureName,
    count: room.students.size,
    capacity: room.capacity,
    full: room.students.size >= room.capacity
  });
});

const httpServices = installHttpServices(app, { uploadsDir, getHttpSession, maxAiRequests: Number(process.env.AI_MAX_CONCURRENT || 32) });

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.code === 'AUTH_UNAVAILABLE' ? 503
    : Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  console.error('Request failed:', req.method, req.path, error.code || error.name);
  res.status(status).json({ ok: false, error: status === 503 ? error.message
    : status === 413 ? '요청 크기가 너무 큽니다.' : status === 400 ? '요청 형식이 올바르지 않습니다.' : '요청을 처리하지 못했습니다. 다시 시도해 주세요.' });
});
// Cleanup uses room inactivity rather than the host machine's midnight. Active
// classes remain intact regardless of timezone or calendar-day boundaries.
let diagnosticsTimer;
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
server.on('listening', () => {
  realtime.startCleanup();
  eventLoop.enable();
  diagnosticsTimer = setInterval(() => {
    const memory = process.memoryUsage();
    console.log(JSON.stringify({ event: 'server_health', rooms: rooms.size,
      connections: io.engine.clientsCount, rssMB: Math.round(memory.rss / 1048576),
      heapMB: Math.round(memory.heapUsed / 1048576),
      eventLoopP99Ms: Math.round(eventLoop.percentile(99) / 1000000),
      ...realtime.getMetrics()
    }));
    eventLoop.reset();
  }, 60000);
  diagnosticsTimer.unref();
});
let closing = null;
function close() {
  if (closing) return closing;
  clearInterval(diagnosticsTimer);
  eventLoop.disable();
  httpServices.close();
  realtime.close();
  closing = new Promise(resolve => io.close(resolve));
  return closing;
}

if (require.main === module) {
  server.listen(PORT, () => console.log(`EduTalk v3 running on port ${PORT}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    console.log(`${signal}: shutting down`);
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    close().then(() => { clearTimeout(deadline); process.exit(0); });
  });
}

module.exports = { app, server, io, realtime, rooms, getRoom, createRoom, getHttpSession,
  cleanupRooms: realtime.cleanupRooms, close };
