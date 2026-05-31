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
  const COLORS = ['#1A2E24', '#C44545', '#3A6F8F', '#2D7A4F', '#B8862C', '#7B4FA8', '#E07A2F'];

  let socket = null;
  let canvas, ctx, wrap;
  let items = [];        // 누적 항목 (stroke | image) — 리사이즈 시 전체 재렌더용
  const imageCache = {}; // url -> { img, loaded }
  let dpr = window.devicePixelRatio || 1;
  let drawing = false;
  let last = null;       // 직전 정규화 좌표 {x, y}
  let color = COLORS[0];
  let size = 3;
  let erasing = false;
  let ready = false;

  function init(opts) {
    opts = opts || {};
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
        if (!canClear) return;
        if (confirm('화이트보드를 전체 지우시겠습니까?')) {
          socket.emit('whiteboard:clear');
        }
      });
      if (!canClear) clearEl.classList.add('hidden');
    }
  }

  // ── 좌표 변환 ──────────────────────────────────────────────────────────────
  function toNorm(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  // ── 포인터 이벤트 (마우스 + 터치) ────────────────────────────────────────────
  function bindPointer() {
    canvas.addEventListener('pointerdown', e => {
      drawing = true;
      last = toNorm(e);
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (!drawing) return;
      const p = toNorm(e);
      const seg = {
        type: 'stroke',
        x0: last.x, y0: last.y, x1: p.x, y1: p.y,
        color, width: size, erase: erasing
      };
      applyStroke(seg);
      socket.emit('whiteboard:draw', seg);
      last = p;
    });
    const stop = () => { drawing = false; last = null; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('pointerleave', stop);
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
    if (!/^image\//.test(file.type || '')) { alert('이미지 파일만 추가할 수 있습니다.'); return; }
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!data.url) throw new Error('no url');
      placeImage(data.url);
    } catch (err) {
      alert('이미지 업로드에 실패했습니다.');
    }
  }

  // 업로드된 이미지의 원본 비율을 읽어 보드 중앙에 적당한 크기로 배치 후 전파
  function placeImage(url) {
    const probe = new Image();
    probe.onload = () => {
      resize(); // 캔버스 크기 보정
      const cw = canvas.width || 1, ch = canvas.height || 1;
      const maxW = cw * 0.6, maxH = ch * 0.6;
      let wpx = probe.naturalWidth || 1;
      let hpx = probe.naturalHeight || 1;
      const scale = Math.min(maxW / wpx, maxH / hpx);
      wpx *= scale; hpx *= scale;
      const xpx = (cw - wpx) / 2;
      const ypx = (ch - hpx) / 2;
      // 서버가 전체(본인 포함)에 broadcast 하므로 로컬에서 직접 그리지 않음
      socket.emit('whiteboard:image', {
        url,
        x: xpx / cw, y: ypx / ch,
        w: wpx / cw, h: hpx / ch
      });
    };
    probe.onerror = () => alert('이미지를 불러오지 못했습니다.');
    probe.src = url;
  }

  // ── 화면 캡처 (getDisplayMedia 한 프레임) ────────────────────────────────────
  async function captureScreen() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      alert('이 브라우저에서는 화면 캡처를 지원하지 않습니다. 캡처 후 붙여넣기(Ctrl+V)를 이용하세요.');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch (err) {
      return; // 사용자가 취소
    }
    try {
      const track = stream.getVideoTracks()[0];
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise(r => setTimeout(r, 250)); // 프레임 안정화
      const cap = document.createElement('canvas');
      cap.width = video.videoWidth;
      cap.height = video.videoHeight;
      cap.getContext('2d').drawImage(video, 0, 0);
      track.stop();
      cap.toBlob(blob => {
        if (blob) uploadAndInsert(new File([blob], 'capture.png', { type: 'image/png' }));
      }, 'image/png');
    } catch (err) {
      alert('화면 캡처에 실패했습니다.');
      if (stream) stream.getTracks().forEach(t => t.stop());
    }
  }

  // ── 소켓 ────────────────────────────────────────────────────────────────────
  function bindSocket() {
    socket.on('whiteboard:draw', seg => applyStroke(seg));
    socket.on('whiteboard:image', item => applyImage(item));
    socket.on('whiteboard:cleared', () => {
      items = [];
      clearCanvas();
    });
  }

  // ── 렌더링 ──────────────────────────────────────────────────────────────────
  function applyStroke(seg) {
    items.push(seg);
    drawSeg(seg);
  }

  function applyImage(item) {
    items.push(item);
    drawImage(item);
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
    const cached = imageCache[item.url];
    if (cached && cached.loaded) {
      const w = canvas.width, h = canvas.height;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(cached.img, item.x * w, item.y * h, item.w * w, item.h * h);
      ctx.restore();
    } else if (!cached) {
      const img = new Image();
      imageCache[item.url] = { img, loaded: false };
      img.onload = () => { imageCache[item.url].loaded = true; renderAll(); };
      img.src = item.url;
    }
    // 캐시는 있으나 아직 로딩 중이면 onload 시 renderAll 로 그려짐
  }

  function clearCanvas() {
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function renderAll() {
    clearCanvas();
    items.forEach(it => {
      if (it.type === 'image') drawImage(it);
      else drawSeg(it);
    });
  }

  function resize() {
    if (!ready) return;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w === 0 || h === 0) return;  // 탭이 숨겨진 상태면 건너뜀
    dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    renderAll();
  }

  // ── 외부 API ────────────────────────────────────────────────────────────────
  function load(initialItems) {
    items = Array.isArray(initialItems) ? initialItems.slice() : [];
    // 탭이 보일 때 resize→renderAll 에서 그려짐. 보이는 상태면 즉시 렌더.
    resize();
  }

  function show() {
    // 화이트보드 탭이 활성화될 때 호출 — 숨겨져 있던 캔버스 크기 보정
    resize();
  }

  return { init, load, show };
})();
