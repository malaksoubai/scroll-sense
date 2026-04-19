# ScrollSense — Setup Guide

**AI-powered Chrome extension that redirects you back to your actual work.**

---

## What It Does

ScrollSense watches your Instagram feed and periodically nudges you toward your open productive tabs — using a local AI (Ollama) to write personal, context-aware messages based on what you actually have open.

### Three States

| State | Trigger | What Happens |
|---|---|---|
| 🟢 **Active** | Always | Timer pill shows time remaining (top-right corner) |
| 💬 **Redirect** | Every N min *or* N new posts | Pop-up card suggests one of your open tabs, written by Ollama |
| 🛑 **Freeze** | At 100% budget *(optional)* | Feed blurs, Ollama writes a personal freeze message |

---

## Step 1 — Install Ollama + Pull the Model

You already have Ollama installed. Now you need to pull the AI model:

1. Open **Terminal**
2. Run:

```bash
ollama pull llama3.2
```

This downloads ~2GB. Wait for it to finish.

3. Verify it works:

```bash
ollama run llama3.2 "Say hello in one sentence."
```

You should see a short reply. That means the local AI is ready.

> **Ollama must be running in the background** when you use ScrollSense.
> It starts automatically on most systems after installation. If not, run:
> ```bash
> ollama serve
> ```

---

## Step 2 — Generate Icons (one-time)

From the `extension/` folder, run:

```bash
python3 make_icons.py
```

This creates `icons/icon16.png`, `icon48.png`, `icon128.png`.

---

## Step 3 — Load the Extension in Chrome

1. Open Chrome and go to: `chrome://extensions`
2. Toggle **Developer mode** ON (top-right switch)
3. Click **"Load unpacked"**
4. Select the `extension/` folder inside this project
5. You should see **ScrollSense** appear in your extensions list

---

## Step 4 — Test It

1. Go to **instagram.com** in Chrome
2. You should see a small **timer pill** in the top-right corner (purple dot, shows time left)
3. Scroll through the feed — after 15 posts or 5 minutes, a redirect card will pop up
4. Click the **ScrollSense icon** in the toolbar to open the popup with stats and settings

---

## Popup Settings

| Setting | Default | What it controls |
|---|---|---|
| Daily budget | 20 min | Total allowed Instagram time per day |
| Redirect every | 5 min | Time-based redirect trigger |
| Redirect after | 15 posts | Scroll-count redirect trigger |
| Nudge at | 80% | Pill turns yellow at this % of budget |
| Hard freeze | ON | Blur feed + block at 100% budget |

The **Ollama dot** in the popup footer shows green if the local AI is reachable, red if not.

---

## File Structure

```
extension/
├── manifest.json      ← Chrome Extension config (Manifest V3)
├── background.js      ← Service worker: budget, Ollama API, tab tracking
├── content.js         ← Injected into instagram.com: DOM watcher, overlays
├── styles.css         ← All injected UI styles
├── popup.html         ← Extension popup UI
├── popup.js           ← Popup logic
├── make_icons.py      ← One-time icon generator
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## How the AI Works (No API Key Needed)

ScrollSense calls Ollama at `http://localhost:11434/api/generate` — completely local, free, private.

**Redirect prompt** — Ollama sees:
- How many minutes you've scrolled
- Your daily budget
- Titles of your currently open tabs
- How many times you've overridden today

It writes a 1-sentence warm nudge referencing one of your actual tabs.

**Freeze prompt** — Same context, but with a harder framing. After 5+ overrides, the prompt mentions the pattern gently.

**Weekly reflection** — After 7 days, Ollama summarizes your week in one insight sentence.

If Ollama is unreachable, ScrollSense falls back to a sensible hardcoded message — it never silently fails.

---

## Troubleshooting

**Timer pill doesn't appear on Instagram**
→ Go to `chrome://extensions`, click "Reload" on ScrollSense, then refresh Instagram.

**Pop-ups aren't appearing**
→ Check that Ollama is running (`ollama serve` in Terminal). The popup shows a red/green dot.

**"Ollama unreachable" in console**
→ The extension still works — it shows fallback messages. Start Ollama: `ollama serve`

**Extension won't load**
→ Make sure you selected the `extension/` folder (the one containing `manifest.json`), not the parent folder.

---

## Changing the AI Model

If you pull a different model (e.g. `ollama pull mistral`), update the `model` field in `background.js`:

```js
const OLLAMA_MODEL = "mistral"; // line 8
```

Then reload the extension in `chrome://extensions`.

---

## Privacy

- **All data stays on your machine.** No servers, no analytics.
- Chrome storage holds only: daily usage seconds, override count, snooze count, outcome log.
- Ollama runs 100% locally. Your tab titles and browsing data never leave your computer.
