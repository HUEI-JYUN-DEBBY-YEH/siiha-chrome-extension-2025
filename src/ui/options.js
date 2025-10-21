// SIIHA · Options (MV3 external script)

// --- fingerprint start ---
console.log("[SIIHA/Options] JS file LOADED at", new Date().toLocaleTimeString());
document.title += " [JS loaded]";
window.__SIIHA_FINGERPRINT__ = Math.random();
// --- fingerprint end ---

import Storage from "../logic/storage.js";

const DEFAULTS = {
  remindMinutes: 60,
  snoozeMinutes: 15,
  hybridEnabled: false,
  // 🆕 對齊 SW 預設
  restMode: "periodic",       // "off" | "periodic"
  restartMode: "immediate"    // "immediate" | "fixed"
};

function fmt(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return ""; }
}
const nowTs = () => Date.now();

// Use local timezone day key (YYYY-MM-DD) to match Storage/SW logic
function pad2(n){ return n < 10 ? "0"+n : ""+n; }
function todayLocal(){
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

async function init() {
  // 讀設定與執行期狀態，都走 Storage 門面
  const s = await Storage.Settings.get() || DEFAULTS;
  const runtime = await Storage.Runtime.get();
  // 🆕 讀偏好：是否儲存「今日聊天 HTML 預覽」與語言
  const prefs = await Storage.Prefs.get(["persistChatHtmlToday","languagePref"]);
  // 🆕 雲端同意
  const consent = (s && s.cloudHybridConsent) || { granted:false, ts:0, scope:"firebase-ai" };

  // 帶入目前值
  document.getElementById("remindMinutes").value = s.remindMinutes ?? DEFAULTS.remindMinutes;
  document.getElementById("snoozeMinutes").value = s.snoozeMinutes ?? DEFAULTS.snoozeMinutes;
  // muteDate 僅屬於 runtime
  document.getElementById("muteToday").checked =
    !!runtime?.muteDate && runtime.muteDate === todayLocal();
  document.getElementById("hybridEnabled").checked = !!s.hybridEnabled;
  const cloudEl = document.getElementById("cloudConsent");
  if (cloudEl) cloudEl.checked = !!consent.granted;

  // 🆕 主開關（restMode）
  const restMode = (s.restMode || DEFAULTS.restMode);
  const restOff = document.getElementById("restModeOff");
  const restPeriodic = document.getElementById("restModePeriodic");
  if (restOff && restPeriodic) {
    restOff.checked = restMode === "off";
    restPeriodic.checked = restMode !== "off";
  }

  // 🆕 Restart 行為（restartMode）
  const restartMode = (s.restartMode || DEFAULTS.restartMode);
  const restartImmediate = document.getElementById("restartImmediate");
  const restartFixed = document.getElementById("restartFixed");
  if (restartImmediate && restartFixed) {
    restartImmediate.checked = restartMode === "immediate";
    restartFixed.checked = restartMode === "fixed";
  }

  // 🆕 帶入「今日聊天 HTML 預覽」勾選狀態
  const persistEl = document.getElementById("persistChatHtmlToday");
  if (persistEl) persistEl.checked = !!prefs?.persistChatHtmlToday;

  // 🧘 Grounding settings
  const grdRememberEl = document.getElementById("groundingRememberPref");
  const grdCooldownEl = document.getElementById("groundingCooldownMinutes");
  if (grdRememberEl) grdRememberEl.checked = (s.groundingRememberPref ?? true);
  if (grdCooldownEl) grdCooldownEl.value = (s.groundingCooldownMinutes ?? 5);  
  // 🌐 語言：鎖定英文
  const langEn = document.getElementById("langEn");
  const langZh = document.getElementById("langZh");
  if (langEn && langZh) {
    langEn.checked = true;
    langZh.checked = false;
    // 可選：灰化避免誤觸
    try { langEn.disabled = true; langZh.disabled = true; } catch {}
  }

  // 顯示上次提醒時間
  const last = runtime?.lastNudgeAt ? fmt(runtime.lastNudgeAt) : "—";
  document.getElementById("lastNudgeHint").textContent = `Last nudge: ${last}`;

  console.debug("[SIIHA/Options] init settings:", s);
}

// 當 runtime 變更（例如 onAlarm 成功後 SW 寫入）→ 也更新畫面
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.runtime?.newValue?.lastNudgeAt) {
    const last = fmt(changes.runtime.newValue.lastNudgeAt);
    const el = document.getElementById("lastNudgeHint");
    if (el) el.textContent = `Last nudge: ${last}`;
    console.debug("[SIIHA/Options] runtime.lastNudgeAt updated:", last);
  }
  // 低迷系統相關：若 runtime 或 stats 變動，嘗試刷新低迷面板
  if (changes.runtime || changes.stats) {
    safeRenderLowMoodPanel();
  }
});

async function save() {
  const remindMinutes = parseInt(document.getElementById("remindMinutes").value || "60", 10);
  const snoozeMinutes = parseInt(document.getElementById("snoozeMinutes").value || "15", 10);
  const muteToday = document.getElementById("muteToday").checked;
  const hybridEnabled = document.getElementById("hybridEnabled").checked;
  // 🆕 讀單選欄位
  const restMode = (document.getElementById("restModeOff").checked ? "off" : "periodic");
  const restartMode = (document.getElementById("restartImmediate").checked ? "immediate" : "fixed");
  // 🆕 讀偏好：是否儲存「今日聊天 HTML 預覽」
  const persistChatHtmlToday = !!document.getElementById("persistChatHtmlToday")?.checked;
  // 🌐 語言：一律寫入 'en'，忽略任何 UI 切換
  const languagePref = "en";
  // 🆕 雲端同意
  const cloudGranted = !!document.getElementById("cloudConsent")?.checked;
  // 🧘 Grounding
  const groundingRememberPref = !!document.getElementById("groundingRememberPref")?.checked;
  const groundingCooldownMinutes = Math.max(
    1,
    parseInt(document.getElementById("groundingCooldownMinutes")?.value || "5", 10)
  );  

  const today = todayLocal();
  // Settings 只帶與設定相關欄位（不帶 muteDate）
  const settings = {
    remindMinutes: Math.max(1, remindMinutes),
    snoozeMinutes: Math.max(1, snoozeMinutes),
    hybridEnabled,
    // 🆕 新增兩個設定鍵
    restMode,
    restartMode,
    // 🧘 Grounding 設定（Options 控制）
    groundingRememberPref,
    groundingCooldownMinutes,    
    // 🆕 雲端同意（留位）：只有 granted/ts/scope
    cloudHybridConsent: { granted: cloudGranted, ts: nowTs(), scope: "firebase-ai" }
  };

  // 1) 寫入設定（門面）
  await Storage.Settings.set(settings);
  console.debug("[SIIHA/Options] saved settings:", settings);

  // 1.5) 🆕 寫入偏好（是否落地今日聊天 HTML）
  try {
    const patch = { persistChatHtmlToday, languagePref: "en" };
    await Storage.Prefs.patch(patch);
    console.debug("[SIIHA/Options] saved prefs:", patch); 
  } catch (e) {
    console.warn("[SIIHA/Options] save prefs failed:", e);
  }

  // 2) 同步 runtime 的 muteDate（單獨歸屬在 runtime）
  await Storage.Runtime.patch({ muteDate: muteToday ? today : null });

  // ▶ 主動通知 SW 重排（不再單靠 storage.onChanged）
  try {
    const res = await chrome.runtime.sendMessage({ type: "SETTINGS_UPDATED", payload: settings });
    console.debug("[SIIHA/Options] notified SW:", res);
  } catch (e) {
    console.warn("[SIIHA/Options] notify SW failed:", e);
  }

  show(restMode === "off" ? "Saved. Reminders are off." : "Saved. Background rescheduled.");
}

async function testNudge() {
  const r = await chrome.runtime.sendMessage({ type: "TEST_NUDGE" });
  show(r?.ok ? "Test nudge sent." : "No eligible tab. Open a normal webpage.");
}

async function showAlarms() {
  const r = await chrome.runtime.sendMessage({ type: "DEBUG_ALARMS" });
  console.debug("[SIIHA/Options] alarms:", r?.alarms);
  show("Alarms printed to the service worker console.");
}

async function showPick() {
  const r = await chrome.runtime.sendMessage({ type: "DEBUG_PICK" });
  console.debug("[SIIHA/Options] pickDeliverableTab ->", r?.tab || null);
  show("Selection printed to the service worker and this console.");
}

async function clearLocal() {
  // 保守清理：保留 user 設定，重置統計/狀態/快取
  await Storage.clearAllSafe();
  console.debug("[SIIHA/Options] safe-clear triggered via Storage.");
  show("Local data cleared.");
}

function show(text) {
  const el = document.getElementById("msg");
  el.textContent = text;
  setTimeout(() => (el.textContent = ""), 1800);
}

// Wire events after DOM ready（你原本這段是對的，保留）
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("save").addEventListener("click", save); 
  document.getElementById("clear").addEventListener("click", clearLocal);
  // 單一出口：整張週趨勢的匯出
  const exportBtn = document.getElementById("exportAll");
  if (exportBtn) exportBtn.addEventListener("click", exportAllJSON);  
  init();

  // === Weekly Trend Panel (local-only) ===
  safeRenderWeeklyPanel();


  const btnRef  = document.getElementById("lowMoodRefresh");
  if (btnRef)  btnRef.addEventListener("click", () => { safeRenderLowMoodPanel(); show("Refreshed."); });

  // 安全渲染低迷面板
  safeRenderLowMoodPanel();

  // === 🆕 Model Manager (Beta) wiring ===
  initModelManager();
});

// 當 stats 有變化（crisis / nudges / chat）時，重新渲染面板
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.stats) {
    console.debug("[SIIHA/Options] stats changed → re-render panel");
    safeRenderWeeklyPanel();
  }
});

// 安全載入 weeklyPanel 的輔助函式（確保 DOM ready）
function safeRenderWeeklyPanel() {
  const run = (tries = 0) => {
    const el = document.getElementById("weeklyPanel");
    if (!el) {
      if (tries < 20) return setTimeout(() => run(tries + 1), 50);
      console.warn("[SIIHA/Options] weeklyPanel not found after retries");
      return;
    }
    renderWeeklyPanel().catch(err => {
      console.error("[SIIHA/Options] renderWeeklyPanel failed:", err);
      el.textContent = "Failed to load weekly trend.";
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => run(), { once: true });
  } else {
    run();
  }
}

// 安全載入 lowMoodPanel 的輔助函式（確保 DOM 存在才渲染）
function safeRenderLowMoodPanel() {
  const run = (tries = 0) => {
    const el = document.getElementById("lowMoodPanel");
    if (!el) {
      if (tries < 20) return setTimeout(() => run(tries + 1), 50);
      // 沒有低迷面板節點就安靜跳過（不影響其它功能）
      return;
    }
    renderLowMoodPanel().catch(err => {
      console.error("[SIIHA/Options] renderLowMoodPanel failed:", err);
      el.textContent = "Failed to load low-mood panel.";
    });
  };
  if (document.readyState === "loading") {
   document.addEventListener("DOMContentLoaded", () => run(), { once: true });
  } else {
    run();
  }
}

// ---------------------------------------------
// 🌿 單一卡片面板：Emotional + Crisis 兩段趨勢與 Export
// ---------------------------------------------
async function renderWeeklyPanel() {
  const panel = document.getElementById("weeklyPanel");
  if (!panel) return;

  // 先放骨架
  panel.innerHTML = `
    <div class="hint" style="margin-bottom:10px">
      All stats live in your browser. No URLs, no text, no IDs.
    </div>

    <section style="margin:10px 0 18px">
      <h3 style="margin:0 0 6px">Weekly emotional trend</h3>
      <canvas id="emCanvas" width="800" height="180" style="width:100%;max-width:800px;height:180px;border-radius:12px;background:#fafafa;box-shadow:inset 0 0 8px rgba(0,0,0,.05)"></canvas>
      <div id="emNote" class="hint" style="margin-top:8px"></div>
    </section>

    <section>
      <h3 style="margin:0 0 6px">Weekly crisis trend</h3>
      <div class="hint" style="margin:0 0 6px">These show the heavier moments and how you responded.</div>
      <canvas id="crCanvas" width="800" height="180" style="width:100%;max-width:800px;height:180px;border-radius:12px;background:#fafafa;box-shadow:inset 0 0 8px rgba(0,0,0,.05)"></canvas>
      <div id="crNote" class="hint" style="margin-top:8px"></div>
      <div id="crChipKpi" style="margin-top:8px"></div>
    </section>

    <div id="weeklySummary" style="margin-top:14px;opacity:.9"></div>
    <div class="hint" style="margin-top:6px;font-style:italic">The weekly trend will reset every Monday at midnight.</div>
  `;

  // 撈資料
  const stats = await Storage.Stats.getAll();
  const days = (stats && stats.days) ? stats.days : {};

  // ── 最近七天標籤
  const now = new Date();
  const labels = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    labels.push(d.toISOString().slice(0, 10));
  }

  // ── Emotional: 以 nudges、chat 為主（示意：nudges.shown / nudges.snooze / chat.turns）
  const emShown = [], emSnooze = [], emChat = [];
  labels.forEach(k => {
    const n = (days[k]?.nudges) || {};
    const ch = (days[k]?.chat) || {};
    emShown.push(n.shown || 0);
    emSnooze.push(n.snooze || 0);
    emChat.push(ch.turns || ch.open || 0);
  });
  drawStackedBars(
    document.getElementById("emCanvas"),
    labels,
    { base: emShown, a: emSnooze, b: emChat },
    { base:"#d9d9d9", a:"#b7d6ff", b:"#ffe2a8" },
    [{key:"shown",  color:"#d9d9d9", label:"nudges"}, {key:"snooze", color:"#b7d6ff", label:"snooze"}, {key:"chat", color:"#ffe2a8", label:"chat"}]
  );

  // ── Crisis: crisis.shown / accept / dismiss + chip / chip_click
  const crShown = [], crAccept = [], crDismiss = [];
  const crChip = [], crChipClick = [];
  labels.forEach(k => {
    const c = (days[k]?.crisis) || {};
    crShown.push(c.shown || 0);
    crAccept.push(c.accept || 0);
    crDismiss.push(c.dismiss || 0);
    // 🆕 前景晶片：觸發與點擊
    crChip.push(c.chip || 0);
    crChipClick.push(c.chip_click || 0);
  });
  drawStackedBars(
    document.getElementById("crCanvas"),
    labels,
    { base: crShown, a: crAccept, b: crDismiss },
    { base:"#d9d9d9", a:"#9bd49b", b:"#f7b2b2" },
    [{key:"shown", color:"#d9d9d9", label:"shown"}, {key:"accept", color:"#9bd49b", label:"accept"}, {key:"dismiss", color:"#f7b2b2", label:"dismiss"}]
  );

  // —— 人話摘要（降低監視感、聚焦「趨勢」而非行為細節）
  const sum = (arr) => arr.reduce((a,b)=>a+(b||0),0);
  const emNote = document.getElementById("emNote");
  const crNote = document.getElementById("crNote");
  const emMsg = (() => {
    const s = sum(emShown), z = sum(emSnooze), ch = sum(emChat);
    if (s+z+ch === 0) return "It’s been a quiet week — simply noticing is already enough.";
    const parts = [];
    if (s) parts.push(`you received ${s} gentle reminder${s>1?"s":""}`);
    if (z) parts.push(`${z} time${z>1?"s":""} you chose to pause for later`);
    if (ch) parts.push(`${ch} moment${ch>1?"s":""} you opened a conversation`);
    return `Your rhythm stayed steady: ${parts.join(", ")}.`;
  })();
  const crMsg = (() => {
    const sh = sum(crShown), ac = sum(crAccept), di = sum(crDismiss);
    if (sh+ac+di === 0) return "No difficult moments showed up this week.";
    const parts = [];
    parts.push(`${sh} protection card${sh>1?"s were":" was"} shown`);
    if (ac) parts.push(`${ac} time${ac>1?"s":""} you chose to pause and take care`);
    if (di) parts.push(`${di} time${di>1?"s":""} you felt okay and moved on`);
    return `For heavier days: ${parts.join(", ")}. Keep your own pace.`;    
  })();
  emNote.textContent = emMsg;
  crNote.textContent = crMsg;

  // 🆕 KPI：Crisis chip conversion（chip_click / chip）
  const chipTotal = sum(crChip);
  const clickTotal = sum(crChipClick);
  const convPct = chipTotal > 0 ? (clickTotal / Math.max(chipTotal, 1)) * 100 : 0;
  // 四捨五入到整數（<10% 時保留 1 位小數以免看起來是 0%）
  const pctText = convPct < 10 ? convPct.toFixed(1) + "%" : Math.round(convPct) + "%";
  const kpi = document.getElementById("crChipKpi");
  if (kpi) {
    kpi.innerHTML = `
      <div class="kpi small" style="display:flex;align-items:center;gap:10px;background:#fff7f7;border:1px solid #f3c0c0;border-radius:12px;padding:10px 12px;box-shadow:0 2px 8px rgba(180,0,0,.08)">
        <div style="font-weight:700;color:#b00020">Crisis chip conversion</div>
        <div style="margin-left:auto;font-weight:700;color:#b00020">${pctText}</div>
      </div>
      <div class="hint" style="margin-top:6px">
        This week the crisis chip appeared <strong>${chipTotal}</strong> time${chipTotal===1?"":"s"}, and was opened <strong>${clickTotal}</strong> time${clickTotal===1?"":"s"} (${pctText}).
      </div>`;
  }
  
  // —— 整體一句話 summary（置於 reset 提示之上）
  const weeklySummary = document.getElementById("weeklySummary");
  weeklySummary.textContent = (() => {
    const totalEm = sum(emShown)+sum(emSnooze)+sum(emChat);
    const totalCr = sum(crShown)+sum(crAccept)+sum(crDismiss);
    if (totalEm+totalCr === 0) return "Your data feels light this week — staying as you are is perfectly fine.";
    if (totalCr === 0) return "Overall, your pace seems balanced — small pauses here and there are all you need.";
    return "There were a few intense moments this week. May you stay kind to yourself and move gently forward.";
  })();
}

// -------------------------------------------------
// 🆕 Download/Update Local Language Model (Beta)
// -------------------------------------------------
function initModelManager() {
  const card = document.getElementById("modelManagerCard");
  if (!card) return; // 安靜跳過
  const $ = (sel) => document.querySelector(sel);

  const requiredGB = 1.5; // 需求大小（可依未來實際模型調整）
  const requiredBytes = Math.round(requiredGB * 1024 * 1024 * 1024);

  const fmt = (n) => {
    const u = ["B","KB","MB","GB","TB"]; let i = 0; let x = Number(n || 0);
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return (i ? x.toFixed(1) : x.toFixed(0)) + " " + u[i];
  };

  async function checkSpace() {
    try {
      const est = (navigator.storage && navigator.storage.estimate)
        ? await navigator.storage.estimate()
        : { quota: 0, usage: 0 };
      const quota = est.quota || 0;
      const usage = est.usage || 0;
      const free = Math.max(0, quota - usage);
      $("#mm-quota").textContent = quota ? fmt(quota) : "unknown";
      $("#mm-free").textContent  = quota ? fmt(free)  : "unknown";
      $("#mm-required").textContent = fmt(requiredBytes);
      const ok = free >= requiredBytes;
      $("#mm-hint").textContent = ok
        ? "You have enough space."
        : "Not enough free space. Free up storage before downloading.";
      $("#mm-download").disabled = !ok;
      return { ok, quota, free };
    } catch (e) {
      console.warn("[SIIHA/Options] storage.estimate() failed:", e);
      $("#mm-hint").textContent = "Couldn’t read storage estimate. You can still try downloading.";
      $("#mm-download").disabled = false;
      return { ok: true, quota: 0, free: 0 };
    }
  }

  function setProgress(pct, label) {
    const v = Math.max(0, Math.min(100, Math.round(pct || 0)));
    const bar = document.getElementById("mm-progress");
    const txt = document.getElementById("mm-progress-text");
    if (bar) bar.value = v;
    if (txt) txt.textContent = label || (v + "%");
  }

  // === 🆕 Prompt API availability & real download ===
  async function paCheck() {
    const statusEl = document.getElementById("pa-status");
    const hintEl = document.getElementById("pa-hint");
    try {
      // 允許兩種入口（新舊命名）
      const LM = globalThis.LanguageModel || (globalThis.ai && globalThis.ai.languageModel);
      if (!LM || typeof LM.availability !== "function") {
        statusEl.textContent = "unavailable";
        hintEl.textContent = "Prompt API isn’t accessible from the extension options page on this browser/profile.";
        return { ok:false, availability:"unavailable", reason:"no-api" };
      }
      const a = String(await LM.availability()).toLowerCase(); // available | downloadable | downloading | unavailable
      statusEl.textContent = a;
      if (a === "available") {
       hintEl.textContent = "Model ready. You can create sessions immediately.";
      } else if (a === "downloadable") {
        hintEl.textContent = "Model downloadable. Press “Download / Update” to start.";
      } else if (a === "downloading") {
        hintEl.textContent = "Model is downloading… You should see progress below.";
      } else {
        hintEl.textContent = "Not supported here. Try Canary Chrome 138+ on desktop, or run from a normal page.";
      }
      return { ok:true, availability:a };
    } catch (e) {
     statusEl.textContent = "error";
      hintEl.textContent = "Failed to check availability (see console).";
      console.warn("[SIIHA/Options] paCheck error:", e);
      return { ok:false, availability:"error", reason:String(e) };
    }
  }

  async function paRealDownload() {
    const statusEl = document.getElementById("pa-status");
    const hintEl = document.getElementById("pa-hint");
    setProgress(0, "Starting…");
    try {
      const LM = globalThis.LanguageModel || (globalThis.ai && globalThis.ai.languageModel);
      if (!LM || typeof LM.create !== "function") {
        // 回落到 SW 模擬（demo）：
       hintEl.textContent = "Prompt API not accessible here. Falling back to simulated progress (demo).";
        try {
          await chrome.runtime.sendMessage({ type: "MODEL_DOWNLOAD_START", payload: { requiredBytes } });
       } catch {}
        return { ok:false, fallback:true };
      }
      // 真實下載：透過 monitor 監聽 downloadprogress
      const session = await LM.create({
        outputLanguage: "en",
        monitor: (monitor) => {
          try {
            monitor.addEventListener("downloadprogress", (e) => {
             const loadedPercent = Number((e.loaded * 100).toFixed(2));
              setProgress(loadedPercent, `downloading · ${loadedPercent|0}%`);
              if (loadedPercent >= 100) {
                // 有的版本在 100% 還會 finalize，一起顯示：
                setProgress(100, "finalizing");
              }
           });
          } catch (err) {
            console.debug("[SIIHA/Options] monitor binding failed:", err);
          }
        }
      });
      // 走到這裡代表 session ready（可立即使用）
      setProgress(100, "Complete");
      statusEl.textContent = "available";
      hintEl.textContent = "Model is ready. Session created successfully.";
      try { session?.destroy?.(); } catch {}
      return { ok:true };
    } catch (e) {
      console.warn("[SIIHA/Options] paRealDownload error:", e);
      statusEl.textContent = "error";
      // 常見：policy / enterprise / context not allowed
      if (/\bpolicy|enterprise|managed|disabled\b/i.test(String(e))) {
       hintEl.textContent = "Blocked by enterprise policy on this profile. Use a non-managed browser.";
      } else {
        hintEl.textContent = "Download failed from this page. You may start it in a normal tab’s console instead.";
      }
      setProgress(0, "error");
      return { ok:false, reason:String(e) };
    }
  }

  document.getElementById("mm-check")?.addEventListener("click", checkSpace);
  document.getElementById("mm-download")?.addEventListener("click", async () => {
    setProgress(0, "Starting...");
    try {
      await chrome.runtime.sendMessage({ type: "MODEL_DOWNLOAD_START", payload: { requiredBytes } });
    } catch (e) {
      console.warn("[SIIHA/Options] MODEL_DOWNLOAD_START failed:", e);
    }
  });
  document.getElementById("mm-cancel")?.addEventListener("click", async () => {
    try {
      await chrome.runtime.sendMessage({ type: "MODEL_DOWNLOAD_CANCEL" });
    } catch (e) {
      console.warn("[SIIHA/Options] MODEL_DOWNLOAD_CANCEL failed:", e);
    }
  });
  // 🆕 Wire Prompt API buttons
  document.getElementById("pa-check")?.addEventListener("click", paCheck);
  document.getElementById("pa-download")?.addEventListener("click", paRealDownload);

  // 進度事件（由 SW 模擬，未來可無縫換成真實下載進度）
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === "MODEL_DL_PROGRESS") {
        const p = Number(msg.payload?.percent || 0);
        const stage = msg.payload?.stage || "";
        setProgress(p, (stage ? stage + " · " : "") + (p|0) + "%");
      } else if (msg.type === "MODEL_DL_DONE") {
        setProgress(100, "Complete");
        const hint = document.getElementById("mm-hint");
        if (hint) hint.textContent = "Model is ready.";
      } else if (msg.type === "MODEL_DL_ERROR") {
        setProgress(0, "error");
        const hint = document.getElementById("mm-hint");
        if (hint) hint.textContent = "Download canceled or failed.";
      }
    });
  } catch {}

  // 首次載入即檢查一次空間
  checkSpace();
  // 首次載入順便探測一次 Prompt API（不阻塞）
  paCheck().catch(()=>{});  
}

// ---------------------------------------------
// 💠 三日低迷：Options 面板（查詢/測試/清空）
// ---------------------------------------------
async function renderLowMoodPanel() {
  const panel = document.getElementById("lowMoodPanel");
  if (!panel) return;

  // 讀取狀態
  let status = { last3: [], crisisEligible: false };
  try {
    status = await chrome.runtime.sendMessage({ type: "LOWMOOD_STATUS" }) || status;
  } catch(e) {
    console.warn("[SIIHA/Options] LOWMOOD_STATUS failed:", e);
  }

  // 骨架（輕量文字表格，避免引入新圖表邏輯）
  const rows = (status.last3 || []).map(d => `
    <tr>
      <td style="padding:4px 8px">${d.day || "—"}</td>
      <td style="padding:4px 8px">${d.count ?? 0}</td>
      <td style="padding:4px 8px">${Number(d.avgScore ?? 0).toFixed(2)}</td>
      <td style="padding:4px 8px">${d.midCount ?? 0}</td>
      <td style="padding:4px 8px">${d.highCount ?? 0}</td>
      <td style="padding:4px 8px">${(d.avgScore >= 3 || (d.highCount||0) >= 2) ? "yes" : "no"}</td>
    </tr>
  `).join("");

  panel.innerHTML = `
    <div class="hint" style="margin-bottom:10px; line-height:1.5">
      This section helps you <strong>observe your recent mood rhythm</strong>.
      <br/>
      <strong>Local-only view. No text is stored.</strong> We only keep light-weight
      intensity signals from your chats (not the content) and turn them into a simplified
      0–5 score.
      <div style="margin-top:8px"></div>
      <ul style="margin:0 0 6px 18px; padding:0">
        <li><strong>Low</strong>: 0–2.09 — everyday ups and downs; relatively steady.</li>
        <li><strong>Mid</strong>: 2.10–3.59 — some load shows up: stress, anxiety, poor sleep.</li>
        <li><strong>High</strong>: ≥3.6 — tougher moments; clear help/overwhelm language.</li>
      </ul>
      <div style="margin-top:6px"></div>
      <em>“Low-day?” rule</em>:
      a day counts as low if <strong>Avg ≥ 3</strong> or <strong>High ≥ 2</strong>.
      We always look at the <strong>past three days (excluding today)</strong>.
      This is only to help you notice patterns — this is not a diagnosis.
    </div>
    <table style="border-collapse:collapse;background:#fafafa;border-radius:12px;overflow:hidden">
      <thead>
        <tr style="background:#f0f0f0">
          <th style="padding:6px 8px;text-align:left">Day</th>
          <th style="padding:6px 8px;text-align:left">Count</th>
          <th style="padding:6px 8px;text-align:left">Avg</th>
          <th style="padding:6px 8px;text-align:left">Mid</th>
          <th style="padding:6px 8px;text-align:left">High</th>
         <th style="padding:6px 8px;text-align:left">Low-day?</th>
        </tr>
      </thead>
      <tbody>${rows || ""}</tbody>
    </table>
    <div id="lowMoodNote" style="margin-top:10px;opacity:.9"></div>
  `;

  const note = document.getElementById("lowMoodNote");
  if (note) {
    note.textContent = status.crisisEligible
      ? "You’re above the 3-day threshold. Lately may have felt heavier — that’s okay. Try a tiny act of care. I’m here with you."
      : "Below the 3-day threshold. Keep your own pace — having you here is already good.";
  }
}

function fmtSince(ts) {
  if (!ts) return "—";
  try {
    const diff = Math.max(0, Date.now() - Number(ts));
    const m = Math.floor(diff / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return m ? `${m}m ${s}s ago` : `${s}s ago`;
  } catch { return "—"; }
}


// 共用：柔色長條（底 bar + 兩段 overlay），labels 為日期字串
// legendItems: [{key,label,color}...]
function drawStackedBars(canvas, labels, series, colors, legendItems) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const barW = 40, gap = 40;
  const startX = 40, baseY = h - 30;

  const max = Math.max(
    ...labels.map((_, i) => Math.max(series.base[i] || 0, (series.a[i] || 0) + (series.b[i] || 0))),
    1
  );
  const scale = (v) => (v / max) * (h - 60);

  ctx.clearRect(0,0,w,h);
  ctx.font = "12px system-ui";
  ctx.textAlign = "center";

  labels.forEach((k, i) => {
    const x = startX + i * (gap + barW);
    // base
    const yBase = scale(series.base[i] || 0);
    ctx.fillStyle = colors.base;
    ctx.fillRect(x, baseY - yBase, barW, yBase);

    // overlay a
    const yA = scale(series.a[i] || 0);
    ctx.fillStyle = colors.a;
    ctx.fillRect(x, baseY - yA, barW/3, yA);

    // overlay b
    const yB = scale(series.b[i] || 0);
    ctx.fillStyle = colors.b;
    ctx.fillRect(x + barW*2/3, baseY - yB, barW/3, yB);

    // 日期
    ctx.fillStyle = "#555";
    ctx.fillText(k.slice(5), x + barW/2, baseY + 14);
  });
  // 圖例（使用彩色小方塊 + 文字，降低混淆）
  ctx.textAlign = "left";
  let lx = 16, ly = 18;
  legendItems.forEach(item => {
    ctx.fillStyle = item.color;
    ctx.fillRect(lx, ly-10, 10, 10);
    ctx.fillStyle = "#666";
    ctx.fillText(` ${item.label}`, lx + 14, ly);
    lx += 90;
  });
}

// 單一「匯出全部」按鈕的動作
async function exportAllJSON() {
  // 也可改走訊息；這裡示範直接讀 Storage
  try {
    const stats = await Storage.Stats.getAll();
    const blob = new Blob([JSON.stringify(stats, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `siiha_stats_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    show("Exported JSON downloaded.");
  } catch (e) {
    console.warn("[SIIHA/Options] export failed:", e);
    show("Export failed. See console.");
  }
}