# SIIHA Pacing – Chrome AI Companion (Developer Preview) · v0.1

**SIIHA Pacing** is a local-first Chrome companion that sits quietly on any webpage.  
It supports a gentle, three-beat rhythm — reflect → tiny step → permission — to help you slow down, take soft pauses, and keep sensitive resources offline.  
All core behavior runs on-device without scraping page content or sending data to a server.

---

## 🌱 Why SIIHA (Design intent)

SIIHA began with a simple aim: wellbeing tools should work **anywhere**, even with weak or no network, and **without** relying on server-side APIs.  
It prioritizes **returning to the present** over chasing output — less push, more space.

**In practice**
- **Local-first**: core prompts and resources live on your device.
- **Network-agnostic**: consistent behavior regardless of connectivity.
- **Wellbeing-first**: helps you notice and care for yourself before productivity metrics.

---

## ✨ Key features

- **Gentle support on any page**  
  A quiet, on-page companion that reflects your state in plain language, invites a tiny action (e.g., a breath), and ends with permission to pause — never pushy, never prescriptive.

- **Local-first by design**  
  Core resources are bundled offline. No cloud calls are required for the primary experience.

- **Soft rest nudges**  
  Optional periodic reminders driven by Chrome’s local alarms — no background network traffic.

- **Crisis chip (offline)**  
  Generic, non-clinical guidance with a clear “seek local help” reminder. No diagnosis. No triage. No escalation services.

- **Light observability**  
  An Options page with weekly counters so you can notice your own trend at a glance. **Patterns, not content.**

---

## 🧩 Architecture (high level)

- **Manifest V3** with a **Service Worker** for scheduling and local state orchestration.  
- **Content script / floater** renders the UI layer and listens to lightweight gestures.  
- **Storage module** centralizes local preferences, flags, and counters.  
- **Offline resources** provide prompt phrasing and crisis language; no remote inference is required.

> The extension does **not** read or transmit page text. It renders its own UI and tracks only its own local states.

---

## 🧾 Tracking without over-tracking

SIIHA observes **rhythms**, not content.

- **Weekly trend (local-only)**  
  A lightweight view of the past week (e.g., reminders shown/snoozed, conversations opened).  
  It exists to help you **notice** patterns — not to score you.

- **Three-day low-mood threshold (local-only)**  
  Looks back across the **recent three days (excluding today)** to surface heavier-than-usual periods.  
  Signals are simplified into broad intensity levels (0–5 bins). **No text is stored.**  
  This is **not** a diagnosis; it’s a gentle mirror.

- **Continuity with boundaries**  
  Keeps a **short-lived conversation context** (hours-level) and **daily/weekly counters** for trends.  
  Context fades automatically; trends rotate on a **weekly** cadence.  
  Exact lifetimes and formulas may change in future releases and remain implementation details.

---

## 🧘 Rest card — flexible by design

You control the rhythm.

- **Rest interval**: choose a cadence that fits (e.g., 45–60 minutes for real use; shorter for testing).  
- **Snooze**: delay a nudge when now isn’t the time.  
- **Restart behavior**: after you complete a rest, either **start from now** or **keep the existing schedule**.

---

## 🔐 Privacy & permissions

See **[PRIVACY_NOTES.md](./PRIVACY_NOTES.md)** for details.

**Summary**
- No page scraping or cloud uploads for core logic.  
- No third-party analytics or trackers.  
- Host permissions exist to render the UI everywhere; **content is not parsed**.  
- You can clear local data from the Options page or by removing the extension.

---

### Need a walkthrough?
See the **[User Guide](./docs/USER_GUIDE.md)** for installation steps, a tour of every Options control, and how to read the Weekly Trend and Low-mood panels.

## 🛠️ Install (unpacked)

1. Clone or download this repository.  
2. Open **chrome://extensions** in Chrome.  
3. Enable **Developer mode** (top right).  
4. Click **Load unpacked** and select the project folder.  
5. Open any webpage — you should see the floating companion in the corner.

> If you don’t see it, ensure the extension is enabled and the page is not a restricted Chrome URL (e.g., Web Store, `chrome://` pages).

---

## 🎬 Demo video

📽️ **YouTube Demo (60 s)**  
Watch the full walkthrough here → [https://youtu.be/XfGPwniVOW8](https://youtu.be/XfGPwniVOW8)

This short demo shows:
- Local‑first, client‑side Chrome AI Extension (runs entirely n‑device)  
- Real “Mirror → Micro‑step → Permission” pacing in action  
- Trend detection with minimal, offline data handling  

*(Submitted to the Google Chrome Built‑in AI Challenge 2025 · as part of surfaces within SIIHA Emotional Productivity OS)*

---

## ⚙️ Basic usage

- Tap the floating companion to reveal a short line or supportive tooltip.  
- Enable rest nudges on the Options page if you’d like periodic pauses.  
- View weekly counters on the Options page to observe your own pattern.  
- The crisis chip appears only when relevant phrases are present; it stays generic and offline by design.

---

## ❗ Disclaimers

- SIIHA Pacing is **not** medical, psychological, legal, or professional advice.  
- It does **not** contact emergency services or provide triage.  
- If you’re in danger or facing a medical/mental-health emergency, please seek **immediate local help**.

---

## 🧭 Design principles

- **Presence over persuasion** — reflect first; don’t rush to solve.  
- **Minimal & respectful** — fewer words, more room for the user.  
- **Local-first** — keep the soul of the experience on-device.  
- **Observable without exposure** — show behavior without reading user content.

---

## 🧪 Known limitations (Developer Preview)

- Accessibility (ARIA, keyboard navigation) is in progress.  
- Crisis resources are generic rather than region-specific.  
- UI tone is English-only in this preview.  
- Hybrid/cloud inference paths are intentionally disabled.

---

## 🗺️ Roadmap (indicative)

- A11y improvements (ARIA labels, keyboard path).  
- Optional language packs.  
- Sharper Options analytics (still local).  
- Carefully scoped, opt-in hybrid modes (if ever introduced) with updated privacy notes.

---

## 🤝 Contributing

Issues and suggestions are welcome. For privacy or security concerns, please **avoid posting sensitive details** publicly — open a minimal issue first and we’ll follow up.

---

## 📄 License

Unless otherwise noted, this project is released under a permissive open-source license (see `LICENSE`). Check third-party component licenses where applicable.

---

## 📬 Contact

For questions or collaboration, please open an issue in the repo.  
Press or research inquiries: use the public contact below.

---

**SIIHA Pacing – Chrome AI Companion (Developer Preview)**  
_Local-first presence. No scraping. No uploads. Just space to breathe._

---

## Author & Developer

**HUEI-JYUN Debby YEH**  
📫 <debby83317@gmail.com>  
🔗 GitHub: [@HUEI-JYUN-DEBBY-YEH](https://github.com/HUEI-JYUN-DEBBY-YEH)  
🙋‍♀️ LinkedIn: [debbyyeh](https://www.linkedin.com/in/debbyyeh/)

---

📄 License: MIT — see LICENSE file for full terms.
