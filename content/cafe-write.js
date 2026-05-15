// NCAFE Tracker - 자동 입력 + 페르소나 검증 (v1.2.22 — 단락 보존 다중 전략: \n\n insertText → NBSP insertParagraph → insertHTML 순서 자동 시도 + 진단 로그)
//
// 흐름:
//   1) NCAFE: postMessage 'NCAFE_AUTO_FILL' 수신 → chrome.storage.local 저장
//   2) 카페 게시판: 알림 → 글쓰기 버튼 폴링·클릭. 8초 못 찾으면 글쓰기 URL로 직접 이동
//   3) 카페 글쓰기: 카페별 닉네임 검증 (가능 시) + 제목·본문 자동 입력
//
// 변경 (v1.2.2):
//   - all_frames:true 대응 (iframe 안에 있는 버튼·폼도 찾음)
//   - 버튼/폼 폴링을 8초까지 (SPA 늦은 렌더 대응)
//   - 글쓰기 버튼 못 찾으면 URL로 직접 이동 fallback
//
// 변경 (v1.2.15):
//   - findActualEditor: .se-text-paragraph에서 위로 올라가 진짜 contenteditable 부모 찾기
//     (이전 findVisibleEditable이 clipboard용 hidden contenteditable을 잡는 케이스 해결)
//   - fillBody 우선순위 변경: execCommand(타이핑 시뮬레이션) 1순위 → DOM 직접 구성 fallback
//     (DOM 직접 구성은 SmartEditor React state가 갱신 안 돼서 빈 글로 발행되던 문제)
//   - fillByExecCommand에 placeholder 해제용 mousedown/click 이벤트 발화 추가
//   - execCommand 후 textContent 검증으로 silent 실패 감지
//
// 변경 (v1.2.16):
//   - findActualEditor 전략 0 추가: iframe 안의 body 자체가 contenteditable인 SmartEditor 변형 지원
//     (한아름 카페 등에서 input_buffer iframe의 body가 진짜 본문 편집 영역)
//   - fillBody 위험한 광범위 fallback 제거 (.se-section / .se-component-content innerHTML 직접 삽입)
//     → 잘못된 영역에 들어가 React 가상 DOM 어긋나며 색칠+freeze 발생하던 케이스 차단
//     → 못 찾으면 차라리 실패 토스트로 명확히 알림
//   - editable.ownerDocument로 정확한 doc(top vs iframe) 식별해 execCommand가 올바른 frame에 작동

(function () {
  if (window.__NCAFE_CAFE_WRITE_LOADED__) return;
  window.__NCAFE_CAFE_WRITE_LOADED__ = true;
  const isTop = window.self === window.top;
  console.log("[NCAFE cafe-write] v1.2.22 loaded on", location.hostname, "top=" + isTop);

  // 확장 reload 후 옛 content script가 chrome API에 접근하면 발생하는 에러 무해화
  function isExtensionAlive() {
    try {
      return !!(chrome && chrome.storage && chrome.storage.local && chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  const STORAGE_KEY = "ncafe_pending_auto_fill";
  const MAX_AGE_MS = 5 * 60 * 1000;

  const onNCAFE = location.hostname.endsWith("vercel.app");
  const onCafe = location.hostname === "cafe.naver.com";

  // ─── A. NCAFE: postMessage → storage ─────────────────────────────
  if (onNCAFE) {
    if (!isTop) return; // postMessage는 top frame에서만
    console.log("[NCAFE cafe-write] NCAFE side ready, listening postMessage");
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || msg.type !== "NCAFE_AUTO_FILL") return;
      if (!msg.data) return;
      // 확장 reload 후 stale context면 silent skip (에러 로그 X)
      if (!isExtensionAlive()) {
        console.warn("[NCAFE cafe-write] extension context lost — 페이지를 새로고침하면 자동 입력이 작동합니다");
        return;
      }
      console.log("[NCAFE cafe-write] received postMessage:", msg.data.cafeName, msg.data.expectedNickname);
      try {
        chrome.storage.local.set(
          { [STORAGE_KEY]: { ...msg.data, ts: msg.data.ts || Date.now() } },
          () => {
            const err = chrome.runtime?.lastError;
            if (err) {
              console.warn("[NCAFE cafe-write] storage set warning:", err.message);
            } else {
              console.log("[NCAFE cafe-write] storage saved OK ✓");
            }
          }
        );
      } catch (e) {
        // Extension context invalidated 등 — warn으로 (확장 에러 패널에 안 올라옴)
        console.warn("[NCAFE cafe-write] save skipped (context lost):", e?.message ?? e);
      }
    });
    return;
  }

  if (!onCafe) return;

  // ─── 페이지 종류 ─────────────────────────────────────────────────
  const HREF = () => location.href;
  function isWritePage() {
    const u = HREF();
    // /articles/write 패턴이 있으면 어떤 prefix(f-e, ca-fe)나 메뉴 경로(/menus/X/)가 있어도 글쓰기 페이지
    return u.includes("ArticleWrite.nhn") || /\/articles\/write/.test(u);
  }
  function isBoardPage() {
    const u = HREF();
    if (isWritePage()) return false; // 글쓰기 페이지는 게시판으로 분류 X
    return u.includes("ArticleList.nhn") ||
           /\/(?:f-e|ca-fe)\/cafes\/\d+\/menus\/\d+/.test(u);
  }

  // ─── 카페별 닉네임 추출 (글쓰기 페이지 전용) ──────────────────────
  const WRITE_NICK_SELECTORS = [
    ".write_form .nick_text",
    ".article-write-form .nick",
    ".writer_info .nick",
    ".write-info .nickname",
    'input[name="memberNick"]',
    'input[name="writerNick"]',
    ".se-author-name",
    ".cafe_member_nick",
    ".member_nick",
    ".my_info .nickname",
    ".profile_area .nick",
    "[data-nickname]",
  ];
  function cleanNick(s) {
    return (s || "").replace(/(님|회원|\s*\(.*?\))$/g, "").trim();
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

  // ─── 토스트 (top frame에서만 보이도록) ────────────────────────────
  function showNotice(message, type, persistent) {
    if (!isTop) return; // iframe에서는 토스트 안 띄움 (top에서 보여줌)
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

  // ─── 글쓰기 버튼 찾기 ─────────────────────────────────────────────
  // v1.2.21: 이모지 variation selector (U+FE0F), zero-width chars, ✏ 자체까지 모두 제거 후
  //          순수 "글쓰기"만 비교. 영주맘 카페처럼 "✏️ 글쓰기" 형태 (VS16 포함) 대응.
  function isVisible(el) {
    return el.offsetParent !== null || el.getClientRects().length > 0;
  }
  function normalizeButtonText(s) {
    return String(s || "")
      .replace(/[​-‍﻿️]/g, "") // zero-width + VS16 (emoji presentation)
      .replace(/\s+/g, "")                          // 공백 모두
      .replace(/[✏✎✍🖉🖊🖋📝]/g, "");                 // 흔한 펜·연필 이모지 제거
  }
  function findWriteButton() {
    const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]'));

    // 텍스트 기반 (정규화 후 정확 매칭)
    for (const el of candidates) {
      const normalized = normalizeButtonText(el.textContent);
      if (normalized === "글쓰기" && isVisible(el)) {
        return el;
      }
    }

    // aria-label / title / data-tip 등 보조 속성 매칭 (텍스트 없는 아이콘 버튼 대응)
    for (const el of candidates) {
      const aria = normalizeButtonText(el.getAttribute("aria-label"));
      const title = normalizeButtonText(el.getAttribute("title"));
      if ((aria === "글쓰기" || title === "글쓰기") && isVisible(el)) {
        return el;
      }
    }

    // href 기반
    for (const el of candidates) {
      const href = el.getAttribute("href") || "";
      if (href.includes("ArticleWrite") || href.includes("/articles/write")) {
        if (isVisible(el)) return el;
      }
    }

    // class 기반
    const classCandidates = [
      ".btn_write", ".article-write-btn", ".btn-write",
      'a[class*="write"]', 'button[class*="write"]',
    ];
    for (const sel of classCandidates) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }

    return null;
  }

  // 직접 URL 이동 fallback은 URL 패턴이 카페별로 달라서 위험.
  // 제거: 글쓰기 버튼 못 찾으면 사용자가 직접 클릭하도록 안내.

  // ─── 폼 입력 ─────────────────────────────────────────────────────
  function fireInput(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  // React가 관리하는 input/textarea의 value를 framework state까지 갱신되도록 설정
  // React 16+의 _valueTracker hack으로 controlled input도 갱신됨
  function setReactValue(el, value) {
    try {
      const proto = el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(el, value);
      } else {
        el.value = value;
      }
    } catch {
      el.value = value;
    }
    // React _valueTracker reset — tracker가 옛 값을 들고 있으면 React가 변경 무시
    if (el._valueTracker) {
      try { el._valueTracker.setValue(""); } catch {}
    }
    fireInput(el);
  }
  function fillTitle(doc, title) {
    const sels = [
      'input[name="subject"]',
      'input.subject',
      '.se-input-text-area input',
      'input[placeholder*="제목"]',
      '.tit_text input',
      'textarea[placeholder*="제목"]',
      'input[type="text"][maxlength]',
    ];
    for (const sel of sels) {
      const el = doc.querySelector(sel);
      if (!el) continue;
      const visible = el.offsetParent !== null || el.getClientRects().length > 0;
      console.log(`[NCAFE cafe-write] title selector "${sel}":`, el.tagName, "visible:", visible);
      if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && visible) {
        try {
          el.focus();
          setReactValue(el, title);
          console.log(`[NCAFE cafe-write]   ✓ title set via "${sel}"`);
          return true;
        } catch (e) {
          console.error(`[NCAFE cafe-write]   ✗ title set error:`, e);
        }
      }
    }
    console.log("[NCAFE cafe-write] no matching title input found");
    return false;
  }
  // 본문 → SmartEditor 단락 구조로 변환
  // \n+ 단위로 분리, 각 단락을 <p>로, 단락 사이에 &nbsp; 단락 삽입해 시각적 간격 확보
  // SmartEditor가 <br>만 든 빈 paragraph를 collapse할 가능성에 대비해 &nbsp; 사용
  function buildParagraphHtml(body, smartEditorClasses) {
    const lines = String(body || "")
      .split(/\n+/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) return "";

    if (smartEditorClasses) {
      const cls = ' class="se-text-paragraph se-text-paragraph-align-"';
      const fontSpanOpen = '<span class="se-ff-nanumgothic se-fs15">';
      const emptyP = `<p${cls}>${fontSpanOpen} </span></p>`;
      return lines
        .map((line) => `<p${cls}>${fontSpanOpen}${escapeHtml(line)}</span></p>`)
        .join(emptyP);
    } else {
      // 일반 contenteditable — <br><br>로 시각적 간격 (가장 확실)
      return lines.map((l) => escapeHtml(l)).join("<br><br>");
    }
  }

  // 진짜 본문 에디터 찾기 — 사용자가 타이핑할 때 실제로 텍스트가 들어가는 contenteditable
  // 전략 0: iframe 안의 body 자체가 contenteditable인 SmartEditor 변형 (한아름 등)
  // 전략 1: 기존 .se-text-paragraph에서 위로 올라가며 contenteditable 부모 찾기
  // 전략 2: .se-content 안에서 가장 큰 visible contenteditable
  // 전략 3: aria-hidden·off-screen·tiny clipboard 영역 제외한 contenteditable
  //
  // 주의: el.isContentEditable은 부모로부터 상속받은 값까지 true가 되므로 paragraph도 true.
  //       명시적 속성 보유자를 찾으려면 el.contentEditable === "true"로 체크해야 함.
  function findActualEditor(doc) {
    // 전략 0: iframe 안의 body가 contenteditable (SmartEditor 일부 변형 — input_buffer iframe 등)
    for (const iframe of doc.querySelectorAll('iframe')) {
      try {
        const idoc = iframe.contentDocument;
        if (!idoc) continue;
        if (idoc.body && idoc.body.contentEditable === "true") {
          return idoc.body;
        }
        // iframe 안 다른 명시적 contenteditable
        const innerCE = idoc.querySelectorAll('[contenteditable="true"]');
        for (const el of innerCE) {
          if (el.contentEditable !== "true") continue;
          const r = el.getBoundingClientRect();
          // iframe 내부 좌표 기준이라 크기만 검증 (작은 clipboard div 제외)
          if (r.width < 50 && r.height < 20) continue;
          return el;
        }
      } catch { /* cross-origin iframe — skip */ }
    }

    // 전략 1: paragraph의 부모로 올라가며 명시적 contenteditable=true 노드 찾기
    const existingPara = doc.querySelector(".se-text-paragraph");
    if (existingPara) {
      let cur = existingPara.parentElement;
      while (cur && cur !== doc.body) {
        if (cur.contentEditable === "true") {
          const rect = cur.getBoundingClientRect();
          if (rect.width > 100 && rect.height > 30) {
            return cur;
          }
        }
        cur = cur.parentElement;
      }
    }

    // 전략 2: .se-content 안의 큰 contenteditable
    const seCandidates = doc.querySelectorAll('.se-content [contenteditable="true"]');
    for (const el of seCandidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 200 && rect.height > 50) {
        return el;
      }
    }

    // 전략 3: 그 외 visible contenteditable (clipboard div 제외)
    const all = doc.querySelectorAll('[contenteditable="true"]');
    for (const el of all) {
      if (el.closest('[aria-hidden="true"]')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.left < -500 || rect.top < -500) continue;
      if (rect.width < 200 || rect.height < 50) continue;
      return el;
    }
    return null;
  }

  // 텍스트 선택 해제 (innerHTML 설정 후 잔여 selection 제거)
  function clearSelection(win) {
    try {
      const sel = (win || window).getSelection();
      if (sel) sel.removeAllRanges();
    } catch { /* ignore */ }
  }

  // SmartEditor 정규 구조로 DOM 직접 구성 (CSS 클래스 정확 → 사용자 타이핑과 동일한 색·간격)
  // 각 단락: <p class="se-text-paragraph se-text-paragraph-align-">
  //           <span class="se-ff-nanumgothic se-fs15">내용</span></p>
  // 단락 사이: 같은 구조의 빈 단락 (span 안에 &nbsp;)
  function buildSeParagraph(doc, text, isEmpty) {
    const p = doc.createElement("p");
    p.className = "se-text-paragraph se-text-paragraph-align-";
    p.style.lineHeight = "1.5";
    const span = doc.createElement("span");
    span.className = "se-ff-nanumgothic se-fs15";
    span.style.color = "#000";
    if (isEmpty) {
      span.innerHTML = "&nbsp;";
    } else {
      span.textContent = text;
    }
    p.appendChild(span);
    return p;
  }

  function fillByDomConstruction(doc, editable, body) {
    try {
      // 에디터 활성화 (placeholder 모드 해제)
      editable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      editable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      editable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      editable.focus();

      // 기존 자식 모두 제거
      while (editable.firstChild) editable.removeChild(editable.firstChild);

      const lines = body.split(/\n+/).map((l) => l.trim()).filter((l) => l);
      for (let i = 0; i < lines.length; i++) {
        editable.appendChild(buildSeParagraph(doc, lines[i], false));
        if (i < lines.length - 1) {
          editable.appendChild(buildSeParagraph(doc, "", true));
        }
      }

      // React onInput 발화로 SmartEditor state 갱신
      editable.dispatchEvent(
        new InputEvent("input", {
          inputType: "insertText",
          data: body,
          bubbles: true,
          composed: true,
        })
      );
      editable.dispatchEvent(new Event("change", { bubbles: true }));

      // 선택 해제
      setTimeout(() => clearSelection(doc.defaultView), 50);
      return true;
    } catch (e) {
      console.error("[NCAFE cafe-write] DOM construction error", e);
      return false;
    }
  }

  // execCommand로 실제 타이핑 시뮬레이션 — 1순위 전략
  // SmartEditor의 React state까지 정상 갱신되도록 사용자 타이핑과 동일한 경로 사용
  // 1) placeholder 해제 (mousedown/mouseup/click)
  // 2) 기존 내용 전체 선택 → 삭제
  // 3) 라인별로 insertText, 라인 사이에 insertParagraph 두 번 (Enter Enter = 빈 줄 간격)
  function fillByExecCommand(doc, editable, body) {
    try {
      // placeholder 모드 해제 — 진짜 사용자 클릭과 동일한 시퀀스
      editable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      editable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      editable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      editable.focus();
      const win = doc.defaultView || window;

      // 기존 내용 전체 선택 후 삭제
      const range = doc.createRange();
      range.selectNodeContents(editable);
      const sel = win.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      doc.execCommand("delete", false);

      const lines = body.split(/\n+/).map((l) => l.trim()).filter((l) => l);

      // v1.2.22: 다중 전략 시퀀스. 각 시도 후 <p> 개수로 검증, 부족하면 다음 전략으로.
      // SmartEditor 변형마다 동작 다름: 양주캐슬은 insertParagraph가 collapse,
      // 일부는 \n\n이 곧바로 <br>로 변환. 가장 단순한 것부터 시도.
      const isSE = !!editable.closest(".se-content");

      const reselect = () => {
        const r = doc.createRange();
        r.selectNodeContents(editable);
        sel.removeAllRanges();
        sel.addRange(r);
      };
      const breakCount = () => {
        const html = editable.innerHTML || "";
        // <br>는 1개당 1break, <p> 사이 경계도 1break로 간주
        const pCount = (html.match(/<p[\s>]/gi) || []).length;
        const brCount = (html.match(/<br/gi) || []).length;
        return Math.max(pCount - 1, 0) + brCount;
      };
      const needed = lines.length - 1;

      let strategy = "none";

      if (lines.length === 1) {
        doc.execCommand("insertText", false, lines[0]);
        strategy = "single-insertText";
      } else {
        // 전략 1: \n\n 한 번에 insertText — 일부 SmartEditor가 자동으로 <br>로 변환
        doc.execCommand("insertText", false, lines.join("\n\n"));
        strategy = "newline-insertText";

        if (breakCount() < needed) {
          // 전략 2: insertParagraph + NBSP + insertParagraph (v1.2.18+ 보강)
          reselect();
          doc.execCommand("delete", false);
          for (let i = 0; i < lines.length; i++) {
            if (i > 0) {
              doc.execCommand("insertParagraph", false);
              doc.execCommand("insertText", false, " "); // NBSP — trim 안 됨
              doc.execCommand("insertParagraph", false);
            }
            doc.execCommand("insertText", false, lines[i]);
          }
          strategy = "insertParagraph-nbsp";
        }

        if (breakCount() < needed) {
          // 전략 3: insertHTML로 SmartEditor-호환 빈 단락 직접 삽입 (v1.2.20 방식)
          reselect();
          doc.execCommand("delete", false);
          const emptyParaHtml = isSE
            ? '<p class="se-text-paragraph se-text-paragraph-align-"><span class="se-ff-nanumgothic se-fs15">&nbsp;</span></p>'
            : '<p>&nbsp;</p>';
          for (let i = 0; i < lines.length; i++) {
            if (i > 0) {
              doc.execCommand("insertParagraph", false);
              doc.execCommand("insertHTML", false, emptyParaHtml);
            }
            doc.execCommand("insertText", false, lines[i]);
          }
          strategy = "insertHTML-empty-para";
        }
      }

      // React state 갱신 보장
      editable.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));

      // 진단 로그 — 어느 전략이 통했는지, 결과 break 수
      const finalBreaks = breakCount();
      const success = finalBreaks >= needed;
      console.log(
        `[NCAFE cafe-write] body filled (v1.2.22) — strategy="${strategy}", ` +
        `lines=${lines.length}, breaks=${finalBreaks}/${needed} ${success ? "✓" : "✗"}`
      );

      // 선택 해제 (잔여 selection 클리어)
      setTimeout(() => clearSelection(win), 50);
      return true;
    } catch (e) {
      console.error("[NCAFE cafe-write] execCommand fill error", e);
      return false;
    }
  }

  // SmartEditor paste 시뮬레이션 — execCommand 실패 시 fallback
  function pasteIntoEditor(doc, editable, body) {
    try {
      editable.focus();
      try {
        const range = doc.createRange();
        range.selectNodeContents(editable);
        const sel = doc.defaultView?.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch {}

      const lines = body.split(/\n+/).map((l) => l.trim()).filter((l) => l);
      const html = lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("<p><br></p>");
      const text = lines.join("\n\n");
      const dt = new DataTransfer();
      dt.setData("text/html", html);
      dt.setData("text/plain", text);

      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      const dispatched = editable.dispatchEvent(pasteEvent);
      setTimeout(() => clearSelection(doc.defaultView), 100);
      return dispatched;
    } catch (e) {
      console.error("[NCAFE cafe-write] paste simulation error", e);
      return false;
    }
  }

  // 에디터에 텍스트가 실제로 들어갔는지 검증 — execCommand가 silent로 무시하는 경우 감지
  function editorHasText(editable) {
    const t = (editable.textContent || "").trim();
    return t.length > 0;
  }

  function fillBody(doc, body) {
    // 진짜 본문 contenteditable 확보 — top frame + iframe 안까지 탐색
    const editable = findActualEditor(doc);
    if (editable) {
      // editable이 iframe 안 element면 그 iframe의 contentDocument를 사용해야
      // execCommand·Range·Selection이 올바른 frame에 작동
      const editorDoc = editable.ownerDocument || doc;
      const isSE = !!editable.closest(".se-content");
      const inIframe = editorDoc !== doc;
      const rect = editable.getBoundingClientRect();
      console.log(`[NCAFE cafe-write] editor target (smartEditor=${isSE}, inIframe=${inIframe}, tag=${editable.tagName}, ${Math.round(rect.width)}x${Math.round(rect.height)})`);

      // 1차: execCommand로 타이핑 시뮬레이션 (SmartEditor React state 정상 갱신)
      if (fillByExecCommand(editorDoc, editable, body) && editorHasText(editable)) {
        console.log("[NCAFE cafe-write] body via execCommand ✓");
        return true;
      }
      console.log("[NCAFE cafe-write] execCommand inserted nothing → DOM construction fallback");

      // 2차: DOM 직접 구성 (CSS 클래스 정확하지만 React state 갱신 안 될 수 있음)
      if (fillByDomConstruction(editorDoc, editable, body) && editorHasText(editable)) {
        console.log("[NCAFE cafe-write] body via DOM build ✓");
        return true;
      }
      // 3차: paste 시뮬레이션
      if (pasteIntoEditor(editorDoc, editable, body) && editorHasText(editable)) {
        console.log("[NCAFE cafe-write] body via paste ✓");
        return true;
      }
      // 4차 (마지막): innerHTML
      try {
        editable.focus();
        editable.innerHTML = buildParagraphHtml(body, isSE);
        fireInput(editable);
        clearSelection(editorDoc.defaultView);
        console.log("[NCAFE cafe-write] body via innerHTML last fallback");
        return true;
      } catch (e) {
        console.error("[NCAFE cafe-write] body editable fill error", e);
      }
    }

    // 광범위 fallback (.se-section / .se-content 직접 innerHTML 삽입)은 v1.2.16에서 제거.
    // 이유: 본문이 아닌 영역(미리보기·렌더 캐시 등)에 들어가 React 가상 DOM과 어긋나며
    //       색칠+freeze 발생. 잘못된 곳에 넣느니 실패로 명확히 처리.

    // 마지막 fallback: 일반 textarea (구형 카페 호환)
    const ta = doc.querySelector("textarea");
    if (ta) {
      try {
        ta.focus();
        setReactValue(ta, body);
        console.log("[NCAFE cafe-write] body via textarea");
        return true;
      } catch (e) {
        console.error("[NCAFE cafe-write] body textarea fill error", e);
      }
    }
    return false;
  }

  // ─── 공개 설정 자동화 ─────────────────────────────────────────────
  // 멤버공개 라디오 클릭 + 검색·네이버 서비스 공개 체크 해제
  function findInputByLabel(doc, type, labelText) {
    const target = labelText.replace(/\s/g, "");
    const labels = doc.querySelectorAll("label");
    for (const label of labels) {
      const text = (label.textContent || "").replace(/\s/g, "");
      if (!text.includes(target)) continue;
      // (a) input이 label 내부
      const inner = label.querySelector(`input[type="${type}"]`);
      if (inner) return inner;
      // (b) label[for=ID]로 외부 input 참조
      const forId = label.getAttribute("for");
      if (forId) {
        const ext = doc.getElementById(forId);
        if (ext && ext.type === type) return ext;
      }
    }
    return null;
  }
  function applyPrivacySettings(doc) {
    let memberOk = false;
    let searchOk = false;
    try {
      const memberRadio = findInputByLabel(doc, "radio", "멤버공개");
      if (memberRadio && !memberRadio.checked) {
        memberRadio.click();
      }
      memberOk = !!memberRadio;
    } catch (e) {
      console.error("[NCAFE cafe-write] 멤버공개 설정 실패", e);
    }
    try {
      const searchCheckbox = findInputByLabel(doc, "checkbox", "검색");
      if (searchCheckbox && searchCheckbox.checked) {
        searchCheckbox.click();
      }
      searchOk = !!searchCheckbox;
    } catch (e) {
      console.error("[NCAFE cafe-write] 검색공개 해제 실패", e);
    }
    return { memberOk, searchOk };
  }
  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function tryFill(data) {
    let titleOk = fillTitle(document, data.title);
    let bodyOk = fillBody(document, data.body);
    let privacy = applyPrivacySettings(document);
    if (!titleOk || !bodyOk || !privacy.memberOk || !privacy.searchOk) {
      for (const iframe of document.querySelectorAll("iframe")) {
        try {
          const doc = iframe.contentDocument;
          if (!doc) continue;
          if (!titleOk) titleOk = fillTitle(doc, data.title);
          if (!bodyOk) bodyOk = fillBody(doc, data.body);
          if (!privacy.memberOk || !privacy.searchOk) {
            const p = applyPrivacySettings(doc);
            privacy.memberOk = privacy.memberOk || p.memberOk;
            privacy.searchOk = privacy.searchOk || p.searchOk;
          }
          if (titleOk && bodyOk && privacy.memberOk && privacy.searchOk) break;
        } catch { /* cross-origin */ }
      }
    }
    console.log("[NCAFE cafe-write] fill result:", { titleOk, bodyOk, ...privacy });
    return { titleOk, bodyOk, privacy };
  }

  // ─── 메인 흐름 ────────────────────────────────────────────────────
  let executed = false;
  let writeButtonClicked = false;

  async function getData() {
    if (!isExtensionAlive()) {
      console.warn("[NCAFE cafe-write] extension context lost on cafe page — refresh");
      return null;
    }
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const data = stored[STORAGE_KEY];
      if (!data) {
        console.log("[NCAFE cafe-write] storage empty (no auto-fill pending)");
        return null;
      }
      if (Date.now() - (data.ts || 0) > MAX_AGE_MS) {
        console.log("[NCAFE cafe-write] data expired (>5min), clearing");
        try { await chrome.storage.local.remove(STORAGE_KEY); } catch {}
        return null;
      }
      console.log("[NCAFE cafe-write] data found:", data.cafeName, "expected:", data.expectedNickname, "age(s):", Math.round((Date.now() - data.ts) / 1000));
      return data;
    } catch (e) {
      console.warn("[NCAFE cafe-write] storage read skipped (context lost):", e?.message ?? e);
      return null;
    }
  }

  async function executeBoard(data) {
    if (executed) return;
    executed = true;
    console.log("[NCAFE cafe-write] board execute, looking for 글쓰기 button…");

    if (isTop) {
      showNotice(
        `📋 ${data.cafeName} 일상글 게시판 도착\n` +
        `예정 페르소나: ${data.expectedPersona?.displayName} (${data.expectedNickname})\n` +
        `잠시 후 글쓰기 페이지로 이동…`,
        "ok"
      );
    }

    // 0.5초 간격으로 8초까지 글쓰기 버튼 폴링
    let elapsed = 0;
    const interval = setInterval(() => {
      if (writeButtonClicked) { clearInterval(interval); return; }
      // 페이지가 이미 글쓰기 페이지로 바뀌었으면 중단
      if (isWritePage()) { clearInterval(interval); writeButtonClicked = true; return; }
      const btn = findWriteButton();
      if (btn) {
        writeButtonClicked = true;
        clearInterval(interval);
        console.log("[NCAFE cafe-write] write button found, clicking", btn);
        try { btn.click(); } catch (e) { console.error("[NCAFE cafe-write] click failed", e); }
        return;
      }
      elapsed += 500;
      if (elapsed >= 8000) {
        clearInterval(interval);
        if (isTop) {
          showNotice(
            `⚠️ [글쓰기] 버튼을 자동으로 찾지 못했습니다.\n` +
            `직접 [✏ 글쓰기] 버튼을 클릭하세요.\n` +
            `글쓰기 페이지로 이동하면 자동 입력됩니다.`,
            "warn",
            true
          );
        }
      }
    }, 500);
  }

  async function executeWrite(data) {
    if (executed) return;
    console.log("[NCAFE cafe-write] write page execute, polling form…");

    // 0.5초 간격으로 8초까지 폼 폴링
    let elapsed = 0;
    const interval = setInterval(() => {
      // 폼이 보이면 시도
      const hasForm = document.querySelector(
        'input[name="subject"], input[placeholder*="제목"], .se-content, [contenteditable="true"], textarea'
      );
      if (!hasForm) {
        elapsed += 500;
        if (elapsed >= 8000) {
          clearInterval(interval);
          executed = true;
          showNotice(
            `❌ 글쓰기 폼을 찾지 못했습니다.\n페이지가 늦게 로드되거나 SmartEditor 호환 안 되는 카페일 수 있습니다.`,
            "error",
            true
          );
        }
        return;
      }

      clearInterval(interval);
      executed = true;

      const writeNick = extractWriteNickname();
      const expected = data.expectedNickname;
      console.log("[NCAFE cafe-write] write nick:", writeNick, "expected:", expected);

      if (writeNick && writeNick !== expected) {
        showNotice(
          `⚠️ 카페 닉네임 불일치 — 자동 입력 중단\n` +
          `예상: ${data.expectedPersona?.displayName} (${expected})\n` +
          `실제: ${writeNick}\n\n` +
          `올바른 계정으로 로그인 후 다시 [📤 자동 입력] 시도하세요.`,
          "error",
          true
        );
        return;
      }

      // 1차 시도
      let { titleOk, bodyOk, privacy } = tryFill(data);

      // React 재렌더로 값이 날아가는 경우 대비 — 0.8초 후 재시도
      setTimeout(() => {
        if (!titleOk || !bodyOk || !privacy.memberOk || !privacy.searchOk) {
          const r2 = tryFill(data);
          if (!titleOk && r2.titleOk) titleOk = true;
          if (!bodyOk && r2.bodyOk) bodyOk = true;
          if (!privacy.memberOk && r2.privacy.memberOk) privacy.memberOk = true;
          if (!privacy.searchOk && r2.privacy.searchOk) privacy.searchOk = true;
        }
      }, 800);

      // 토스트는 1차 결과 기준으로 즉시 표시
      if (titleOk && bodyOk) {
        const verified = writeNick === expected;
        showNotice(
          `✅ 자동 입력 완료\n` +
          `페르소나: ${data.expectedPersona?.displayName} (${expected})\n` +
          (verified ? `카페 닉네임 검증 ✓\n` : `(닉네임 자동 검증 불가 — 본인 확인 필요)\n`) +
          `공개 설정: ${privacy.memberOk ? "멤버공개 ✓" : "멤버공개 ✗"} / ${privacy.searchOk ? "검색공개 처리 ✓" : "검색공개 처리 ✗"}\n` +
          `검토 후 [임시저장] 또는 [등록] 클릭하세요.`,
          "ok"
        );
        try { chrome.storage.local.remove(STORAGE_KEY); } catch {}
      } else if (titleOk || bodyOk) {
        showNotice(
          `⚠️ 일부만 자동 입력됨 (제목 ${titleOk ? "✓" : "✗"} / 본문 ${bodyOk ? "✓" : "✗"})\n` +
          `수동 보완 후 발행하세요.`,
          "warn"
        );
        try { chrome.storage.local.remove(STORAGE_KEY); } catch {}
      } else {
        showNotice(
          `❌ 자동 입력 실패\n글쓰기 폼에 데이터를 넣지 못했습니다. SmartEditor 변형일 수 있음.`,
          "error",
          true
        );
      }
    }, 500);
  }

  async function dispatch() {
    const data = await getData();
    if (!data) return;

    const url = HREF();
    if (isWritePage()) {
      console.log("[NCAFE cafe-write] dispatch → write page", url);
      await executeWrite(data);
    } else if (isBoardPage()) {
      console.log("[NCAFE cafe-write] dispatch → board page", url);
      await executeBoard(data);
    } else {
      console.log("[NCAFE cafe-write] dispatch → page type unknown, skip", url);
    }
  }

  // 초기 + 1·3초 후 시도 (SPA 늦은 로드 대응)
  setTimeout(() => dispatch().catch(() => {}), 500);
  setTimeout(() => dispatch().catch(() => {}), 2500);

  // SPA 네비게이션 감지
  let lastUrl = HREF();
  new MutationObserver(() => {
    if (HREF() === lastUrl) return;
    lastUrl = HREF();
    executed = false;
    writeButtonClicked = false;
    console.log("[NCAFE cafe-write] URL changed:", lastUrl);
    setTimeout(() => dispatch().catch(() => {}), 800);
    setTimeout(() => dispatch().catch(() => {}), 2500);
  }).observe(document.body || document.documentElement, { subtree: true, childList: true });
})();
