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

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 25000, pingTimeout: 60000, maxHttpBufferSize: 128 * 1024,
  perMessageDeflate: false
});

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// 관리자 = 아래 이메일의 Google 계정. 이 계정으로 Google 로그인하면
// 관리자 페이지를 사용할 수 있고, 강사 프로필도 자동 승인된다.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'buddykorea79@gmail.com').toLowerCase();

// ── Supabase (인증 + 강사 프로필 영속화) ─────────────────────────────────────
// 인증은 Supabase Auth(Google OAuth)가 담당하고, 이 서버는 access token 을
// 검증한 뒤 instructor_profiles 테이블의 승인 상태만 관리한다.
//
// 필요 환경변수:
//   SUPABASE_URL              — 프로젝트 URL
//   SUPABASE_SERVICE_ROLE_KEY — 서버 전용 (토큰 검증·프로필 관리)
//   SUPABASE_ANON_KEY         — 브라우저 전용 (Google 로그인) — /api/config 로 노출
//
// 프로필 테이블 생성 SQL (프로젝트 SQL 에디터에서 한 번만 실행):
//   CREATE TABLE IF NOT EXISTS instructor_profiles (
//     user_id     UUID    PRIMARY KEY,
//     email       TEXT    UNIQUE NOT NULL,
//     name        TEXT    NOT NULL,
//     status      TEXT    NOT NULL DEFAULT 'pending',
//     created_at  BIGINT  NOT NULL,
//     approved_at BIGINT
//   );
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
  console.warn('Supabase not configured — instructor login is unavailable (set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY)');
}

// ── Instructor profiles (인메모리 캐시 + Supabase write-through) ─────────────
let instructorProfiles = []; // { userId, email, name, status, createdAt, approvedAt }
let profilesLoaded = false;

function dbToProfile(r) {
  return {
    userId: r.user_id, email: r.email, name: r.name,
    status: r.status, createdAt: r.created_at, approvedAt: r.approved_at ?? null
  };
}

async function loadInstructorProfiles() {
  if (!supabase) return;
  const { data, error } = await supabase.from('instructor_profiles').select('*');
  if (error) throw error;
  instructorProfiles = (data || []).map(dbToProfile);
  profilesLoaded = true;
  console.log(`Loaded ${instructorProfiles.length} instructor profiles from Supabase`);
}

const profilesReady = loadInstructorProfiles().catch(e => console.error('Supabase init error:', e.message));

async function findInstructorProfile(userId) {
  await profilesReady;
  const cached = instructorProfiles.find(p => p.userId === userId);
  if (cached) return cached;
  if (!supabase) return null;
  const { data, error } = await supabase.from('instructor_profiles').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw Object.assign(new Error('인증 서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.'), { code: 'AUTH_UNAVAILABLE', status: 503 });
  if (!data) return null;
  const profile = dbToProfile(data);
  const existing = instructorProfiles.find(p => p.userId === userId);
  if (existing) return existing;
  instructorProfiles.push(profile);
  return profile;
}

// Supabase access token 검증 → 사용자 반환 (강사 입장 / 관리자 로그인 공통)
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
const realtime = createRealtime(io, {
  authenticateInstructor: async token => {
    const user = await getAuthUser(token);
    return user ? findInstructorProfile(user.id) : null;
  }
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
// must not prevent instructor/admin login from loading.
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

// ── 강사 세션: Google 로그인 직후 호출 — 프로필 조회 (없으면 자동 생성) ───────
// Authorization: Bearer <supabase access token>
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.post('/api/instructor/session', asyncRoute(async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = await getAuthUser(token);
  if (!user) {
    return res.status(401).json({ ok: false, error: '인증에 실패했습니다. 다시 로그인하세요.' });
  }

  const email = (user.email || '').toLowerCase();
  let prof = await findInstructorProfile(user.id);

  if (!prof) {
    const isAdmin = email === ADMIN_EMAIL;
    const meta = user.user_metadata || {};
    prof = {
      userId: user.id,
      email,
      name: String(meta.full_name || meta.name || email.split('@')[0]).slice(0, 30),
      status: isAdmin ? 'approved' : 'pending',   // 관리자 계정은 자동 승인
      createdAt: Date.now(),
      approvedAt: isAdmin ? Date.now() : null
    };
    const { error } = await supabase.from('instructor_profiles').insert({
      user_id: prof.userId, email: prof.email, name: prof.name,
      status: prof.status, created_at: prof.createdAt, approved_at: prof.approvedAt
    });
    if (error && error.code !== '23505') {
      console.error('Supabase profile insert error:', error.message);
      return res.status(500).json({ ok: false, error: '서버 오류가 발생했습니다.' });
    }
    if (error?.code === '23505') {
      prof = await findInstructorProfile(user.id);
      if (!prof) throw new Error('Profile creation race');
    } else if (!instructorProfiles.some(p => p.userId === user.id)) {
      instructorProfiles.push(prof);
    }
  }

  res.json({
    ok: true,
    status: prof.status,
    name: prof.name,
    email: prof.email,
    isAdmin: email === ADMIN_EMAIL
  });
}));

// ── 관리자: 로그인 — ADMIN_EMAIL 의 Google 계정으로 인증 ─────────────────────
app.post('/api/admin/auth', asyncRoute(async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = await getAuthUser(token);
  if (!user) {
    return res.status(401).json({ ok: false, error: '인증에 실패했습니다. 다시 로그인하세요.' });
  }
  if ((user.email || '').toLowerCase() !== ADMIN_EMAIL) {
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

const profileMutations = new Set();
const profileMutation = fn => asyncRoute(async (req, res) => {
  const id = req.params.id;
  if (profileMutations.has(id)) return res.status(409).json({ ok: false, error: '이 계정을 처리 중입니다. 잠시 후 다시 시도하세요.' });
  profileMutations.add(id);
  try { await fn(req, res); }
  finally { profileMutations.delete(id); }
});

// ── 관리자: 강사 목록 조회 ─────────────────────────────────────────────────────
app.get('/api/admin/instructors', requireAdmin, asyncRoute(async (req, res) => {
  await profilesReady;
  if (!profilesLoaded) await loadInstructorProfiles();
  res.json({
    ok: true,
    instructors: instructorProfiles.map(p => ({
      id: p.userId, name: p.name, email: p.email,
      status: p.status, createdAt: p.createdAt, approvedAt: p.approvedAt
    }))
  });
}));

// ── 관리자: 승인 / 거절 / 보류 ─────────────────────────────────────────────────
app.post('/api/admin/instructors/:id/status', requireAdmin, profileMutation(async (req, res) => {
  const { status } = req.body || {};
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ ok: false, error: '잘못된 상태값입니다.' });
  }
  const prof = instructorProfiles.find(p => p.userId === req.params.id);
  if (!prof) return res.status(404).json({ ok: false, error: '계정을 찾을 수 없습니다.' });
  if (prof.email === ADMIN_EMAIL && status !== 'approved') {
    return res.status(400).json({ ok: false, error: '관리자 계정의 승인 상태는 변경할 수 없습니다.' });
  }

  const approvedAt = status === 'approved' ? Date.now() : null;
  const update = { status };
  update.approved_at = approvedAt;
  const { error } = await supabase.from('instructor_profiles').update(update).eq('user_id', prof.userId);
  if (error) {
    console.error('Supabase status update error:', error.message);
    return res.status(500).json({ ok: false, error: '서버 오류가 발생했습니다.' });
  }
  prof.status = status;
  prof.approvedAt = approvedAt;
  if (status !== 'approved') realtime.revokeInstructor(prof.userId);
  else realtime.allowInstructor(prof.userId);
  res.json({ ok: true });
}));

// ── 관리자: 계정 삭제 (프로필 + Supabase Auth 사용자 모두 삭제) ───────────────
app.delete('/api/admin/instructors/:id', requireAdmin, profileMutation(async (req, res) => {
  const idx = instructorProfiles.findIndex(p => p.userId === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: '계정을 찾을 수 없습니다.' });
  if (instructorProfiles[idx].email === ADMIN_EMAIL) {
    return res.status(400).json({ ok: false, error: '관리자 계정은 삭제할 수 없습니다.' });
  }

  const { error: authError } = await supabase.auth.admin.deleteUser(req.params.id);
  if (authError && authError.status !== 404) throw authError;
  realtime.revokeInstructor(req.params.id);
  const { error } = await supabase.from('instructor_profiles').delete().eq('user_id', req.params.id);
  if (error) {
    console.error('Supabase delete error:', error.message);
    return res.status(500).json({ ok: false, error: '서버 오류가 발생했습니다.' });
  }
  instructorProfiles = instructorProfiles.filter(p => p.userId !== req.params.id);
  res.json({ ok: true });
}));

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
