
# SIIHA Pacing – Chrome AI Companion (Developer Preview) · v0.1

**Privacy Notes**

SIIHA Pacing is designed **local-first**. It aims to support gentle pacing and presence on any webpage without collecting, transmitting, or selling personal data. This document explains what the extension does, what it does **not** do, and how you can control your data.

---

## 1) What the extension does

* **Renders a floating companion UI** on webpages to offer light, on-page pacing prompts (mirror → micro-action → permission).
* **Schedules soft pauses** (rest nudges) with Chrome’s local alarm/timer APIs.
* **Shows an offline crisis chip** with region-agnostic, generic guidance and “seek local help” disclaimer.
* **Keeps basic counters/flags locally** (e.g., weekly trend totals, feature toggles) to help you see your own usage pattern.

> The design priority is presence, not advice. No medical, legal, or professional guidance is provided.

---

## 2) What the extension does **not** do

* **No page scraping of your content.** It does not read your form inputs, messages, or page text to send elsewhere.
* **No cloud calls for pacing/grounding logic.** Emotional templates and resources are bundled offline.
* **No ad tech, tracking pixels, or third-party analytics.**
* **No sale or sharing of personal data.**

---

## 3) Permissions & why they are needed

| Permission                                  | Why it’s needed                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `activeTab` / content scripts on webpages   | To render the floating UI consistently across sites.                      |
| `alarms`                                    | To schedule periodic rest nudges locally.                                 |
| `storage`                                   | To store feature flags, counts, and preferences locally (Chrome storage). |
| `host_permissions` for broad match patterns | To let the UI appear on most sites (the UI layer is the product).         |

> Even with broad host permissions, the extension **does not** parse or upload page text. It only attaches its own UI and stores its own local states.

---

## 4) Data stored locally

* **Feature toggles and preferences** (e.g., rest mode).
* **Lightweight counters** (e.g., weekly chip/chip_click tallies).
* **Operational flags** (e.g., internal version, migration status).

All data remains in the browser’s local extension storage unless you explicitly clear it.

---

## 5) How to clear your data

You can remove stored data at any time by:

1. Opening the extension’s **Options** page → **Clear local data** to remove locally stored preferences and counters.
2. Removing the extension from Chrome (**Manage extensions → Remove**) will deletes the extension's local storage associated with this installation.

---

## 6) Crisis & safety disclaimer

SIIHA Pacing is **not** a healthcare or crisis service. It does not provide diagnosis or treatment, and it does not contact emergency services.
If you or someone else may be in danger, or you are experiencing a medical/mental-health emergency, please seek **immediate local help** (e.g., local emergency number or trusted community resources).

---

## 7) Regional differences

The crisis chip shows **generic** guidance. It is not a directory of region-specific resources. Users should contact local services appropriate to their location and context.

---

## 8) Developer preview status

This is a **Developer Preview (v0.1)** release intended for evaluation. Features and wording may change. Any future cloud integrations (if considered) will be opt-in and documented with updated privacy notes.

---

## 9) Contact

For responsible disclosure or privacy questions, please open an issue in the repository or reach out via the author’s public contact listed there.

---

## Author & Developer

**HUEI-JYUN Debby YEH**  
📫 <debby83317@gmail.com>  
🔗 GitHub: [@HUEI-JYUN-DEBBY-YEH](https://github.com/HUEI-JYUN-DEBBY-YEH)  
🙋‍♀️ LinkedIn: [debbyyeh](https://www.linkedin.com/in/debbyyeh/)