// NCAFE Tracker - 자동 입력 + 페르소나 검증
//
// 1) NCAFE 도메인: postMessage 'NCAFE_AUTO_FILL' 수신 → chrome.storage.local 저장
// 2) cafe.naver.com: 저장된 데이터 확인 → 닉네임 검증 → 글쓰기 페이지 이동 → 제목·본문 자동 입력
//
// 절대 [임시저장]/[등록] 자동 클릭 X — 본인이 직접 클릭해야 함 (약관 준수)

(function () {
  if (window.__NCAFE_CAFE_WRITE_LOADED__) return;
  window.__NCAFE_CAFE_WRITE_LOADED__ = true;

  const STORAGE_KEY = "ncafe_pending_auto_fill";
  const MAX_AGE_MS = 5 * 60 * 1000; // 5분

  const onNCAFE = /(?:^|\.)ncafe-web\.vercel\.app$/.test(location.hostname) ||
                  location.hostname.endsWith(".vercel.app");
  const onCafe = location.hostname === "cafe.naver.com";

  // ─── A. NCAFE 도메인: postMessage 수신 → storage 저장 ──────────────
  if (onNCAFE) {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || msg.type !== "NCAFE_AUTO_FILL") return;
      if (!msg.data) return;

      try {
        chrome.storage.local.set({
          [STORAGE_KEY]: { ...msg.data, ts: msg.data.ts || Date.now() },
        });
        console.log("[NCAFE] auto-fill data saved", msg.data.cafeName);
      } catch (e) {
        console.error("[NCAFE] storage save failed", e);
      }
    });
    return; // NCAFE 측은 여기서 끝
  }

  // ─── B. 카페 도메인: 데이터 확인 후 검증 + 입력 ───────────────────
  if (!onCafe) return;

  // 페이지 종류
  const HREF = () => location.href;
  function isWritePage() {
    const u = HREF();
    return u.includes("ArticleWrite.nhn") ||
           /\/f-e\/cafes\/\d+\/articles\/write/.test(u) ||
           /\/ca-fe\/cafes\/\d+\/articles\/write/.test(u);
  }
  function isBoardPage() {
    const u = HREF();
    return u.includes("ArticleList.nhn") ||
           /\/f-e\/cafes\/\d+\/menus\/\d+/.test(u) ||
           /\/ca-fe\/cafes\/\d+\/menus\/\d+/.test(u);
  }

  // ─── 닉네임 추출 (다중 셀렉터) ────────────────────────────────────
  // 네이버 카페 디자인 변동에 대비해 여러 셀렉터를 시도. iframe도 포함.
  const NICK_SELECTORS = [
    ".cafe_member_nick",
    ".member_nick",
    ".user-info .nickname",
    ".user_nick",
    ".profile_area .nick",
    ".my_info .nickname",
    ".pers_nick_area .nickname",
    'a[class*="my-cafe-nick"]',
    'span[class*="nick"][class*="my"]',
    "div.cafe_personal_area .nickname",
    ".gnb_my_nickname",
    "[data-nickname]",
    ".profile-nickname",
    ".m_my_info .nickname",
  ];
  function cleanNick(s) {
    return (s || "")
      .replace(/(님|회원|\s*\(.*?\))$/g, "")
      .trim();
  }
  function extractNickFromDoc(doc) {
    if (!doc) return null;
    for (const sel of NICK_SELECTORS) {
      const el = doc.querySelector(sel);
      if (!el) continue;
      const txt = (el.textContent || el.dataset?.nickname || "").trim();
      if (txt && txt.length < 50) {
        const cleaned = cleanNick(txt);
        if (cleaned) return cleaned;
      }
    }
    return null;
  }
  function extractCurrentNickname() {
    const top = extractNickFromDoc(document);
    if (top) return top;
    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        const sub = extractNickFromDoc(iframe.contentDocument);
        if (sub) return sub;
      } catch { /* cross-origin */ }
    }
    return null;
  }

  // ─── 토스트 알림 ─────────────────────────────────────────────────
  function showNotice(message, type) {
    // 우선 NCAFE_Toast 사용 (toast.js 로드된 경우)
    try {
      if (window.NCAFE_Toast?.show) {
        window.NCAFE_Toast.show({
          title: "NCAFE 자동 입력",
          message,
          type: type === "error" ? "err" : type === "warn" ? "warn" : "ok",
          duration: 8000,
        });
        return;
      }
    } catch { /* fallthrough */ }

    // fallback: 직접 DOM 알림
    const colors = { ok: "#16a34a", error: "#dc2626", warn: "#d97706" };
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;top:20px;right:20px;background:" + (colors[type] || colors.ok) +
      ";color:#fff;padding:14px 16px;border-radius:8px;z-index:2147483647;max-width:420px;" +
      "font-size:13px;line-height:1.5;white-space:pre-line;box-shadow:0 6px 20px rgba(0,0,0,0.2);" +
      'font-family:-apple-system,"Apple SD Gothic Neo",sans-serif;';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 10000);
  }

  // ─── 글쓰기 버튼 찾기 ─────────────────────────────────────────────
  function findWriteButton() {
    const selectors = [
      'a[href*="ArticleWrite"]',
      'a[href*="/articles/write"]',
      ".btn_write",
      ".article-write-btn",
      ".btn-write",
      'button[class*="write"]',
      'a[class*="write"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && /글쓰기|작성/.test(el.textContent || "") || el?.matches('a[href*="Write"]')) {
        return el;
      }
    }
    return null;
  }

  // ─── 폼 자동 입력 ─────────────────────────────────────────────────
  function fireInput(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function fillTitle(doc, title) {
    const sels = [
      'input[name="subject"]',
      'input.subject',
      '.se-input-text-area input',
      'input[placeholder*="제목"]',
      '.tit_text input',
    ];
    for (const sel of sels) {
      const el = doc.querySelector(sel);
      if (el && el.tagName === "INPUT") {
        el.focus();
        el.value = title;
        fireInput(el);
        return true;
      }
    }
    return false;
  }
  function fillBody(doc, body) {
    // SmartEditor v3 (se-)
    const seArea = doc.querySelector(".se-content");
    if (seArea) {
      // 단락별로 분리하여 paragraph div 생성
      const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim());
      const html = paragraphs
        .map((p) => `<div class="se-text-paragraph">${escapeHtml(p)}</div>`)
        .join("");
      try {
        seArea.innerHTML = html;
        fireInput(seArea);
        return true;
      } catch { /* fallthrough */ }
    }

    // 일반 contenteditable
    const editable = doc.querySelector('[contenteditable="true"]');
    if (editable) {
      editable.focus();
      // \n\n을 <br><br>로
      editable.innerHTML = escapeHtml(body).replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>");
      fireInput(editable);
      return true;
    }

    // textarea fallback
    const ta = doc.querySelector("textarea");
    if (ta) {
      ta.focus();
      ta.value = body;
      fireInput(ta);
      return true;
    }

    return false;
  }
  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function tryFill(data) {
    let titleOk = fillTitle(document, data.title);
    let bodyOk = fillBody(document, data.body);

    // iframe 내부 시도 (SmartEditor가 iframe을 쓰는 경우)
    if (!titleOk || !bodyOk) {
      for (const iframe of document.querySelectorAll("iframe")) {
        try {
          const doc = iframe.contentDocument;
          if (!doc) continue;
          if (!titleOk) titleOk = fillTitle(doc, data.title);
          if (!bodyOk) bodyOk = fillBody(doc, data.body);
          if (titleOk && bodyOk) break;
        } catch { /* cross-origin */ }
      }
    }

    return { titleOk, bodyOk };
  }

  // ─── 메인 흐름 ────────────────────────────────────────────────────
  let executed = false;
  async function execute() {
    if (executed) return;
    let data;
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      data = stored[STORAGE_KEY];
    } catch {
      return;
    }
    if (!data) return;

    // 만료 체크
    if (Date.now() - (data.ts || 0) > MAX_AGE_MS) {
      try { await chrome.storage.local.remove(STORAGE_KEY); } catch {}
      return;
    }

    // 글쓰기 페이지 — 자동 입력 시도
    if (isWritePage()) {
      executed = true;
      const { titleOk, bodyOk } = tryFill(data);

      if (titleOk && bodyOk) {
        showNotice(
          `✅ 자동 입력 완료\n페르소나: ${data.expectedPersona?.displayName || "?"} (${data.expectedNickname || "?"})\n검토 후 [임시저장] 또는 [등록] 클릭하세요.`,
          "ok"
        );
        try { await chrome.storage.local.remove(STORAGE_KEY); } catch {}
      } else if (titleOk || bodyOk) {
        showNotice(
          `⚠️ 일부만 자동 입력됨 (제목 ${titleOk ? "✓" : "✗"} / 본문 ${bodyOk ? "✓" : "✗"})\n수동 보완 후 발행하세요.`,
          "warn"
        );
        try { await chrome.storage.local.remove(STORAGE_KEY); } catch {}
      } else {
        showNotice(
          "❌ 자동 입력 실패: 글쓰기 폼을 찾지 못했습니다. 페이지 새로고침 후 다시 시도하거나 수동 입력하세요.",
          "error"
        );
      }
      return;
    }

    // 게시판 페이지 — 검증 후 글쓰기 페이지로 유도
    if (isBoardPage()) {
      executed = true;

      // 페르소나 검증
      const current = extractCurrentNickname();
      if (!current) {
        showNotice(
          `❌ 카페 로그인 닉네임을 확인할 수 없습니다.\n${data.cafeName || "카페"}에 ${data.expectedPersona?.displayName} (${data.expectedNickname}) 계정으로 로그인 후 다시 시도하세요.`,
          "error"
        );
        return; // 데이터 보존 (재시도 가능)
      }
      if (current !== data.expectedNickname) {
        showNotice(
          `⚠️ 잘못된 계정\n예상: ${data.expectedPersona?.displayName} (${data.expectedNickname})\n실제: ${current}\n올바른 계정으로 로그인 후 다시 시도하세요.`,
          "error"
        );
        return; // 데이터 보존
      }

      // 검증 통과 — 글쓰기 버튼 찾아 클릭
      showNotice(
        `✓ ${data.expectedPersona?.displayName} (${current}) 확인됨. 글쓰기 페이지로 이동합니다…`,
        "ok"
      );
      const btn = findWriteButton();
      if (btn) {
        setTimeout(() => btn.click(), 800);
      } else {
        showNotice(
          "⚠️ 글쓰기 버튼을 찾지 못했습니다. 직접 [글쓰기] 클릭 후 잠시 기다리면 자동 입력됩니다.",
          "warn"
        );
        // executed=true이므로 다른 페이지로 이동 후 다시 발화는 안 됨
        // 글쓰기 페이지로 이동 후 다시 트리거하려면 executed 리셋 필요
        executed = false;
      }
    }
  }

  // 페이지 로드 후 + SPA 네비게이션 후 시도
  function schedule() {
    if (executed) return;
    setTimeout(() => execute().catch(() => {}), 1500);
    setTimeout(() => execute().catch(() => {}), 3500);
  }
  schedule();

  let lastUrl = HREF();
  new MutationObserver(() => {
    if (HREF() === lastUrl) return;
    lastUrl = HREF();
    executed = false;
    schedule();
  }).observe(document.body || document.documentElement, { subtree: true, childList: true });
})();
