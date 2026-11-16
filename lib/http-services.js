'use strict';

const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const multer = require('multer');

const FILE_LIMIT = 20 * 1024 * 1024;
const DISK_LIMIT = 256 * 1024 * 1024;
const FILE_TTL = 24 * 60 * 60 * 1000;

function installHttpServices(app, { uploadsDir, getHttpSession, request = https.request, aiTimeoutMs = 60000, maxAiRequests = 32 }) {
  let diskBytes = 0;
  let activeUploads = 0;
  const uploading = new Set();
  const uploadRequests = new Set();
  const aiRequests = new Map();
  const aiLimit = Number.isInteger(maxAiRequests) && maxAiRequests > 0 && maxAiRequests <= 64 ? maxAiRequests : 32;
  let closing = false;
  const storageReady = fs.mkdir(uploadsDir, { recursive: true }).then(async () => {
    for (const name of await fs.readdir(uploadsDir)) {
      const stat = await fs.stat(path.join(uploadsDir, name));
      if (stat.isFile()) diskBytes += stat.size;
    }
  });
  storageReady.catch(error => console.error('Upload storage unavailable:', error.code));

  function requireMember(req, res, next) {
    if (closing) return res.status(503).json({ error: '서버를 재시작하고 있습니다. 잠시 후 다시 시도하세요.' });
    const session = getHttpSession(req.get('X-Socket-Id'), req.get('X-Upload-Token'));
    if (!session) return res.status(401).json({ error: '채팅방 연결을 복구한 뒤 다시 시도해 주세요.' });
    req.member = session;
    next();
  }

  const upload = multer({
    // Browser FormData sends UTF-8 filenames without an explicit charset.
    // Decode them once here so chat and shared resources retain the original name.
    defParamCharset: 'utf8',
    storage: multer.diskStorage({
      destination: uploadsDir,
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, randomUUID() + (/^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''));
      }
    }),
    limits: { fileSize: FILE_LIMIT, files: 1, fields: 0, parts: 1, fieldNameSize: 100 }
  }).single('file');

  app.post('/api/upload', requireMember, (req, res, next) => {
    storageReady.then(() => {
      if (req.destroyed) return;
      if (closing) return res.status(503).json({ error: '서버를 재시작하고 있습니다. 잠시 후 다시 시도하세요.' });
      const key = req.member.participantId;
      if (activeUploads >= 4 || uploading.has(key)) {
        return res.status(429).set('Retry-After', '3').json({ error: '다른 파일을 업로드 중입니다. 잠시 후 다시 시도해 주세요.' });
      }
      if (diskBytes + (activeUploads + 1) * FILE_LIMIT > DISK_LIMIT) {
        return res.status(507).json({ error: '업로드 저장 공간이 가득 찼습니다.' });
      }
      activeUploads++;
      uploading.add(key);
      uploadRequests.add(req);
      const timer = setTimeout(() => req.destroy(), 60000);
      timer.unref();
      upload(req, res, async err => {
        clearTimeout(timer);
        activeUploads--;
        uploading.delete(key);
        uploadRequests.delete(req);
        if (err) {
          if (res.destroyed) return;
          const invalidMultipart = err instanceof multer.MulterError || /Unexpected end of (form|file)|Malformed part header/i.test(err.message);
          return res.status(invalidMultipart ? 400 : 500).json({
            error: err.code === 'LIMIT_FILE_SIZE' ? '파일은 20MB 이하로 올려 주세요.' : '파일 업로드에 실패했습니다.'
          });
        }
        if (!req.file) return res.status(400).json({ error: '파일이 필요합니다.' });
        // A request can finish after its room/session has disappeared.
        const endingSession = getHttpSession(req.get('X-Socket-Id'), req.get('X-Upload-Token'));
        if (!endingSession || endingSession.roomCode !== req.member.roomCode || endingSession.participantId !== req.member.participantId) {
          await fs.unlink(req.file.path).catch(() => {});
          if (!res.destroyed) res.status(401).json({ error: '연결이 변경되었습니다. 파일을 다시 올려 주세요.' });
          return;
        }
        diskBytes += req.file.size;
        res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.originalname });
      });
    }).catch(next);
  });

  app.post('/api/ai/chat', requireMember, (req, res) => {
    const { messages, model, apiKey } = req.body || {};
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 512 || /[\r\n]/.test(apiKey)) {
      return res.status(400).json({ error: '올바른 API 키가 필요합니다.' });
    }
    if (!Array.isArray(messages) || !messages.length || messages.length > 40 ||
        messages.some(m => !m || !['user', 'assistant', 'system'].includes(m.role) ||
          typeof m.content !== 'string' || m.content.length > 20000) ||
        messages.reduce((n, m) => n + m.content.length, 0) > 60000 ||
        (model != null && (typeof model !== 'string' || model.length > 200))) {
      return res.status(400).json({ error: '대화가 너무 길거나 형식이 잘못되었습니다. 대화를 초기화해 주세요.' });
    }
    const key = req.member.participantId;
    if (aiRequests.has(key) || aiRequests.size >= aiLimit) {
      return res.status(429).set('Retry-After', '5').json({ error: 'AI 요청이 많습니다. 잠시 후 다시 시도해 주세요.' });
    }
    let upstream;
    let upstreamResponse;
    let done = false;
    let deadline;
    const finish = (status, payload) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      aiRequests.delete(key);
      res.off('close', cancelled);
      if (status && !res.destroyed && !res.headersSent) res.status(status).json(payload);
      upstreamResponse?.destroy();
      upstream?.destroy();
    };
    const cancelled = () => finish(0);
    aiRequests.set(key, () => finish(503, { error: '서버를 재시작하고 있습니다. 잠시 후 다시 시도하세요.' }));
    res.once('close', cancelled);
    deadline = setTimeout(() => finish(504, { error: 'AI 응답 시간이 초과되었습니다. 다시 시도해 주세요.' }), aiTimeoutMs);
    deadline.unref();
    try {
      upstream = request({
        hostname: process.env.AI_ROUTER_HOST || 'bizrouter.ai',
        path: process.env.AI_ROUTER_PATH || '/api/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-Title': 'EduTalk' }
      }, response => {
        upstreamResponse = response;
        if (done) { response.destroy(); return; }
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) return finish(502, { error: 'AI 응답이 너무 큽니다.' });
          chunks.push(Buffer.from(chunk));
        });
        response.once('error', () => finish(502, { error: 'AI 서버 연결이 끊어졌습니다.' }));
        response.once('aborted', () => finish(502, { error: 'AI 서버 연결이 끊어졌습니다.' }));
        response.once('end', () => {
          if (done) return;
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (response.statusCode !== 200) {
              const status = [400, 401, 403, 429].includes(response.statusCode) ? response.statusCode : 502;
              const detail = parsed.error?.message;
              return finish(status, { error: typeof detail === 'string' ? detail.slice(0, 400) : 'AI 서버 오류가 발생했습니다.' });
            }
            const content = parsed.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content) return finish(502, { error: 'AI 서버의 응답 형식이 올바르지 않습니다.' });
            finish(200, { content: content.slice(0, 20000) });
          } catch {
            finish(502, { error: 'AI 서버의 응답 형식이 올바르지 않습니다.' });
          }
        });
      });
      upstream.once('error', () => finish(502, { error: 'AI 서버에 연결할 수 없습니다.' }));
      upstream.end(JSON.stringify({ model: model || 'qwen/qwen3-coder', messages: messages.map(({ role, content }) => ({ role, content })) }));
    } catch {
      finish(502, { error: 'AI 요청을 처리할 수 없습니다.' });
    }
  });

  async function cleanupUploads() {
    await storageReady;
    for (const name of await fs.readdir(uploadsDir)) {
      const filename = path.join(uploadsDir, name);
      const stat = await fs.stat(filename).catch(() => null);
      if (stat?.isFile() && Date.now() - stat.mtimeMs > FILE_TTL) {
        await fs.unlink(filename);
        diskBytes = Math.max(0, diskBytes - stat.size);
      }
    }
  }
  const cleanupTimer = setInterval(() => cleanupUploads().catch(e => console.error('Upload cleanup failed:', e.code)), 60 * 60 * 1000);
  cleanupTimer.unref();
  return { close() {
    closing = true;
    clearInterval(cleanupTimer);
    for (const cancel of aiRequests.values()) cancel();
    for (const req of uploadRequests) req.destroy();
  }, cleanupUploads };
}

module.exports = { installHttpServices };
