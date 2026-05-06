// NCAFE Tracker - 글 페이지 content script
// 네이버 카페 글 페이지에서 글 정보 + 작성자 추출 → background에 전달.
//
// 변경: 더 이상 popup의 myNickname으로 본인 글 필터링 X.
// 작성자 닉네임을 항상 같이 보내고, 백엔드의 persona_cafes 매칭이
// 본인 글 여부와 어떤 페르소나의 글인지 결정.
//
// → 카페별로 다른 닉네임 사용 시에도 정확히 매칭됨.

(function () {
  if (window.__NCAFE_POST_PAGE_LOADED__) return;

  // board-page.js가 만든 숨겨진 iframe(1×1px) 안이면 실행하지 않음
  try {
    if (window.self !== window.top) {
      const fe = window.frameElement;
      if (!fe) return; // cross-origin — 알 수 없으면 중단
      const rect = fe.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) return; // 숨겨진 tiny iframe
    }
  } catch { return; }

  window.__NCAFE_POST_PAGE_LOADED__ = true;
  console.log('[NCAFE] post-page.js 로드됨. URL:', location.href);

  const SELECTORS = {
    title: [
      ".article_header_title",
      ".tit-board",
      ".title_text",
      ".se-title-text",
      'h3[class*="title"]',
      ".board-title",
      '[class*="ArticleTitle"]',
      '[class*="article-title"]',
      '[class*="articleTitle"]',
    ],
    body: [
      ".se-main-container",
      ".ContentRenderer",
      "#postViewArea",
      ".article_viewer",
      ".NHN_Writeform_Main",
      ".tbody.m-tcol-c",
      '[class*="se-main"]',
      '[class*="ArticleBody"]',
      '[class*="article-body"]',
      '[class*="articleBody"]',
      '[class*="ArticleContent"]',
      '[class*="article-content"]',
    ],
    author: [
      ".nick_box .nickname",
      ".profile_area .nick",
      ".pers_nick_area .nickname",
      'span[class*="ArticleWriterProfile"] strong',
      '[class*="WriterProfile"] strong',
      '[class*="writerProfile"] strong',
      'a[class*="nickname"]',
    ],
    commentCount: [
      ".comment_count",
      ".CommentBox em",
      'em[class*="num"]',
      'a[href*="comment"] em',
      ".cmt_count",
    ],
    viewCount: [
      ".article_info .count",
      'span[class*="count"]',
      ".u_cnt em",
    ],
    likeCount: [
      ".btn_like .count",
      ".like_area em",
      'button[class*="like"] em',
    ],
    cafeName: [
      ".cafe_name a",
      "h1.cafe_name",
      "a.cafe_name",
      ".CafeNickName",
    ],
  };

  function pickText(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent && el.textContent.trim()) {
        return el.textContent.trim();
      }
    }
    return "";
  }

  function pickNumber(selectors) {
    const text = pickText(selectors);
    if (!text) return 0;
    const m = text.replace(/,/g, "").match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }

  function getCafeNameFromURL() {
    const url = window.location.href;
    const spa = url.match(/cafe\.naver\.com\/(?:f-e|ca-fe)\/cafes\/([^/]+)/);
    if (spa) return spa[1];
    const slug = url.match(/cafe\.naver\.com\/([^/?#]+)/);
    if (slug && slug[1] !== "ArticleRead.nhn") return slug[1];
    return "";
  }

  function getCafeNameFromShell() {
    try {
      if (window.parent && window.parent !== window) {
        const parentDoc = window.parent.document;
        for (const sel of SELECTORS.cafeName) {
          const el = parentDoc.querySelector(sel);
          if (el && el.textContent.trim()) return el.textContent.trim();
        }
      }
    } catch {
      // cross-origin 차단 시 무시
    }
    return "";
  }

  // 카페 가입 안내·로그인 안내·접근 권한 없음 등 article view가 아닌 안내 페이지 감지
  // 이걸 article view로 잘못 판정하면 안내 메시지가 글 본문으로 추적되어 brief.content가 오염됨
  function isRestrictedAccessPage() {
    const text = (document.body?.innerText || "").trim();
    if (!text) return false;
    const patterns = [
      /이 카페는 회원만 가입할 수 있습니다/,
      /가입 후 이용해\s*주세요/,
      /회원 전용/,
      /로그인 후 이용/,
      /접근 권한이 없/,
      /비공개 카페/,
      /본 카페에 가입하셔야/,
    ];
    return patterns.some((p) => p.test(text));
  }

  // title/body 텍스트가 시스템 안내 메시지 패턴인지 — 추적 가드용
  function looksLikeSystemMessage(s) {
    const t = (s || "").trim();
    if (!t) return false;
    const patterns = [
      /이 카페는 회원만/,
      /가입 후 이용해/,
      /회원 전용/,
      /로그인 후 이용/,
      /접근 권한이 없/,
      /비공개 카페/,
      /본 카페에 가입/,
      /^죄송합니다[.\s]/,
    ];
    return patterns.some((p) => p.test(t));
  }

  function isArticleView() {
    // URL 기반 감지 (가장 신뢰성 높음)
    if (/\/articles\/\d+/.test(location.href)) return true;
    if (location.href.includes("ArticleRead")) return true;
    // DOM 기반 감지 (iframe 내부 또는 SPA 렌더링 후)
    if (!SELECTORS.body.some((sel) => document.querySelector(sel))) return false;
    // 카페 안내 페이지 같으면 article view 아님 (false positive 차단)
    if (isRestrictedAccessPage()) return false;
    return true;
  }

  async function sendTrack(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { kind: "ncafe.track", type, payload },
          (resp) => resolve(resp ?? { ok: false, error: "no response" })
        );
      } catch {
        resolve({ ok: false, error: "extension context unavailable" });
      }
    });
  }

  async function process() {
    console.log('[NCAFE] process() 실행. isArticleView:', isArticleView(), location.href);
    if (!isArticleView()) return;

    const author = pickText(SELECTORS.author) || "unknown";
    const title = pickText(SELECTORS.title);
    const bodyEl = SELECTORS.body
      .map((s) => document.querySelector(s))
      .find((el) => el);
    const body = bodyEl ? (bodyEl.innerText || "").trim() : "";
    console.log('[NCAFE] 추출 결과 — title:', title.slice(0,30), 'body길이:', body.length, 'author:', author);

    // 시스템 안내 메시지(가입 안내·로그인 안내 등) 감지 시 추적 중단
    // 가입 안 된 카페에 자동 입력 시도하면 안내 메시지가 title selector에 매칭되는 케이스 방지
    if (looksLikeSystemMessage(title) || looksLikeSystemMessage(body)) {
      console.log('[NCAFE] post-page.js: 시스템 안내 메시지 감지 → 추적 skip');
      return;
    }

    if (!title && !body) {
      if (!process._retried) {
        process._retried = true;
        setTimeout(() => { process().catch(() => {}); }, 3000);
        return;
      }
      process._retried = false;
      // 최상위 f-e SPA 쉘은 내용이 없는 것이 정상 (iframe에서 처리)
      return;
    }

    const commentCount = pickNumber(SELECTORS.commentCount);
    const viewCount = pickNumber(SELECTORS.viewCount);
    const likeCount = pickNumber(SELECTORS.likeCount);
    const cafeName =
      pickText(SELECTORS.cafeName) || getCafeNameFromShell() || getCafeNameFromURL();
    const url = window.location.href;

    // 본인 글 추적: post_stats → post_published
    let result = await sendTrack("post_stats", {
      url,
      commentCount,
      viewCount,
      likeCount,
    });

    if (result.warning && result.warning.includes("찾을 수 없")) {
      result = await sendTrack("post_published", {
        url,
        title,
        body,
        cafeName,
        author,
        commentCount,
        viewCount,
        likeCount,
        publishedAt: new Date().toISOString(),
      });
    }

    // 본인 글 결과만 토스트로 표시 (다른 사람 글은 silent collected)
    if (result.ok && result.message) {
      window.NCAFE_Toast?.show({
        title: "NCAFE",
        message: result.message,
        type: "ok",
      });
    } else if (result.warning && !result.warning.includes("본인 글 아님")) {
      window.NCAFE_Toast?.show({
        title: "NCAFE 경고",
        message: result.warning,
        type: "warn",
        duration: 6000,
      });
    } else if (result.error) {
      window.NCAFE_Toast?.show({
        title: "NCAFE 오류",
        message: result.error,
        type: "err",
        duration: 6000,
      });
    }
  }

  // ─── 글 감지 및 수집 ──────────────────────────────────

  let lastProcessedKey = '';
  let scheduleTimer = null;

  function getArticleKey() {
    // URL에 article ID가 있으면 우선 사용
    const m = location.href.match(/\/articles\/(\d+)/) ||
              location.href.match(/articleid=(\d+)/i);
    if (m) return `id:${m[1]}`;
    // fallback: 제목 기반 (iframe 내부 등 URL 변경 없는 경우)
    const title = pickText(SELECTORS.title);
    return title ? `title:${title}` : location.href;
  }

  function scheduleProcess(fromNavigation = false) {
    if (fromNavigation) {
      // 네비게이션이면 기존 예약 취소 후 재시작
      if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null; }
    }
    if (scheduleTimer) return; // 이미 예약됨

    const delay = 2500 + Math.floor(Math.random() * 2000);
    scheduleTimer = setTimeout(async () => {
      scheduleTimer = null;
      if (!isArticleView()) return;
      const key = getArticleKey();
      if (!key || key === lastProcessedKey) return;
      lastProcessedKey = key;
      await process().catch(() => {});
    }, delay);
  }

  // 초기 실행
  scheduleProcess();

  // SPA/iframe 감지: URL 변경 OR 글 콘텐츠 DOM 출현 모두 대응
  let lastHref = location.href;
  new MutationObserver(() => {
    const href = location.href;
    if (href !== lastHref) {
      lastHref = href;
      scheduleProcess(true); // URL 변경 = 명확한 네비게이션
    } else if (isArticleView() && !scheduleTimer) {
      scheduleProcess(); // URL 변경 없이 글 콘텐츠 출현 (iframe 방식)
    }
  }).observe(document.body || document.documentElement, { subtree: true, childList: true });
})();
