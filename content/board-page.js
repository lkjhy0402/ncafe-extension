// NCAFE Tracker - 게시판 페이지 content script
// 카페 게시판(글 목록)에서 [📥 NCAFE 수집] 버튼 표시.
// 클릭 시:
//   1. 글 메타데이터 수집 (제목·URL·작성자·댓글수)
//   2. iframe으로 본문 자동 수집 시도 (동일 도메인)
//   3. 차단 감지 시 게시판 미리보기 본문 추출로 fallback

(function () {
  if (window.__NCAFE_BOARD_PAGE_LOADED__) return;
  window.__NCAFE_BOARD_PAGE_LOADED__ = true;

  function isBoardPage() {
    const href = window.location.href;
    if (href.includes("ArticleList.nhn")) return true;
    if (/cafe\.naver\.com\/f-e\/cafes\/[^/]+\/menus\/\d+/.test(href)) return true;
    return false;
  }

  function getCafeUrlId() {
    const fe = window.location.pathname.match(/\/f-e\/cafes\/([^/]+)/);
    if (fe) return fe[1];
    const slug = window.location.pathname.match(/^\/([^/]+)/);
    return slug ? slug[1] : null;
  }

  // ─── 게시판 글 목록 추출 (다중 fallback) ───────────────

  const ARTICLE_LINK_SEL = 'a[href*="ArticleRead"], a[href*="/articles/"]';

  function rowFromLink(linkEl) {
    return linkEl.closest("li, tr, article, [class*='item'], [class*='Item'], [class*='article']")
      || linkEl.parentElement;
  }

  function parseRow(linkEl, row) {
    const href = linkEl.href;
    if (!href || href.includes("write") || href.includes("edit")) return null;

    const titleEl = row?.querySelector(
      ".article-title, .tit, .title, span[class*='title'], span[class*='Title']"
    ) || linkEl;

    const authorEl = row?.querySelector(
      ".nick, .article-author, .p-nick, td.p-nick, [class*='nick'], [class*='author'], [class*='writer']"
    );

    const commentEl = row?.querySelector(
      ".comment, .article-comment, em.cmt, .num, [class*='comment'], [class*='cmt']"
    );

    const commentText = commentEl?.textContent?.replace(/\D/g, "") ?? "0";
    return {
      url: href,
      title: (titleEl?.textContent ?? "").trim(),
      author: (authorEl?.textContent ?? "").trim() || null,
      commentCount: parseInt(commentText, 10) || 0,
    };
  }

  function extractPosts(maxCount = 20) {
    const posts = [];
    const seen = new Set();

    const rowSelectors = [
      ".article-board .article",
      "tr.tit-num-box",
      "tr[data-id]",
      ".article-list li",
      ".se-board-list li",
      ".ArticleListItem",
      "li[class*='article']",
      "li[class*='Article']",
      "tr[class*='article']",
      "[class*='board-list'] li",
      "[class*='BoardList'] li",
      "[class*='articleList'] li",
    ];

    for (const sel of rowSelectors) {
      const rows = document.querySelectorAll(sel);
      if (rows.length === 0) continue;

      rows.forEach((row) => {
        if (posts.length >= maxCount) return;
        const linkEl = row.querySelector(ARTICLE_LINK_SEL);
        if (!linkEl) return;
        const href = linkEl.href;
        if (!href || seen.has(href)) return;
        seen.add(href);
        const post = parseRow(linkEl, row);
        if (post) posts.push(post);
      });

      if (posts.length > 0) break;
    }

    // 범용 fallback
    if (posts.length === 0) {
      document.querySelectorAll(ARTICLE_LINK_SEL).forEach((linkEl) => {
        if (posts.length >= maxCount) return;
        const href = linkEl.href;
        if (!href || seen.has(href)) return;
        seen.add(href);
        const post = parseRow(linkEl, rowFromLink(linkEl));
        if (post) posts.push(post);
      });
    }

    return posts;
  }

  // ─── 게시판 미리보기 본문 추출 (fallback) ─────────────

  function extractPartialBodiesFromBoard() {
    const bodies = [];
    const seen = new Set();

    // 일부 카페는 목록에서 미리보기 본문을 노출
    const previewSelectors = [
      ".article-preview",
      ".preview",
      ".article-content-preview",
      ".content-preview",
      "[class*='preview']",
      ".article_text",
    ];

    document.querySelectorAll(ARTICLE_LINK_SEL).forEach((linkEl) => {
      const href = linkEl.href;
      if (!href || seen.has(href)) return;

      const row = rowFromLink(linkEl);
      let preview = null;

      for (const sel of previewSelectors) {
        const el = row?.querySelector(sel);
        if (el && el.textContent.trim()) {
          preview = el.textContent.trim().slice(0, 200);
          break;
        }
      }

      if (preview) {
        seen.add(href);
        bodies.push({ url: href, partial_body: preview });
      }
    });

    return bodies;
  }

  // ─── iframe 본문 수집 ──────────────────────────────────

  const BODY_SELECTORS = [
    ".se-main-container",
    ".ContentRenderer",
    "#postViewArea",
    ".article_viewer",
    ".NHN_Writeform_Main",
    ".tbody.m-tcol-c",
  ];

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function loadInIframe(url) {
    return new Promise((resolve) => {
      const iframe = document.createElement("iframe");
      iframe.style.cssText = [
        "position:fixed",
        "top:-9999px",
        "left:-9999px",
        "width:1px",
        "height:1px",
        "opacity:0",
        "pointer-events:none",
      ].join(";");
      iframe.src = url;

      const timeout = setTimeout(() => {
        iframe.remove();
        resolve(null);
      }, 10000);

      iframe.onerror = () => {
        clearTimeout(timeout);
        iframe.remove();
        resolve(null);
      };

      iframe.onload = () => {
        // JS 렌더링 폴링 (0.5초마다 최대 6초)
        let waited = 0;
        const poll = setInterval(() => {
          waited += 500;
          try {
            const doc = iframe.contentDocument || iframe.contentWindow?.document;
            if (doc && doc.body) {
              for (const sel of BODY_SELECTORS) {
                const el = doc.querySelector(sel);
                const text = (el?.innerText || el?.textContent || "").trim();
                if (text) {
                  clearInterval(poll);
                  clearTimeout(timeout);
                  iframe.remove();
                  resolve(text);
                  return;
                }
              }
            }
          } catch {
            clearInterval(poll);
            clearTimeout(timeout);
            iframe.remove();
            resolve(null);
            return;
          }
          if (waited >= 6000) {
            clearInterval(poll);
            clearTimeout(timeout);
            iframe.remove();
            resolve(null);
          }
        }, 500);
      };

      document.body.appendChild(iframe);
    });
  }

  async function tryIframeBodyCollection(urls, onProgress) {
    const results = { success: 0, failed: 0, bodies: [] };

    for (let i = 0; i < urls.length; i++) {
      onProgress(i + 1, urls.length);

      const body = await loadInIframe(urls[i]);

      if (body) {
        results.bodies.push({ url: urls[i], body });
        results.success++;
      } else {
        results.failed++;
      }

      if (i < urls.length - 1) {
        await sleep(2000 + Math.random() * 1500);
      }
    }

    return results;
  }

  // ─── 메시지 전송 헬퍼 ─────────────────────────────────

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          void chrome.runtime.lastError; // suppress Unchecked lastError warning
          resolve(resp ?? { ok: false, error: "no response" });
        });
      } catch {
        resolve({ ok: false, error: "extension context unavailable" });
      }
    });
  }

  // ─── 플로팅 버튼 ──────────────────────────────────────

  function makeBtn() {
    const btn = document.createElement("button");
    btn.id = "ncafe-collect-btn";
    btn.type = "button";
    btn.innerHTML = `<span style="margin-right:6px">📥</span>NCAFE 수집`;
    btn.style.cssText = [
      "position:fixed",
      "right:20px",
      "bottom:20px",
      "z-index:2147483647",
      "padding:12px 18px",
      "background:#18181b",
      "color:#fff",
      "border:none",
      "border-radius:8px",
      "font-size:13px",
      "font-weight:500",
      'font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif',
      "cursor:pointer",
      "box-shadow:0 4px 12px rgba(0,0,0,0.18)",
      "transition:transform 0.15s,background 0.15s",
      "min-width:130px",
      "text-align:center",
    ].join(";");

    btn.addEventListener("mouseenter", () => {
      if (!btn.disabled) {
        btn.style.background = "#27272a";
        btn.style.transform = "translateY(-1px)";
      }
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = btn.disabled ? "#52525b" : "#18181b";
      btn.style.transform = "translateY(0)";
    });

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.style.background = "#52525b";
      try {

      // ── 현재 페이지 재확인 (SPA 이동 후 버튼이 남아있을 수 있음) ──
      if (!isBoardPage()) {
        window.NCAFE_Toast?.show({
          title: "NCAFE",
          message: "게시판 글 목록 페이지에서 사용해주세요.",
          type: "warn",
          duration: 4000,
        });
        btn.disabled = false;
        btn.style.background = "#18181b";
        return;
      }

      // ── 1. 메타데이터 수집 ──
      const posts = extractPosts(20);
      if (posts.length === 0) {
        window.NCAFE_Toast?.show({
          title: "NCAFE",
          message: "수집 가능한 글이 없습니다 (셀렉터 매칭 실패).",
          type: "warn",
          duration: 5000,
        });
        btn.disabled = false;
        btn.style.background = "#18181b";
        btn.innerHTML = `<span style="margin-right:6px">📥</span>NCAFE 수집`;
        return;
      }

      btn.innerHTML = `메타 수집 중…`;

      const metaResult = await sendMessage({
        kind: "ncafe.track",
        type: "board_posts_collected",
        payload: {
          cafeUrlId: getCafeUrlId(),
          boardUrl: window.location.href,
          posts,
        },
      });

      if (!metaResult.ok) {
        window.NCAFE_Toast?.show({
          title: "NCAFE 오류",
          message: metaResult.warning || metaResult.error || "메타 수집 실패",
          type: "err",
          duration: 6000,
        });
        btn.disabled = false;
        btn.style.background = "#18181b";
        btn.innerHTML = `<span style="margin-right:6px">📥</span>NCAFE 수집`;
        return;
      }

      // ── 2. iframe 본문 수집 ──
      btn.innerHTML = `본문 수집 중… (1/${posts.length})`;

      const iframeResult = await tryIframeBodyCollection(
        posts.map((p) => p.url),
        (cur, total) => { btn.innerHTML = `본문 수집 중… (${cur}/${total})`; }
      );

      if (iframeResult.bodies.length > 0) {
        await sendMessage({
          kind: "ncafe.track",
          type: "full_bodies_collected",
          payload: { bodies: iframeResult.bodies },
        });
      }

      // ── 3. 수집 못한 글은 게시판 미리보기 fallback ──
      const collectedUrls = new Set(iframeResult.bodies.map((b) => b.url));
      const missingUrls = posts.map((p) => p.url).filter((u) => !collectedUrls.has(u));

      if (missingUrls.length > 0) {
        const partialBodies = extractPartialBodiesFromBoard()
          .filter((pb) => missingUrls.includes(pb.url));

        if (partialBodies.length > 0) {
          await sendMessage({
            kind: "ncafe.track",
            type: "partial_bodies_collected",
            payload: { boardUrl: window.location.href, bodies: partialBodies },
          });
        }
      }

      const totalBodies = iframeResult.bodies.length;
      const msg = totalBodies > 0
        ? `✅ 메타 ${posts.length}개 + 본문 ${totalBodies}개 수집 완료`
        : `메타 ${posts.length}개 수집 완료 (본문 추출 실패 — 글 방문 시 자동 수집)`;

      window.NCAFE_Toast?.show({
        title: "NCAFE",
        message: msg,
        type: totalBodies > 0 ? "ok" : "warn",
        duration: 5000,
      });

      } catch {
        window.NCAFE_Toast?.show({
          title: "NCAFE 오류",
          message: "수집 중 오류 발생. 페이지를 새로고침 후 다시 시도하세요.",
          type: "err",
          duration: 6000,
        });
      }

      btn.disabled = false;
      btn.style.background = "#18181b";
      btn.innerHTML = `<span style="margin-right:6px">📥</span>NCAFE 수집`;
    });

    return btn;
  }

  function addFloatingButton() {
    if (document.getElementById("ncafe-collect-btn")) return;
    document.body.appendChild(makeBtn());
  }

  function tryAddButton() {
    if (!document.body) return;
    if (!isBoardPage()) return;
    addFloatingButton();
  }

  // 1.5초 후 초기 시도, 실패 대비 3초 후 재시도
  setTimeout(tryAddButton, 1500);
  setTimeout(tryAddButton, 3000);

  // SPA 네비게이션 지원: URL 변경 시 버튼 재확인
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const existing = document.getElementById("ncafe-collect-btn");
    if (isBoardPage()) {
      if (!existing) addFloatingButton();
    } else {
      existing?.remove();
    }
  }).observe(document.body, { subtree: true, childList: true });
})();
