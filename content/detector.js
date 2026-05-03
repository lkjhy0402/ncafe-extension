/**
 * NCAFE 카페 페이지 자동 감지 및 데이터 전송
 * 네이버 카페 페이지 전반에서 작동
 */
(function () {
  "use strict";

  const NCAFE_URL = "https://ncafe-web.vercel.app";

  // ── 유틸리티 ──────────────────────────────────────────

  function isArticlePage() {
    const href = window.location.href;
    return (
      /cafe\.naver\.com\/[^/]+\/\d+/.test(href) ||
      href.includes("ArticleRead")
    );
  }

  function isCafeMainPage() {
    const href = window.location.href;
    return /cafe\.naver\.com\/[^/]+\/?$/.test(href) || href.includes("MemberJoinForm");
  }

  function isPopularPage() {
    const href = window.location.href;
    return href.includes("BestArticleList") || href.includes("popularPost");
  }

  function getCafeName() {
    return (
      document.querySelector(".cafe-name > a")?.textContent?.trim() ||
      document.querySelector(".cafe_name")?.textContent?.trim() ||
      document.querySelector("#cafe-info-ct .cafe_name")?.textContent?.trim() ||
      window.location.pathname.split("/")[1] ||
      ""
    );
  }

  // ── 데이터 전송 ──────────────────────────────────────

  async function sendToNCAFE(type, payload) {
    return new Promise((resolve) => {
      chrome.storage.local.get(["ncafeToken"], async (result) => {
        if (!result.ncafeToken) {
          console.warn("[NCAFE] 토큰 없음. 확장 설정에서 토큰을 입력하세요.");
          resolve(null);
          return;
        }
        try {
          const res = await fetch(`${NCAFE_URL}/api/track`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${result.ncafeToken}`,
            },
            body: JSON.stringify({ type, payload }),
          });
          const data = await res.json();
          resolve(data);
          if (data.ok) {
            showBadge("✅ NCAFE", data.message || "저장됨");
            chrome.runtime.sendMessage({ type: "STAT_INCREMENT", key: type });
          } else if (data.warning) {
            showBadge("⚠️", data.warning, "warning");
          }
        } catch (e) {
          console.error("[NCAFE] 전송 실패:", e);
          resolve(null);
        }
      });
    });
  }

  // ── 화면 뱃지 ─────────────────────────────────────────

  function showBadge(title, message, type = "success") {
    const existing = document.getElementById("__ncafe_badge__");
    if (existing) existing.remove();

    const div = document.createElement("div");
    div.id = "__ncafe_badge__";
    div.style.cssText = `
      position: fixed; top: 20px; right: 20px;
      background: ${type === "warning" ? "#F59E0B" : "#10B981"};
      color: white; padding: 10px 16px; border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 2147483647; font-size: 13px; font-family: sans-serif;
      max-width: 280px; line-height: 1.4;
    `;
    div.innerHTML = `<strong>${title}</strong>${message ? `<br><span style="opacity:.85;font-size:11px">${message}</span>` : ""}`;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 4000);
  }

  // ── 글 페이지 처리 ────────────────────────────────────

  async function handleArticlePage() {
    const url = window.location.href;

    // 제목: 여러 선택자 시도
    const title =
      document.querySelector(".tit_box .ar_title")?.textContent?.trim() ||
      document.querySelector("h3.title_text")?.textContent?.trim() ||
      document.querySelector(".ArticleTitle")?.textContent?.trim() ||
      document.querySelector("[class*='title']")?.textContent?.trim() ||
      document.title.replace(/ : .+$/, "").trim() ||
      "";

    // 본문
    const body =
      document.querySelector("#tbody")?.innerText?.trim() ||
      document.querySelector(".se-main-container")?.innerText?.trim() ||
      document.querySelector("[class*='ContentBody']")?.innerText?.trim() ||
      "";

    // 통계
    const commentCount = parseInt(
      document.querySelector(".comment_count, .commentNum, [class*='comment'] [class*='count']")
        ?.textContent?.replace(/\D/g, "") || "0"
    );
    const viewCount = parseInt(
      document.querySelector("[class*='view'] [class*='count'], .view_count")
        ?.textContent?.replace(/\D/g, "") || "0"
    );
    const likeCount = parseInt(
      document.querySelector("[class*='like'] [class*='count'], .like_count")
        ?.textContent?.replace(/\D/g, "") || "0"
    );

    // 작성자
    const author =
      document.querySelector(".nick, .m-tcol-c.date-author, [class*='author']")
        ?.textContent?.trim() || "";

    const cafeName = getCafeName();

    // 본인 글인지 확인
    chrome.storage.local.get(["myNickname"], async (result) => {
      const myNick = result.myNickname?.trim();
      const isMyPost = myNick && author && author.includes(myNick);

      if (isMyPost) {
        // 본인 글 → post_published 전송
        await sendToNCAFE("post_published", {
          url,
          title,
          body,
          cafeName,
          commentCount,
          viewCount,
          likeCount,
          publishedAt: new Date().toISOString(),
        });
      } else {
        // 다른 사람 글이지만 통계 업데이트가 필요한 경우 (기존 발행 글 재방문)
        chrome.storage.local.get(["trackedUrls"], async (r) => {
          const tracked = r.trackedUrls || [];
          if (tracked.includes(url)) {
            await sendToNCAFE("post_stats", { url, commentCount, viewCount, likeCount });
          }
          // 댓글 많은 인기글 수집
          if (commentCount >= 10) {
            chrome.runtime.sendMessage({
              type: "POPULAR_POST",
              data: { title, commentCount, cafeName },
            });
          }
        });
      }
    });
  }

  // ── 카페 메인 처리 ────────────────────────────────────

  async function handleCafePage() {
    const url = window.location.href;
    let status = "unknown";

    if (document.querySelector(".btn_join, .btn-join")) {
      status = "not_joined";
    } else if (document.body.innerText.includes("신입회원")) {
      status = "pending";
    } else if (
      document.body.innerText.includes("정회원") ||
      document.querySelector(".member_grade")
    ) {
      status = "active";
    }

    if (status !== "unknown") {
      await sendToNCAFE("cafe_membership", {
        cafeUrl: url,
        cafeId: url.split("cafe.naver.com/")[1]?.split("/")[0] ?? "",
        status,
      });
    }
  }

  // ── 인기글 처리 ──────────────────────────────────────

  async function handlePopularPage() {
    const cafeName = getCafeName();
    const posts = [];
    const items = document.querySelectorAll(".article-board .td_article, [class*='ArticleList'] li");
    items.forEach((item) => {
      const title = item.querySelector(".article")?.textContent?.trim() || "";
      const cntText = item.querySelector(".td_comment, .comment")?.textContent?.trim() || "0";
      const commentCount = parseInt(cntText.replace(/\D/g, "") || "0");
      if (title && commentCount >= 5) {
        posts.push({ title, commentCount });
      }
    });

    if (posts.length > 0) {
      await sendToNCAFE("popular_posts", { cafeName, posts: posts.slice(0, 20) });
    }
  }

  // ── 메인 진입 ─────────────────────────────────────────

  // 페이지 완전 로드 대기 후 실행
  const delay = isArticlePage() ? 2500 : 1500;
  setTimeout(() => {
    try {
      if (isArticlePage()) handleArticlePage();
      else if (isPopularPage()) handlePopularPage();
      else if (isCafeMainPage()) handleCafePage();
    } catch (e) {
      console.error("[NCAFE] 오류:", e);
    }
  }, delay);
})();
