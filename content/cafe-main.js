// NCAFE Tracker - 카페 메인 페이지 content script
// 카페 메인(루트)에서 가입 상태 + 본인 닉네임 자동 감지 → background로 전달.
//
// 자동 감지 셀렉터는 best-effort. 네이버 카페가 실제로 사용하는 클래스명은 자주 바뀌고
// iframe 안에 있는 경우도 있으므로 다중 fallback + silent skip으로 안정성 확보.
// 감지 실패 시 사용자가 NCAFE 페르소나 편집 페이지에서 수동 입력으로 보완 가능.

(function () {
  if (window.__NCAFE_CAFE_MAIN_LOADED__) return;
  window.__NCAFE_CAFE_MAIN_LOADED__ = true;

  function isCafeMainPage() {
    const url = window.location.pathname;
    if (/^\/f-e\/cafes\/[^/]+\/?$/.test(url)) return true;
    if (/^\/[^/]+\/?$/.test(url) && !url.includes("ArticleRead")) return true;
    return false;
  }

  function getCafeUrl() {
    return window.location.origin + window.location.pathname;
  }

  function getCafeId() {
    const fe = window.location.pathname.match(/\/f-e\/cafes\/([^/]+)/);
    if (fe) return fe[1];
    const slug = window.location.pathname.match(/^\/([^/]+)/);
    return slug ? slug[1] : null;
  }

  // ─── 본인 닉네임 자동 감지 ─────────────────────────────
  // 네이버 카페의 "현재 로그인한 회원" 표시 영역에서 닉네임 추출.
  // 다양한 위치/구조 대응: shell, iframe, 회원 정보 패널 등.

  const NICK_SELECTORS = [
    // 모바일/PC 공통 후보
    ".cafe_member_nick",
    ".member_nick",
    ".user-info .nickname",
    ".user_nick",
    ".profile_area .nick",
    ".my_info .nickname",
    ".pers_nick_area .nickname",
    'a[class*="my-cafe-nick"]',
    'span[class*="nick"][class*="my"]',
    // 카페 상단의 "ㅇㅇㅇ님" 형태
    "div.cafe_personal_area .nickname",
  ];

  function pickNickname() {
    for (const sel of NICK_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) {
        const text = (el.textContent || "").trim();
        if (text && text.length < 50) {
          // "○○님" 등 접미사 제거
          return text.replace(/(님|회원|\s*\(.*?\))$/g, "").trim();
        }
      }
    }
    // iframe 안에서 시도 (cross-origin 차단 시 silent fail)
    const iframes = document.querySelectorAll("iframe");
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument;
        if (!doc) continue;
        for (const sel of NICK_SELECTORS) {
          const el = doc.querySelector(sel);
          if (el) {
            const text = (el.textContent || "").trim();
            if (text && text.length < 50) {
              return text.replace(/(님|회원|\s*\(.*?\))$/g, "").trim();
            }
          }
        }
      } catch {
        // cross-origin 무시
      }
    }
    return null;
  }

  // ─── 가입 상태 추론 ───────────────────────────────────

  function detectMembershipStatus() {
    const bodyText = document.body.innerText || "";

    const joinBtn = document.querySelector(
      'a.btn-cafe-join, a[href*="JoinForm"], button[class*="join"]'
    );
    if (joinBtn || /가입하기|회원가입/.test(bodyText.slice(0, 3000))) {
      if (!/내가 쓴 글|회원등급/.test(bodyText)) {
        return "not_joined";
      }
    }

    const writeBtn = document.querySelector(
      'a.btn-write, a[href*="ArticleWrite"], button[class*="write"]'
    );
    if (writeBtn) {
      if (/신입|예비회원|준회원/.test(bodyText.slice(0, 5000))) {
        return "pending";
      }
      return "active";
    }

    if (/내가 쓴 글|내 활동|내 정보/.test(bodyText.slice(0, 5000))) {
      return "active";
    }

    return "unknown";
  }

  async function sendTrack(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { kind: "ncafe.track", type, payload },
        (resp) => resolve(resp ?? { ok: false, error: "no response" })
      );
    });
  }

  async function process() {
    if (!isCafeMainPage()) return;

    const status = detectMembershipStatus();
    const cafeUrl = getCafeUrl();
    const cafeId = getCafeId();
    const myNickname = pickNickname();

    const result = await sendTrack("cafe_membership", {
      cafeUrl,
      cafeId,
      status,
      myNickname,  // null이면 백엔드가 닉네임 업데이트 skip
    });

    if (result.ok) {
      const nickInfo =
        result.nicknameUpdate?.updatedRows > 0
          ? `, 닉네임 "${myNickname}" 자동 등록 (${result.nicknameUpdate.updatedRows}개)`
          : myNickname
          ? ` (닉네임 "${myNickname}" 감지)`
          : "";
      window.NCAFE_Toast?.show({
        title: "NCAFE",
        message: `가입 상태 ${status}${nickInfo}`,
        type: "ok",
        duration: 3000,
      });
    }
    // 카페 미등록 등 warning은 silent (사용자가 NCAFE에 카페 등록해야 함)
  }

  // 페이지 동적 로드 대비 폴링 (최대 4초)
  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;
    if (document.body && document.body.innerText.length > 200) {
      clearInterval(interval);
      process().catch(() => {
        // silent
      });
    } else if (attempts >= 8) {
      clearInterval(interval);
    }
  }, 500);
})();
