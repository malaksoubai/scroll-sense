// ============================================================
// ScrollSense — popup.js  v2.0
// ============================================================

const CIRCUMFERENCE = 264;

document.addEventListener("DOMContentLoaded", async () => {
  await loadStats();
  await checkOllama();
  await checkQuizFile();
  bindSave();
  bindQuizMe();
});

// ─── Stats ───────────────────────────────────────────────────
function loadStats() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "GET_POPUP_STATS" }, (res) => {
      if (!res) { resolve(); return; }
      const { settings, today, budgetSec, streak } = res;

      // Ring
      const usedSec   = today?.usedSeconds   || 0;
      const usedMin   = Math.floor(usedSec / 60);
      const remaining = Math.max(0, budgetSec - usedSec);
      const pct       = budgetSec > 0 ? Math.min(1, usedSec / budgetSec) : 0;
      const over      = usedSec > budgetSec;

      const ring = document.getElementById("ring-fg");
      if (ring) {
        ring.style.strokeDashoffset = CIRCUMFERENCE - pct * CIRCUMFERENCE;
        ring.style.stroke = pct >= 1 ? "#f87171" : pct >= 0.8 ? "#facc15" : "#6366f1";
      }
      setText("ring-time",  formatTime(over ? usedSec - budgetSec : remaining));
      setText("ring-label", over ? "over budget" : "left today");

      // Earned time badge
      const earnedSec = today?.earnedSeconds || 0;
      const earnedMin = Math.floor(earnedSec / 60);
      const earnedEl  = document.getElementById("earned-badge");
      if (earnedMin > 0 && earnedEl) {
        earnedEl.classList.add("visible");
        setText("earned-text", `+${earnedMin} min earned today`);
      }

      // Streak
      const streakRow = document.getElementById("streak-row");
      if (streak > 0 && streakRow) {
        streakRow.classList.add("visible");
        setText("streak-count", streak);
      }

      // Stats
      setText("stat-used",      usedMin);
      setText("stat-overrides", today?.overrideCount  || 0);
      setText("stat-correct",   today?.correctAnswers || 0);
      setText("stat-wrong",     today?.wrongAnswers   || 0);

      // Quiz accuracy bar
      const correct = today?.correctAnswers || 0;
      const wrong   = today?.wrongAnswers   || 0;
      const total   = correct + wrong;
      const fill    = document.getElementById("score-fill");
      if (fill) fill.style.width = (total > 0 ? Math.round((correct / total) * 100) : 0) + "%";

      // Settings
      setValue("set-budget",  settings.dailyBudgetMinutes   ?? 20);
      setValue("set-posts",   settings.postsPerIntervention ?? 10);
      setChecked("set-freeze", settings.hardFreezeEnabled   ?? true);
      setText("model-name",   settings.model || "llama3.2");

      resolve();
    });
  });
}

// ─── Ollama dot ───────────────────────────────────────────────
async function checkOllama() {
  const dot = document.getElementById("ollama-dot");
  if (!dot) return;
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2500) });
    dot.classList.add(res.ok ? "online" : "offline");
  } catch {
    dot.classList.add("offline");
  }
}

// ─── Quiz Me file dot ─────────────────────────────────────────
function checkQuizFile() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "GET_QUIZ_FILES" }, (res) => {
      const dot = document.getElementById("quiz-dot");
      if (dot && res?.files?.length > 0) dot.classList.remove("inactive");
      resolve();
    });
  });
}

// ─── Quiz Me button → opens options page ─────────────────────
function bindQuizMe() {
  document.getElementById("quiz-me-btn")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

// ─── Save settings ────────────────────────────────────────────
function bindSave() {
  const btn = document.getElementById("save-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const settings = {
      dailyBudgetMinutes:   Math.max(1, parseInt(getValue("set-budget"))  || 20),
      postsPerIntervention: Math.max(3, parseInt(getValue("set-posts"))   || 10),
      hardFreezeEnabled:    getChecked("set-freeze"),
      model:                document.getElementById("model-name")?.textContent?.trim() || "llama3.2",
    };
    chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings }, () => {
      btn.textContent = "Saved ✓";
      btn.classList.add("saved");
      setTimeout(() => { btn.textContent = "Save Settings"; btn.classList.remove("saved"); }, 1800);
    });
  });
}

// ─── Helpers ─────────────────────────────────────────────────
function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function setText(id, v)    { const e = document.getElementById(id); if (e) e.textContent = v; }
function setValue(id, v)   { const e = document.getElementById(id); if (e) e.value = v; }
function getValue(id)      { return document.getElementById(id)?.value || ""; }
function setChecked(id, v) { const e = document.getElementById(id); if (e) e.checked = !!v; }
function getChecked(id)    { return document.getElementById(id)?.checked ?? false; }
