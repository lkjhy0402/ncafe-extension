// NCAFE Tracker - Toast 알림 유틸 (content script용)
// 페이지 우상단에 일시적 토스트 표시.
// IIFE로 전역 오염 최소화. window.NCAFE_Toast로 노출.

(function () {
  if (window.NCAFE_Toast) return; // 중복 로드 방지

  const TOAST_ID = "ncafe-tracker-toast";
  const STYLE_ID = "ncafe-tracker-toast-style";

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${TOAST_ID} {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", sans-serif;
        font-size: 13px;
        max-width: 320px;
        padding: 12px 16px;
        border-radius: 8px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.18);
        opacity: 0;
        transform: translateY(-8px);
        transition: opacity 0.2s ease, transform 0.2s ease;
        pointer-events: auto;
        line-height: 1.45;
      }
      #${TOAST_ID}.show {
        opacity: 1;
        transform: translateY(0);
      }
      #${TOAST_ID}.ok {
        background: #18181b;
        color: #fff;
      }
      #${TOAST_ID}.err {
        background: #fef2f2;
        color: #b91c1c;
        border: 1px solid #fecaca;
      }
      #${TOAST_ID}.warn {
        background: #fffbeb;
        color: #b45309;
        border: 1px solid #fde68a;
      }
      #${TOAST_ID} .ncafe-toast-title {
        font-weight: 600;
        margin-bottom: 2px;
      }
      #${TOAST_ID} .ncafe-toast-msg {
        opacity: 0.9;
        font-size: 12px;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function show(opts) {
    const { title = "NCAFE", message = "", type = "ok", duration = 4000 } = opts;
    ensureStyle();

    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = TOAST_ID;
      document.body.appendChild(el);
    }
    el.className = type;
    el.innerHTML = `
      <div class="ncafe-toast-title">🎯 ${escapeHTML(title)}</div>
      ${message ? `<div class="ncafe-toast-msg">${escapeHTML(message)}</div>` : ""}
    `;

    requestAnimationFrame(() => el.classList.add("show"));

    if (el._timer) clearTimeout(el._timer);
    el._timer = setTimeout(() => {
      el.classList.remove("show");
    }, duration);
  }

  function escapeHTML(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  window.NCAFE_Toast = { show };
})();
