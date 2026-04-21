// ============================================================
// ScrollSense — background.js  v3.0
// Option C: Ollama generates question bank when file is uploaded
// (from service worker = no CORS). Content script reads from
// local storage during scrolling = no network call needed.
// ============================================================

const OLLAMA_URL   = "http://localhost:11434/api/generate";
const OLLAMA_MODEL = "llama3.2";
const EARN_SECONDS = 120; // +2 min per correct answer
const QUESTIONS_PER_FILE = 20; // questions to generate per uploaded file

const DEFAULT_SETTINGS = {
  dailyBudgetMinutes:   20,
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
        earnedSeconds:  0,
        overrideCount:  0,
        correctAnswers: 0,
        wrongAnswers:   0,
        interventions:  0,
        outcomeLog:     [],
      },
    });
  }
}

// ─── Streak ───────────────────────────────────────────────────
async function calculateStreak() {
  const settings  = await getSettings();
  const budgetSec = settings.dailyBudgetMinutes * 60;
  let streak = 0;
  for (let i = 1; i <= 30; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = "day_" + d.toISOString().slice(0, 10);
    const r   = await chrome.storage.local.get(key);
    const day = r[key];
    if (!day) break;
    const effective = budgetSec + (day.earnedSeconds || 0);
    if (day.usedSeconds <= effective) streak++;
    else break;
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

// ─── Ollama (called from service worker — no CORS issue) ──────
async function callOllama(prompt, model) {
  try {
    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model || OLLAMA_MODEL, prompt, stream: false }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    return (data.response || "").trim() || null;
  } catch (err) {
    console.warn("[ScrollSense] Ollama:", err.message);
    return null;
  }
}

// ─── Generate ONE question from a text snippet ────────────────
async function generateOneQuestion(snippet, fileName, model) {
  const prompt =
    "You are a quiz generator. Given the study excerpt below, write ONE multiple-choice question.\n\n" +
    "EXCERPT:\n" + snippet + "\n\n" +
    "Rules:\n" +
    "- Write a clear factual question about something explicitly stated in the excerpt.\n" +
    "- Provide exactly 4 answer options (A, B, C, D).\n" +
    "- One option must be correct; the others plausible but wrong.\n" +
    "- correctIndex is the 0-based index (0=A, 1=B, 2=C, 3=D) of the correct answer.\n\n" +
    "Respond with ONLY this JSON object and absolutely nothing else — no markdown, no explanation:\n" +
    '{"question": "your question here", "options": ["A answer", "B answer", "C answer", "D answer"], "correctIndex": 0}';

  const raw = await callOllama(prompt, model);
  console.log("[ScrollSense] Ollama raw response:", raw ? raw.slice(0, 200) : "null");
  if (!raw) return null;

  try {
    // Strip any markdown fences and find the JSON object
    const cleaned = raw.replace(/```json|```/gi, "").trim();
    const match   = cleaned.match(/\{[\s\S]*\}/);
    if (!match) { console.warn("[ScrollSense] No JSON object found in response"); return null; }
    const q = JSON.parse(match[0]);

    // Tolerant validation — coerce types where Ollama is inconsistent
    if (!q.question || typeof q.question !== "string") return null;
    if (!Array.isArray(q.options)) return null;
    // Accept 4 options; if Ollama gave 3 or 5 pad/trim to 4
    while (q.options.length < 4) q.options.push("None of the above");
    if (q.options.length > 4) q.options = q.options.slice(0, 4);
    // Coerce correctIndex to number (Ollama sometimes returns a string)
    q.correctIndex = parseInt(String(q.correctIndex), 10);
    if (isNaN(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3) q.correctIndex = 0;

    return q;
  } catch (err) {
    console.warn("[ScrollSense] JSON parse failed:", err.message, "| raw:", raw.slice(0, 300));
    return null;
  }
}

// ─── Build question bank for a file ───────────────────────────
async function buildQuestionBank(fileName, content, model, totalTarget) {
  // Split content into chunks — always generate at least one question
  // even if content is shorter than chunkSize
  const chunkSize = 800;
  const chunks    = [];

  if (content.length <= chunkSize) {
    // Short content: use it whole, repeat to hit totalTarget
    for (let i = 0; i < totalTarget; i++) chunks.push(content);
  } else {
    // Long content: sliding window with overlap
    for (let i = 0; i < content.length && chunks.length < totalTarget; i += chunkSize - 200) {
      chunks.push(content.slice(i, i + chunkSize));
    }
    // If we have fewer chunks than target, cycle through them
    while (chunks.length < totalTarget) {
      chunks.push(chunks[chunks.length % Math.max(chunks.length, 1)]);
    }
  }

  const questions = [];
  const actualTotal = Math.min(chunks.length, totalTarget);
  console.log("[ScrollSense] buildQuestionBank: content.length=" + content.length +
    " chunks=" + chunks.length + " actualTotal=" + actualTotal + " model=" + model);

  for (let i = 0; i < actualTotal; i++) {
    console.log("[ScrollSense] Generating question " + (i+1) + "/" + actualTotal);
    const q = await generateOneQuestion(chunks[i], fileName, model);
    if (q) {
      q.fileName = fileName;
      questions.push(q);
    }
    // Update progress after every attempt so options page always shows movement
    await chrome.storage.local.set({
      quizGenProgress: {
        fileName,
        done: i + 1,
        total: actualTotal,
        generated: questions.length,
        questions,
        complete: false,
      }
    });
  }
  return questions;
}

// ─── Get next question from bank ─────────────────────────────
// Rotates through questions, tracking which were recently used.
async function getNextQuestion() {
  const stored = await chrome.storage.local.get(["questionBank", "questionBankIndex"]);
  const bank   = stored.questionBank || [];
  if (!bank.length) return null;

  let idx = (stored.questionBankIndex || 0) % bank.length;
  const q = bank[idx];
  await chrome.storage.local.set({ questionBankIndex: idx + 1 });
  return q;
}

// ─── Generate freeze message ──────────────────────────────────
async function generateFreezeMessage(usedMin, budgetMin, overrides, tabTitle, model) {
  const prompt =
    "Calm screen-time coach. Brief, no lecturing, don't start with \"You've\".\n" +
    "Budget: " + budgetMin + " min | Used: " + usedMin + " min | Overrides: " + overrides + "\n" +
    "Prior tab: \"" + (tabTitle || "your work") + "\"\n" +
    "Write exactly 1 short sentence referencing the tab title if available.";
  return callOllama(prompt, model);
}

// ─── Message router ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {

      // ── Switch to existing tab
      case "SWITCH_TAB": {
        try {
          await chrome.tabs.update(msg.tabId, { active: true });
          const tab = await chrome.tabs.get(msg.tabId);
          await chrome.windows.update(tab.windowId, { focused: true });
          sendResponse({ ok: true });
        } catch { sendResponse({ ok: false }); }
        break;
      }

      // ── Full status for content.js
      case "GET_STATUS": {
        const [settings, today, streak] = await Promise.all([
          getSettings(), getTodayData(), calculateStreak()
        ]);
        const budgetSec = (settings.dailyBudgetMinutes * 60) + (today.earnedSeconds || 0);
        sendResponse({ budgetSec, usedSec: today.usedSeconds,
          overrideCount: today.overrideCount, streak, settings });
        break;
      }

      // ── 1-second heartbeat
      case "TICK": {
        const today    = await getTodayData();
        const settings = await getSettings();
        today.usedSeconds += 1;
        await saveTodayData(today);
        const budgetSec = (settings.dailyBudgetMinutes * 60) + (today.earnedSeconds || 0);
        sendResponse({ usedSeconds: today.usedSeconds, budgetSec });
        break;
      }

      // ── Next intervention: quiz from bank OR redirect card
      case "GET_INTERVENTION": {
        const [settings, tabs, today] = await Promise.all([
          getSettings(), getProductiveTabs(), getTodayData()
        ]);
        today.interventions = (today.interventions || 0) + 1;
        today.outcomeLog.push({ outcome: "intervention", ts: Date.now() });
        await saveTodayData(today);

        const isQuizTurn = today.interventions % 2 === 1;

        if (isQuizTurn) {
          // Pull next question from pre-generated bank — no Ollama call here
          const question = await getNextQuestion();
          if (!question) {
            // Bank empty — tell content.js to show upload prompt
            sendResponse({ kind: "quiz", question: null, tabs, bankEmpty: true });
          } else {
            sendResponse({ kind: "quiz", question, tabs, bankEmpty: false });
          }
        } else {
          sendResponse({ kind: "redirect", tabs });
        }
        break;
      }

      // ── Freeze message (from service worker = no CORS)
      case "GET_FREEZE_MSG": {
        const [settings, today] = await Promise.all([getSettings(), getTodayData()]);
        const usedMin = Math.floor(today.usedSeconds / 60);
        const message = await generateFreezeMessage(
          usedMin, settings.dailyBudgetMinutes,
          today.overrideCount, msg.tabTitle || "", settings.model
        );
        sendResponse({ message: message || "Budget reached — your work tab is still waiting." });
        break;
      }

      // ── Log outcome
      case "LOG_OUTCOME": {
        const today = await getTodayData();
        today.outcomeLog.push({ outcome: msg.outcome, ts: Date.now() });
        if (msg.outcome === "override")     today.overrideCount  = (today.overrideCount  || 0) + 1;
        if (msg.outcome === "quiz_correct") today.correctAnswers = (today.correctAnswers || 0) + 1;
        if (msg.outcome === "quiz_wrong")   today.wrongAnswers   = (today.wrongAnswers   || 0) + 1;
        if (msg.outcome === "quiz_correct") {
          today.earnedSeconds = (today.earnedSeconds || 0) + EARN_SECONDS;
        }
        await saveTodayData(today);
        const settings  = await getSettings();
        const newBudget = (settings.dailyBudgetMinutes * 60) + (today.earnedSeconds || 0);
        sendResponse({ ok: true, newBudget });
        break;
      }

      // ── Popup stats
      case "GET_POPUP_STATS": {
        const [settings, today, streak] = await Promise.all([
          getSettings(), getTodayData(), calculateStreak()
        ]);
        const stored    = await chrome.storage.local.get("questionBank");
        const bankSize  = (stored.questionBank || []).length;
        const budgetSec = (settings.dailyBudgetMinutes * 60) + (today.earnedSeconds || 0);
        sendResponse({ settings, today, budgetSec, streak, bankSize });
        break;
      }

      // ── Full historical stats for the Stats page
      case "GET_HISTORY": {
        const settings  = await getSettings();
        const budgetSec = settings.dailyBudgetMinutes * 60;
        // Collect last 30 days
        const days = [];
        for (let i = 29; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const key  = "day_" + d.toISOString().slice(0, 10);
          const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
          const r    = await chrome.storage.local.get(key);
          const day  = r[key];
          if (day && (day.usedSeconds > 0 || day.correctAnswers > 0)) {
            days.push({
              date:           key.slice(4),
              label,
              usedMin:        Math.round((day.usedSeconds || 0) / 60),
              budgetMin:      Math.round((budgetSec + (day.earnedSeconds || 0)) / 60),
              earnedMin:      Math.round((day.earnedSeconds || 0) / 60),
              overrides:      day.overrideCount  || 0,
              correct:        day.correctAnswers || 0,
              wrong:          day.wrongAnswers   || 0,
              interventions:  day.interventions  || 0,
              outcomeLog:     day.outcomeLog     || [],
            });
          }
        }
        // All-time totals
        const totals = days.reduce((acc, d) => {
          acc.usedMin      += d.usedMin;
          acc.earnedMin    += d.earnedMin;
          acc.overrides    += d.overrides;
          acc.correct      += d.correct;
          acc.wrong        += d.wrong;
          acc.interventions+= d.interventions;
          return acc;
        }, { usedMin: 0, earnedMin: 0, overrides: 0, correct: 0, wrong: 0, interventions: 0 });

        // Peak scroll hour from outcomeLog
        const hourCounts = new Array(24).fill(0);
        days.forEach(d => d.outcomeLog.forEach(e => {
          if (e.ts) hourCounts[new Date(e.ts).getHours()]++;
        }));
        const peakHour = hourCounts.indexOf(Math.max(...hourCounts));

        sendResponse({ days, totals, peakHour, budgetMin: settings.dailyBudgetMinutes });
        break;
      }

      // ── Reset today only
      case "RESET_TODAY": {
        const key = todayKey();
        await chrome.storage.local.set({
          [key]: {
            usedSeconds: 0, earnedSeconds: 0, overrideCount: 0,
            correctAnswers: 0, wrongAnswers: 0, interventions: 0, outcomeLog: [],
          }
        });
        sendResponse({ ok: true });
        break;
      }

      // ── Full reset — wipe everything except question bank
      case "RESET_ALL": {
        // Collect all day_ keys
        const allKeys = await new Promise(res => chrome.storage.local.get(null, res));
        const dayKeys = Object.keys(allKeys).filter(k => k.startsWith("day_"));
        await chrome.storage.local.remove(dayKeys);
        await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
        await ensureTodayData();
        sendResponse({ ok: true });
        break;
      }

      // ── Nuclear reset — wipe absolutely everything
      case "RESET_NUCLEAR": {
        await chrome.storage.local.clear();
        await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
        await ensureTodayData();
        sendResponse({ ok: true });
        break;
      }

      // ── Save settings
      case "SAVE_SETTINGS": {
        const merged = Object.assign({}, DEFAULT_SETTINGS, msg.settings);
        await chrome.storage.local.set({ settings: merged });
        sendResponse({ ok: true });
        break;
      }

      // ── Save uploaded file + generate question bank
      // IMPORTANT: sendResponse is called AFTER generation completes.
      // This keeps the service worker alive for the full generation loop.
      // The options page polls storage for progress — it doesn't wait on sendResponse.
      case "SAVE_QUIZ_FILE": {
        try {
          // Store the file first
          const stored    = await chrome.storage.local.get("quizFiles");
          const quizFiles = stored.quizFiles || [];
          const filtered  = quizFiles.filter(f => f.name !== msg.name);
          const content   = (msg.content || "").slice(0, 200000);
          filtered.push({ name: msg.name, content, addedAt: Date.now() });
          await chrome.storage.local.set({ quizFiles: filtered });

          // Reset progress so options page polling starts from 0
          await chrome.storage.local.set({
            quizGenProgress: { fileName: msg.name, done: 0, total: QUESTIONS_PER_FILE, questions: [], complete: false }
          });

          // Generate — do this BEFORE sendResponse so service worker stays alive
          const settings   = await getSettings();
          // Pass content directly from the message — don't re-read from filtered array
          // (filtered.map(f => f.content) can fail if content was not stored correctly)
          const directContent = msg.content || "";
          console.log("[ScrollSense] SAVE_QUIZ_FILE: name=" + msg.name +
            " directContent.length=" + directContent.length +
            " filtered.length=" + filtered.length +
            " model=" + settings.model);
          const allContent = directContent.length > 0
            ? directContent
            : filtered.map(f => f.content || "").join("\n\n");
          console.log("[ScrollSense] allContent.length=" + allContent.length +
            " first100=" + allContent.slice(0, 100));
          const questions  = await buildQuestionBank(
            msg.name, allContent, settings.model, QUESTIONS_PER_FILE
          );

          // Merge with existing bank, shuffle, save
          const existingStored = await chrome.storage.local.get("questionBank");
          const existing = (existingStored.questionBank || []).filter(q => q.fileName !== msg.name);
          const merged   = shuffle([...existing, ...questions]);
          await chrome.storage.local.set({ questionBank: merged, questionBankIndex: 0 });

          // Mark complete in storage (options page polling will pick this up)
          await chrome.storage.local.set({
            quizGenProgress: {
              fileName: msg.name, done: questions.length,
              total: QUESTIONS_PER_FILE, questions, complete: true
            }
          });

          // NOW send response — service worker stays alive until here
          sendResponse({ ok: true, count: filtered.length, generated: questions.length });
        } catch (err) {
          console.error("[ScrollSense] SAVE_QUIZ_FILE:", err);
          sendResponse({ ok: false, error: err.message });
        }
        break;
      }

      // ── Get file list (for options page display)
      case "GET_QUIZ_FILES": {
        const stored = await chrome.storage.local.get(["quizFiles","questionBank","quizGenProgress"]);
        const files  = (stored.quizFiles || []).map(f => ({
          name: f.name, addedAt: f.addedAt, charCount: f.content?.length || 0,
        }));
        const bankSize = (stored.questionBank || []).length;
        const progress = stored.quizGenProgress || null;
        sendResponse({ files, bankSize, progress });
        break;
      }

      // ── Remove one file + rebuild bank without it
      case "REMOVE_QUIZ_FILE": {
        const stored    = await chrome.storage.local.get(["quizFiles","questionBank"]);
        const quizFiles = (stored.quizFiles || []).filter(f => f.name !== msg.name);
        const bank      = (stored.questionBank || []).filter(q => q.fileName !== msg.name);
        await chrome.storage.local.set({ quizFiles, questionBank: bank, questionBankIndex: 0 });
        sendResponse({ ok: true, count: quizFiles.length, bankSize: bank.length });
        break;
      }

      // ── Clear everything
      case "CLEAR_ALL_QUIZ_FILES": {
        await chrome.storage.local.set({
          quizFiles: [], questionBank: [], questionBankIndex: 0, quizGenProgress: null
        });
        sendResponse({ ok: true });
        break;
      }

      // ── Weekly summary
      case "WEEKLY_SUMMARY_REQUEST": {
        const keys = Array.from({ length: 7 }, (_, i) => {
          const d = new Date(); d.setDate(d.getDate() - i);
          return "day_" + d.toISOString().slice(0, 10);
        });
        const results = await chrome.storage.local.get(keys);
        const days    = keys.map(k => results[k]).filter(Boolean);
        const totalOverrides = days.reduce((a, d) => a + (d.overrideCount || 0), 0);
        const avgMin = days.length
          ? Math.round(days.reduce((a, d) => a + (d.usedSeconds || 0), 0) / days.length / 60) : 0;
        const settings = await getSettings();
        const insight  = await callOllama(
          "Reflective productivity coach. User's Instagram: avg " + avgMin +
          " min/day, " + totalOverrides + " overrides this week. Write ONE kind insight sentence (max 20 words).",
          settings.model
        );
        sendResponse({ insight: insight || "Small steps each day add up to real change." });
        break;
      }

      default:
        sendResponse({ error: "Unknown message type" });
    }
  })();
  return true;
});

// ─── Alarm ────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "weeklySummary") return;
  chrome.tabs.query({ url: "https://www.instagram.com/*" }, (tabs) => {
    tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, { type: "SHOW_WEEKLY_SUMMARY" }).catch(() => {}));
  });
});

// ─── Util ─────────────────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
