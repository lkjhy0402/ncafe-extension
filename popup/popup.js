const NCAFE_URL = "https://ncafe-web.vercel.app";

// ── 초기화 ────────────────────────────────────────────────

let personaLoadTimer = null;

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();

  document.getElementById("saveBtn").addEventListener("click", saveSettings);
  document.getElementById("testBtn").addEventListener("click", testConnection);
  document.getElementById("openBtn").addEventListener("click", openNCAFE);
  document.getElementById("toggleToken").addEventListener("click", toggleTokenVisibility);
  document.getElementById("personaSelect").addEventListener("change", onPersonaChange);

  // 토큰 입력 시 페르소나 자동 로드 (0.6초 디바운스)
  document.getElementById("token").addEventListener("input", () => {
    clearTimeout(personaLoadTimer);
    personaLoadTimer = setTimeout(async () => {
      const token = document.getElementById("token").value.trim();
      if (token.length > 20) {
        await loadPersonas(token, "");
      }
    }, 600);
  });
});

// ── 설정 로드 ─────────────────────────────────────────────

function loadSettings() {
  chrome.storage.local.get(["ncafeToken", "currentPersonaId", "lastSavedAt"], async (r) => {
    const token = r.ncafeToken || "";
    document.getElementById("token").value = token;
    updateStatusBadge(!!token);

    if (token) {
      await loadPersonas(token, r.currentPersonaId || "");
      if (r.currentPersonaId) {
        loadStats(token, r.currentPersonaId);
      }
      if (r.lastSavedAt) {
        showSaveStatus(`마지막 저장: ${formatRelativeTime(r.lastSavedAt)}`);
      }
    }
  });
}

// ── 페르소나 드롭다운 ──────────────────────────────────────

async function loadPersonas(token, selectedId) {
  const select = document.getElementById("personaSelect");
  select.innerHTML = '<option value="">— 로딩 중… —</option>';

  try {
    const res = await fetch(`${NCAFE_URL}/api/personas`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      select.innerHTML = '<option value="">— 페르소나 선택 —</option>';
      return;
    }

    const personas = await res.json();
    select.innerHTML = '<option value="">— 페르소나 선택 —</option>';

    personas.forEach((p) => {
      const option = document.createElement("option");
      option.value = p.id;
      const name = p.display_name || p.nickname || p.id;
      option.textContent = name;
      if (p.id === selectedId) option.selected = true;
      select.appendChild(option);
    });

    // 페르소나가 1명이면 자동 선택
    if (!selectedId && personas.length === 1) {
      select.value = personas[0].id;
    }

    const currentVal = select.value;
    if (currentVal) {
      select.classList.add("selected");
      document.getElementById("personaHint").style.display = "block";
    }
  } catch {
    select.innerHTML = '<option value="">— 페르소나 선택 —</option>';
  }
}

function onPersonaChange() {
  const select = document.getElementById("personaSelect");
  const hasValue = !!select.value;
  select.classList.toggle("selected", hasValue);
  document.getElementById("personaHint").style.display = hasValue ? "block" : "none";
  document.getElementById("statsSection").style.display = "none";
}

// ── 저장 ─────────────────────────────────────────────────

async function saveSettings() {
  const token = document.getElementById("token").value.trim();
  const select = document.getElementById("personaSelect");
  const personaId = select.value;
  const personaLabel = select.options[select.selectedIndex]?.text || "";

  if (!token) {
    showSaveStatus("⚠️ 토큰을 입력하세요", "warn");
    return;
  }

  const btn = document.getElementById("saveBtn");
  btn.disabled = true;

  // 페르소나가 아직 로드 안 됐으면 먼저 로드
  if (select.options.length <= 1) {
    showSaveStatus("페르소나 불러오는 중…");
    await loadPersonas(token, "");
  }

  const finalPersonaId = select.value;
  const finalPersonaLabel = select.options[select.selectedIndex]?.text || "";

  if (!finalPersonaId) {
    showSaveStatus("⚠️ 페르소나를 선택하세요", "warn");
    btn.disabled = false;
    return;
  }

  const now = new Date().toISOString();
  await chrome.storage.local.set({
    ncafeToken: token,
    currentPersonaId: finalPersonaId,
    currentPersonaLabel: finalPersonaLabel,
    lastSavedAt: now,
  });

  updateStatusBadge(true);
  showSaveStatus(`✅ ${finalPersonaLabel}으로 저장됨`);
  loadStats(token, finalPersonaId);
  btn.disabled = false;
}

function showSaveStatus(msg, type = "") {
  const el = document.getElementById("saveStatus");
  el.textContent = msg;
  el.className = `save-status${type ? ` ${type}` : ""}`;
}

// ── 통계 로드 ─────────────────────────────────────────────

async function loadStats(token, personaId) {
  if (!personaId) return;
  const section = document.getElementById("statsSection");
  section.style.display = "block";

  try {
    const res = await fetch(
      `${NCAFE_URL}/api/stats/persona-today?personaId=${encodeURIComponent(personaId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return;

    const data = await res.json();
    document.getElementById("postsCount").textContent = data.posts ?? 0;
    document.getElementById("collectedCount").textContent = data.collected ?? 0;
  } catch {
    // 통계 로드 실패 — 0 그대로
  }
}

// ── 연결 테스트 ──────────────────────────────────────────

async function testConnection() {
  const btn = document.getElementById("testBtn");
  btn.textContent = "확인 중…";
  btn.disabled = true;

  chrome.storage.local.get(["ncafeToken"], async (r) => {
    if (!r.ncafeToken) {
      showMsg("토큰을 먼저 입력하고 저장하세요.", "err");
      btn.textContent = "🔌 연결 테스트";
      btn.disabled = false;
      return;
    }
    try {
      const res = await fetch(`${NCAFE_URL}/api/track/test`, {
        headers: { Authorization: `Bearer ${r.ncafeToken}` },
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        showMsg("✅ 연결 성공!", "ok");
        updateStatusBadge(true);
      } else {
        showMsg("❌ 토큰이 유효하지 않습니다.", "err");
        updateStatusBadge(false, true);
      }
    } catch (e) {
      showMsg("❌ 네트워크 오류: " + e.message, "err");
      updateStatusBadge(false, true);
    }
    btn.textContent = "🔌 연결 테스트";
    btn.disabled = false;
  });
}

// ── NCAFE 열기 ────────────────────────────────────────────

function openNCAFE() {
  chrome.tabs.create({ url: NCAFE_URL });
}

// ── UI 헬퍼 ──────────────────────────────────────────────

function toggleTokenVisibility() {
  const inp = document.getElementById("token");
  inp.type = inp.type === "password" ? "text" : "password";
}

function updateStatusBadge(connected, error = false) {
  const badge = document.getElementById("statusBadge");
  badge.className = "badge";
  if (error) {
    badge.classList.add("badge--err");
    badge.textContent = "오류";
  } else if (connected) {
    badge.classList.add("badge--on");
    badge.textContent = "✅ 활성";
  } else {
    badge.classList.add("badge--off");
    badge.textContent = "⚠️ 토큰 필요";
  }
}

function showMsg(text, type) {
  const el = document.getElementById("msg");
  el.textContent = text;
  el.className = `msg msg--${type}`;
  setTimeout(() => { el.className = "msg hidden"; }, 3000);
}

function formatRelativeTime(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}
