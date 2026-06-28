'use strict';

/* ============================================================================
   경량 마크다운 렌더러 — XSS 안전 (항상 HTML escape 후 마크다운 변환)
   window.renderMarkdown(text) → HTML 문자열
   외부 라이브러리 의존 없음. AI 답변 표시에 사용.
   ============================================================================ */
window.renderMarkdown = (function () {
  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 이미 escape 된 텍스트에 인라인 서식 적용
  function inline(s) {
    const codes = [];
    // 인라인 코드 `...` 는 먼저 보호(다른 변환 적용 방지)
    s = s.replace(/`([^`]+)`/g, (m, c) => {
      codes.push(c);
      return '\x00' + (codes.length - 1) + '\x00';
    });
    // 링크 [라벨](url) — http(s) 만 허용
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (m, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="md-link">${label}</a>`);
    // 굵게 **text**
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // 기울임 *text*
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    // 취소선 ~~text~~
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // 보호했던 인라인 코드 복원
    s = s.replace(/\x00(\d+)\x00/g, (m, i) => `<code class="md-code">${codes[i]}</code>`);
    return s;
  }

  return function renderMarkdown(raw) {
    if (!raw) return '';
    const lines = String(raw).replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let i = 0;
    let inList = null; // 'ul' | 'ol'

    function closeList() {
      if (inList) { html += `</${inList}>`; inList = null; }
    }

    while (i < lines.length) {
      const line = lines[i];

      // 코드 블록 ```
      if (/^```/.test(line)) {
        closeList();
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 닫는 펜스 건너뜀
        html += `<pre class="md-pre"><code>${escHtml(buf.join('\n'))}</code></pre>`;
        continue;
      }

      // 제목 #, ##, ###
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        closeList();
        const level = h[1].length;
        html += `<h${level} class="md-h">${inline(escHtml(h[2]))}</h${level}>`;
        i++;
        continue;
      }

      // 인용 >
      const bq = line.match(/^>\s?(.*)$/);
      if (bq) {
        closeList();
        html += `<blockquote class="md-quote">${inline(escHtml(bq[1]))}</blockquote>`;
        i++;
        continue;
      }

      // 구분선
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        closeList();
        html += '<hr class="md-hr">';
        i++;
        continue;
      }

      // 순서 없는 목록 -, *, +
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        if (inList !== 'ul') { closeList(); html += '<ul class="md-list">'; inList = 'ul'; }
        html += `<li>${inline(escHtml(ul[1]))}</li>`;
        i++;
        continue;
      }

      // 순서 있는 목록 1.
      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ol) {
        if (inList !== 'ol') { closeList(); html += '<ol class="md-list">'; inList = 'ol'; }
        html += `<li>${inline(escHtml(ol[1]))}</li>`;
        i++;
        continue;
      }

      // 빈 줄
      if (/^\s*$/.test(line)) { closeList(); i++; continue; }

      // 문단 — 연속된 일반 줄 묶기
      closeList();
      const para = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i])
             && !/^```/.test(lines[i])
             && !/^#{1,6}\s/.test(lines[i])
             && !/^>\s?/.test(lines[i])
             && !/^\s*[-*+]\s+/.test(lines[i])
             && !/^\s*\d+\.\s+/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      html += `<p class="md-p">${inline(escHtml(para.join('\n'))).replace(/\n/g, '<br>')}</p>`;
    }
    closeList();
    return html;
  };
})();
