// ============================================================
// ScrollSense — background.js  v2.0
// ============================================================

const OLLAMA_URL   = "http://localhost:11434/api/generate";
const OLLAMA_MODEL = "llama3.2";
const EARN_SECONDS = 120; // +2 min per correct file-quiz answer

const DEFAULT_SETTINGS = {
  dailyBudgetMinutes:   20,
  postsPerIntervention: 10,
  hardFreezeEnabled:    true,
  model:                OLLAMA_MODEL,
};

// ─── Install ─────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  await ensureTodayData();
  chrome.alarms.create("weeklySummary", { periodInMinutes: 60 * 24 * 7 });
});

// ─── Storage helpers ─────────────────────────────────────────
function todayKey() {
  return "day_" + new Date().toISOString().slice(0, 10);
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return Object.assign({}, DEFAULT_SETTINGS, settings || {});
}

async function getTodayData() {
  await ensureTodayData();
  const r = await chrome.storage.local.get(todayKey());
  return r[todayKey()];
}

async function saveTodayData(data) {
  await chrome.storage.local.set({ [todayKey()]: data });
}

async function ensureTodayData() {
  const key = todayKey();
  const r = await chrome.storage.local.get(key);
  if (!r[key]) {
    await chrome.storage.local.set({
      [key]: {
        usedSeconds:    0,
        earnedSeconds:  0,   // bonus seconds from correct quiz answers
        overrideCount:  0,
        correctAnswers: 0,
        wrongAnswers:   0,
        interventions:  0,
        outcomeLog:     [],
      },
    });
  }
}

// ─── Streak calculator ────────────────────────────────────────
// Returns number of consecutive days (ending yesterday) where
// usedSeconds <= budgetSeconds. Today doesn't count yet.
async function calculateStreak() {
  const settings = await getSettings();
  const budgetSec = settings.dailyBudgetMinutes * 60;
  let streak = 0;
  for (let i = 1; i <= 30; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = "day_" + d.toISOString().slice(0, 10);
    const r = await chrome.storage.local.get(key);
    const day = r[key];
    if (!day) break; // no data = streak broken
    const effectiveBudget = budgetSec + (day.earnedSeconds || 0);
    if (day.usedSeconds <= effectiveBudget) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// ─── Productive tabs ─────────────────────────────────────────
async function getProductiveTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs
    .filter(t => t.url &&
      !t.url.includes("instagram.com") &&
      !t.url.startsWith("chrome://") &&
      !t.url.startsWith("about:"))
    .map(t => ({ title: t.title || "Untitled", url: t.url, id: t.id }))
    .slice(0, 6);
}

// ─── Ollama ───────────────────────────────────────────────────
async function callOllama(prompt, model) {
  try {
    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model || OLLAMA_MODEL, prompt, stream: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.response?.trim() || null;
  } catch (err) {
    console.warn("[ScrollSense] Ollama:", err.message);
    return null;
  }
}

// ─── Generate MC quiz from FILE content ──────────────────────
async function generateFileQuiz(fileContent, fileName, model) {
  // Trim to avoid hitting token limits — use first ~2000 chars
  const snippet = fileContent.slice(0, 2000);

  const prompt = `You are a quiz generator for a productivity browser extension.
A user uploaded study material. Here is an excerpt:
---
${snippet}
---
Generate ONE multiple-choice question (4 options) based on the content above.
Respond ONLY with valid JSON — no markdown, no explanation:
{"question": "...", "options": ["A","B","C","D"], "correctIndex": 0}
"correctIndex" is the 0-based index of the correct answer. Be factual and specific to the text.`;

  const raw = await callOllama(prompt, model);
  try {
    const cleaned = (raw || "").replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : cleaned);
  } catch {
    return null;
  }
}


// ─── Generate freeze message ──────────────────────────────────
async function generateFreezeMessage(usedMin, budgetMin, overrides, tabTitle, model) {
  const prompt = `Calm screen-time coach. Brief, no lecturing, don't start with "You've".
Budget: ${budgetMin} min | Used: ${usedMin} min | Overrides: ${overrides}
Prior tab: "${tabTitle || "your work"}"
Write exactly 1 short sentence referencing the tab title if available.`;
  return callOllama(prompt, model);
}

// ─── Message router ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {

      // Switch to an existing tab by id (bring it to focus)
      case "SWITCH_TAB": {
        try {
          await chrome.tabs.update(msg.tabId, { active: true });
          const win = await chrome.tabs.get(msg.tabId);
          await chrome.windows.update(win.windowId, { focused: true });
          sendResponse({ ok: true });
        } catch {
          sendResponse({ ok: false });
        }
        break;
      }

      // Full status — includes streak + earned seconds
      case "GET_STATUS": {
        const [settings, today, streak] = await Promise.all([
          getSettings(), getTodayData(), calculateStreak()
        ]);
        const baseBudget = settings.dailyBudgetMinutes * 60;
        const budgetSec  = baseBudget + (today.earnedSeconds || 0);
        sendResponse({
          budgetSec,
          usedSec:       today.usedSeconds,
          overrideCount: today.overrideCount,
          streak,
          settings,
        });
        break;
      }

      // Heartbeat tick
      case "TICK": {
        const today = await getTodayData();
        today.usedSeconds += 1;
        await saveTodayData(today);
        // Return effective budget too so pill stays live
        const settings = await getSettings();
        const budgetSec = (settings.dailyBudgetMinutes * 60) + (today.earnedSeconds || 0);
        sendResponse({ usedSeconds: today.usedSeconds, budgetSec });
        break;
      }

      // Next intervention — quiz (files ONLY) or redirect card (tabs only)
      case "GET_INTERVENTION": {
        const [settings, tabs, today] = await Promise.all([
          getSettings(), getProductiveTabs(), getTodayData()
        ]);

        today.interventions = (today.interventions || 0) + 1;
        today.outcomeLog.push({ outcome: "intervention", ts: Date.now() });
        await saveTodayData(today);

        const isQuizTurn = today.interventions % 2 === 1;

        if (isQuizTurn) {
          // Quiz draws ONLY from uploaded files — never from open tabs
          const stored = await chrome.storage.local.get("quizFiles");
          const quizFiles = stored.quizFiles || [];

          if (!quizFiles.length) {
            sendResponse({ kind: "quiz", quiz: null, tabs, source: "none" });
            break;
          }

          // Send file snippet + model to content.js — it will call Ollama directly
          // (content scripts can fetch localhost; MV3 service workers sometimes cannot)
          const file = quizFiles[Math.floor(Math.random() * quizFiles.length)];
          const snippet = file.content.slice(0, 2000);
          sendResponse({ kind: "quiz", quiz: null, tabs, source: "file",
            fileName: file.name, snippet, model: settings.model });
        } else {
          sendResponse({ kind: "redirect", tabs });
        }
        break;
      }

      // Freeze message
      case "GET_FREEZE_MSG": {
        const [settings, today] = await Promise.all([getSettings(), getTodayData()]);
        const usedMin = Math.floor(today.usedSeconds / 60);
        const msg2 = await generateFreezeMessage(
          usedMin, settings.dailyBudgetMinutes,
          today.overrideCount, msg.tabTitle || "", settings.model
        );
        sendResponse({ message: msg2 || "Budget reached — your work tab is still waiting." });
        break;
      }

      // Log outcome — handle earn-time on correct file quiz
      case "LOG_OUTCOME": {
        const today = await getTodayData();
        today.outcomeLog.push({ outcome: msg.outcome, ts: Date.now() });

        if (msg.outcome === "override")     today.overrideCount  = (today.overrideCount  || 0) + 1;
        if (msg.outcome === "quiz_correct") today.correctAnswers = (today.correctAnswers || 0) + 1;
        if (msg.outcome === "quiz_wrong")   today.wrongAnswers   = (today.wrongAnswers   || 0) + 1;

        // Earn time only on file-based correct answers
        if (msg.outcome === "quiz_correct" && msg.source === "file") {
          today.earnedSeconds = (today.earnedSeconds || 0) + EARN_SECONDS;
        }

        await saveTodayData(today);
        const settings = await getSettings();
        const newBudget = (settings.dailyBudgetMinutes * 60) + (today.earnedSeconds || 0);
        sendResponse({ ok: true, earnedSeconds: today.earnedSeconds || 0, newBudget });
        break;
      }

      // Popup stats
      case "GET_POPUP_STATS": {
        const [settings, today, streak] = await Promise.all([
          getSettings(), getTodayData(), calculateStreak()
        ]);
        const budgetSec = (settings.dailyBudgetMinutes * 60) + (today.earnedSeconds || 0);
        sendResponse({ settings, today, budgetSec, streak });
        break;
      }

      // Save settings
      case "SAVE_SETTINGS": {
        const merged = Object.assign({}, DEFAULT_SETTINGS, msg.settings);
        await chrome.storage.local.set({ settings: merged });
        sendResponse({ ok: true });
        break;
      }

      // Add a file to the quiz library (multiple files supported)
      case "SAVE_QUIZ_FILE": {
        try {
          const stored = await chrome.storage.local.get("quizFiles");
          const quizFiles = stored.quizFiles || [];
          const filtered = quizFiles.filter(f => f.name !== msg.name);
          // Cap each file at 200k chars to stay well within storage limits
          const content = (msg.content || "").slice(0, 200000);
          filtered.push({ name: msg.name, content, addedAt: Date.now() });
          await chrome.storage.local.set({ quizFiles: filtered });
          sendResponse({ ok: true, count: filtered.length });
        } catch (err) {
          console.error("[ScrollSense] SAVE_QUIZ_FILE failed:", err);
          sendResponse({ ok: false, error: err.message || "Storage write failed" });
        }
        break;
      }

      // Get all quiz files (names only, not content — for UI display)
      case "GET_QUIZ_FILES": {
        const stored = await chrome.storage.local.get("quizFiles");
        const quizFiles = (stored.quizFiles || []).map(f => ({
          name: f.name,
          addedAt: f.addedAt,
          charCount: f.content?.length || 0,
        }));
        sendResponse({ files: quizFiles });
        break;
      }

      // Remove a single file by name
      case "REMOVE_QUIZ_FILE": {
        const stored = await chrome.storage.local.get("quizFiles");
        const quizFiles = (stored.quizFiles || []).filter(f => f.name !== msg.name);
        await chrome.storage.local.set({ quizFiles });
        sendResponse({ ok: true, count: quizFiles.length });
        break;
      }

      // Clear ALL quiz files
      case "CLEAR_ALL_QUIZ_FILES": {
        await chrome.storage.local.set({ quizFiles: [] });
        sendResponse({ ok: true });
        break;
      }

      // Weekly summary
      case "WEEKLY_SUMMARY_REQUEST": {
        const keys = Array.from({ length: 7 }, (_, i) => {
          const d = new Date(); d.setDate(d.getDate() - i);
          return "day_" + d.toISOString().slice(0, 10);
        });
        const results = await chrome.storage.local.get(keys);
        const days = keys.map(k => results[k]).filter(Boolean);
        const totalOverrides = days.reduce((a, d) => a + (d.overrideCount || 0), 0);
        const avgMin = days.length
          ? Math.round(days.reduce((a, d) => a + (d.usedSeconds || 0), 0) / days.length / 60) : 0;
        const settings = await getSettings();
        const raw = await callOllama(
          `Reflective productivity coach. User's Instagram: avg ${avgMin} min/day, ${totalOverrides} overrides this week. Write ONE kind insight sentence (max 20 words).`,
          settings.model
        );
        sendResponse({ insight: raw || "Small steps each day add up to real change." });
        break;
      }

      default:
        sendResponse({ error: "Unknown message type" });
    }
  })();
  return true;
});

// ─── Alarms ───────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "weeklySummary") return;
  chrome.tabs.query({ url: "https://www.instagram.com/*" }, (tabs) => {
    tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, { type: "SHOW_WEEKLY_SUMMARY" }).catch(() => {}));
  });
});
