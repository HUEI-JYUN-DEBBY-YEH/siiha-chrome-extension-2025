# SIIHA Pacing — User Guide (Developer Preview · v0.1)

This guide explains how to install, see the floating companion, and tune settings on the **Options** page.
The focus is on **how to use it**, not how it’s implemented.

---

## Contents

1. [Quick start](#quick-start)
2. [Options — main controls](#options--main-controls)
   a. [Rest mode](#a-rest-mode-off--periodic)
   b. [Rest reminder interval & Snooze duration](#b-rest-reminder-interval-minutes--snooze-duration)
   c. [Restart behavior](#c-restart-behavior-from-now--keep-schedule)
   d. [Mute today](#d-mute-today)
   e. [Hybrid (not enabled in v0.1)](#e-hybrid-firebase-ai-logic-not-enabled-in-v01)
   f. [Allow cloud generation (not enabled in v0.1)](#f-allow-cloud-generation-firebase-ai-not-enabled-in-v01)
   g. [Store today’s chat preview (HTML)](#g-store-todays-chat-preview-html)
   h. [Grounding](#h-grounding-remember-my-preferred-duration--cooldown)
   i. [Clear local data](#i-clear-local-data)
   j. [Download/Update Local Language Model (Beta)](#j-downloadupdate-local-language-model-beta)
   k. [Weekly Trend](#k-weekly-trend)
   l. [Low-mood (3-day threshold)](#l-lowmood-3day-threshold)
3. [Troubleshooting](#troubleshooting)
4. [Privacy at a glance](#privacy-at-a-glance)

---

## Quick start

1. **Install (unpacked)**

   * Clone or download the repository.
   * Open `chrome://extensions` → turn on **Developer mode** (top right).
   * Click **Load unpacked** and select the project folder.

2. **See the floating companion**

   * Open any regular webpage (not the Chrome Web Store or `chrome://` pages).
   * Look for a small companion in the corner. If you don’t see it, confirm the extension is enabled.

3. **First click**

   * Click the floating companion. You’ll see a short, gentle line.
   * Open the **Options** page to customize reminders, rest behavior, and privacy preferences.

---

## Options — main controls

This page helps you tune SIIHA to your habits. Settings are **local-first**: they live on your device and can be changed anytime.

### a) Rest mode: Off · Periodic

* **Off** – All rest nudges are disabled.
* **Periodic** – SIIHA will remind you on a fixed cadence you choose (see *Rest reminder interval* below).

**Tip:** Use **Off** when you want a quiet day; switch back to **Periodic** when you’re ready for a gentle rhythm.

---

### b) Rest reminder interval (minutes) & Snooze duration

* **Rest reminder interval** – How often a reminder appears.

  * For testing, try **1–2 minutes**.
  * For typical use, **45–60 minutes** is a calm pace.
* **Snooze duration** – How long to delay a reminder when you choose *Snooze*.

**What happens:** SIIHA schedules these natively via Chrome’s local alarms. No background network calls.

---

### c) Restart behavior: From now · Keep schedule

When you tap a rest card (e.g., “I’ll rest now”), you can decide how the next reminder should be timed:

* **From now** – The timer restarts from the moment you finished resting.
* **Keep schedule** – The original cadence continues, regardless of when you rested.

**When to use:**

* Choose **From now** if you prefer rolling intervals.
* Choose **Keep schedule** if you want fixed anchors across the day.

---

### d) Mute today

Temporarily turns off nudges for the rest of the day.
**Note:** This affects reminders only; it doesn’t delete any local counters.

---

### e) Hybrid (Firebase AI Logic) — *not enabled in v0.1*

A future path that, when available, would allow optional hybrid behavior.

* In v0.1, this **does nothing**. It remains unchecked by default.

---

### f) Allow cloud generation (Firebase AI) — *not enabled in v0.1*

A future consent toggle.

* In v0.1, checking this **only records your preference locally** and does not contact any cloud service.

---

### g) Store today’s chat preview (HTML)

* **Unchecked (default)** – No chat preview HTML is cached.
* **Checked** – A **same-day cache** of the on-page chat preview is stored **locally** (expires after the day).

  * This is for your own continuity view; it is **not** uploaded.

**Good to know:** This is a lightweight, short-lived preview. It’s designed for your eyes, not analytics.

---

### h) Grounding — “Remember my preferred duration” & Cooldown

* **Remember my preferred duration**

  * **Checked** – When you finish a grounding exercise (e.g., tap “I’m okay for now / done”), your preferred duration is remembered for later sessions.
  * **Unchecked** – SIIHA won’t remember a preferred duration.
* **Cooldown (minutes)**

  * Prevents grounding prompts from appearing too often.
  * Think of it as a minimum quiet time between grounding suggestions.

---

### i) Clear local data

Removes locally stored **preferences, counters, and short-lived caches** held by the extension.

**Impact**

* You’ll return to defaults (e.g., rest mode, intervals).
* Weekly trend and low-mood summaries kept by the extension are cleared.
* This does **not** affect your browser history, downloads, or files.
* You can also remove the extension from Chrome to delete its local storage entirely.

*For full details, see `PRIVACY_NOTES.md`.*

---

### j) Download/Update Local Language Model (Beta)

Manage an **on-device model** used for future local features.

* **Re-check space** – Estimates available storage using the browser API.
* **Download / Update** – Begins or updates the local model. The file stays on your device.
* **Cancel** – Stops an in-progress download.

**When to use:** Only if you want to try the beta path and have enough free space.
**Privacy note:** The model file resides locally; your content is **not** uploaded for this.

---

### k) Weekly Trend

A local-only snapshot of the past week. It shows high-level counts such as:

* **Nudges** shown
* **Snooze** actions
* **Conversations** opened
* **Crisis** card events (e.g., shown / accepted / dismissed)

**How to read it:** It’s a mirror, not a score. Look for *rhythm* (e.g., when you tend to need breaks) rather than performance.

**Export JSON:**

* Downloads a file with your weekly summary data (counts and dates).
* It contains **no page text, URLs, or IDs**.
* Useful if you want to keep a personal log or import into your own tools.

---

### l) Low-mood (3-day threshold)

A local-only panel that helps you **notice** heavier-than-usual periods.

* Uses simplified **0–5** intensity levels; **no text is stored**.
* Looks at the **past three days (excluding today)** and shows day-level aggregates like Count / Avg / Mid / High.
* A day is flagged “Low-day?” using broad rules (explained inline). It’s **not** a diagnosis.

**Refresh**

* Recomputes the panel from your current local data.
* It does **not** delete anything and does **not** contact a server.

**Why no “delete” here?**

* The panel is for *awareness*, not performance. Allowing selective deletion could mislead self-observation. You can still **Clear local data** if you want a full reset.

---

## Troubleshooting

* **I don’t see the floating companion.**

  * Ensure the extension is enabled.
  * Try a regular webpage (not `chrome://` or the Chrome Web Store).
  * If you use strict content blockers, allow this extension on the page.

* **Reminders don’t show up.**

  * Confirm **Rest mode = Periodic** and that the **interval** isn’t set to 0.
  * Check **Mute today** isn’t enabled.
  * If your device sleeps aggressively, timers may resume on wake.

* **Export JSON downloaded but looks empty.**

  * You may have little or no recent activity; try again after a day or two of normal use.

---

## Privacy at a glance

* **Local-first** by default.
* **No page scraping**; the companion renders its own UI.
* **No cloud calls** for core features.
* **No third-party analytics or trackers.**
* You can **Clear local data** on the Options page or remove the extension to delete its local storage.

For more, see `PRIVACY_NOTES.md`.

---

*Developer Preview · v0.1 — Features and wording may evolve. The intent stays the same: gentle presence, on your device.*
