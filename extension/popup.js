// ============================================================
// ScrollSense — popup.js  v3.0
// ============================================================

const CIRCUMFERENCE = 264;

document.addEventListener("DOMContentLoaded", async () => {
  await loadStats();
  await checkOllama();
  await checkQuizFile();
  bindButtons();
});

// ─── Load stats ───────────────────────────────────────────────
function loadStats() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "GET_POPUP_STATS" }, (res) => {
      if (!res) { resolve(); return; }
      const { settings, today, budgetSec, streak, bankSize } = res;

      const usedSec   = today?.usedSeconds   || 0;
      const usedMin   = Math.floor(usedSec / 60);
      const remaining = Math.max(0, budgetSec - usedSec);
      const pct       = budgetSec > 0 ? Math.min(1, usedSec / budgetSec) : 0;
      const over      = usedSec > budgetSec;
      const earnedMin = Math.floor((today?.earnedSeconds || 0) / 60);

      // Ring
      const ring = document.getElementById("ring-fg");
      if (ring) {
        ring.style.strokeDashoffset = CIRCUMFERENCE - pct * CIRCUMFERENCE;
        ring.style.stroke = pct >= 1 ? "#f87171" : pct >= 0.8 ? "#facc15" : "#6366f1";
      }
      setText("ring-time",  formatTime(over ? usedSec - budgetSec : remaining));
      setText("ring-label", over ? "over budget" : "left today");

      // Badges
      if (streak > 0) {
        const el = document.getElementById("badge-streak");
        if (el) { el.textContent = "🔥 " + streak + " day streak"; el.classList.add("visible"); }
      }
      if (earnedMin > 0) {
        const el = document.getElementById("badge-earned");
        if (el) { el.textContent = "✨ +" + earnedMin + " min earned"; el.classList.add("visible"); }
      }

      // Stat tiles
      setText("stat-used",          usedMin);
      setText("stat-overrides",     today?.overrideCount   || 0);
      setText("stat-interventions", today?.interventions   || 0);
      setText("stat-correct",       today?.correctAnswers  || 0);
      setText("stat-wrong",         today?.wrongAnswers    || 0);
      setText("stat-bank",          bankSize || 0);

      // Quiz accuracy
      const correct = today?.correctAnswers || 0;
      const wrong   = today?.wrongAnswers   || 0;
      const total   = correct + wrong;
      const acc     = total > 0 ? Math.round((correct / total) * 100) : null;
      const fill    = document.getElementById("score-fill");
      if (fill) fill.style.width = (acc || 0) + "%";
      setText("score-pct", acc !== null ? acc + "%" : "—");

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
  const dot   = document.getElementById("ollama-dot");
  const label = document.getElementById("model-name");
  if (!dot) return;
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: controller.signal });
    clearTimeout(timeout);
    dot.classList.toggle("online",  res.ok);
    dot.classList.toggle("offline", !res.ok);
    if (!res.ok && label) label.textContent = "llama3.2 (offline)";
  } catch {
    clearTimeout(timeout);
    dot.classList.add("offline");
    if (label) label.textContent = "llama3.2 (offline)";
  }
}

// ─── Quiz Me dot ──────────────────────────────────────────────
function checkQuizFile() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "GET_QUIZ_FILES" }, (res) => {
      const dot = document.getElementById("quiz-dot");
      if (dot && res?.files?.length > 0) dot.classList.remove("inactive");
      resolve();
    });
  });
}

// ─── Bind all buttons ─────────────────────────────────────────
function bindButtons() {
  // Quiz Me → options page
  document.getElementById("quiz-me-btn")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // Stats → options page with stats tab
  document.getElementById("stats-btn")?.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html") + "?tab=stats" });
  });

  // Save settings
  document.getElementById("save-btn")?.addEventListener("click", () => {
    const settings = {
      dailyBudgetMinutes:   Math.max(1, parseInt(getValue("set-budget"))  || 20),
      postsPerIntervention: Math.max(3, parseInt(getValue("set-posts"))   || 10),
      hardFreezeEnabled:    getChecked("set-freeze"),
      model:                document.getElementById("model-name")?.textContent?.trim() || "llama3.2",
    };
    const btn = document.getElementById("save-btn");
    chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings }, () => {
      if (btn) { btn.textContent = "Saved ✓"; btn.classList.add("saved"); }
      setTimeout(() => { if (btn) { btn.textContent = "Save Settings"; btn.classList.remove("saved"); } }, 1800);
    });
  });

  // Reset today
  document.getElementById("reset-today-btn")?.addEventListener("click", () => {
    if (!confirm("Reset today's timer, quiz scores and overrides? Your streak and history stay intact.")) return;
    chrome.runtime.sendMessage({ type: "RESET_TODAY" }, () => {
      loadStats(); // refresh display
    });
  });
}

// ─── Helpers ─────────────────────────────────────────────────
function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
function setText(id, v)    { const e = document.getElementById(id); if (e) e.textContent = v; }
function setValue(id, v)   { const e = document.getElementById(id); if (e) e.value = v; }
function getValue(id)      { return document.getElementById(id)?.value || ""; }
function setChecked(id, v) { const e = document.getElementById(id); if (e) e.checked = !!v; }
function getChecked(id)    { return document.getElementById(id)?.checked ?? false; }
