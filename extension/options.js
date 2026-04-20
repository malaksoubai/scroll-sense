// ============================================================
// ScrollSense — options.js  v5.0
// Upload files → background.js calls Ollama → stores question bank
// This page polls storage for progress and shows it live.
// ============================================================

const dropZone     = document.getElementById("drop-zone");
const fileInput    = document.getElementById("file-input");
const pasteArea    = document.getElementById("paste-area");
const pasteName    = document.getElementById("paste-name");
const addPasteBtn  = document.getElementById("add-paste-btn");
const charCountEl  = document.getElementById("char-count");
const statusEl     = document.getElementById("status");
const fileListEl   = document.getElementById("file-list");
const emptyLib     = document.getElementById("empty-lib");
const clearAllBtn  = document.getElementById("clear-all-btn");
const genProgress  = document.getElementById("gen-progress");
const genFill      = document.getElementById("gen-fill");
const genCount     = document.getElementById("gen-count");
const genLabel     = document.getElementById("gen-label");
const genStatus    = document.getElementById("gen-status");
const bankCount    = document.getElementById("bank-count");
const bankSub      = document.getElementById("bank-sub");

let pollInterval = null;

// ─── Init ─────────────────────────────────────────────────────
loadAll();

// ─── Tab switching ────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    clearStatus();
  });
});

// ─── Drop zone ────────────────────────────────────────────────
dropZone.addEventListener("dragover",  (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  handleFiles(Array.from(e.dataTransfer?.files || []));
});
fileInput.addEventListener("change", () => {
  handleFiles(Array.from(fileInput.files || []));
  fileInput.value = "";
});

// ─── Paste ────────────────────────────────────────────────────
pasteArea.addEventListener("input", () => {
  charCountEl.textContent = pasteArea.value.length.toLocaleString();
  addPasteBtn.disabled = pasteArea.value.trim().length < 20;
});

addPasteBtn.addEventListener("click", async () => {
  const text = pasteArea.value.trim();
  const name = pasteName.value.trim() || ("Notes — " + new Date().toLocaleDateString());
  if (text.length < 20) { showStatus("Paste at least a sentence of text.", "error"); return; }
  addPasteBtn.disabled = true;
  addPasteBtn.textContent = "Saving…";
  await uploadFile(name, text);
  addPasteBtn.textContent = "Save & Generate Questions";
  pasteArea.value = "";
  pasteName.value = "";
  charCountEl.textContent = "0";
  addPasteBtn.disabled = true;
});

// ─── Clear all ────────────────────────────────────────────────
clearAllBtn.addEventListener("click", () => {
  if (!confirm("Remove all files and clear the question bank?")) return;
  chrome.runtime.sendMessage({ type: "CLEAR_ALL_QUIZ_FILES" }, () => {
    showStatus("Library and question bank cleared.", "info");
    stopPolling();
    genProgress.classList.remove("visible");
    loadAll();
  });
});

// ─── Handle uploaded files ────────────────────────────────────
const SUPPORTED = ["txt", "md", "html", "csv"];

async function handleFiles(files) {
  if (!files.length) return;
  const bad  = files.filter((f) => !SUPPORTED.includes(ext(f.name)));
  const good = files.filter((f) =>  SUPPORTED.includes(ext(f.name)));

  if (!good.length) {
    showStatus("❌ Use .txt, .md, .html, or .csv. See the PDF/DOCX tip above.", "error");
    return;
  }

  for (const file of good) {
    let text = "";
    try { text = await readAsText(file); } catch {
      showStatus("❌ Could not read " + file.name, "error"); continue;
    }
    if (!text || text.trim().length < 20) {
      showStatus("❌ " + file.name + " appears empty.", "error"); continue;
    }
    await uploadFile(file.name, text.trim());
  }

  if (bad.length) {
    showStatus((statusEl.textContent ? statusEl.textContent + " " : "") +
      "Skipped: " + bad.map(f => f.name).join(", ") + " (unsupported type).", "info");
  }
}

// ─── Upload one file to background + start progress polling ──
async function uploadFile(name, content) {
  showStatus("📤 Sending to Ollama… this may take a minute.", "info");
  genProgress.classList.add("visible");
  genFill.style.width = "0%";
  genCount.textContent = "0 / 20";
  genLabel.textContent = "Generating questions from \"" + name + "\"…";
  genStatus.textContent = "Ollama is reading your file. Don't close this tab.";

  startPolling();

  const res = await sendMsg({ type: "SAVE_QUIZ_FILE", name, content });
  // sendResponse fires immediately (before generation is done)
  // so we rely on polling to track actual progress

  if (!res || !res.ok) {
    showStatus("❌ Failed to save file: " + (res?.error || "unknown error"), "error");
    stopPolling();
    genProgress.classList.remove("visible");
  }

  loadAll();
}

// ─── Poll chrome.storage for generation progress ──────────────
function startPolling() {
  stopPolling();
  pollInterval = setInterval(async () => {
    const stored = await getStorage(["quizGenProgress", "questionBank"]);
    const prog   = stored.quizGenProgress;
    const bank   = stored.questionBank || [];

    bankCount.textContent = bank.length;
    bankSub.textContent   = bank.length
      ? bank.length + " questions ready"
      : "Generating…";

    if (prog) {
      const done      = prog.done      || 0;
      const total     = prog.total     || 20;
      const generated = prog.generated || prog.questions?.length || 0;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      genFill.style.width  = pct + "%";
      genCount.textContent = generated + " questions (" + done + "/" + total + " chunks processed)";

      if (prog.complete) {
        if (generated > 0) {
          genLabel.textContent  = "✅ Done! " + generated + " questions ready.";
          genStatus.textContent = "Questions saved — they'll pop up as you scroll Instagram.";
          showStatus("✅ " + generated + " questions generated from \"" + prog.fileName + "\".", "success");
        } else {
          genLabel.textContent  = "⚠️ Generation finished but 0 questions were saved.";
          genStatus.textContent = "Check that Ollama is running (ollama serve) and the model is pulled (ollama pull llama3.2).";
          showStatus("⚠️ 0 questions generated. Make sure Ollama is running and try again.", "error");
        }
        stopPolling();
        loadAll();
      }
    }
  }, 1000);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

// ─── Load library + bank size ─────────────────────────────────
function loadAll() {
  chrome.runtime.sendMessage({ type: "GET_QUIZ_FILES" }, (res) => {
    if (!res) return;
    const files    = res.files  || [];
    const bankSize = res.bankSize || 0;

    bankCount.textContent = bankSize;
    bankSub.textContent   = bankSize
      ? bankSize + " questions ready — quizzes will appear while you scroll"
      : files.length
        ? "Generating… keep this tab open"
        : "Upload a file to generate questions";

    // File list
    emptyLib.style.display = files.length ? "none" : "block";
    fileListEl.querySelectorAll(".file-item").forEach((el) => el.remove());

    files.forEach((f) => {
      const e    = ext(f.name);
      const icon = { md: "📝", html: "🌐", csv: "📊" }[e] || "📄";
      const kb   = f.charCount ? (f.charCount / 1000).toFixed(1) + "k chars" : "";
      const date = f.addedAt ? new Date(f.addedAt).toLocaleDateString() : "";

      const item = document.createElement("div");
      item.className = "file-item";
      item.innerHTML =
        "<span class=\"file-icon\">" + icon + "</span>" +
        "<div class=\"file-info\">" +
          "<div class=\"file-name\" title=\"" + escHtml(f.name) + "\">" + escHtml(f.name) + "</div>" +
          "<div class=\"file-meta\">" + [kb, date].filter(Boolean).join(" · ") + "</div>" +
        "</div>" +
        "<button class=\"file-del\" title=\"Remove\">✕</button>";

      item.querySelector(".file-del").addEventListener("click", () => {
        if (confirm("Remove \"" + f.name + "\" and its questions?")) {
          chrome.runtime.sendMessage({ type: "REMOVE_QUIZ_FILE", name: f.name }, () => loadAll());
        }
      });
      fileListEl.appendChild(item);
    });

    // If generation is in progress, resume polling
    if (res.progress && !res.progress.complete && !pollInterval) {
      startPolling();
      genProgress.classList.add("visible");
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────
function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result);
    r.onerror = () => reject(new Error("read failed"));
    r.readAsText(file, "UTF-8");
  });
}

function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res);
    });
  });
}

function getStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

function ext(filename) { return (filename.split(".").pop() || "").toLowerCase(); }

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = "status " + (type || "");
}
function clearStatus() {
  statusEl.textContent = "";
  statusEl.className = "status";
}
function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
