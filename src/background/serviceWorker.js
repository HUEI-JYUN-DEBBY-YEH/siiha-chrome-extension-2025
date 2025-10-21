// SIIHA v0.1 — Background (MV3 Service Worker, ESM + dev bridge)

// ⬇️ SW 內禁止動態 import()，改用 ESM 靜態匯入
import { envCheck } from "../utils/envCheck.js";
import { detectTone } from "../logic/intensityGate.js";
import { generateReply as orchestratedGenerateReply } from "../logic/promptClient.js";
import Storage from "../logic/storage.js";

console.log("[SIIHA/BG] Service Worker LOADED at", new Date().toLocaleTimeString());

// === Locale hard lock (for delivery stability) ===
// 'en' | null  →  set to null to re-enable auto detection
const FORCE_LOCALE = 'en';

// ===== Small async utils =====
const sleep = (ms = 0) => new Promise(res => setTimeout(res, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ===== Lightweight conversational signals (shortcode-based) =====
// Triggers (neutral naming; no domain jargon)
const RE_P1 = /\b(stay\s+here\s+and\s+listen|just\s+listen)\b/i;                   // user asks for "stay/listen"
const RE_RJ = /\b(don[’']?t\s+think\s+that\s+helps|not\s+helping|not\s+listening|you\s+don[’']?t\s+understand)\b/i; // pushback/doubt
// 🔎 明確要「做法/建議/分析」的關鍵詞（英/中）
// - balance X and Y 支援多詞片語（非只限單字）
const RE_ASK_APPROACH =
  /\b(analyz(e|is)|how\s+(do|can)\s+i|how\s+to|what\s+should\s+i|suggest(ion)?s?|advice(s)?|tips?|plan|roadmap|steps?|approach)\b|建議|怎麼做|做法|分析/i;
const RE_ASK_BALANCE = /\bbalance\b.{0,120}\band\b/i;
// 🧘 緊張線索（才標 grounding_cue）
const RE_GROUNDING_CUE = /\b(panic|anxiety|insomnia)\b|崩潰|心悸|睡不著|恐慌|害怕/i;

// 固定句庫（去重時過濾）
const GENERIC_PHRASES = [/^I.?m here to listen\.?/i, /^It.?s (completely )?understandable/i];

// Token overlap for same-point detection (language-agnostic, Unicode-friendly)
function jaccardOverlap(a = "", b = "") {
  const tok = s => new Set(String(s).toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\s]/gi," ")
    .split(/\s+/).filter(x=>x && x.length>=2));
  const A = tok(a), B = tok(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach(x => { if (B.has(x)) inter++; });
  return inter / (A.size + B.size - inter);
}
// Generic, model-free keyphrase picker: cut → score → de-dup → top 2
function pickKeyphrases(text = "", prevSummaries = []) {
  const s = String(text || "").trim();
  if (!s) return [];
  const isZH = /[\u4e00-\u9fff]/.test(s);
  let cands = [];
  if (isZH) {
    const parts = s.split(/[，。！？、；\s]/).filter(Boolean);
    parts.forEach(p=>{
      for (let n=2;n<=4;n++){
        for (let i=0;i<=p.length-n;i++){
          const seg = p.slice(i,i+n);
          if (!/^[的了在很把被嗎呢吧哦啊呀麼]+$/.test(seg)) cands.push(seg);
        }
      }
    });
  } else {
    const words = s.replace(/[^\w\s→\-\/]/g," ").split(/\s+/).filter(Boolean);
    for (let n=1;n<=3;n++){
      for (let i=0;i<=words.length-n;i++){
        const seg = words.slice(i,i+n).join(" ");
        if (!/^(of|the|a|an|to|in|on|for|with|and|but|or|so|at|from|by|as|that|this|it|is|are)$/i.test(seg)) {
          cands.push(seg);
        }
      }
    }
  }
  // score
  const prev = (prevSummaries||[]).join(" ").toLowerCase();
  const seenPrev = new Set(prev.split(/\s+/).filter(Boolean));
  const counts = new Map();
  cands.forEach(c=>counts.set(c,(counts.get(c)||0)+1));
  const scored = Array.from(new Set(cands)).map(c=>{
    let score = 0;
    // position bias: earlier tokens slightly higher
    score += Math.max(0, 1.0 - (s.indexOf(c) / Math.max(1, s.length)));
    // length prefer 2–5 words/chars
    const len = isZH ? c.length : c.split(/\s+/).length;
    score += (len>=2 && len<=5) ? 0.6 : (len===1?0.1:-0.2);
    // novelty against previous summaries
    const words = isZH ? c.split("") : c.split(/\s+/);
    const novel = words.filter(w=>!seenPrev.has(w.toLowerCase())).length / Math.max(1, words.length);
    score += 0.5 * novel;
    // repetition within current text
    score += Math.min(0.6, (counts.get(c)||0) * 0.2);
    // type hints: numbers/dates/arrows/roles
    if (/[0-9％%年月日\/\-]/.test(c)) score += 0.2;
    if (/[→\-\/]|\bto\b/.test(c)) score += 0.2;
    if (/(爸媽|父母|家人|manager|boss|parent|family|我)/i.test(c)) score += 0.15;
    return { c, score };
  }).sort((a,b)=>b.score-a.score);
  // diversity (simple redundancy suppression)
  const chosen = [];
  for (const item of scored) {
    const tooSimilar = chosen.some(x=>{
      const a=item.c.toLowerCase(), b=x.toLowerCase();
      const setA = new Set(a.split(isZH?"":/\s+/)), setB = new Set(b.split(isZH?"":/\s+/));
      let inter=0; setA.forEach(t=>{ if(setB.has(t)) inter++; });
      const j = inter / (setA.size + setB.size - inter);
      return j >= 0.6;
    });
    if (!tooSimilar) chosen.push(item.c);
    if (chosen.length>=2) break;
  }
  return chosen;
}

const DEFAULTS = {
  remindMinutes: 60,
  snoozeMinutes: 15,
  hybridEnabled: false,
  // 🆕 休息提醒主開關與重啟行為（Options）
  // "off" | "periodic"
  restMode: "periodic",
  // "immediate" | "fixed"
  restartMode: "immediate",
  // 🆕 DEV：是否記錄最近 20 筆路徑到 Runtime.lastTurns（僅存 meta，不存原文）
  devTrackTurns: true,
  // 🆕 Grounding defaults (Options 可覆蓋)
  groundingRememberPref: true,
  groundingCooldownMinutes: 5
};
// Advice 2+1 確認句（超短）
const ADVICE_CONFIRM_EN = "Keep concrete steps, or shift to listening?";

// ===== Alarm names =====
const ALARM_MAIN = "siiha-rest-nudge";
const ALARM_SNOOZE = "siiha-rest-snooze";
const ALARM_MIDNIGHT = "siiha-midnight-rollup"; // 🕛 本地午夜：三日低迷 rollup
const HTTP_OK = (t) => typeof t?.url === "string" && /^https?:\/\//i.test(t.url);

// --- date helpers (LOCAL calendar keys) ---
function pad2(n){ return n < 10 ? "0"+n : ""+n; }
function dateKeyLocal(d = new Date()){
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
function dateKeyOffset(base = new Date(), offsetDays = 0){
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays);
  return dateKeyLocal(d);
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  // 保險：確保 runtime 結構與欄位到位
  await Storage.Runtime.ensure();
  // 🧹 啟動時先做一次續聊層惰性清理
  try { await Storage.Continuity.sweepExpired(); } catch {}
  await scheduleAlarm("onInstalled");
  await scheduleWeeklyReset();
  await scheduleMidnightRollup();
  await runThreeDayRollup("onInstalled");
  console.log("[SIIHA] installed & scheduled.");
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  await Storage.Runtime.ensure();
  // 🧹 啟動時先做一次續聊層惰性清理
  try { await Storage.Continuity.sweepExpired(); } catch {}
  await scheduleAlarm("onStartup");
  await scheduleWeeklyReset();
  await scheduleMidnightRollup();
  await runThreeDayRollup("onStartup");
  console.log("[SIIHA] startup & scheduled.");
});

// === Unified alarm listener ===
chrome.alarms.onAlarm.addListener(async (alarm) => {
  const settings = (await Storage.Settings.get()) || DEFAULTS;
  const runtime = await Storage.Runtime.get();
  const today = dateKeyLocal();

  // ❌ 若主開關為 off，直接忽略所有提醒類鬧鐘
  if (settings.restMode === "off" && (alarm.name === ALARM_MAIN || alarm.name === ALARM_SNOOZE)) {
    console.debug("[SIIHA/BG] restMode=off, skip alarm:", alarm.name);
    return;
  }

  // 🕛 本地午夜 rollup（連續三日低迷門檻）
  if (alarm.name === ALARM_MIDNIGHT) {
    console.log("[SIIHA/BG] Midnight roll-up triggered:", new Date().toLocaleString());
    await runThreeDayRollup("midnight");
    await scheduleMidnightRollup(); // 安排下一次
    return;
  }

  // 🕛 每週重置
  if (alarm.name === "siiha-weekly-reset") {
    console.log("[SIIHA/BG] Weekly reset triggered:", new Date().toLocaleString());
    await Storage.Stats.resetWeekly();
    console.log("[SIIHA/BG] Weekly stats cleared (via Storage).");
    return;
  }

  // 🎯 主鬧鐘與暫延鬧鐘
  if (alarm.name !== ALARM_MAIN && alarm.name !== ALARM_SNOOZE) return;
  if (runtime.muteDate === today && alarm.name === ALARM_MAIN) {
    console.debug("[SIIHA/BG] muted for today, skip main alarm.");
    return;
  }
  // 🆕 在 snooze 窗內：主鬧鐘需跳過（避免雙響）
  if (alarm.name === ALARM_MAIN) {
    const now = Date.now();
    if (Number(runtime.snoozeUntil || 0) > now) {
      console.debug("[SIIHA/BG] main alarm skipped due to active snooze window.");
      return;
    }
  }

  // 若為 snooze 喚醒，先清掉 snoozeUntil（避免殘留造成後續誤判）
  if (alarm.name === ALARM_SNOOZE) {
    try { await Storage.Runtime.patch({ snoozeUntil: 0 }); } catch {}
  }
  const tab = await pickDeliverableTab();
  if (!tab) {
    console.debug("[SIIHA/BG] no deliverable tab (http/https) found; skip.");
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "NUDGE" });
    await Storage.Runtime.patch({ lastNudgeAt: Date.now() });
    console.debug("[SIIHA/BG] NUDGE sent to tab", { id: tab.id, url: tab.url });
    // 可選：統計一次顯示（與 TEST_NUDGE 對齊）
    try { await Storage.Stats.bumpImmediate("nudges.shown", today); } catch {}
  } catch (e) {
    console.warn("[SIIHA/BG] NUDGE failed:", e?.message);
  }
});

// === Messages from content/options ===
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const t = msg?.type;
      console.debug("[SIIHA/BG] onMessage:", t || msg);

    switch (t) {
      // === Model Manager (Beta) : simulate download progress for Options page ===
      case "MODEL_DOWNLOAD_START": {
        try { if (globalThis.__modelDlTimer) clearInterval(globalThis.__modelDlTimer); } catch {}
        globalThis.__modelDlPct = 0;
        const total = Number(msg && msg.payload && msg.payload.requiredBytes || 0);
        globalThis.__modelDlTimer = setInterval(() => {
          globalThis.__modelDlPct = Math.min(100, (globalThis.__modelDlPct || 0) + 4);
          chrome.runtime.sendMessage({
            type: "MODEL_DL_PROGRESS",
            payload: {
              percent: globalThis.__modelDlPct,
              total,
              stage: (globalThis.__modelDlPct < 100 ? "downloading" : "finalizing")
            }
          });
          if (globalThis.__modelDlPct >= 100) {
            try { clearInterval(globalThis.__modelDlTimer); } catch {}
            chrome.runtime.sendMessage({ type: "MODEL_DL_DONE", payload: { total } });
          }
        }, 500);
        sendResponse({ ok: true });
        break;
      }
      case "MODEL_DOWNLOAD_CANCEL": {
        try { clearInterval(globalThis.__modelDlTimer); } catch {}
        globalThis.__modelDlPct = 0;
        chrome.runtime.sendMessage({ type: "MODEL_DL_ERROR", payload: { reason: "cancelled" } });
        sendResponse({ ok: true });
        break;
      }
        case "PING":
          sendResponse({ pong: true });
          break;

        case "SETTINGS_UPDATED": {
          const merged = { ...DEFAULTS, ...(msg.payload || {}) };        
          // 立即寫入（storage 為 immediate 模式）
          await Storage.Settings.set(merged);
          // 🆕 主開關控制：off → 全清；periodic → 重排程
          if (merged.restMode === "off") {
            await chrome.alarms.clear(ALARM_MAIN);
            await chrome.alarms.clear(ALARM_SNOOZE);
            console.log("[SIIHA/BG] SETTINGS_UPDATED -> rest off, alarms cleared.");
          } else {
            await scheduleAlarm("via SETTINGS_UPDATED", merged);
            console.log("[SIIHA/BG] SETTINGS_UPDATED -> rescheduled (periodic).", merged);
          }          
          sendResponse({ ok: true });
          break;
        }

        case "SNOOZE": {
          const settings = (await Storage.Settings.get()) || DEFAULTS;
          const delay = Number(settings.snoozeMinutes || DEFAULTS.snoozeMinutes);
          await chrome.alarms.create(ALARM_SNOOZE, { delayInMinutes: delay });
          await Storage.Runtime.patch({ snoozeUntil: Date.now() + delay * 60 * 1000 });
          console.debug("[SIIHA/BG] snoozed via one-off alarm for", delay, "minute(s).");
          await Storage.Stats.bumpImmediate("nudges.snooze", dateKeyLocal());
          sendResponse({ ok: true });
          break;
        }

        case "MUTE_TODAY": {
          const todayLocal = dateKeyLocal();
          await Storage.Runtime.patch({ muteDate: todayLocal });
          console.debug("[SIIHA/BG] muted for today (runtime).");
          await Storage.Stats.bumpImmediate("nudges.mute", todayLocal);
          sendResponse({ ok: true });
          break;
        }
        
        // 🆕 由 content script 請 SW 打開 Options（content-script 不可直接呼叫 openOptionsPage）
        case "OPEN_OPTIONS": {
          try {
            await chrome.runtime.openOptionsPage();
            sendResponse({ ok: true });
          } catch (e) {
            console.warn("[SIIHA/BG] OPEN_OPTIONS failed:", e);
            sendResponse({ ok: false, error: String(e) });
          }
          break;
        }

        // 🆕 使用者回覆「我去休息了」，依 restartMode 決定是否從現在重啟
        case "REST_DONE": {
          const settings = (await Storage.Settings.get()) || DEFAULTS;
          const period = Number(settings.remindMinutes || DEFAULTS.remindMinutes);
          const mode = String(settings.restartMode || DEFAULTS.restartMode);
          // 接受一次 → 記錄「accept」
          try { await Storage.Stats.bumpImmediate("nudges.accept", dateKeyLocal()); } catch {}
          // 更新最近互動時間
          try { await Storage.Runtime.patch({ lastNudgeAt: Date.now() }); } catch {}
          if (mode === "immediate") {
            await chrome.alarms.clear(ALARM_SNOOZE);
            await chrome.alarms.clear(ALARM_MAIN);
            await chrome.alarms.create(ALARM_MAIN, {
              delayInMinutes: period,
              periodInMinutes: period
            });
            // 清除 snooze 窗（避免誤判）
            try { await Storage.Runtime.patch({ snoozeUntil: 0 }); } catch {}
            console.debug("[SIIHA/BG] REST_DONE → restart from now (periodic).");
            sendResponse({ ok: true, restarted: "immediate", nextInMinutes: period });
          } else {
            console.debug("[SIIHA/BG] REST_DONE → keep schedule (fixed).");
            sendResponse({ ok: true, restarted: "fixed" });
          }
          break;
        }

        case "TEST_NUDGE": {
          const tab = await pickDeliverableTab();
          if (!tab) { sendResponse({ ok: false, reason: "no-tab" }); break; }
          await chrome.tabs.sendMessage(tab.id, { type: "NUDGE" });
          console.debug("[SIIHA/BG] test nudge sent to", tab.id);
          await Storage.Stats.bumpImmediate("nudges.shown", dateKeyLocal());
          sendResponse({ ok: true });
          break;
        }

        // === DEV：立即執行三日低迷 rollup（手動驗證用）
        case "__DEBUG_CHECK_NOW": {
          try {
            const res = await runThreeDayRollup("manual-check");
            // 回傳更完整的資訊，方便在 console 觀察
            sendResponse({ ok: true, ran: true, eligible: !!res.eligible, streak: res.streak, last3: res.last3 });
          } catch (e) {
            sendResponse({ ok: false, error: String(e) });
          }
          break;
        }

        // === 💠 低迷系統：除錯／查詢 ===
        case "LOWMOOD_PUSH": {
          // 直接寫入一筆「今日」mood 分數（繞過文字解析），方便 options/console 測試
          const score = Number(msg.score ?? 0);
          const level = score >= 3.6 ? "high" : (score >= 2.1 ? "mid" : "low");
          await Storage.Mood.appendImmediate(score, level, dateKeyLocal());
          sendResponse({ ok: true });
          break;
        }
        case "LOWMOOD_STATUS": {
          const status = await getLowMoodStatusLocal();
          sendResponse({ ok: true, ...status });
          break;
        }
        case "LOWMOOD_CLEAR": {
          await Storage.Mood.clearImmediate();
          sendResponse({ ok: true });
          break;
        }

        case "DEBUG_ALARMS": {
          const all = await chrome.alarms.getAll();
          console.debug("[SIIHA/BG] alarms:", all);
          sendResponse({ ok: true, alarms: all });
          break;
        }

        case "DEBUG_PICK": {
          const tab = await pickDeliverableTab(true);
          const brief = tab ? { id: tab.id, url: tab.url, active: !!tab.active, windowId: tab.windowId } : null;
          console.debug("[SIIHA/BG] DEBUG_PICK ->", brief);
          sendResponse({ ok: !!tab, tab: brief });
          break;
        }

        // === 🧘 GROUNDING: open a grounding card/packs (dialog or from crisis CTA) ===
        case "GROUNDING_OPEN": {
          const settings = (await Storage.Settings.get()) || DEFAULTS;
          const runtime = await Storage.Runtime.get();
          const now = Date.now();
          const until = Number(runtime.groundingCooldownUntil || 0);
          const cooldownHit = until > now;
          const remainingMs = cooldownHit ? (until - now) : 0;

          if (cooldownHit) {
            console.debug("[SIIHA/BG] grounding open blocked by cooldown", { remainingMs });
            sendResponse({ ok: false, cooldown: true, remainingMs });
            break;
          }

          // load packs from local json（units 轉為 packs）
          let packs = [];
          try { packs = await loadGroundingPacks(); } catch {}

          // prefer user's saved duration if enabled
          let defaultDuration = 60; // sec, safe default
          try {
            const prefs = await Storage.Prefs.get();
            const fromPref = Number(prefs?.groundingPreferredDuration || 0);
            if (settings.groundingRememberPref && isFinite(fromPref) && fromPref > 0) {
              defaultDuration = fromPref;
            }
          } catch {}

          // mark start + stats
          try { await Storage.Runtime.patch({ lastGroundingAt: now }); } catch {}
          try { await Storage.Stats.bumpImmediate("grounding.open", dateKeyLocal()); } catch {}

          console.debug("[SIIHA/BG] grounding open", {
            source: msg?.source || "dialog",
            cooldownHit: false,
            rememberPref: !!settings.groundingRememberPref,
            defaultDuration
          });

          sendResponse({
            ok: true,
            payload: {
              packs,
              rememberPref: !!settings.groundingRememberPref,
              defaultDuration
            }
          });
          break;
        }

        // === 🧘 GROUNDING: user moved to next / again (optional telemetry) ===
        case "GROUNDING_PROGRESS": {
          try { await Storage.Stats.bumpImmediate("grounding.next", dateKeyLocal()); } catch {}
          sendResponse({ ok: true });
          break;
        }

        // === 🧘 GROUNDING: session ended, record outcome and set cooldown ===
        case "GROUNDING_DONE": {
          const settings = (await Storage.Settings.get()) || DEFAULTS;
          // 修正：payload 內帶資料
          const duration_s = Math.max(0, Number(msg?.payload?.duration_s || 0));
          const exit = String(msg?.payload?.exit || "ok");
          try { await Storage.Stats.bumpImmediate("grounding.done", dateKeyLocal()); } catch {}
          try { await Storage.Stats.bumpImmediate(`grounding.exit.${exit}`, dateKeyLocal()); } catch {}
          // remember preferred duration if enabled
          try {
            if (settings.groundingRememberPref && duration_s > 0) {
              await Storage.Prefs.patch({ groundingPreferredDuration: duration_s });
            }
          } catch {}
          // set cooldown
          const coolMin = Number(settings.groundingCooldownMinutes || DEFAULTS.groundingCooldownMinutes || 5);
          try { await Storage.Runtime.patch({ groundingCooldownUntil: Date.now() + coolMin * 60 * 1000 }); } catch {}
          console.debug("[SIIHA/BG] grounding done", { duration_s, exit, cooldownMin: coolMin });
          sendResponse({ ok: true });
          break;
        }

        // === CRISIS TEST ===
        case "CRISIS_TEST": {
          const cards = await loadCrisisCards();
          const runtime = await Storage.Runtime.get();
          const settings = await Storage.Settings.get();
          // 順手更新一次三日門檻旗標（不影響原有彈卡流程）
          const roll = await runThreeDayRollup("manual");
          const rt2 = await Storage.Runtime.get();

          const idx = runtime.crisisIndex || 0;
          const randomMode = settings.randomMode || false;

          let card;
          if (randomMode) {
            card = cards[Math.floor(Math.random() * cards.length)];
          } else {
            card = cards[idx % cards.length];
          }

          const nextIndex = (idx + 1) % cards.length;
          // 連按強一致：立即寫入，避免順序跳動
          await Storage.Base.mergeImmediate("runtime", { crisisIndex: nextIndex });

          // 🆕 標記一次「新的危機事件」→ 讓前景危機晶片能再次出現
          try {
            await Storage.Runtime.patch({
              crisisEligible: true,
              lastCrisisLockAt: Date.now(),
              crisisChipDismissed: false
            });
          } catch {}

          const tab = await pickDeliverableTab();
          if (!tab) {
            console.warn("[SIIHA/BG] CRISIS_TEST skipped (no tab).");
            sendResponse({ ok: false, reason: "no-tab", crisisEligible: !!rt2.crisisEligible });
            break;
          }

          await chrome.tabs.sendMessage(tab.id, { type: "CRISIS_SHOW", payload: card });
          await Storage.Stats.bump("crisis.shown", dateKeyLocal());

          console.log("[SIIHA/BG] CRISIS dispatched to tab:", tab.id, "card:", card.id);
          sendResponse({ ok: true, card, crisisEligible: !!rt2.crisisEligible });
          break;
        }

        // === CRISIS ACTION (accept/dismiss) ===
        case "CRISIS_ACTION": {
          const { action, cardId } = msg.payload || {};
          // 🧩 將 action 紀錄進每日 stats
          if (action === "accept" || action === "dismiss") {
            await Storage.Stats.bump(`crisis.${action}`, dateKeyLocal());
          }

          // 額外 debug：記錄每次互動
          const ts = new Date().toISOString();
          console.debug("[SIIHA/BG] CRISIS_ACTION logged:", { action, cardId, ts });

          // 更新 runtime 狀態（方便日後週回顧模組讀取）
          await Storage.Runtime.append("lastCrisisAction", { action, cardId, ts }, { cap: 20 });

          sendResponse({ ok: true, logged: true });
          break;          
        }

        // 🆕 CRISIS OPENED（由前景危機晶片點擊觸發 → 開卡）
        // - 計一次 chip_click（前景轉化）
        // - 同步計一次 crisis.shown（卡片實際被打開）
        case "CRISIS_OPENED": {
          try {
            const todayLocal = dateKeyLocal();
            await Storage.Stats.bumpImmediate("crisis.chip_click", todayLocal);
            await Storage.Stats.bumpImmediate("crisis.shown", todayLocal);
            // 可選：標記最近一次互動，便於週回顧讀取
            try {
              await Storage.Runtime.append(
                "lastCrisisAction",
                { action: "opened_via_chip", ts: new Date().toISOString() },
                { cap: 20 }
              );
            } catch {}
            sendResponse({ ok: true, noted: true });
          } catch (e) {
            sendResponse({ ok: false, error: String(e) });
          }
          break;
        }
        // === 📈 匯出統計資料 ===
        case "EXPORT_STATS": {
          try {
            const stats = await Storage.Stats.getAll();
            console.debug("[SIIHA/BG] EXPORT_STATS fetched:", Object.keys(stats.days || {}).length, "days");
            sendResponse({ ok: true, stats });
          } catch (err) {
            console.error("[SIIHA/BG] EXPORT_STATS error:", err);
            sendResponse({ ok: false, error: String(err) });
          }
          break;
        }

        // === 📉 清除統計資料 ===
        case "CLEAR_STATS": {
          try {
            await Storage.Stats.clear();
            console.log("[SIIHA/BG] Stats cleared by user (via Storage).");
            sendResponse({ ok: true });
          } catch (err) {
            console.error("[SIIHA/BG] CLEAR_STATS error:", err);
            sendResponse({ ok: false, error: String(err) });
          }
          break;
        }

        // === 💬 CHAT PROMPT / REPLY ===
        case "CHAT_PROMPT": {
          const userText = (msg.text || "").trim();
          // 🧹 語言決策簡化：統一英文。
          const effectiveLocale = 'en';
          const langForEngine = 'en';
          // 觀測（保留最小訊息）
          try {
            console.debug("[SIIHA/BG] locale pick", {
              incomingLocale: null,
              resolvedLocale: effectiveLocale,
              langForEngine,
              forced: true
            });
          } catch {}

          // 🧹 續聊層惰性清理（處理前）
          try { await Storage.Continuity.sweepExpired(); } catch {}

          // 1) 取續聊狀態（心緒層/語境層）
          const lastEmotion = await Storage.Continuity.loadEmotionIfValid(); // {intensity, styleCode}|null
          const lastDialog = await Storage.Continuity.loadDialogIfValid();   // [{t,summary}] (≤3)
          const summaries = (lastDialog || []).map(d => String(d?.summary || "")).filter(Boolean);

          // 2) env & 本地強度判斷（作為提示值；最終仍以路由器輸出為準）
          const env = await envCheck().catch(() => ({}));
          const tone = await detectTone(userText, { mode: "auto", env }).catch(() => ({ level: "mid", tags: [] }));
          const quick = localQuickScore(userText);

          // ===== Entry marking (shortcodes only) =====
          const tags = new Set();      // e.g., ["p1","rj","rp"]
          let gateP1 = false;          // presence-like gate (shortcode)
          let routeSrc = "na";         // "ur" | "rj" | "na"
          let askApproach = false;     // 行動意圖
          let groundingCue = false;    // 緊張線索（僅此時才配 grounding）

          if (RE_GROUNDING_CUE.test(userText)) { tags.add("grounding_cue"); groundingCue = true; }
          let needSyncQ = false;       // UX hint for closing yes/no
          // p1: explicit "stay/listen"
          if (RE_P1.test(userText)) { gateP1 = true; tags.add("p1"); routeSrc = "ur"; }
          // rj: pushback/doubt → also implies p1 for safety unless contradicted later
          if (RE_RJ.test(userText)) { tags.add("rj"); if (!gateP1) { gateP1 = true; routeSrc = "rj"; } }
          // ask_approach: 明確要求分析 / 建議 / 作法
          if (RE_ASK_APPROACH.test(userText) || RE_ASK_BALANCE.test(userText)) {
            tags.add("ask_approach");
            askApproach = true;
            // 若沒有明說 just listen，關掉 gateP1（從「陪」切到「做法」）
            if (!RE_P1.test(userText)) { gateP1 = false; tags.delete("p1"); }
            routeSrc = "ask_approach";
          }
          // rp: same-point detection vs recent summaries
          try {
            const last = summaries[summaries.length - 1] || "";
            const prev = summaries[summaries.length - 2] || "";
            const sim = Math.max(jaccardOverlap(userText,last), jaccardOverlap(userText,prev));
            if (sim >= 0.85) { tags.add("rp"); needSyncQ = true; }
          } catch {}
          // k.top: generic keyphrases (0–2)
          const kTop = pickKeyphrases(userText, summaries);
          if (kTop.length) tags.add("k");

          // 🆕 規則性補標（與前景 orchestrator 對齊）：
          // 1) triage_ok：在 p1 或 rj 脈絡下，允許回覆尾端帶極簡 triage 問句
          try {
            if (tags.has("p1") || tags.has("rj")) tags.add("triage_ok");
          } catch {}
          // 2) cont：有續聊摘要即視為續聊脈絡（供覆層做更克制的節奏判斷）
          try {
            if ((summaries || []).length > 0) {
              tags.add("cont");
            }
          } catch {}
          
          // Persist minimal runtime telemetry（含路由來源）
          try {
            await Storage.Runtime.patch({
              route: { src: routeSrc },
              k: { top: kTop }
            });
          } catch {}
          // Persist minimal runtime telemetry (shortcode-names only)
          try {
            if (gateP1) {
              await Storage.Runtime.patch({ gate: { p1: { on: true, n: 3, since: Date.now() } }, route: { src: routeSrc } });
            }
            await Storage.Runtime.patch({ k: { top: kTop } });
          } catch {}
          
          // ⭕️ 保留原有日彙整/低迷統計（旁路，不阻塞主路徑）
          await Storage.Stats.emo.bumpImmediate(quick.score, dateKeyLocal());
          try {
            const moodScored = scoreTextForMood(userText);
            await Storage.Mood.appendImmediate(moodScored.score, moodScored.level, dateKeyLocal());
          } catch (e) {
            console.warn("[SIIHA/BG] mood score append failed:", e);
          }

          // 3) 組 context → 呼叫 orchestrator（支援 demo/remote 由 promptClient 內部決定）
          const contextText = summaries.join(" / ").slice(0, 600); // 輕量摘要串接
          const styleCodeHint = lastEmotion?.styleCode || null;
          let replyText = "";
          let replyMeta = {};
          let replyLines = null; // 🆕 保留路由器輸出的 lines，供摘要來源切換
          try {
            const out = await orchestratedGenerateReply({
              youSaid: userText,
              // 🆕 明確帶入語言（resolver → en）
              lang: langForEngine,
              audience: "ext",
              // 提示：延續 style 與語境（由路由器選擇是否採用）
              context: contextText,
              styleCodeHint,
              intensityHint: tone?.level || quick.level,
              // 🆕 shortcodes for routing/overlays (no semantics leaked)
              tags: Array.from(tags),       // ["p1","rj","rp","k"?]
              k: { top: kTop },             // anchors for templates (generic)
              meta: { ux_nsq: needSyncQ, hard_require_concrete: !!askApproach }   // ⬅️ 要求具體行動
            });
            replyText = String(out?.text || "").trim();
            replyMeta = out?.meta || {};
            replyLines = Array.isArray(out?.lines) ? out.lines : null;
            // 🆕 帶上來源標籤
            if (out?.source) replyMeta.source = out.source;
            // 🆕 合併 settings.consent 到 debug（準備第三軌觀測）
            try {
              const settings = (await Storage.Settings.get()) || {};
              const consent = settings.cloudHybridConsent || { granted: false, ts: 0, scope: "firebase-ai" };
              replyMeta.debug = Object.assign({}, replyMeta.debug, { consent });
            } catch {}
          } catch (e) {
            console.warn("[SIIHA/BG] generateReply failed, fallback echo:", e?.message);
           replyText = userText ? `You said: “${userText}.” Thanks for sharing.` : "I'm here, listening.";
          }

          // 🔒 是否命中危機鎖（統一早判，後續可短路）
          const crisisLock = !!(replyMeta?.debug?.guardrails?.crisis_lock);

          // ===== 8A) 續聊銜接：保守判定第二輪（⚠️ 危機時停用） =====
          // 規則：有上一輪摘要（≥1）且近 30 分鐘內、且未命中冷卻 → 嘗試接一句
          let leadInUsed = false;
          let leadInLine = null;
          try {
            if (crisisLock) { /* 危機短路：不加 lead-in 以避免雙訊息 */ throw new Error("skip lead-in due to crisis"); }
            const rt = await Storage.Runtime.get();
            const lastUsedAt = Number(rt.leadInCooldownUntil || 0);
            const withinCooldown = lastUsedAt && lastUsedAt > Date.now();
            const hasPrev = (summaries || []).length >= 1;
            const recentEnough = true; // 已由 Continuity.sweepExpired 控制有效期；此處不再重算時間
            if (hasPrev && recentEnough && !withinCooldown) {
              const targetLocale = 'en';
              leadInLine = await pickLeadInLine(targetLocale);
              if (leadInLine) {
                replyText = `${leadInLine} ${replyText}`.trim();
                leadInUsed = true;
                // 冷卻 30 分鐘，避免每輪都觸發
                await Storage.Runtime.patch({ leadInCooldownUntil: Date.now() + 30 * 60 * 1000 });
              }
            }
          } catch (e) {
            console.debug("[SIIHA/BG] lead-in skipped:", e?.message);
          }

          // ===== 8B) 危機短路：只送一則危機回覆 + 顯示卡片/資格 =====
          if (crisisLock) {
            // 危機命中時：保留路由器輸出的完整回覆（d401 模板），不再覆寫成單句。
            // 仍然顯示危機卡/標記資格，維持行為與統計一致。
            try {
              const [activePre] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
              const cards = await loadCrisisCards();
              const card = cards?.[0] || null;
              if (activePre?.id && card) {
                await chrome.tabs.sendMessage(activePre.id, { type: "CRISIS_SHOW", payload: card });
                await Storage.Stats.bump("crisis.shown", dateKeyLocal());
              } else {
                await Storage.Runtime.patch({
                  crisisEligible: true,
                  lastCrisisLockAt: Date.now(),
                  crisisChipDismissed: false
                });
              }
            } catch {}
          }

          // 🆕 若路由器/guardrail 命中危機鎖，宣告「新事件」→ 讓晶片回來
          try {
            if (crisisLock) {
              await Storage.Runtime.patch({
                crisisEligible: true,
                lastCrisisLockAt: Date.now(),
                crisisChipDismissed: false
              });
            }
          } catch {}

          // 🆕 若本輪命中危機鎖：記一次「晶片曝光」（chip）供週趨勢/轉化率使用
          try {
            const crisisLock = !!(replyMeta?.debug?.guardrails?.crisis_lock);
            if (crisisLock) {
              const todayLocal = dateKeyLocal();
              // 晶片曝光次數（同一輪只在這裡 +1；不在前景重複加）
              await Storage.Stats.bumpImmediate("crisis.chip", todayLocal);
            }
          } catch (e) {
            console.debug("[SIIHA/BG] crisis.chip bump skipped:", e?.message);
          }

          // 4) 回寫續聊兩層（以回覆 meta 優先，無則沿用/回退）
          const nextStyle = crisisLock ? "d401" : String(replyMeta?.styleCode || styleCodeHint || "b3c1");
          const nextIntensity = String(tone?.level || quick.level || "mid");
          try { await Storage.Continuity.saveEmotion(nextIntensity, nextStyle); } catch {}
          // 🆕 記下這輪實際使用的 locale（供下一輪回退）
          try { await Storage.Runtime.patch({ lastUsedLocale: "en" }); } catch {}
          // 🆕 寫回 Routing 觀測欄位到 Runtime（Options 面板讀取）
          try {
            const dbg = replyMeta?.debug || {};
            const route_reason =
              (Array.isArray(replyMeta?.reasons) && replyMeta.reasons[0]) ||
              dbg.route_reason ||
              null;
            await Storage.Runtime.patch({
              // 快取最近一次樣式 / 路由理由
              lastStyleCode: nextStyle,
              lastRouteReason: route_reason,
              // debug 面板只讀欄位
              debug: {
                minisum_used: !!dbg.minisum_used,
                triage_used: !!dbg.triage_used,
                styleCode: nextStyle,
                route_reason: route_reason,
                style_id: replyMeta?.style_id || dbg.style_id || null
              }
            });
          } catch (e) {
            console.debug("[SIIHA/BG] runtime debug patch skipped:", e?.message);
          }

          // 超輕摘要來源切換：優先使用「回覆第一句」，失敗才回退到使用者輸入
          const replyFirstLine = Array.isArray(replyLines) ? (replyLines[0] || "") : "";
          const brief = makeUltraBrief(replyFirstLine || userText);
          if (brief) {
            try { await Storage.Continuity.appendDialogSummary(brief); } catch {}
          }

          // 🧹 處理後再做一次惰性清理（確保 TTL/上限）
          try { await Storage.Continuity.sweepExpired(); } catch {}

          // 🆕（可開關）記錄最近 20 筆路徑到 Runtime.lastTurns（僅存 meta，不存原文）
          try {
            const settings = (await Storage.Settings.get()) || DEFAULTS;
            if (settings.devTrackTurns === true) {
              const src = replyMeta?.source || "template";
              // model_state 可從 env 或 debug 兩處擷取（以 env 優先）
              const ms  = replyMeta?.env?.model_state || replyMeta?.debug?.model_state || "none";
              const crisis = !!(replyMeta?.debug?.guardrails?.crisis_lock);
              await Storage.Runtime.append("lastTurns", {
                ts: new Date().toISOString(),
                source: src,
                style: String(nextStyle),
                crisis_lock: crisis,
                model_state: ms
              }, { cap: 20 });
            }
          } catch (e) {
            console.debug("[SIIHA/BG] lastTurns append skipped:", e?.message);
          }

          // 5) 回傳 UI（可攜帶 styleCode 供薄 UI 做主題微承接）
          // —— 在發送前做一次「固定套話」去重：與上一輪前兩句過高相似就剔除
          try {
            const rt4 = await Storage.Runtime.get();
            const prevHead = Array.isArray(rt4?.prevReplyHead) ? rt4.prevReplyHead : [];
            const split = (s) => String(s||"").split(/[\r\n]+|(?<=[。！？!?\.])\s+/).map(x=>x.trim()).filter(Boolean);
            let linesNow = split(replyText);
            // 過濾固定套話
            linesNow = linesNow.filter(l => !GENERIC_PHRASES.some(re=>re.test(l)));
            // 與上一輪前兩句做簡單 Jaccard 去重
            const head = prevHead.slice(0,2);
            const deduped = [];
            for (const ln of linesNow) {
              const sim = head.length ? Math.max(...head.map(h => jaccardOverlap(ln, h))) : 0;
              if (sim < 0.80) deduped.push(ln);
            }
            if (deduped.length) replyText = deduped.join(" ");
            // 更新本輪 head（存前兩句）
            const newHead = split(replyText).slice(0,2);
            await Storage.Runtime.patch({ prevReplyHead: newHead });
          } catch {}
          
          // 🔒 危機雙保險：SW 層強制覆寫 source 為 template（與 d401 一致）
          try {
            if (crisisLock) replyMeta.source = "template";
            // 補寫 Router 決策可觀測欄位（若 orchestrator 已帶入則覆蓋/合併）
            replyMeta.debug = Object.assign({}, replyMeta.debug || {}, {
              lead_in_used: !!leadInUsed,
              crisis_delay_ms: null
            });
          } catch {}
          // 🧪 追加：在 SW console 顯示「桶分 + 實際樣式」追蹤
          try {
            console.debug("[SIIHA/BG] reply trace", {
              pacing_mode: replyMeta?.debug?.pacing_mode || null,
              length_bucket: replyMeta?.debug?.length_bucket || null,
              style_id: replyMeta?.debug?.style_id || replyMeta?.style_id || null,
              styleCode: replyMeta?.styleCode || nextStyle,
              variantKey: replyMeta?.variantKey || null,
              source: replyMeta?.source || "template"
            });
          } catch {}
          
          // === SW console snapshot (moved from content tooltip): log routing/meta before sending reply ===
          try {
            const dbg = replyMeta.debug || {};
            const snap = {
              source: replyMeta.source || "template",
              model_backend: dbg.model_backend || "local",
              latency_ms: Number(dbg.latency_ms || 0),
              parse_ok: !!dbg.parse_ok,
              errorStage: dbg.errorStage || null,
              style_id: (replyMeta.styleCode || replyMeta.style_id || "-"),
              consent_granted: (dbg.consent && dbg.consent.granted === true) ? true : false,
              model_state: dbg.model_state || (replyMeta.env && replyMeta.env.model_state) || "unknown",
              crisis_lock: !!(dbg.guardrails && dbg.guardrails.crisis_lock)
            };
            console.groupCollapsed("[SIIHA/SW] Routing snapshot");
            console.table(snap);
            // Minimal telemetry: shortcodes only
            console.debug("[SIIHA/SW] sig", { tags: Array.from(tags) });
            console.debug("[SIIHA/SW] gate", { p1: gateP1 ? 1 : 0 });
            console.debug("[SIIHA/SW] k", { top_n: (Array.isArray(kTop)?kTop.length:0) });
            console.debug("[SIIHA/SW] debug", dbg);
            console.groupEnd();
          } catch {}

          const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });                
          if (active?.id) {
            await chrome.tabs.sendMessage(active.id, {
              type: "CHAT_REPLY",
              text: replyText,
              // 🆕 將來源與 debug 帶給 UI（dev-only 可顯示）
              meta: { 
                styleCode: nextStyle, intensity: nextIntensity,
                source: replyMeta?.source || "template",
                debug: replyMeta?.debug || null,
                // 🆕 回傳這輪語言（完整 locale + 引擎用的簡碼）
                locale: "en",
                lang: "en",
                // 🆕 夾帶 env（前景優先讀 meta.env.model_state）
                env: { model_state: (env && env.model_state) ? env.model_state : null },
                // shortcodes forwarded to UI (dev tooltip may show counts only)
                sig: Array.from(tags),
                gate: gateP1 ? { p1: { on: true, n: 3 } } : { },
                k: { top: kTop },
                ux: { nsq: !!needSyncQ }
              }
            });
          } else {
            console.debug("[SIIHA/BG] no active tab to send CHAT_REPLY.");
          }
          sendResponse({ ok: true, scored: quick, styleCode: nextStyle, summariesCount: summaries.length });
          break;
        }

        // 🧽 清語境：使用者主動開新話題（保留心緒層）
        case "CLEAR_DIALOG": {
          try { await Storage.Continuity.clearDialog(); } catch {}
          // 做一次 sweep，確保回到乾淨語境
          try { await Storage.Continuity.sweepExpired(); } catch {}
          sendResponse({ ok: true, cleared: "dialog" });
          break;
        }

        // ✅ 測試用：直接把一個分數塞進「日彙整(emo) + mood」（繞過聊天）
        case "__DEBUG_PUSH": {
          const score = Number(msg.score);
          if (!isFinite(score)) { sendResponse({ ok:false, error:"bad score" }); break; }
          // 允許多種欄位名稱指定日期；皆為 'YYYY-MM-DD'
          const key = pickDateKeyFromMsg(msg) || dateKeyLocal();

          // 1) 寫入 emo（舊日彙整，提供週趨勢用）
          const recEmo = await Storage.Stats.emo.bumpImmediate(score, key);

          // 2) 依分數推導 level，並寫入 mood（低迷判定與 options 顯示用）
          const level = score >= 3.6 ? "high" : (score >= 2.1 ? "mid" : "low");
          await Storage.Mood.appendImmediate(score, level, key);

          sendResponse({ ok:true, pushed: score, key, avg: recEmo.avg, count: recEmo.count });
          break;
        }

        // === 預設 ===
        default: {
          console.debug("[SIIHA/BG] (default) got raw message:", msg);
          sendResponse({ ok: true, notice: "unhandled" });
        }
      } // <-- ✅ 收尾 switch

    } catch (e) {
      console.error("[SIIHA/BG] onMessage error:", e);
      try { sendResponse({ ok: false, error: String(e) }); } catch {}
    }
  })();
  return true; // keep channel open for async
});

// === Helpers ===
// 極簡本地評分：命中一些焦慮/崩潰詞就拉高分；沒命中給低分
function localQuickScore(text = "") {
  const t = (text || "").toLowerCase();
  const hi = /(panic|anxiety|崩潰|心悸|害怕|恐慌|快不行|受不了)/i.test(t);
  const mid = /(stress|壓力|累|煩|焦慮|難受)/i.test(t);
  const score = hi ? 4.5 : mid ? 3.2 : 1.2;
  const level = score >= 3.6 ? "high" : score >= 2.1 ? "mid" : "low";
  return { level, score };
}

async function ensureDefaults() {
  // 由 Storage 自動建立/補齊
  await Storage.Settings.ensureDefaults();
  await Storage.Runtime.ensure();
}

async function scheduleAlarm(reason = "unknown", settingsOverride = null) {
  const settings = settingsOverride || (await Storage.Settings.get()) || DEFAULTS;
  // 🆕 主開關為 off：清除並返回
  if (settings.restMode === "off") {
    await chrome.alarms.clear(ALARM_MAIN);
    await chrome.alarms.clear(ALARM_SNOOZE);
    console.log("[SIIHA/BG] scheduleAlarm skipped (restMode=off).", { reason });
    return;
  }  
  await chrome.alarms.clear(ALARM_MAIN);
  await chrome.alarms.create(ALARM_MAIN, {
    delayInMinutes: settings.remindMinutes,
    periodInMinutes: settings.remindMinutes
  });
  const all = await chrome.alarms.getAll();
  console.log("[SIIHA/BG] scheduleAlarm:", { reason, settings, alarms: all });
}

// === 🕛 Weekly reset (every Monday midnight) ===
const ALARM_WEEKLY_RESET = "siiha-weekly-reset";

// 安裝與啟動時排程下週一 00:00
async function scheduleWeeklyReset() {
  await chrome.alarms.clear(ALARM_WEEKLY_RESET);
  const now = new Date();
  const next = new Date(now);
  next.setDate(now.getDate() + ((8 - now.getDay()) % 7)); // 下個週一
  next.setHours(0, 0, 0, 0);

  const delay = (next.getTime() - now.getTime()) / 60000; // 轉分鐘

  await chrome.alarms.create(ALARM_WEEKLY_RESET, {
    delayInMinutes: delay,
    periodInMinutes: 10080 // 7 天
  });
  console.log("[SIIHA/BG] Weekly reset scheduled:", next.toLocaleString());
}

// === Crisis helpers ===
async function loadCrisisCards() {
  try {
    const url = chrome.runtime.getURL("src/data/crisis_local.json");
    const res = await fetch(url);
    return await res.json();
  } catch (e) {
    console.error("[SIIHA/BG] failed to load crisis cards:", e);
    return [];
  }
}

// Supplemental/Responding template pickers (lead-in & warm-hold)
async function loadSupplementalPools() {
  try {
    const url = chrome.runtime.getURL("src/data/supplementalTemplates.json");
    const res = await fetch(url);
    const js = await res.json();
    // flatten first pack only (current schema)
    const pack = (js?.packs || [])[0] || {};
    return pack.pools || {};
  } catch (e) {
    console.warn("[SIIHA/BG] loadSupplementalPools failed:", e?.message);
    return {};
  }
}

async function loadRespondingTemplates() {
  try {
    const url = chrome.runtime.getURL("src/logic/respondingTemplates.json");
    const res = await fetch(url);
    return await res.json();
  } catch (e) {
   console.warn("[SIIHA/BG] loadRespondingTemplates failed:", e?.message);
    return null;
  }
}

function pickFromArray(arr = []) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[randInt(0, arr.length - 1)];
}

async function pickLeadInLine(_targetLocale = "en") {
  const pools = await loadSupplementalPools();
  const key = "ph.en.pool";
  const bag = pools[key]?.pool;
  return pickFromArray(bag) || null;
}

async function pickWarmHoldLine(_targetLocale = "en") {
  const tpl = await loadRespondingTemplates();
  const t = tpl?.templates?.wh;
  if (!t) return null;
  return t["en"]?.line || null;
}

// === Grounding helpers ===
async function loadGroundingPacks() {
  try {
    const url = chrome.runtime.getURL("src/data/grounding_local.json");
    const res = await fetch(url);
    const js = await res.json();
    // schema: { units:[...] } → normalize to packs[]
    const packs = normalizeUnitsToPacks(js?.units || []);
    return packs;
  } catch (e) {
    console.warn("[SIIHA/BG] loadGroundingPacks failed:", e?.message);
    return [];
  }
}

function normalizeUnitsToPacks(units = []) {
  const msToSec = (n) => Math.round((Number(n)||0)/1000);
  return units.map(u => {
    if (u.kind === "breath") {
      const oneCycle = (Array.isArray(u.beats)?u.beats:[]).map(b=>{
        const secs = msToSec(b.ms||0);
        const hint = secs ? ` (${secs}s)` : "";
        return `${b.label}${hint}`;
      });
      const loops = Math.max(1, Number(u.loops||1));
      const steps = Array.from({length:loops}).flatMap(()=> oneCycle);
      return {
        id: u.id, label: u.label, duration_s: Number(u.duration_s||0),
        kind: "breath",
        intro: u.intro || "We’ll do gentle cycles. Adjust pace if you need.",
        guidance: `Follow the labels at your pace.${loops>1?` We’ll do ${loops} cycles.`:" When you finish one cycle, tap Next."}`,
        steps,
        outro: Array.isArray(u.outro)?u.outro:[]
      };
    }
    const steps = (Array.isArray(u.steps)?u.steps:[]).map(s=> String(s.text||"").trim()).filter(Boolean);
    const cadence = Number(u.cadence_ms||0);
    return {
      id: u.id, label: u.label, duration_s: Number(u.duration_s||0),
      kind: "senses",
      intro: u.intro || "Tiny check-in. Nothing to fix.",
      guidance: `Read the line once, then tap Next.${cadence?` (~${Math.round(cadence/1000)}s each)`:``}`,
      steps,
      outro: Array.isArray(u.outro)?u.outro:[]
    };
  });
}

// 選擇可投遞的分頁（優先 active(http/https) → 目前視窗其他 http/https → 其他視窗）
async function pickDeliverableTab(verbose = false) {
  // 1) 試目前視窗的 active tab
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  // 🧩 Gmail iframe 特例：避開 mail.google.com
  const isBlockedHost = (url) => /mail\.google\.com/.test(url || "");
  if (active && HTTP_OK(active) && !isBlockedHost(active.url)) {
    if (verbose) console.debug("[SIIHA/BG] pick: active http tab in current window", { id: active.id, url: active.url });
    return active;
  }
  // 若 Gmail 被選為唯一 active 頁面 → 嘗試其他分頁
  if (active && isBlockedHost(active.url)) {
    console.debug("[SIIHA/BG] skip Gmail iframe; looking for alternate tab");
  }
  // 2) 試目前視窗的其他 http/https tab
  const tabsLF = await chrome.tabs.query({ lastFocusedWindow: true });
  const candLF = tabsLF.filter(HTTP_OK);
  if (candLF.length) {
    if (verbose) console.debug("[SIIHA/BG] pick: http tab in current window", { id: candLF[0].id, url: candLF[0].url });
    return candLF[0];
  }
  // 3) 試所有視窗的 http/https tab（優先那些 active 的）
  const all = await chrome.tabs.query({});
  const candAll = all.filter(HTTP_OK);
  if (candAll.length) {
    const activeAny = candAll.find(t => t.active);
    const chosen = activeAny || candAll[0];
    if (verbose) console.debug("[SIIHA/BG] pick: http tab in other window", { id: chosen.id, url: chosen.url });
    return chosen;
  }
  if (verbose) console.debug("[SIIHA/BG] pick: no http/https tab found");
  return null;
}

// ===============================
// === 三日低迷門檻：資料與規則 ===
// ===============================

// 1) 輕量詞典評分（0~5）：low < 2.1 <= mid < 3.6 <= high
function scoreTextForMood(text) {
  const s = (text || "").trim();
  if (!s) return { score: 0, level: "low" };
  const hit = (reArr) => reArr.some(re => re.test(s));
  const L = {
    high: [
      /自殺|不想活|活不下去|suicid(e|al)|kill myself/i,
      /崩潰|絕望|panic|break(ing)? down/i,
      /去死|死亡|die/i,
    ],
    mid: [
      /焦慮|anx(ious|iety)|心悸|壓力|失眠/i,
      /低落|難過|sad|depressed?/i,
      /倦|疲憊|burn(ed)?\s?out|tired/i,
    ]
  };
  let score = 0;
  if (hit(L.high)) score += 4.2;
  if (hit(L.mid)) score += 2.6;
  if (s.length > 40) score += 0.3;
  if (/[!?]{2,}/.test(s)) score += 0.2;
  score = Math.max(0, Math.min(5, Number(score.toFixed(2))));
  const level = score >= 3.6 ? "high" : (score >= 2.1 ? "mid" : "low");
  return { score, level };
}

// 3) 連續三日低迷判定：
//    當日低迷 = (avgScore >= 3) 或 (highCount >= 2)
async function runThreeDayRollup(source = "manual") {
  // 單一真相：委託 Storage.Mood.rollupLast3()
  const st = await Storage.Mood.rollupLast3();
  console.log("[SIIHA/BG] Low-mood rollup(%s): eligible=%s", source, !!st.crisisEligible);
  return { eligible: !!st.crisisEligible, streak: (st.last3 || []).length, last3: st.last3 };
}

// 6) 本地午夜排程
async function scheduleMidnightRollup() {
  await chrome.alarms.clear(ALARM_MIDNIGHT);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5); // 00:00:05
  await chrome.alarms.create(ALARM_MIDNIGHT, { when: next.getTime() });
  console.log("[SIIHA/BG] Midnight roll-up scheduled:", next.toLocaleString());
}

// 4) 取狀態（交由 Storage.Mood.status 單一口徑）
async function getLowMoodStatusLocal() {
  return await Storage.Mood.status();
}

// 小工具：從除錯訊息取出日期 key（支援多種欄位），回傳 'YYYY-MM-DD' 或 null
function pickDateKeyFromMsg(msg = {}) {
  const raw = msg.date || msg.dateOverride || msg.day || msg.key;
  if (!raw || typeof raw !== "string") return null;
  const k = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(k) ? k : null;
}

// 取第一句/主要子句，去除多餘空白與包引號，限制長度（不存全文）
function makeUltraBrief(s = "", max = 80) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const first = t.split(/(?<=[。！？!?｡]|\.|\?|!|;|；)/)[0] || t;
  const cleaned = first.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

// ===============================
// === DEV Bridge for SW Console ==
// ===============================
// SW Console 直接測：
//   await __SIIHA_DEV.envCheck()
//   await __SIIHA_DEV.detectTone("i feel anxious", { mode:"auto", env: await __SIIHA_DEV.envCheck() })
//   await __SIIHA_DEV.generateReply({ youSaid:"These days feel heavy.", lang:"en", audience:"ext" })
globalThis.__SIIHA_DEV = {
  envCheck,
  detectTone,
  generateReply: orchestratedGenerateReply
};