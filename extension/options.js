// ============================================================
// ScrollSense — options.js  v4.0
// Simple, reliable: FileReader for text files only.
// No external libraries. No CDN. No binary parsing.
// ============================================================

// ─── Elements ────────────────────────────────────────────────
const dropZone     = document.getElementById("drop-zone");
const fileInput    = document.getElementById("file-input");
const pasteArea    = document.getElementById("paste-area");
const pasteName    = document.getElementById("paste-name");
const addPasteBtn  = document.getElementById("add-paste-btn");
const charCount    = document.getElementById("char-count");
const statusEl     = document.getElementById("status");
const fileListEl   = document.getElementById("file-list");
const emptyLib     = document.getElementById("empty-lib");
const libCount     = document.getElementById("lib-count");
const clearAllBtn  = document.getElementById("clear-all-btn");
const progressWrap = document.getElementById("progress-wrap");
const progressFill = document.getElementById("progress-fill");
const progressLbl  = document.getElementById("progress-label");

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

// ─── Load library on open ─────────────────────────────────────
loadLibrary();

// ─── Drag & drop ──────────────────────────────────────────────
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  handleFiles(Array.from(e.dataTransfer?.files || []));
});
fileInput.addEventListener("change", () => {
  handleFiles(Array.from(fileInput.files || []));
  fileInput.value = ""; // allow re-selecting the same file
});

// ─── Paste panel ──────────────────────────────────────────────
pasteArea.addEventListener("input", () => {
  const len = pasteArea.value.length;
  charCount.textContent = len.toLocaleString();
  addPasteBtn.disabled = len < 20;
});

addPasteBtn.addEventListener("click", async () => {
  const text = pasteArea.value.trim();
  const name = pasteName.value.trim() || ("Notes — " + new Date().toLocaleDateString());
  if (text.length < 20) { showStatus("Paste at least a sentence of text.", "error"); return; }

  addPasteBtn.disabled = true;
  addPasteBtn.textContent = "Saving…";

  const res = await saveFile(name, text);

  addPasteBtn.textContent = "Save to Library";
  addPasteBtn.disabled = false;

  if (res && res.ok) {
    showStatus("✅ \"" + name + "\" saved to your library.", "success");
    pasteArea.value = "";
    pasteName.value = "";
    charCount.textContent = "0";
    addPasteBtn.disabled = true;
    loadLibrary();
  } else {
    showStatus("❌ Save failed: " + ((res && res.error) || "unknown error"), "error");
  }
});

// ─── Clear all ────────────────────────────────────────────────
clearAllBtn.addEventListener("click", () => {
  if (!confirm("Remove all files from your study library?")) return;
  chrome.runtime.sendMessage({ type: "CLEAR_ALL_QUIZ_FILES" }, () => {
    showStatus("Library cleared.", "info");
    loadLibrary();
  });
});

// ─── Handle uploaded files ────────────────────────────────────
const SUPPORTED = ["txt", "md", "html", "csv"];

async function handleFiles(files) {
  if (!files.length) return;

  // Reject unsupported types immediately
  const badFiles = files.filter((f) => !SUPPORTED.includes(ext(f.name)));
  const goodFiles = files.filter((f) => SUPPORTED.includes(ext(f.name)));

  if (badFiles.length && !goodFiles.length) {
    showStatus(
      "❌ Unsupported file type(s): " + badFiles.map((f) => f.name).join(", ") +
      ". Use .txt, .md, .html, or .csv. See the PDF/DOCX conversion tip above.",
      "error"
    );
    return;
  }

  setProgress(true, "Reading " + goodFiles.length + " file(s)…", 10);

  let added = 0;
  const failed = [];

  for (let i = 0; i < goodFiles.length; i++) {
    const file = goodFiles[i];
    const pct = Math.round(((i + 1) / goodFiles.length) * 100);
    setProgress(true, "Reading: " + file.name, pct);

    let text = "";
    try {
      text = await readFileAsText(file);
    } catch (e) {
      failed.push(file.name + " (could not read)");
      continue;
    }

    if (!text || text.trim().length < 20) {
      failed.push(file.name + " (file appears empty)");
      continue;
    }

    const res = await saveFile(file.name, text.trim());
    if (res && res.ok) {
      added++;
    } else {
      failed.push(file.name + " (storage error: " + ((res && res.error) || "unknown") + ")");
    }
  }

  setProgress(false);

  if (added > 0 && !failed.length) {
    showStatus("✅ " + added + " file" + (added > 1 ? "s" : "") + " saved to your library.", "success");
  } else if (added > 0 && failed.length) {
    showStatus(
      "✅ " + added + " saved. ⚠️ Skipped: " + failed.join(", "),
      "info"
    );
  } else {
    showStatus("❌ Could not save: " + failed.join(", "), "error");
  }

  if (badFiles.length) {
    showStatus(
      (statusEl.textContent ? statusEl.textContent + " " : "") +
      "Note: " + badFiles.map((f) => f.name).join(", ") + " skipped (unsupported type — see PDF/DOCX tip).",
      "info"
    );
  }

  loadLibrary();
}

// ─── Read a text file ─────────────────────────────────────────
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("FileReader error"));
    reader.readAsText(file, "UTF-8");
  });
}

// ─── Save to background storage ──────────────────────────────
function saveFile(name, content) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "SAVE_QUIZ_FILE", name, content }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res);
      }
    });
  });
}

// ─── Remove one file ─────────────────────────────────────────
function removeFile(name) {
  chrome.runtime.sendMessage({ type: "REMOVE_QUIZ_FILE", name }, () => {
    loadLibrary();
  });
}

// ─── Render the library ───────────────────────────────────────
function loadLibrary() {
  chrome.runtime.sendMessage({ type: "GET_QUIZ_FILES" }, (res) => {
    const files = (res && res.files) || [];
    libCount.textContent = files.length === 1 ? "1 file saved" : files.length + " files saved";
    emptyLib.style.display = files.length ? "none" : "block";

    fileListEl.querySelectorAll(".file-item").forEach((el) => el.remove());

    files.forEach((f) => {
      const e = ext(f.name);
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
        "<button class=\"file-del\" title=\"Remove this file\">✕</button>";

      item.querySelector(".file-del").addEventListener("click", () => {
        if (confirm("Remove \"" + f.name + "\" from your library?")) removeFile(f.name);
      });

      fileListEl.appendChild(item);
    });
  });
}

// ─── UI helpers ───────────────────────────────────────────────
function ext(filename) {
  return (filename.split(".").pop() || "").toLowerCase();
}

function setProgress(visible, label, pct) {
  progressWrap.classList.toggle("visible", visible);
  if (label) progressLbl.textContent = label;
  if (pct !== undefined) progressFill.style.width = pct + "%";
}

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = "status " + (type || "");
}

function clearStatus() {
  statusEl.textContent = "";
  statusEl.className = "status";
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
