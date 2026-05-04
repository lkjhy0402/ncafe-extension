const NCAFE_URL = "https://ncafe-web.vercel.app";

// ── 메시지 라우터 ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.kind === "ncafe.track") {
    // content scripts → NCAFE API 포워딩 (currentPersonaId 자동 주입)
    handleTrack(message.type, message.payload).then(sendResponse);
    return true; // async 응답을 위해 채널 유지
  }
  if (message.type === "STAT_INCREMENT") {
    updateStats(message.key);
  }
});

// ── NCAFE API 포워딩 ──────────────────────────────────────

async function handleTrack(type, payload) {
  const storage = await chrome.storage.local.get(["ncafeToken", "currentPersonaId"]);

  if (!storage.ncafeToken) {
    return { ok: false, error: "토큰 미설정. 확장 팝업에서 토큰을 저장하세요." };
  }

  // currentPersonaId를 페이로드에 자동 주입
  const enrichedPayload = {
    ...payload,
    ...(storage.currentPersonaId ? { currentPersonaId: storage.currentPersonaId } : {}),
  };

  try {
    const res = await fetch(`${NCAFE_URL}/api/track`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${storage.ncafeToken}`,
      },
      body: JSON.stringify({ type, payload: enrichedPayload }),
    });
    const data = await res.json();
    // 통계 카운터 업데이트
    if (res.ok) updateStats(type);
    return data;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── 통계 관리 (이번 주) ────────────────────────────────────

function updateStats(type) {
  const statKey = {
    post_published: "posts",
    post_stats: "posts",
    cafe_membership: "cafes",
  }[type];
  if (!statKey) return;

  chrome.storage.local.get(["stats"], (result) => {
    const stats = result.stats || { posts: 0, cafes: 0, weekStart: getWeekStart() };
    if (stats.weekStart !== getWeekStart()) {
      Object.assign(stats, { posts: 0, cafes: 0, weekStart: getWeekStart() });
    }
    stats[statKey] = (stats[statKey] || 0) + 1;
    chrome.storage.local.set({ stats });
  });
}

function getWeekStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 월요일 기준
  return d.toISOString().split("T")[0];
}
