// ============================================================
// ScrollSense — options.js  v6.0
// Three tabs: Quiz Me, Stats, Reset
// ============================================================

// ─── Page navigation ─────────────────────────────────────────
const taglines = {
  quiz:  "Quiz Me — Study while you scroll",
  stats: "Stats — Your scrolling habits at a glance",
  reset: "Reset — Manage your ScrollSense data",
};

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const page = btn.dataset.page;
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("page-" + page).classList.add("active");
    const tl = document.getElementById("page-tagline");
    if (tl) tl.textContent = taglines[page] || "";
    if (page === "stats") loadStats();
  });
});

// Check if opened with ?tab=stats
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get("tab") === "stats") {
  document.querySelector('[data-page="stats"]')?.click();
}

// ─── Sub-tabs (Quiz Me upload/paste) ─────────────────────────
document.querySelectorAll(".sub-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".sub-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".sub-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("sub-" + btn.dataset.sub).classList.add("active");
  });
});

// ─── Quiz Me elements ─────────────────────────────────────────
const dropZone    = document.getElementById("drop-zone");
const fileInput   = document.getElementById("file-input");
const pasteArea   = document.getElementById("paste-area");
const pasteName   = document.getElementById("paste-name");
const addPasteBtn = document.getElementById("add-paste-btn");
const charCountEl = document.getElementById("char-count");
const quizStatus  = document.getElementById("quiz-status");
const fileListEl  = document.getElementById("file-list");
const emptyLib    = document.getElementById("empty-lib");
const clearAllBtn = document.getElementById("clear-all-btn");
const genProgress = document.getElementById("gen-progress");
const genFill     = document.getElementById("gen-fill");
const genCount    = document.getElementById("gen-count");
const genLabel    = document.getElementById("gen-label");
const genStatus   = document.getElementById("gen-status");
const bankCount   = document.getElementById("bank-count");
const bankSub     = document.getElementById("bank-sub");

let pollInterval = null;

// ─── Init ─────────────────────────────────────────────────────
loadLibrary();

// ─── Drop zone ────────────────────────────────────────────────
dropZone.addEventListener("dragover",  (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault(); dropZone.classList.remove("drag-over");
  handleFiles(Array.from(e.dataTransfer?.files || []));
});
fileInput.addEventListener("change", () => { handleFiles(Array.from(fileInput.files || [])); fileInput.value = ""; });

// ─── Paste ────────────────────────────────────────────────────
pasteArea.addEventListener("input", () => {
  charCountEl.textContent = pasteArea.value.length.toLocaleString();
  addPasteBtn.disabled = pasteArea.value.trim().length < 20;
});

addPasteBtn.addEventListener("click", async () => {
  const text = pasteArea.value.trim();
  const name = pasteName.value.trim() || ("Notes — " + new Date().toLocaleDateString());
  if (text.length < 20) { showQuizStatus("Paste at least a sentence of text.", "error"); return; }
  addPasteBtn.disabled = true;
  addPasteBtn.textContent = "Saving…";
  await uploadFile(name, text);
  addPasteBtn.textContent = "Save & Generate Questions";
  pasteArea.value = ""; pasteName.value = ""; charCountEl.textContent = "0"; addPasteBtn.disabled = true;
});

clearAllBtn.addEventListener("click", () => {
  if (!confirm("Remove all files and clear the question bank?")) return;
  chrome.runtime.sendMessage({ type: "CLEAR_ALL_QUIZ_FILES" }, () => {
    showQuizStatus("Library and question bank cleared.", "info");
    stopPolling(); genProgress.classList.remove("visible"); loadLibrary();
  });
});

// ─── File handling ────────────────────────────────────────────
const SUPPORTED = ["txt", "md", "html", "csv"];

async function handleFiles(files) {
  const bad  = files.filter(f => !SUPPORTED.includes(ext(f.name)));
  const good = files.filter(f =>  SUPPORTED.includes(ext(f.name)));
  if (!good.length) { showQuizStatus("❌ Use .txt, .md, .html, or .csv. See the PDF/DOCX tip.", "error"); return; }
  for (const file of good) {
    let text = "";
    try { text = await readAsText(file); } catch { showQuizStatus("❌ Could not read " + file.name, "error"); continue; }
    if (!text || text.trim().length < 20) { showQuizStatus("❌ " + file.name + " appears empty.", "error"); continue; }
    await uploadFile(file.name, text.trim());
  }
  if (bad.length) showQuizStatus("Skipped: " + bad.map(f=>f.name).join(", ") + " (unsupported type).", "info");
}

async function uploadFile(name, content) {
  showQuizStatus("📤 Generating questions with Ollama… keep this tab open.", "info");
  genProgress.classList.add("visible");
  genFill.style.width = "0%"; genCount.textContent = "0 / 20";
  genLabel.textContent = "Generating from \"" + name + "\"…";
  genStatus.textContent = "Ollama is reading your file. This takes ~1 min.";
  startPolling();
  const res = await sendMsg({ type: "SAVE_QUIZ_FILE", name, content });
  if (!res || !res.ok) {
    showQuizStatus("❌ Save failed: " + (res?.error || "unknown error"), "error");
    stopPolling(); genProgress.classList.remove("visible");
  }
  loadLibrary();
}

// ─── Progress polling ─────────────────────────────────────────
function startPolling() {
  stopPolling();
  pollInterval = setInterval(async () => {
    const stored = await getStorage(["quizGenProgress", "questionBank"]);
    const prog = stored.quizGenProgress;
    const bank = stored.questionBank || [];
    bankCount.textContent = bank.length;
    bankSub.textContent = bank.length ? bank.length + " questions ready" : "Generating…";
    if (prog) {
      const done = prog.done || 0, total = prog.total || 20;
      const generated = prog.generated || prog.questions?.length || 0;
      genFill.style.width = (total > 0 ? Math.round((done/total)*100) : 0) + "%";
      genCount.textContent = generated + " questions (" + done + "/" + total + " chunks)";
      if (prog.complete) {
        genLabel.textContent  = generated > 0 ? "✅ " + generated + " questions ready!" : "⚠️ 0 questions generated.";
        genStatus.textContent = generated > 0
          ? "Questions saved — they'll appear as you scroll Instagram."
          : "Make sure Ollama is running with OLLAMA_ORIGINS=* and try again.";
        showQuizStatus(
          generated > 0 ? "✅ " + generated + " questions from \"" + prog.fileName + "\"." : "⚠️ 0 questions. Is Ollama running?",
          generated > 0 ? "success" : "error"
        );
        stopPolling(); loadLibrary();
      }
    }
  }, 1000);
}
function stopPolling() { if (pollInterval) { clearInterval(pollInterval); pollInterval = null; } }

// ─── Library render ───────────────────────────────────────────
function loadLibrary() {
  chrome.runtime.sendMessage({ type: "GET_QUIZ_FILES" }, (res) => {
    if (!res) return;
    const files = res.files || [], bankSize = res.bankSize || 0;
    bankCount.textContent = bankSize;
    bankSub.textContent = bankSize
      ? bankSize + " questions ready — quizzes will appear while you scroll"
      : files.length ? "Generating… keep this tab open" : "Upload a file to generate questions";
    emptyLib.style.display = files.length ? "none" : "block";
    fileListEl.querySelectorAll(".file-item").forEach(el => el.remove());
    files.forEach(f => {
      const e = ext(f.name);
      const icon = { md:"📝", html:"🌐", csv:"📊" }[e] || "📄";
      const kb = f.charCount ? (f.charCount/1000).toFixed(1)+"k chars" : "";
      const date = f.addedAt ? new Date(f.addedAt).toLocaleDateString() : "";
      const item = document.createElement("div"); item.className = "file-item";
      item.innerHTML =
        "<span class=\"file-icon\">" + icon + "</span>" +
        "<div class=\"file-info\"><div class=\"file-name\" title=\"" + escHtml(f.name) + "\">" + escHtml(f.name) + "</div>" +
        "<div class=\"file-meta\">" + [kb,date].filter(Boolean).join(" · ") + "</div></div>" +
        "<button class=\"file-del\" title=\"Remove\">✕</button>";
      item.querySelector(".file-del").addEventListener("click", () => {
        if (confirm("Remove \"" + f.name + "\" and its questions?"))
          chrome.runtime.sendMessage({ type: "REMOVE_QUIZ_FILE", name: f.name }, () => loadLibrary());
      });
      fileListEl.appendChild(item);
    });
    if (res.progress && !res.progress.complete && !pollInterval) {
      startPolling(); genProgress.classList.add("visible");
    }
  });
}

// ══════════════════════════════════════════════════════════════
// ─── STATS PAGE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
function loadStats() {
  chrome.runtime.sendMessage({ type: "GET_HISTORY" }, (res) => {
    if (!res) return;
    const { days, totals, peakHour, budgetMin } = res;

    // All-time summary
    const totalHours = (totals.usedMin / 60).toFixed(1);
    const accuracy = (totals.correct + totals.wrong) > 0
      ? Math.round((totals.correct / (totals.correct + totals.wrong)) * 100) + "%" : "—";
    setText("all-hours",     totalHours);
    setText("all-correct",   totals.correct);
    setText("all-earned",    totals.earnedMin);
    setText("all-accuracy",  accuracy);
    setText("all-overrides", totals.overrides);
    setText("all-days",      days.length);

    // 7-day bar chart
    buildChart(days.slice(-7), budgetMin);

    // Insights
    const hour12 = peakHour === 0 ? "12 AM" : peakHour < 12 ? peakHour + " AM" : peakHour === 12 ? "12 PM" : (peakHour-12) + " PM";
    setText("insight-peak-text",
      days.length ? "You scroll most around <strong>" + hour12 + "</strong>." : "Not enough data yet.");
    document.getElementById("insight-peak-text").innerHTML =
      days.length ? "You scroll most around <strong>" + hour12 + "</strong>." : "Not enough data yet — keep using ScrollSense.";

    const streak = days.filter((d,i,arr) => {
      // count consecutive days from today backwards where under budget
      return d.usedMin <= budgetMin;
    }).length; // simplified — bg already computes real streak
    document.getElementById("insight-streak-text").innerHTML =
      totals.usedMin > 0
        ? "You've used Instagram for <strong>" + (totals.usedMin/60).toFixed(1) + " hours</strong> across " + days.length + " days tracked."
        : "No usage data yet.";

    document.getElementById("insight-quiz-text").innerHTML =
      totals.correct + totals.wrong > 0
        ? "You've answered <strong>" + (totals.correct+totals.wrong) + " quiz questions</strong> — " + accuracy + " accuracy, <strong>" + totals.earnedMin + " min</strong> earned."
        : "No quiz answers yet. Upload a file in Quiz Me to get started.";

    // History table
    buildHistoryTable(days, budgetMin);
  });
}

function buildChart(days, budgetMin) {
  const chart = document.getElementById("week-chart");
  if (!days.length) return; // leave "no data" message
  chart.innerHTML = "";
  const maxMin = Math.max(...days.map(d => d.usedMin), budgetMin, 1);
  days.forEach(d => {
    const heightPct = Math.min(100, Math.round((d.usedMin / maxMin) * 100));
    const under = d.usedMin <= d.budgetMin;
    const col = document.createElement("div"); col.className = "bar-col";
    col.innerHTML =
      "<div class=\"bar-val\">" + d.usedMin + "m</div>" +
      "<div class=\"bar-track\"><div class=\"bar-fill " + (under?"under":"over") + "\" style=\"height:" + heightPct + "%\"></div></div>" +
      "<div class=\"bar-label\">" + d.label + "</div>";
    chart.appendChild(col);
  });
}

function buildHistoryTable(days, budgetMin) {
  const wrap = document.getElementById("history-table-wrap");
  if (!days.length) { wrap.innerHTML = '<div class="no-data">No history yet.</div>'; return; }
  const reversed = [...days].reverse();
  let rows = "";
  reversed.forEach(d => {
    const under = d.usedMin <= d.budgetMin;
    const acc = (d.correct+d.wrong) > 0 ? Math.round((d.correct/(d.correct+d.wrong))*100)+"%" : "—";
    rows +=
      "<tr>" +
        "<td><span class=\"" + (under?"dot-under":"dot-over") + "\"></span>" + d.label + "</td>" +
        "<td>" + d.usedMin + "/" + d.budgetMin + "m</td>" +
        "<td>" + d.correct + "/" + (d.correct+d.wrong) + " (" + acc + ")</td>" +
        "<td>" + d.overrides + "</td>" +
        "<td>+" + d.earnedMin + "m</td>" +
      "</tr>";
  });
  wrap.innerHTML =
    "<table class=\"history-table\">" +
      "<thead><tr><th>Date</th><th>Used/Budget</th><th>Quiz</th><th>Overrides</th><th>Earned</th></tr></thead>" +
      "<tbody>" + rows + "</tbody>" +
    "</table>";
}

// ══════════════════════════════════════════════════════════════
// ─── RESET PAGE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

// Reset today (no confirmation input needed)
document.getElementById("btn-reset-today")?.addEventListener("click", () => {
  if (!confirm("Reset today's timer and scores? History and streak stay intact.")) return;
  chrome.runtime.sendMessage({ type: "RESET_TODAY" }, (res) => {
    const el = document.getElementById("status-today");
    if (el) { el.textContent = res?.ok ? "✅ Today's data cleared." : "❌ Something went wrong."; el.className = "reset-status " + (res?.ok?"ok":"err"); }
  });
});

// Reset all history — requires typing "RESET"
const confirmAllInput = document.getElementById("confirm-all");
const btnResetAll     = document.getElementById("btn-reset-all");
confirmAllInput?.addEventListener("input", () => {
  btnResetAll.disabled = confirmAllInput.value.trim() !== "RESET";
});
btnResetAll?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "RESET_ALL" }, (res) => {
    const el = document.getElementById("status-all");
    if (el) { el.textContent = res?.ok ? "✅ All history and settings reset." : "❌ Something went wrong."; el.className = "reset-status " + (res?.ok?"ok":"err"); }
    if (res?.ok) { confirmAllInput.value = ""; btnResetAll.disabled = true; }
  });
});

// Nuclear reset — requires typing "DELETE ALL"
const confirmNuclearInput = document.getElementById("confirm-nuclear");
const btnNuclear          = document.getElementById("btn-reset-nuclear");
confirmNuclearInput?.addEventListener("input", () => {
  btnNuclear.disabled = confirmNuclearInput.value.trim() !== "DELETE ALL";
});
btnNuclear?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "RESET_NUCLEAR" }, (res) => {
    const el = document.getElementById("status-nuclear");
    if (el) { el.textContent = res?.ok ? "✅ Everything wiped. ScrollSense is reset to day one." : "❌ Something went wrong."; el.className = "reset-status " + (res?.ok?"ok":"err"); }
    if (res?.ok) { confirmNuclearInput.value = ""; btnNuclear.disabled = true; loadLibrary(); }
  });
});

// ─── Shared helpers ───────────────────────────────────────────
function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(); r.readAsText(file,"UTF-8");
  });
}
function sendMsg(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, res => { if (chrome.runtime.lastError) resolve(null); else resolve(res); });
  });
}
function getStorage(keys) { return new Promise(resolve => chrome.storage.local.get(keys, resolve)); }
function setText(id, v)   { const e = document.getElementById(id); if (e) e.textContent = v; }
function ext(filename)    { return (filename.split(".").pop() || "").toLowerCase(); }
function escHtml(s)       { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function showQuizStatus(msg, type) {
  if (!quizStatus) return;
  quizStatus.textContent = msg; quizStatus.className = "status " + (type||"");
}
