'use strict';

/* ============================================================================
   공유 화이트보드 (협업 그림판)
   - 좌표는 0~1 정규화 값으로 주고받아 화면 크기가 달라도 비율이 유지됨
   - 강사 / 조교 / 학생 모두 그릴 수 있음 (전체 지우기는 운영진만)
   - 페이지에 #wb-canvas, #wb-wrap, #wb-colors, #wb-size, #wb-eraser-btn,
     (#wb-clear-btn) 가 있어야 한다.
   사용법:
     Whiteboard.init({ socket, canClear: true });
     Whiteboard.load(segments);   // 입장 시 서버가 준 누적 세그먼트 재생
     Whiteboard.show();           // 화이트보드 탭이 보일 때 호출 (리사이즈)
   ============================================================================ */
window.Whiteboard = (function () {
  const COLORS = ['#1A2E24', '#C44545', '#3A6F8F', '#2D7A4F', '#B8862C', '#7B4FA8', '#E07A2F'];

  let socket = null;
  let canvas, ctx, wrap;
  let segments = [];     // 누적 세그먼트 (리사이즈 시 전체 재렌더용)
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
        x0: last.x, y0: last.y, x1: p.x, y1: p.y,
        color, width: size, erase: erasing
      };
      apply(seg);
      socket.emit('whiteboard:draw', seg);
      last = p;
    });
    const stop = () => { drawing = false; last = null; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('pointerleave', stop);
  }

  // ── 소켓 ────────────────────────────────────────────────────────────────────
  function bindSocket() {
    socket.on('whiteboard:draw', seg => apply(seg));
    socket.on('whiteboard:cleared', () => {
      segments = [];
      clearCanvas();
    });
  }

  // ── 렌더링 ──────────────────────────────────────────────────────────────────
  function apply(seg) {
    segments.push(seg);
    drawSeg(seg);
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

  function clearCanvas() {
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function renderAll() {
    clearCanvas();
    segments.forEach(drawSeg);
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
  function load(initialSegments) {
    segments = Array.isArray(initialSegments) ? initialSegments.slice() : [];
    // 탭이 보일 때 resize→renderAll 에서 그려짐. 보이는 상태면 즉시 렌더.
    resize();
  }

  function show() {
    // 화이트보드 탭이 활성화될 때 호출 — 숨겨져 있던 캔버스 크기 보정
    resize();
  }

  return { init, load, show };
})();
