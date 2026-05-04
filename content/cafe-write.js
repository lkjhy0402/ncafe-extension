// NCAFE Tracker - 자동 입력 + 페르소나 검증 (v1.2.1)
//
// 흐름:
//   1) NCAFE 도메인: postMessage 'NCAFE_AUTO_FILL' 수신 → chrome.storage.local 저장
//   2) 카페 게시판 페이지: 알림 + [글쓰기] 버튼 클릭 → 글쓰기 페이지로 이동 (검증 X)
//   3) 카페 글쓰기 페이지:
//      - 카페별 닉네임 추출 시도 (글쓰기 폼에 표시되는 카페 닉네임)
//      - 닉네임 추출 성공 + NCAFE 등록과 일치 → 자동 입력
//      - 닉네임 불일치 → 경고 + 자동 입력 중단 (안전)
//      - 닉네임 추출 실패 → 경고 후 자동 입력 진행 (확인은 본인이)
//
// 절대 자동 [임시저장]/[등록] 클릭 X

(function () {
  if (window.__NCAFE_CAFE_WRITE_LOADED__) return;
  window.__NCAFE_CAFE_WRITE_LOADED__ = true;
  console.log("[NCAFE cafe-write] loaded v1.2.1 on", location.hostname);

  const STORAGE_KEY = "ncafe_pending_auto_fill";
  const MAX_AGE_MS = 5 * 60 * 1000;

  const onNCAFE = location.hostname.endsWith("vercel.app");
  const onCafe = location.hostname === "cafe.naver.com";

  // ─── A. NCAFE 도메인: postMessage 수신 → storage 저장 ─────────────
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
        console.log("[NCAFE cafe-write] saved auto-fill data:", msg.data.cafeName);
      } catch (e) {
        console.error("[NCAFE cafe-write] storage save failed", e);
      }
    });
    return;
  }

  // ─── B. 카페 도메인: 검증 + 자동 입력 ────────────────────────────
  if (!onCafe) return;

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

  // ─── 카페별 닉네임 추출 (글쓰기 페이지 전용) ──────────────────────
  // 글쓰기 폼 근처에 노출되는 카페별 닉네임을 찾음.
  // 다양한 카페·시점 디자인 대비 다중 셀렉터.
  const WRITE_NICK_SELECTORS = [
    // 글쓰기 폼 영역의 닉네임 표시
    ".write_form .nick_text",
    ".article-write-form .nick",
    ".writer_info .nick",
    ".write-info .nickname",
    'input[name="memberNick"]',
    'input[name="writerNick"]',
    // SmartEditor 헤더의 작성자 표시
    ".se-author-name",
    // 우측 사이드 회원 정보
    ".cafe_member_nick",
    ".member_nick",
    ".my_info .nickname",
    ".profile_area .nick",
    // 텍스트 패턴 fallback
    "[data-nickname]",
  ];

  function cleanNick(s) {
    return (s || "")
      .replace(/(님|회원|\s*\(.*?\))$/g, "")
      .trim();
  }

  function extractNickFromDoc(doc) {
    if (!doc) return null;
    for (const sel of WRITE_NICK_SELECTORS) {
      const el = doc.querySelector(sel);
      if (!el) continue;
      const txt = (el.value || el.textContent || el.dataset?.nickname || "").trim();
      if (txt && txt.length < 50) {
        const cleaned = cleanNick(txt);
        if (cleaned) return cleaned;
      }
    }
    // 글쓰기 폼 안에서 텍스트 패턴 검색 ("닉네임: ㅇㅇㅇ")
    const writeForm = doc.querySelector('form, .write_area, .article-write, .se-content');
    if (writeForm) {
      const text = writeForm.textContent || "";
      const m = text.match(/닉네임\s*[:：]\s*([^\s\n,]{1,30})/);
      if (m) return cleanNick(m[1]);
    }
    return null;
  }

  function extractWriteNickname() {
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
  function showNotice(message, type, persistent) {
    try {
      if (window.NCAFE_Toast?.show) {
        window.NCAFE_Toast.show({
          title: "NCAFE 자동 입력",
          message,
          type: type === "error" ? "err" : type === "warn" ? "warn" : "ok",
          duration: persistent ? 30000 : 8000,
        });
        return;
      }
    } catch { /* fallthrough */ }
    const colors = { ok: "#16a34a", error: "#dc2626", warn: "#d97706" };
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;top:20px;right:20px;background:" + (colors[type] || colors.ok) +
      ";color:#fff;padding:14px 18px;border-radius:8px;z-index:2147483647;max-width:440px;" +
      "font-size:13px;line-height:1.55;white-space:pre-line;box-shadow:0 8px 24px rgba(0,0,0,0.2);" +
      'font-family:-apple-system,"Apple SD Gothic Neo",sans-serif;';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), persistent ? 30000 : 10000);
  }

  // ─── 글쓰기 버튼 찾기 + 클릭 ─────────────────────────────────────
  function findWriteButton() {
    const candidates = Array.from(document.querySelectorAll(
      'a, button, [role="button"]'
    ));
    for (const el of candidates) {
      const text = (el.textContent || "").replace(/\s/g, "");
      const href = el.getAttribute("href") || "";
      if (
        text === "글쓰기" || text.includes("글쓰기") ||
        href.includes("ArticleWrite") || href.includes("/articles/write")
      ) {
        return el;
      }
    }
    // class 기반 fallback
    const classCandidates = [
      ".btn_write", ".article-write-btn", ".btn-write",
      'a[class*="write"]', 'button[class*="write"]',
    ];
    for (const sel of classCandidates) {
      const el = document.querySelector(sel);
      if (el) return el;
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
      'input[type="text"][maxlength]',
    ];
    for (const sel of sels) {
      const el = doc.querySelector(sel);
      if (el && el.tagName === "INPUT" && el.offsetParent !== null) {
        try {
          el.focus();
          el.value = title;
          fireInput(el);
          return true;
        } catch { /* try next */ }
      }
    }
    return false;
  }
  function fillBody(doc, body) {
    // SmartEditor v3
    const seArea = doc.querySelector(".se-content");
    if (seArea) {
      const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim());
      const html = paragraphs.map((p) =>
        `<div class="se-text-paragraph"><span class="se-ff-nanumgothic se-fs15">${escapeHtml(p)}</span></div>`
      ).join("");
      try {
        seArea.innerHTML = html;
        fireInput(seArea);
        return true;
      } catch { /* fallthrough */ }
    }
    // contenteditable
    const editable = doc.querySelector('[contenteditable="true"]');
    if (editable) {
      try {
        editable.focus();
        editable.innerHTML = escapeHtml(body).replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>");
        fireInput(editable);
        return true;
      } catch { /* fallthrough */ }
    }
    // textarea
    const ta = doc.querySelector("textarea");
    if (ta) {
      try {
        ta.focus();
        ta.value = body;
        fireInput(ta);
        return true;
      } catch { /* fallthrough */ }
    }
    return false;
  }
  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function tryFill(data) {
    let titleOk = fillTitle(document, data.title);
    let bodyOk = fillBody(document, data.body);
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

    if (Date.now() - (data.ts || 0) > MAX_AGE_MS) {
      try { await chrome.storage.local.remove(STORAGE_KEY); } catch {}
      return;
    }

    // 글쓰기 페이지 — 검증 + 입력
    if (isWritePage()) {
      executed = true;
      console.log("[NCAFE cafe-write] write page detected, attempting fill");

      // 카페별 닉네임 검증 (있을 때만 엄격 검사, 없으면 fill 진행 + 경고)
      const writeNick = extractWriteNickname();
      const expected = data.expectedNickname;

      if (writeNick && writeNick !== expected) {
        showNotice(
          `⚠️ 카페 닉네임 불일치 — 자동 입력 중단\n` +
          `예상: ${data.expectedPersona?.displayName} (${expected})\n` +
          `실제: ${writeNick}\n\n` +
          `올바른 계정으로 로그인 후 다시 [📤 자동 입력] 시도하세요.`,
          "error",
          true
        );
        return; // 데이터 보존
      }

      const { titleOk, bodyOk } = tryFill(data);
      if (titleOk && bodyOk) {
        const verified = writeNick === expected;
        showNotice(
          `✅ 자동 입력 완료\n` +
          `페르소나: ${data.expectedPersona?.displayName} (${expected})\n` +
          (verified ? `카페 닉네임 검증 ✓\n` : `(닉네임 자동 검증 불가 — 본인 확인 필요)\n`) +
          `검토 후 [임시저장] 또는 [등록] 클릭하세요.`,
          "ok"
        );
        try { await chrome.storage.local.remove(STORAGE_KEY); } catch {}
      } else if (titleOk || bodyOk) {
        showNotice(
          `⚠️ 일부만 자동 입력됨 (제목 ${titleOk ? "✓" : "✗"} / 본문 ${bodyOk ? "✓" : "✗"})\n` +
          `수동 보완 후 발행하세요.`,
          "warn"
        );
        try { await chrome.storage.local.remove(STORAGE_KEY); } catch {}
      } else {
        showNotice(
          `❌ 자동 입력 실패\n글쓰기 폼을 찾지 못했습니다.\n페이지가 완전히 로드된 후에도 안 되면 수동 입력하세요.`,
          "error"
        );
      }
      return;
    }

    // 게시판 페이지 — 안내 + 글쓰기 버튼 클릭
    if (isBoardPage()) {
      executed = true;
      console.log("[NCAFE cafe-write] board page detected");

      showNotice(
        `📋 ${data.cafeName} 일상글 게시판 도착\n` +
        `예정 페르소나: ${data.expectedPersona?.displayName} (${data.expectedNickname})\n` +
        `잠시 후 글쓰기 페이지로 이동…\n` +
        `(닉네임 검증은 글쓰기 페이지에서 자동 수행)`,
        "ok"
      );

      // 글쓰기 버튼 찾기 (1초·2초 두 번 시도)
      const click = () => {
        const btn = findWriteButton();
        if (btn) {
          try { btn.click(); return true; } catch { return false; }
        }
        return false;
      };
      setTimeout(() => {
        if (!click()) {
          setTimeout(() => {
            if (!click()) {
              showNotice(
                `⚠️ [글쓰기] 버튼을 찾지 못했습니다.\n` +
                `직접 [글쓰기] 클릭 → 글쓰기 페이지에서 자동 입력됩니다.`,
                "warn",
                true
              );
              executed = false;  // 글쓰기 페이지로 직접 이동 시 다시 발화 가능하도록
            }
          }, 2000);
        }
      }, 1200);
    }
  }

  function schedule() {
    if (executed) return;
    setTimeout(() => execute().catch(() => {}), 1000);
    setTimeout(() => execute().catch(() => {}), 3000);
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
