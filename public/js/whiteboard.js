'use strict';

/* ============================================================================
   공유 화이트보드 (협업 그림판 + 이미지/화면 캡처 삽입)
   - 좌표/크기는 0~1 정규화 값으로 주고받아 화면 크기가 달라도 비율이 유지됨
   - 강사 / 조교 / 학생 모두 그리기·이미지 삽입 가능 (전체 지우기는 운영진만)
   - 보드 상태(items)는 stroke / image 항목이 시간순으로 쌓인 배열
   페이지 요구 요소:
     #wb-canvas, #wb-wrap, #wb-colors, #wb-size, #wb-eraser-btn,
     #wb-image-btn, #wb-image-input, #wb-capture-btn, (#wb-clear-btn)
   사용법:
     Whiteboard.init({ socket, canClear: true });
     Whiteboard.load(items);   // 입장 시 서버가 준 누적 항목 재생
     Whiteboard.show();        // 화이트보드 탭이 보일 때 호출 (리사이즈)
   ============================================================================ */
window.Whiteboard = (function () {
  const COLORS = ['#1A3048', '#5BA3E8', '#3DBDBD', '#3DBD7D', '#F0A830', '#9B6FC8', '#F06070'];
  const MAX_ITEMS = 10000;
  const MAX_IMAGES = 32;
  const BATCH_SIZE = 16;
  const BATCH_MS = 40;
  const MAX_PENDING = 160;
  const RENDER_CHUNK = 200;

  let socket = null;
  let canvas, ctx, wrap;
  let items = [];        // 누적 항목 (stroke | image) — 리사이즈 시 전체 재렌더용
  const imageCache = new Map(); // 현재 보드에 있는 이미지만 보관
  let dpr = window.devicePixelRatio || 1;
  let drawing = false;
  let last = null;       // 직전 정규화 좌표 {x, y}
  let pointerId = null;
  let nextPoint = null;
  let pointerFrame = null;
  let pending = [];
  let flushTimer = null;
  let renderFrame = null;
  let renderIndex = 0;
  let needsClear = true;
  let isReady = () => false;
  let uploadHeaders = () => ({});
  let boardVersion = 0;
  let lastNoticeAt = 0;
  let uploadBusy = false;
  let captureBusy = false;
  const uploads = new Set();
  let color = COLORS[0];
  let size = 3;
  let erasing = false;
  let ready = false;

  function init(opts) {
    opts = opts || {};
    isReady = opts.isReady || (() => !!(socket && socket.connected && socket.roomReady));
    uploadHeaders = opts.uploadHeaders || (() => ({}));
    if (ready) return;
    socket = opts.socket;
    canvas = document.getElementById('wb-canvas');
    wrap = document.getElementById('wb-wrap');
    if (!canvas || !wrap || !socket) return;
    ctx = canvas.getContext('2d');
    ready = true;

    buildPalette();
    bindToolbar(opts.canClear);
    bindPointer();
    bindPaste();
    bindSocket();

    window.addEventListener('resize', resize);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(wrap);
  }

  function notice(message) {
    if (Date.now() - lastNoticeAt < 3000) return;
    lastNoticeAt = Date.now();
    if (typeof showToast === 'function') showToast(message, 4000);
    else alert(message);
  }

  function canSend() {
    if (!ready || !socket.connected || !isReady()) return false;
    return true;
  }

  // ── 팔레트 / 툴바 ──────────────────────────────────────────────────────────
  function buildPalette() {
    const wrapEl = document.getElementById('wb-colors');
    if (!wrapEl) return;
    wrapEl.innerHTML = '';
    COLORS.forEach((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wb-color' + (i === 0 ? ' selected' : '');
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => {
        color = c;
        erasing = false;
        document.querySelectorAll('.wb-color').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        const er = document.getElementById('wb-eraser-btn');
        if (er) er.classList.remove('active');
      });
      wrapEl.appendChild(b);
    });
  }

  function bindToolbar(canClear) {
    const sizeEl = document.getElementById('wb-size');
    if (sizeEl) {
      size = parseInt(sizeEl.value, 10) || 3;
      sizeEl.addEventListener('input', () => { size = parseInt(sizeEl.value, 10) || 3; });
    }

    const eraserEl = document.getElementById('wb-eraser-btn');
    if (eraserEl) {
      eraserEl.addEventListener('click', () => {
        erasing = !erasing;
        eraserEl.classList.toggle('active', erasing);
        if (erasing) {
          document.querySelectorAll('.wb-color').forEach(x => x.classList.remove('selected'));
        }
      });
    }

    // 이미지 파일 삽입
    const imgBtn = document.getElementById('wb-image-btn');
    const imgInput = document.getElementById('wb-image-input');
    if (imgBtn && imgInput) {
      imgBtn.addEventListener('click', () => imgInput.click());
      imgInput.addEventListener('change', function () {
        if (this.files && this.files[0]) uploadAndInsert(this.files[0]);
        this.value = '';
      });
    }

    // 화면 캡처 삽입
    const capBtn = document.getElementById('wb-capture-btn');
    if (capBtn) capBtn.addEventListener('click', captureScreen);

    const clearEl = document.getElementById('wb-clear-btn');
    if (clearEl) {
      // 전체 지우기 버튼이 보이는 경우(운영진)만 동작
      clearEl.addEventListener('click', () => {
        if (!canClear || !canSend()) return;
        if (confirm('화이트보드를 전체 지우시겠습니까?')) {
          stopDrawing(false);
          socket.emit('whiteboard:clear');
        }
      });
      if (!canClear) clearEl.classList.add('hidden');
    }
  }

  // ── 좌표 변환 ──────────────────────────────────────────────────────────────
  function toNorm(e) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  // ── 포인터 이벤트 (마우스 + 터치) ────────────────────────────────────────────
  function bindPointer() {
    canvas.addEventListener('pointerdown', e => {
      if (e.isPrimary === false || (e.button !== undefined && e.button !== 0)) return;
      if (!canSend()) { notice('연결을 복구한 뒤 화이트보드를 사용할 수 있습니다.'); return; }
      if (items.length >= MAX_ITEMS) { notice('화이트보드가 가득 찼습니다. 운영진에게 전체 지우기를 요청하세요.'); return; }
      const point = toNorm(e);
      if (!point) return;
      drawing = true;
      last = point;
      pointerId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (!drawing || e.pointerId !== pointerId) return;
      nextPoint = toNorm(e);
      // 고주사율 펜에서도 프레임당 한 번만 표본화한다.
      if (pointerFrame === null) pointerFrame = requestAnimationFrame(samplePointer);
    });
    canvas.addEventListener('pointerup', e => {
      if (e.pointerId !== pointerId) return;
      nextPoint = toNorm(e);
      stopDrawing(true);
    });
    canvas.addEventListener('pointercancel', () => stopDrawing(true));
    canvas.addEventListener('lostpointercapture', () => stopDrawing(true));
  }

  function samplePointer() {
    pointerFrame = null;
    if (!drawing || !last || !nextPoint || !canSend()) return;
    const p = nextPoint;
    nextPoint = null;
    if (p.x === last.x && p.y === last.y) return;
    if (pending.length >= MAX_PENDING || items.length + pending.length >= MAX_ITEMS) {
      notice('그리기 전송이 밀리고 있습니다. 잠시 후 다시 그려 주세요.');
      stopDrawing(false);
      return;
    }
    pending.push({ type: 'stroke', x0: last.x, y0: last.y, x1: p.x, y1: p.y,
      color, width: size, erase: erasing });
    last = p;
    // 서버가 확정한 순서대로 본인을 포함해 렌더링한다.
    if (flushTimer === null) flushTimer = setTimeout(flushStrokes, BATCH_MS);
  }

  function stopDrawing(flush) {
    if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
    pointerFrame = null;
    if (flush) samplePointer();
    drawing = false;
    last = nextPoint = null;
    pointerId = null;
    if (flush) flushStrokes();
    else {
      pending = [];
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function flushStrokes() {
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    if (!canSend()) { pending = []; return; }
    if (!pending.length) return;
    const batch = pending.splice(0, BATCH_SIZE);
    const version = boardVersion;
    socket.timeout(5000).emit('whiteboard:drawBatch', batch, (err, result) => {
      if (version !== boardVersion || !canSend()) return;
      if (err) { notice('그리기 전송 확인이 지연되고 있습니다. 연결 상태를 확인하세요.'); return; }
      if (result && !result.ok) {
        stopDrawing(false);
        notice(result.message || result.error || '그리기를 전송하지 못했습니다.');
      }
    });
    if (pending.length) flushTimer = setTimeout(flushStrokes, BATCH_MS);
  }

  // ── 붙여넣기(Ctrl+V)로 캡처 이미지 삽입 ──────────────────────────────────────
  function bindPaste() {
    document.addEventListener('paste', e => {
      if (!ready || !wrap || wrap.clientWidth === 0) return; // 화이트보드 탭 활성 시에만
      const data = e.clipboardData;
      if (!data || !data.items) return;
      for (const it of data.items) {
        if (it.type && it.type.indexOf('image') === 0) {
          const file = it.getAsFile();
          if (file) { uploadAndInsert(file); e.preventDefault(); }
          break;
        }
      }
    });
  }

  // ── 이미지 업로드 후 보드에 삽입 ─────────────────────────────────────────────
  async function uploadAndInsert(file) {
    if (!file) return;
    if (!canSend()) { notice('연결을 복구한 뒤 이미지를 추가할 수 있습니다.'); return; }
    if (uploadBusy) { notice('이전 이미지 업로드가 완료될 때까지 기다려 주세요.'); return; }
    if (!/^image\//.test(file.type || '')) { alert('이미지 파일만 추가할 수 있습니다.'); return; }
    if (file.size > 8 * 1024 * 1024) { alert('이미지는 8MB 이하로 추가해 주세요.'); return; }
    if (items.filter(item => item.type === 'image').length >= MAX_IMAGES) {
      notice('이미지는 보드당 32개까지 추가할 수 있습니다. 운영진에게 전체 지우기를 요청하세요.');
      return;
    }
    uploadBusy = true;
    const version = boardVersion;
    const controller = new AbortController();
    uploads.add(controller);
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      // 30명이 원본 고해상도 캡처를 동시에 디코딩하지 않도록 업로드 전에 축소한다.
      const image = await prepareImage(file, controller.signal);
      if (!canSend() || version !== boardVersion) return;
      const fd = new FormData();
      fd.append('file', image.blob, 'whiteboard.png');
      const res = await fetch('/api/upload', { method: 'POST', body: fd,
        headers: uploadHeaders(), signal: controller.signal });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || '업로드 실패');
      if (!canSend() || version !== boardVersion) return;
      placeImage(data.url, image.width, image.height);
    } catch (err) {
      if (version === boardVersion) notice('이미지 업로드에 실패했습니다. 연결 상태와 파일을 확인해 주세요.');
    } finally {
      clearTimeout(timeout);
      uploads.delete(controller);
      uploadBusy = false;
    }
  }

  function prepareImage(file, signal) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      const clean = () => {
        URL.revokeObjectURL(url);
        signal.removeEventListener('abort', abort);
        img.onload = img.onerror = null;
      };
      const abort = () => { clean(); img.src = ''; reject(new Error('upload aborted')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      img.onerror = () => { clean(); reject(new Error('invalid image')); };
      img.onload = () => {
        const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        const preview = document.createElement('canvas');
        preview.width = Math.max(1, Math.round(img.naturalWidth * scale));
        preview.height = Math.max(1, Math.round(img.naturalHeight * scale));
        try {
          preview.getContext('2d').drawImage(img, 0, 0, preview.width, preview.height);
          preview.toBlob(blob => {
            clean();
            if (signal.aborted || !blob) { reject(new Error('image conversion failed')); return; }
            resolve({ blob, width: preview.width, height: preview.height });
          }, 'image/png');
        } catch (err) { clean(); reject(err); }
      };
      img.src = url;
    });
  }

  function placeImage(url, imageWidth, imageHeight) {
    if (!canSend()) return;
    while (pending.length) flushStrokes();
    resize();
    const cw = canvas.width || 1, ch = canvas.height || 1;
    const scale = Math.min(cw * 0.6 / imageWidth, ch * 0.6 / imageHeight);
    const w = imageWidth * scale / cw, h = imageHeight * scale / ch;
    socket.emit('whiteboard:image', { url, x: (1 - w) / 2, y: (1 - h) / 2, w, h });
  }
  // ── 화면 캡처 (getDisplayMedia 한 프레임) ────────────────────────────────────
  async function captureScreen() {
    if (!canSend()) { notice('연결을 복구한 뒤 화면을 캡처할 수 있습니다.'); return; }
    if (captureBusy || uploadBusy) { notice('이전 이미지 작업이 완료될 때까지 기다려 주세요.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      alert('이 브라우저에서는 화면 캡처를 지원하지 않습니다. 캡처 후 붙여넣기(Ctrl+V)를 이용하세요.');
      return;
    }
    captureBusy = true;
    const version = boardVersion;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch (err) {
      captureBusy = false;
      return; // 사용자가 취소
    }
    let playTimeout;
    try {
      if (version !== boardVersion || !canSend()) return;
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await Promise.race([video.play(), new Promise((resolve, reject) => {
        playTimeout = setTimeout(() => reject(new Error('capture timeout')), 10000);
      })]);
      await new Promise(r => setTimeout(r, 250)); // 프레임 안정화
      if (version !== boardVersion || !canSend()) return;
      const cap = document.createElement('canvas');
      const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
      cap.width = Math.max(1, Math.round(video.videoWidth * scale));
      cap.height = Math.max(1, Math.round(video.videoHeight * scale));
      cap.getContext('2d').drawImage(video, 0, 0, cap.width, cap.height);
      cap.toBlob(blob => {
        if (blob && version === boardVersion) uploadAndInsert(new File([blob], 'capture.png', { type: 'image/png' }));
      }, 'image/png');
    } catch (err) {
      alert('화면 캡처에 실패했습니다.');
    } finally {
      clearTimeout(playTimeout);
      captureBusy = false;
      if (stream) stream.getTracks().forEach(t => t.stop());
    }
  }

  // ── 소켓 ────────────────────────────────────────────────────────────────────
  function bindSocket() {
    socket.on('whiteboard:draw', seg => applyStroke(seg));
    socket.on('whiteboard:drawBatch', batch => {
      if (Array.isArray(batch)) batch.slice(0, BATCH_SIZE).forEach(applyStroke);
    });
    socket.on('whiteboard:image', item => applyImage(item));
    socket.on('whiteboard:cleared', () => load([]));
    socket.on('disconnect', () => {
      boardVersion++;
      stopDrawing(false);
      uploads.forEach(controller => controller.abort());
    });
  }

  // ── 렌더링 ──────────────────────────────────────────────────────────────────
  function applyStroke(seg) {
    if (!seg || items.length >= MAX_ITEMS) return;
    items.push(seg);
    scheduleRender();
  }

  function applyImage(item) {
    if (!item || items.length >= MAX_ITEMS || items.filter(it => it.type === 'image').length >= MAX_IMAGES) return;
    items.push(item);
    scheduleRender();
  }

  function drawSeg(s) {
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = s.width * dpr;
    if (s.erase) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = s.color || '#1A2E24';
    }
    ctx.beginPath();
    ctx.moveTo(s.x0 * w, s.y0 * h);
    ctx.lineTo(s.x1 * w, s.y1 * h);
    ctx.stroke();
    ctx.restore();
  }

  function drawImage(item) {
    if (!ctx) return;
    const cached = imageCache.get(item.url);
    if (cached && cached.loaded) {
      const w = canvas.width, h = canvas.height;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(cached.img, item.x * w, item.y * h, item.w * w, item.h * h);
      ctx.restore();
    } else if (!cached) {
      const img = new Image();
      const entry = { img, loaded: false };
      imageCache.set(item.url, entry);
      img.onload = () => {
        if (imageCache.get(item.url) !== entry) return;
        entry.loaded = true;
        // 비동기 로딩 순서와 관계없이 스트로크/이미지의 서버 순서대로 다시 그린다.
        invalidateRender();
      };
      img.onerror = () => { entry.failed = true; };
      img.src = item.url;
    }
    // 캐시는 있으나 아직 로딩 중이면 onload 시 renderAll 로 그려짐
  }

  function clearCanvas() {
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function invalidateRender() {
    needsClear = true;
    renderIndex = 0;
    scheduleRender();
  }

  function scheduleRender() {
    if (!ready || !wrap.clientWidth || !wrap.clientHeight || renderFrame !== null) return;
    renderFrame = requestAnimationFrame(renderChunk);
  }

  function renderChunk() {
    renderFrame = null;
    if (!wrap.clientWidth || !wrap.clientHeight) return;
    if (needsClear) { clearCanvas(); needsClear = false; }
    const end = Math.min(renderIndex + RENDER_CHUNK, items.length);
    for (; renderIndex < end; renderIndex++) {
      const item = items[renderIndex];
      if (item.type === 'image') drawImage(item);
      else drawSeg(item);
    }
    if (renderIndex < items.length) scheduleRender();
  }

  function resize() {
    if (!ready) return;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w === 0 || h === 0) return;  // 탭이 숨겨진 상태면 건너뜀
    dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8000000 / (w * h)));
    const pixelWidth = Math.max(1, Math.round(w * dpr));
    const pixelHeight = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      invalidateRender();
    }
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    scheduleRender();
  }

  // ── 외부 API ────────────────────────────────────────────────────────────────
  function load(initialItems) {
    boardVersion++;
    stopDrawing(false);
    uploads.forEach(controller => controller.abort());
    let imageCount = 0;
    items = Array.isArray(initialItems) ? initialItems.slice(0, MAX_ITEMS).filter(item => {
      if (!item || typeof item !== 'object') return false;
      return item.type !== 'image' || ++imageCount <= MAX_IMAGES;
    }) : [];
    const urls = new Set(items.filter(item => item.type === 'image').map(item => item.url));
    for (const [url, cached] of imageCache) {
      if (urls.has(url)) continue;
      cached.img.onload = cached.img.onerror = null;
      cached.img.src = '';
      imageCache.delete(url);
    }
    invalidateRender();
    // 탭이 보일 때 resize→renderAll 에서 그려짐. 보이는 상태면 즉시 렌더.
    resize();
  }

  function show() {
    // 화이트보드 탭이 활성화될 때 호출 — 숨겨져 있던 캔버스 크기 보정
    resize();
  }

  return { init, load, show };
})();
