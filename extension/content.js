// ============================================================
// ScrollSense — content.js  v4.0
// Key fixes:
//   - Scroll-distance trigger (replaces brittle MutationObserver)
//   - Ollama called directly from content script (not service worker)
//   - Tab switching via chrome.tabs.update instead of window.open
// ============================================================

(function () {
  "use strict";
  if (window.__scrollSenseLoaded) return;
  window.__scrollSenseLoaded = true;

  const OLLAMA_URL = "http://localhost:11434/api/generate";

  // ─── State ────────────────────────────────────────────────
  let usedSeconds           = 0;
  let budgetSec             = 1200;
  let settings              = {};
  let streak                = 0;
  let isFrozen              = false;
  let freezeOverriddenToday = false;
  let overlayActive         = false;
  let warned90              = false;
  let tickInterval          = null;
  let pillEl                = null;
  let overlayEl             = null;

  // Scroll tracking — trigger every N pixels scrolled (not N posts)
  let totalScrolled         = 0;
  let lastScrollY           = window.scrollY;
  let scrollsSinceIntervene = 0;
  const SCROLL_TRIGGER_PX   = 3000; // ~3 screenlengths of scrolling

  // ─── Boot ─────────────────────────────────────────────────
  init();

  async function init() {
    await refreshStatus();
    renderPill();
    startTicker();
    startScrollTracker();
    chrome.runtime.onMessage.addListener((m) => {
      if (m.type === "SHOW_WEEKLY_SUMMARY") showWeeklySummary();
    });
  }

  // ─── Sync from background ─────────────────────────────────
  async function refreshStatus() {
    const res = await sendMsg({ type: "GET_STATUS" });
    if (!res) return;
    usedSeconds = res.usedSec;
    budgetSec   = res.budgetSec;
    settings    = res.settings;
    streak      = res.streak || 0;
    updatePill();
  }

  // ─── Ticker ───────────────────────────────────────────────
  function startTicker() {
    clearInterval(tickInterval);
    let syncCountdown = 30;
    tickInterval = setInterval(async () => {
      if (document.hidden || isFrozen) return;
      const res = await sendMsg({ type: "TICK" });
      if (res) { usedSeconds = res.usedSeconds; budgetSec = res.budgetSec; }
      syncCountdown--;
      if (syncCountdown <= 0) { syncCountdown = 30; await refreshStatus(); }
      updatePill();
      checkThresholds();
    }, 1000);
  }

  // ─── Scroll tracker ───────────────────────────────────────
  // Much more reliable than MutationObserver on Instagram.
  // Fires every SCROLL_TRIGGER_PX pixels of cumulative downward scroll.
  function startScrollTracker() {
    window.addEventListener("scroll", () => {
      if (isFrozen || overlayActive) return;
      const currentY = window.scrollY;
      const delta    = currentY - lastScrollY;
      lastScrollY    = currentY;
      if (delta <= 0) return; // ignore upward scroll

      scrollsSinceIntervene += delta;
      if (scrollsSinceIntervene >= SCROLL_TRIGGER_PX) {
        scrollsSinceIntervene = 0;
        triggerIntervention();
      }
    }, { passive: true });
  }

  // ─── Threshold checks ─────────────────────────────────────
  function checkThresholds() {
    const pct = budgetSec > 0 ? usedSeconds / budgetSec : 0;
    if (pct >= 0.9 && pct < 1 && !warned90) {
      warned90 = true;
      pillEl?.classList.add("ss-pulse");
      showToast("warning", "⚠️ 90% of budget used — hard freeze coming soon.");
      setTimeout(() => pillEl?.classList.remove("ss-pulse"), 3000);
    }
    if (pct >= 1 && settings.hardFreezeEnabled && !isFrozen && !freezeOverriddenToday) {
      triggerHardFreeze();
    }
  }

  // ─── Timer Pill ───────────────────────────────────────────
  function renderPill() {
    if (pillEl) return;
    pillEl = document.createElement("div");
    pillEl.id = "ss-pill";
    document.body.appendChild(pillEl);
    updatePill();
  }

  function updatePill() {
    if (!pillEl) return;
    const pct     = budgetSec > 0 ? usedSeconds / budgetSec : 0;
    const over    = usedSeconds > budgetSec;
    const display = over ? usedSeconds - budgetSec : Math.max(0, budgetSec - usedSeconds);
    pillEl.className = pct < 0.8 ? "ss-green" : pct < 1 ? "ss-yellow" : "ss-red";
    pillEl.innerHTML =
      '<span class="ss-pill-icon">⏱</span>' +
      '<span class="ss-pill-time">' + formatTime(display) + "</span>" +
      '<span class="ss-pill-label">' + (over ? "over" : "left") + "</span>" +
      (streak > 0 ? '<span class="ss-pill-streak">🔥' + streak + "</span>" : "");
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  // ─── Toast ────────────────────────────────────────────────
  function showToast(kind, text) {
    const id = kind === "warning" ? "ss-warning-toast" : "ss-earn-toast";
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    const t = document.createElement("div");
    t.id = id;
    t.textContent = text;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("ss-toast-visible"));
    setTimeout(() => { t.classList.remove("ss-toast-visible"); setTimeout(() => t.remove(), 400); },
      kind === "warning" ? 4000 : 2500);
  }

  // ─── Intervention dispatcher ──────────────────────────────
  async function triggerIntervention() {
    if (overlayActive || isFrozen) return;
    overlayActive = true;

    const res = await sendMsg({ type: "GET_INTERVENTION" });
    if (!res) { overlayActive = false; return; }

    if (res.kind === "quiz") {
      // If background sent a snippet, we call Ollama directly from here
      if (res.snippet) {
        showLoadingOverlay(res.fileName);
        const quiz = await callOllamaForQuiz(res.snippet, res.fileName, res.model);
        if (quiz) showQuizOverlay(quiz, res.tabs, res.fileName);
        else      showNoFileOverlay(res.tabs); // Ollama failed
      } else {
        showNoFileOverlay(res.tabs); // no files uploaded
      }
    } else {
      showRedirectOverlay(res.tabs);
    }
  }

  // ─── Call Ollama from content script ─────────────────────
  // Content scripts CAN fetch localhost reliably. Service workers sometimes cannot.
  async function callOllamaForQuiz(snippet, fileName, model) {
    const prompt =
      "You are a quiz generator for a browser extension.\n" +
      "A user is studying: \"" + (fileName || "study material") + "\"\n" +
      "Here is an excerpt:\n---\n" + snippet + "\n---\n" +
      "Generate ONE multiple-choice question with exactly 4 options based ONLY on the text above.\n" +
      "Respond with ONLY this JSON and nothing else:\n" +
      '{"question":"...","options":["...","...","...","..."],"correctIndex":0}\n' +
      "correctIndex is 0-based. No markdown, no explanation, no extra text.";

    try {
      const res = await fetch(OLLAMA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model || "llama3.2", prompt, stream: false }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const raw  = (data.response || "").trim();
      const match = raw.match(/\{[\s\S]*\}/);
      return JSON.parse(match ? match[0] : raw);
    } catch (err) {
      console.warn("[ScrollSense] Ollama fetch failed:", err.message);
      return null;
    }
  }

  // ─── Loading overlay (while Ollama generates) ─────────────
  function showLoadingOverlay(fileName) {
    removeOverlay();
    overlayEl = document.createElement("div");
    overlayEl.id = "ss-quiz-overlay";
    overlayEl.innerHTML =
      '<div id="ss-quiz-card">' +
        '<div class="ss-quiz-header">' +
          '<span class="ss-logo">ScrollSense</span>' +
          '<span class="ss-quiz-badge">📚 Quiz</span>' +
        "</div>" +
        '<div class="ss-quiz-source">📂 ' + escHtml(truncate(fileName || "Study file", 44)) + "</div>" +
        '<div class="ss-loading-wrap">' +
          '<div class="ss-spinner"></div>' +
          '<p class="ss-loading-text">Generating question…</p>' +
        "</div>" +
      "</div>";
    blurFeed(true);
    document.body.appendChild(overlayEl);
    requestAnimationFrame(() => overlayEl.classList.add("ss-visible"));
  }

  // ─── No-files prompt ──────────────────────────────────────
  function showNoFileOverlay(tabs) {
    removeOverlay();
    overlayEl = document.createElement("div");
    overlayEl.id = "ss-quiz-overlay";

    const tabsHTML = tabs && tabs.length
      ? '<div class="ss-tabs-label">Jump back to your work:</div>' +
        '<div class="ss-tab-list" id="ss-nofile-tabs">' + buildTabButtons(tabs) + "</div>"
      : "";

    overlayEl.innerHTML =
      '<div id="ss-quiz-card">' +
        '<div class="ss-quiz-header">' +
          '<span class="ss-logo">ScrollSense</span>' +
          '<span class="ss-quiz-badge">📚 Quiz</span>' +
        "</div>" +
        '<p class="ss-quiz-question" style="text-align:center;color:#6366f1;margin-bottom:10px">No study files uploaded yet.</p>' +
        '<p style="font-size:13px;color:#6b7280;text-align:center;margin-bottom:16px;line-height:1.6">' +
          "Open <strong>ScrollSense → Quiz Me</strong> to upload notes.<br>" +
          "You'll earn +2 min for every correct answer." +
        "</p>" +
        tabsHTML +
        '<button id="ss-nofile-continue">Keep scrolling</button>' +
      "</div>";

    blurFeed(true);
    document.body.appendChild(overlayEl);
    requestAnimationFrame(() => overlayEl.classList.add("ss-visible"));
    wireTabButtons(overlayEl.querySelector("#ss-nofile-tabs"));
    overlayEl.querySelector("#ss-nofile-continue")
      ?.addEventListener("click", () => { sendMsg({ type: "LOG_OUTCOME", outcome: "override" }); closeOverlay(); });
  }

  // ─── Quiz Overlay ─────────────────────────────────────────
  function showQuizOverlay(quiz, tabs, fileName) {
    removeOverlay(); // replaces the loading overlay

    let choicesBtns = "";
    (quiz.options || []).forEach((opt, i) => {
      choicesBtns += '<button class="ss-choice-btn" data-val="' + i + '">' + escHtml(opt) + "</button>";
    });

    overlayEl = document.createElement("div");
    overlayEl.id = "ss-quiz-overlay";
    overlayEl.innerHTML =
      '<div id="ss-quiz-card">' +
        '<div class="ss-quiz-header">' +
          '<span class="ss-logo">ScrollSense</span>' +
          '<span class="ss-quiz-badge">📚 Quiz</span>' +
        "</div>" +
        '<div class="ss-quiz-source">📂 ' + escHtml(truncate(fileName || "Study file", 44)) + "</div>" +
        '<div class="ss-earn-note">✨ Answer correctly to earn +2 min</div>' +
        '<p class="ss-quiz-question">' + escHtml(quiz.question) + "</p>" +
        '<div class="ss-choice-col">' + choicesBtns + "</div>" +
        '<div id="ss-quiz-feedback" class="ss-quiz-feedback" style="display:none"></div>' +
        '<div id="ss-quiz-after" style="display:none">' +
          '<div class="ss-tabs-label">Jump back to your work:</div>' +
          '<div class="ss-tab-list" id="ss-quiz-tabs"></div>' +
          '<button id="ss-quiz-continue">Keep scrolling</button>' +
        "</div>" +
      "</div>";

    blurFeed(true);
    document.body.appendChild(overlayEl);
    requestAnimationFrame(() => overlayEl.classList.add("ss-visible"));

    const answered = { done: false };
    overlayEl.querySelectorAll(".ss-choice-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (answered.done) return;
        answered.done = true;

        const correct = parseInt(btn.dataset.val) === quiz.correctIndex;
        overlayEl.querySelectorAll(".ss-choice-btn").forEach((b, i) => {
          b.disabled = true;
          b.classList.add(i === quiz.correctIndex ? "ss-correct" : "ss-wrong-opt");
        });
        if (!correct) btn.classList.add("ss-wrong");

        const fb = overlayEl.querySelector("#ss-quiz-feedback");
        if (fb) {
          fb.style.display = "block";
          fb.className = "ss-quiz-feedback " + (correct ? "ss-fb-correct" : "ss-fb-wrong");
          fb.textContent = correct
            ? "✅ Correct! +2 min earned 🎉"
            : "❌ The answer was: " + escHtml(quiz.options?.[quiz.correctIndex] || "—");
        }

        const logRes = await sendMsg({
          type: "LOG_OUTCOME", outcome: correct ? "quiz_correct" : "quiz_wrong", source: "file"
        });
        if (correct && logRes?.newBudget) {
          budgetSec = logRes.newBudget;
          updatePill();
          showToast("earn", "🎉 +2 minutes earned!");
        }

        const after   = overlayEl.querySelector("#ss-quiz-after");
        const tabList = overlayEl.querySelector("#ss-quiz-tabs");
        if (after && tabList) {
          tabList.innerHTML = buildTabButtons(tabs);
          after.style.display = "block";
          wireTabButtons(tabList);
        }
        overlayEl.querySelector("#ss-quiz-continue")
          ?.addEventListener("click", () => { sendMsg({ type: "LOG_OUTCOME", outcome: "override", source: "file" }); closeOverlay(); });
      });
    });
  }

  // ─── Redirect Card — bottom-right, no blur ────────────────
  function showRedirectOverlay(tabs) {
    removeOverlay();
    overlayEl = document.createElement("div");
    overlayEl.id = "ss-redirect-overlay";

    const tabsHTML = tabs && tabs.length
      ? '<div class="ss-tabs-label">Your open tabs:</div>' +
        '<div class="ss-tab-list" id="ss-redirect-tabs">' + buildTabButtons(tabs) + "</div>"
      : '<p class="ss-no-tabs">No other tabs open right now.</p>';

    overlayEl.innerHTML =
      '<div id="ss-redirect-card">' +
        '<div class="ss-redirect-header">' +
          '<span class="ss-logo">ScrollSense</span>' +
          '<span class="ss-quiz-badge">🔀 Back to work</span>' +
        "</div>" +
        '<p class="ss-redirect-msg">Your open tabs are waiting.</p>' +
        tabsHTML +
        '<button id="ss-keep-scrolling">Keep scrolling</button>' +
      "</div>";

    document.body.appendChild(overlayEl);
    requestAnimationFrame(() => overlayEl.classList.add("ss-visible"));
    wireTabButtons(overlayEl.querySelector("#ss-redirect-tabs"));
    overlayEl.querySelector("#ss-keep-scrolling")
      ?.addEventListener("click", () => { sendMsg({ type: "LOG_OUTCOME", outcome: "override" }); closeOverlay(); });
  }

  // ─── Hard Freeze ──────────────────────────────────────────
  async function triggerHardFreeze() {
    if (isFrozen) return;
    isFrozen = true;
    overlayActive = true;
    blurFeed(true);

    const tabsRes  = await sendMsg({ type: "GET_INTERVENTION" });
    const allTabs  = tabsRes?.tabs || [];
    const freezeRes = await sendMsg({ type: "GET_FREEZE_MSG", tabTitle: allTabs[0]?.title || "" });
    const message  = (freezeRes && freezeRes.message) || "Daily budget reached — time to head back.";

    removeOverlay();
    overlayEl = document.createElement("div");
    overlayEl.id = "ss-freeze-overlay";

    const tabListHTML = allTabs.length
      ? '<div class="ss-tabs-label" style="text-align:left;margin-bottom:8px">Return to your work:</div>' +
        '<div class="ss-tab-list" id="ss-freeze-tabs">' + buildTabButtons(allTabs) + "</div>"
      : "";

    overlayEl.innerHTML =
      '<div id="ss-freeze-card">' +
        '<div class="ss-freeze-icon">🛑</div>' +
        '<div class="ss-logo" style="display:block;font-size:15px;margin-bottom:12px">ScrollSense</div>' +
        '<p class="ss-freeze-msg">' + escHtml(message) + "</p>" +
        tabListHTML +
        '<button id="ss-override-freeze">Override for today</button>' +
      "</div>";

    document.body.appendChild(overlayEl);
    requestAnimationFrame(() => overlayEl.classList.add("ss-visible"));

    // Tab buttons: switch to existing tab (not open new one)
    overlayEl.querySelectorAll(".ss-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        switchToTab(parseInt(btn.dataset.tabId), btn.dataset.url);
        sendMsg({ type: "LOG_OUTCOME", outcome: "redirect" });
      });
    });

    overlayEl.querySelector("#ss-override-freeze")?.addEventListener("click", () => {
      sendMsg({ type: "LOG_OUTCOME", outcome: "override" });
      isFrozen              = false;
      overlayActive         = false;
      freezeOverriddenToday = true;
      warned90              = false;
      blurFeed(false);
      const el = overlayEl; overlayEl = null;
      if (el) { el.classList.remove("ss-visible"); setTimeout(() => el.remove(), 300); }
    });
  }

  // ─── Weekly Summary ───────────────────────────────────────
  async function showWeeklySummary() {
    const res = await sendMsg({ type: "WEEKLY_SUMMARY_REQUEST" });
    if (!res?.insight) return;
    const banner = document.createElement("div");
    banner.id = "ss-weekly-banner";
    banner.innerHTML =
      '<div class="ss-weekly-inner">' +
        '<span class="ss-logo">ScrollSense · Weekly</span>' +
        "<p>" + escHtml(res.insight) + "</p>" +
        '<button id="ss-weekly-close">Got it</button>' +
      "</div>";
    document.body.appendChild(banner);
    banner.querySelector("#ss-weekly-close")?.addEventListener("click", () => banner.remove());
    setTimeout(() => banner.remove(), 15000);
  }

  // ─── Helpers ──────────────────────────────────────────────
  function closeOverlay() {
    blurFeed(false);
    overlayActive = false;
    if (!overlayEl) return;
    const el = overlayEl; overlayEl = null;
    el.classList.remove("ss-visible");
    setTimeout(() => el.remove(), 300);
  }

  function removeOverlay() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  }

  function blurFeed(on) {
    const feed = document.querySelector("main") || document.querySelector("[role='main']");
    if (!feed) return;
    feed.style.filter        = on ? "blur(6px)" : "";
    feed.style.pointerEvents = on ? "none" : "";
    feed.style.userSelect    = on ? "none" : "";
    feed.style.transition    = "filter 0.3s";
  }

  // Switch to existing tab by id; fallback to opening URL if tab no longer exists
  function switchToTab(tabId, url) {
    if (tabId && !isNaN(tabId)) {
      sendMsg({ type: "SWITCH_TAB", tabId });
    } else if (url) {
      window.open(url, "_blank");
    }
  }

  function buildTabButtons(tabs) {
    if (!tabs || !tabs.length) return "";
    return tabs.map((t) =>
      '<button class="ss-tab-btn" data-tab-id="' + (t.id || "") + '" data-url="' + escAttr(t.url) + '" title="' + escAttr(t.title) + '">' +
        '<span class="ss-tab-icon">📄</span>' +
        '<span class="ss-tab-title">' + escHtml(truncate(t.title, 32)) + "</span>" +
        '<span class="ss-tab-arrow">→</span>' +
      "</button>"
    ).join("");
  }

  function wireTabButtons(container) {
    if (!container) return;
    container.querySelectorAll(".ss-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        switchToTab(parseInt(btn.dataset.tabId), btn.dataset.url);
        sendMsg({ type: "LOG_OUTCOME", outcome: "redirect" });
        closeOverlay();
      });
    });
  }

  function sendMsg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      } catch { resolve(null); }
    });
  }

  function escHtml(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function escAttr(s) { return String(s).replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
  function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + "…" : s; }

})();
