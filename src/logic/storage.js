// SIIHA — Unified Storage Layer (local/session)
// - Single entry for all storage access across SW / UI / Content
// - Namespaces: settings / runtime / stats / mood / prefs / ui / chat / continuity
// - Includes schema versioning + lightweight migration for old keys
// - All methods are Promise-based
// ⚠️ Immediate-write mode: 避免 MV3 Service Worker 休眠吞寫入，所有 set/merge 均改為「立即落地」。

const SCHEMA_VERSION = 5;

// ---- helpers ----
function extAlive() {
  try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
  catch { return false; }
}

const nowTs = () => Date.now();
// Use **local timezone** for calendar keys to match user-visible days
const _pad2 = (n) => (n < 10 ? "0" + n : "" + n);
const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`;
const dayKeyOffset = (base = new Date(), offsetDays = 0) => {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays);
  return dayKey(d);
};
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

function _area(area = "local") {
  try {
    if (!extAlive()) throw new Error("Extension context invalidated");
    return area === "session" ? chrome.storage.session : chrome.storage.local;
  } catch (e) {
    // 安全 shim：避免呼叫端爆掉
    return {
      get: (_k, cb) => cb && cb({}),
      set: (_o, cb) => cb && cb(),
      remove: (_k, cb) => cb && cb(),
    };
  }
}

async function _getRaw(keys, area = "local") {
  try {
    if (!extAlive()) return {};
    const a = _area(area);
    return await new Promise((resolve) => a.get(keys, resolve));
  } catch (e) {
    console.warn("[Storage] get error", e);
    return {};
  }
}

async function _setRaw(obj, area = "local") {
  try {
    if (!extAlive()) return;
    const a = _area(area);
    await new Promise((resolve) => a.set(obj, resolve));
  } catch (e) {
    console.warn("[Storage] set error", e, obj);
  }
}

async function _removeRaw(keys, area = "local") {
  try {
    if (!extAlive()) return;
    const a = _area(area);
    await new Promise((resolve) => a.remove(keys, resolve));
  } catch (e) {
    console.warn("[Storage] remove error", e, keys);
  }
}

// ⛔️（保留原結構以相容舊呼叫，但不再使用佇列/coalescing）
const _pending = { local: null, session: null };
const _queue = { local: {}, session: {} };
async function _flush(_area) { /* no-op in immediate mode */ }
function _mergeToQueue(_patch, _area) { /* no-op in immediate mode */ }

// deep-ish merge (1-level)
function _mergeObj(base, patch) {
  if (!base) return patch;
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    const pv = patch[k];
    if (pv && typeof pv === "object" && !Array.isArray(pv)) {
      out[k] = { ...(out[k] || {}), ...pv };
    } else {
      out[k] = pv;
    }
  }
  return out;
}

function _safe(obj, fallback) {
  return obj && typeof obj === "object" ? obj : fallback;
}

// observe utility
function _observe(filter, handler, area = "local") {
  const aName = area === "session" ? "session" : "local";
  const isPrefix = typeof filter === "string" && filter.endsWith("*");
  const prefix = isPrefix ? filter.slice(0, -1) : null;
  const keys = Array.isArray(filter) ? new Set(filter) : null;

  function onChanged(changes, ns) {
    if (ns !== aName) return;
    const hits = {};
    for (const k of Object.keys(changes)) {
      if (keys && keys.has(k)) hits[k] = changes[k];
      else if (isPrefix && k.startsWith(prefix)) hits[k] = changes[k];
      else if (!keys && !isPrefix && k === filter) hits[k] = changes[k];
    }
    if (Object.keys(hits).length) handler(hits);
  }
  chrome.storage.onChanged.addListener(onChanged);
  return () => chrome.storage.onChanged.removeListener(onChanged);
}

// ---- schema & migration ----
const DEFAULTS = {
  // 👉 Align settings with extension UI/SW expectations
  settings: {
    remindMinutes: 60,
    snoozeMinutes: 15,
    hybridEnabled: false,
    // 🆕 開發期：是否記錄最近路徑（SW 讀用）
    devTrackTurns: true,
    // 🆕 休息提醒主開關與重啟行為（與 SW / Options 對齊）
    // "off" | "periodic"
    restMode: "periodic",
    // "immediate" | "fixed"
    restartMode: "immediate",
    // 🆕 雲端混合（Firebase AI）顯式同意留位
    cloudHybridConsent: { granted: false, ts: 0, scope: "firebase-ai" },
    // 🧘 Grounding（Options 控制）
    // 記憶偏好：會把使用者最後一次選的秒數寫入 Prefs.groundingPreferredDuration
    groundingRememberPref: true,
    groundingCooldownMinutes: 5,
  },
  runtime: {
    lastNudgeAt: 0,
    lastCrisisAction: [],
    crisisEligible: false,
    // 🆕 最近一次危機鎖時間（毫秒）
    lastCrisisLockAt: 0,
    // 🆕 上次實際使用的完整語系（例如 "en-US"）；僅觀測，不驅動路由
    lastUsedLocale: null,
    // 🆕 路由器觀測（上次 pacing 與版本）
    lastPacingMode: null,
    lastRouterVersion: null,    
    muteDate: null,
    snoozeUntil: null,
    // 🆕 續聊承接冷卻（毫秒時間戳）；供 SW 判斷是否暫停 lead-in
    leadInCooldownUntil: 0,
    // 🧘 Grounding 短生命狀態
    groundingCooldownUntil: 0,   // timestamp(ms)
    lastGroundingAt: 0,          // timestamp(ms)
    // 🆕 Gate：短碼欄位（gate.p1）— Presence Lock 倒數
    gate: {
      p1: { on: false, turns_left: 0, since: 0 }
    },
    // 🆕 Act：動作冷卻（以 ID 短碼為 key，例如 "12a"）
    act: {
      cooldown: {} // { [actionKey: string]: number(ts) }
    },
    // 🆕 k.top：內容錨定短語（thread-local，不落 UI）
    k: {
      top: [] // string[]
    },
    // 🆕 修復手觸發旗標（短碼命名避免語義外露）
    fix: {
      fired: false
    },
    // 🆕 route.src：樣式被誰強制（短碼：ur|rj|na 等）
    route: {
      src: ""
    },
    // 🆕 最近一次使用者明確意圖（短碼：listen|advice|ground）
    lastIntent: null,
    // 🆕 Advice 2+1 鎖定狀態
    advice: { on: false, since: 0, turnsLeft: 0 }, // turnsLeft: 2 → 2+1 模式
    // 🆕 ask latch（自然語「advice/steps」時黏著 90s）
    askLatchUntil: 0
  },
  stats: {
    // days: { [YYYY-MM-DD]: { nudges:{shown,snooze,mute,accept}, crisis:{shown,accept,dismiss,chip,chip_click}, chat:{turns,sessions}, emo:{sum,count,avg} } }
    days: {},
  },
  mood: {
    // days: { [YYYY-MM-DD]: { avgScore, highCount, midCount, lowCount, count } }
    days: {},
  },
  prefs: {
    // Used by promptClient.js
    modePreference: null,  // "local" | "demo" | null
    toneTimeoutMs: 1600,
    // 🌐 Default reply language (internal: 'en')
    languagePref: "en",    
    // 🆕 是否保留「今日聊天 HTML 預覽」（預設關閉以避免存全文）
    persistChatHtmlToday: false,
    // 🆕 麵包屑顯示偏好（承接列）
    breadcrumbHidden: false,
    // 🆕 隱私告知是否已讀
    privacyBannerSeen: false,
    // 🧘 使用者偏好：Grounding 時長（秒），若未設定則為 null
    groundingPreferredDuration: null,
  },
  ui: {
    // Floater expects 4-corner anchors: "lt" | "rt" | "lb" | "rb"
    anchorMode: "rb",
    // Prefer right/bottom as defaults so floater clamps correctly
    position: { right: 16, bottom: 16 },
    zBase: 300,
  },
  chat: {
    today: { date: "", html: "" },
  },
  // 🆕 Continuity
  continuity: {
    lastEmotion: null,
    emotionLineId: null,
    lastLeadInAt: 0,
    lastDialog: [],
    recentTurnKinds: [],    
  },
  __meta__: {
    schemaVersion: SCHEMA_VERSION,
    migratedAt: 0,
  },
};

// ---- small helpers (local to prefs) ----
function _normalizeLangPref(v) {
  return "en";
}

async function _ensureSchema() {
  const raw = (await _getRaw(Object.keys(DEFAULTS))) || {};
  const meta = _safe(raw.__meta__, {});
  const ver = Number(meta.schemaVersion || 0);

  // First-install defaults:
  if (!ver) {
    const seed = {};
    for (const k of Object.keys(DEFAULTS)) seed[k] = DEFAULTS[k];
    seed.__meta__ = { schemaVersion: SCHEMA_VERSION, migratedAt: nowTs() };
    await _setRaw(seed);
    await _migrateOldKeys(); // just in case existing loose keys exist
    return;
  }

  // Bump version in future migrations:
  if (ver < SCHEMA_VERSION) {
    // 更新版本與補齊 runtime 新增欄位（merge 而非覆蓋）
    try {
      const curRt = (await _getRaw(["runtime"])).runtime || {};
      const mergedRt = _mergeObj(DEFAULTS.runtime, curRt);
      await _setRaw({ runtime: mergedRt });
    } catch {}
    await _setRaw({ __meta__: { schemaVersion: SCHEMA_VERSION, migratedAt: nowTs() } });
  }

  // Ensure missing top-level namespaces exist
  const patch = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (raw[k] == null) patch[k] = DEFAULTS[k];
  }
  if (Object.keys(patch).length) await _setRaw(patch);
  // opportunistic migration of loose keys
  await _migrateOldKeys();
}

async function _migrateOldKeys() {
  // Move legacy UI/chat keys into new namespaces if present.
  const legacy = await _getRaw(["siihaChat", "siihaZBase", "siihaAnchorMode", "siihaPosition"]);
  const patch = {};

  if (legacy.siihaChat) {
    patch.chat = _mergeObj((await _getRaw(["chat"])).chat || DEFAULTS.chat, {
      today: legacy.siihaChat,
    });
    await _removeRaw(["siihaChat"]);
  }
  if (legacy.siihaZBase != null) {
    const ui = (await _getRaw(["ui"])).ui || DEFAULTS.ui;
    patch.ui = _mergeObj(ui, { zBase: legacy.siihaZBase });
    await _removeRaw(["siihaZBase"]);
  }
  if (legacy.siihaAnchorMode) {
    const ui = (await _getRaw(["ui"])).ui || DEFAULTS.ui;
    patch.ui = _mergeObj(patch.ui || ui, { anchorMode: legacy.siihaAnchorMode });
    await _removeRaw(["siihaAnchorMode"]);
  }
  if (legacy.siihaPosition) {
    const ui = (await _getRaw(["ui"])).ui || DEFAULTS.ui;
    patch.ui = _mergeObj(patch.ui || ui, { position: legacy.siihaPosition });
    await _removeRaw(["siihaPosition"]);
  }
  if (Object.keys(patch).length) await _setRaw(patch);
}

// ---- public base API ----
const Base = {
  async get(key, area = "local") {
    const obj = await _getRaw([key], area);
    return obj[key];
  },
  async getMany(keys, area = "local") {
    return await _getRaw(keys, area);
  },
  // Immediate writes (MV3-safe)
  async set(key, value, area = "local") {
    await _setRaw({ [key]: value }, area);
  },
  async setMany(obj, area = "local") {
    await _setRaw(obj, area);
  },
  // 👉 Immediate variant retained for API compatibility
  async setImmediate(key, value, area = "local") {
    await _setRaw({ [key]: value }, area);
  },
  async merge(key, partial, area = "local") {
    const cur = await Base.get(key, area);
    const next = _mergeObj(cur || {}, partial || {});
    await _setRaw({ [key]: next }, area);
    return next;
  },
  async mergeImmediate(key, partial, area = "local") {
    const cur = await Base.get(key, area);
    const next = _mergeObj(cur || {}, partial || {});
    await _setRaw({ [key]: next }, area);
    return next;
  },
  async remove(key, area = "local") {
    await _removeRaw([key], area);
  },
  observe(filter, handler, area = "local") {
    return _observe(filter, handler, area);
  },
  // Flush kept for backward-compat; immediate mode makes this a no-op
  async flush(area = "local") {
    return;
  },
  async flushAll() {
    return;
  },
  async clearAllSafe() {
    // conservative clear: do not nuke settings/prefs; reset stats/mood/runtime/chat/ui position
    const raw = await _getRaw(Object.keys(DEFAULTS));
    const patch = {
      stats: DEFAULTS.stats,
      mood: DEFAULTS.mood,
      runtime: DEFAULTS.runtime,
      chat: DEFAULTS.chat,
      ui: _mergeObj(raw.ui || DEFAULTS.ui, { position: DEFAULTS.ui.position }),
    };
    await _setRaw(patch);
  },
};

// ---- subdomains ----

// Settings
const Settings = {
  async get() {
    return (await Base.get("settings")) || DEFAULTS.settings;
  },
  async set(next) {
    // sanitize: ensure muteDate never resides under settings
    const merged = _mergeObj(DEFAULTS.settings, next || {});
    if ("muteDate" in merged) delete merged.muteDate;
    await Base.set("settings", merged);
  },
  async patch(partial) {
    // sanitize on patch as well
    const p = { ...(partial || {}) };
    if ("muteDate" in p) delete p.muteDate;
    return await Base.merge("settings", p);    
  },
  async ensureDefaults() {
    const cur = await Settings.get();
    if (!cur || typeof cur !== "object") await Settings.set(DEFAULTS.settings);
    return await Settings.get();
  },
};

// Runtime
const Runtime = {
  async get() {
    return (await Base.get("runtime")) || DEFAULTS.runtime;
  },
  // Ensure runtime object & required fields exist (idempotent)
  async ensure() {
    const cur = (await Base.get("runtime")) || {};
    const merged = _mergeObj(DEFAULTS.runtime, cur);
    await Base.set("runtime", merged);
    return merged;
  },
  async patch(partial) {
    return await Base.merge("runtime", partial || {});
  },
  async append(listKey, item, opts = { cap: 50 }) {
    const rt = await Runtime.get();
    const arr = Array.isArray(rt[listKey]) ? rt[listKey].slice(0) : [];
    arr.unshift(item);
    const cap = clamp(Number(opts.cap || 50), 1, 2000);
    while (arr.length > cap) arr.pop();
    await Runtime.patch({ [listKey]: arr });
    return arr;
  },
  // 🆕 前景/Options 訂閱 runtime 變更（封裝 chrome.storage.onChanged）
  // 回傳取消函式：const un = Storage.Runtime.subscribe(cb); un();
  subscribe(cb) {
    if (typeof cb !== "function") return () => {};
    // 只過濾 runtime 這個 key
    const un = Base.observe("runtime", async (changes) => {
      try {
        // 優先拿 change 的 newValue；沒有就讀一次
        const next = changes?.runtime?.newValue || (await Runtime.get());
        cb(next);
      } catch { /* noop */ }
    });
    return un;
  },
};

// Stats (daily buckets)
function _ensureDay(stats, dk) {
  stats.days = stats.days || {};
  const cur = stats.days[dk] || {};
  stats.days[dk] = {
    // 🆕 nudges.accept：記錄「I’ll rest now」的接受次數
    nudges: { shown: 0, snooze: 0, mute: 0, accept: 0, ...(cur.nudges || {}) },
    // 🆕 危機：加入 chip（晶片觸發量）與 chip_click（晶片被點擊量）；舊資料自動補 0
    crisis: { shown: 0, accept: 0, dismiss: 0, chip: 0, chip_click: 0, ...(cur.crisis || {}) },
    // 🧘 Grounding：開啟/完成/出口與來源拆解
    grounding: {
      open: 0,
      done: 0,
      exit: { ok: 0, bit_better: 0, not_much: 0, ...((cur.grounding || {}).exit || {}) },
      from: { crisis: 0, dialog: 0, ...((cur.grounding || {}).from || {}) },
      // 保留其他舊欄位
      ...Object.fromEntries(Object.entries(cur.grounding || {}).filter(([k]) => !["exit","from","open","done"].includes(k)))
    },    
    chat: { turns: 0, sessions: 0, ...(cur.chat || {}) },
    emo: { sum: 0, count: 0, avg: 0, ...(cur.emo || {}) },
  };
  return stats.days[dk];
}

const Stats = {
  async getAll() {
    return (await Base.get("stats")) || DEFAULTS.stats;
  },
  async clear() {
    await Base.set("stats", DEFAULTS.stats);
  },
  async resetWeekly() {
    const stats = await Stats.getAll();
    stats.days = {};
    await Base.set("stats", stats);
  },
  async bump(kind, dk = dayKey()) {
    const stats = await Stats.getAll();
    const bucket = _ensureDay(stats, dk);
    const parts = String(kind).split(".");
    if (parts.length === 2) {
      const [a, b] = parts;
      bucket[a] = bucket[a] || {};
      bucket[a][b] = Number(bucket[a][b] || 0) + 1;
    } else if (parts.length === 3) {
      const [a, b, c] = parts;
      bucket[a] = bucket[a] || {};
      // ensure second level object
      if (typeof bucket[a][b] !== "object" || Array.isArray(bucket[a][b])) {
        bucket[a][b] = {};
      }
      bucket[a][b][c] = Number(bucket[a][b][c] || 0) + 1;
    } else {
      // fallback: treat whole string as a flat counter under "misc"
      bucket.misc = bucket.misc || {};
      bucket.misc[kind] = Number(bucket.misc[kind] || 0) + 1;
    }
    await Base.set("stats", stats);
    return stats.days[dk];
    },
  bumpImmediate: async (kind, dk = dayKey()) => {
    const stats = await Stats.getAll();
    const bucket = _ensureDay(stats, dk);
    const parts = String(kind).split(".");
    if (parts.length === 2) {
      const [a, b] = parts;
      bucket[a] = bucket[a] || {};
      bucket[a][b] = Number(bucket[a][b] || 0) + 1;
    } else if (parts.length === 3) {
      const [a, b, c] = parts;
      bucket[a] = bucket[a] || {};
      if (typeof bucket[a][b] !== "object" || Array.isArray(bucket[a][b])) {
        bucket[a][b] = {};
      }
      bucket[a][b][c] = Number(bucket[a][b][c] || 0) + 1;
    } else {
      bucket.misc = bucket.misc || {};
      bucket.misc[kind] = Number(bucket.misc[kind] || 0) + 1;
    }
    await Base.setImmediate("stats", stats);
    return stats.days[dk];
  },    
  emo: {
    async bump(score, dk = dayKey()) {
      const s = Number(score) || 0;
      const stats = await Stats.getAll();
      const bucket = _ensureDay(stats, dk);
      bucket.emo.sum += s;
      bucket.emo.count += 1;
      bucket.emo.avg = bucket.emo.count ? bucket.emo.sum / bucket.emo.count : 0;
      await Base.set("stats", stats);
      return bucket.emo;
    },
    bumpImmediate: async (score, dk = dayKey()) => {
      const s = Number(score) || 0;
      const stats = await Stats.getAll();
      const bucket = _ensureDay(stats, dk);
      bucket.emo.sum += s; bucket.emo.count += 1;
      bucket.emo.avg = bucket.emo.count ? bucket.emo.sum / bucket.emo.count : 0;
      await Base.setImmediate("stats", stats);
      return bucket.emo;
    }    
  },
};

// Mood (3-day rolling low-mood window)
function _ensureMoodDay(mood, dk) {
  mood.days = mood.days || {};
  const cur = mood.days[dk] || {};
  mood.days[dk] = {
    avgScore: cur.avgScore || 0,
    highCount: cur.highCount || 0,
    midCount: cur.midCount || 0,
    lowCount: cur.lowCount || 0,
    count: cur.count || 0,
  };
  return mood.days[dk];
}

function _levelToCounts(level) {
  if (level === "high") return { highCount: 1 };
  if (level === "mid") return { midCount: 1 };
  return { lowCount: 1 };
}

const Mood = {
  async get() {
    return (await Base.get("mood")) || DEFAULTS.mood;
  },
  async clear() {
    await Base.set("mood", DEFAULTS.mood);
  },
  async append(score, level = "mid", dk = dayKey()) {
    const mood = await Mood.get();
    const day = _ensureMoodDay(mood, dk);
    const s = Number(score) || 0;
    day.count += 1;
    const inc = _levelToCounts(level);
    day.highCount += inc.highCount || 0;
    day.midCount += inc.midCount || 0;
    day.lowCount += inc.lowCount || 0;
    // simple running average
    day.avgScore = day.avgScore ? (day.avgScore * (day.count - 1) + s) / day.count : s;
    await Base.set("mood", mood);
    return day;
  },
  async appendImmediate(score, level = "mid", dk = dayKey()) {
    const mood = await Mood.get();
    const day = _ensureMoodDay(mood, dk);
    const s = Number(score) || 0;
    day.count += 1;
    const inc = _levelToCounts(level);
    day.highCount += inc.highCount || 0;
    day.midCount  += inc.midCount  || 0;
    day.lowCount  += inc.lowCount  || 0;
    day.avgScore = day.avgScore ? (day.avgScore * (day.count - 1) + s) / day.count : s;
    await Base.setImmediate("mood", mood);
    return day;
  },
  async clearImmediate() { await Base.setImmediate("mood", DEFAULTS.mood); },
  async status() {
    // Rule: look at the previous three calendar days (exclude today).
    const mood = await Mood.get();
    // Use LOCAL calendar: D-1, D-2, D-3
    const keys = [dayKeyOffset(new Date(), -1), dayKeyOffset(new Date(), -2), dayKeyOffset(new Date(), -3)];
    const last3 = keys.map((k) => {
      const rec = (mood.days || {})[k] || { avgScore: 0, highCount: 0, midCount: 0, lowCount: 0, count: 0 };
      return { day: k, ...rec };
    });
   const isLow = (d) => Number(d.avgScore || 0) >= 3 || Number(d.highCount || 0) >= 2;
    const flags = last3.map(isLow);
    const crisisEligible = flags.every(Boolean);
    return { last3, crisisEligible };
  },
  async rollupLast3() {
    const st = await Mood.status();
    // Also record the last rolled window for debugging
    const lastMoodRollup = (st.last3 || []).map(d => d.day).join(",");
    await Runtime.patch({ crisisEligible: !!st.crisisEligible, lastMoodRollup });
    return st;
  }
};

// Prefs
const Prefs = {
  async get(keys) {
    const all = (await Base.get("prefs")) || DEFAULTS.prefs;
    // ensure languagePref always normalized to 'en'
    if (!all.languagePref) all.languagePref = "en";
    all.languagePref = "en";  
    if (!keys) return all;
    const out = {};
    for (const k of keys) out[k] = all[k];
    return out;
  },
  async patch(partial) {
    const p = { ...(partial || {}) };
    if ("languagePref" in p) {
      p.languagePref = "en";
    }
    return await Base.merge("prefs", p);
  },
};

// UI
const UI = {
  async get() {
    return (await Base.get("ui")) || DEFAULTS.ui;
  },
  async getAnchor() {
    const ui = await UI.get();
    return { anchorMode: ui.anchorMode, position: ui.position };
  },
  async setAnchor(mode, position) {
    const ui = await UI.get();
    await Base.set("ui", _mergeObj(ui, { anchorMode: mode || ui.anchorMode, position: position || ui.position }));
  },
  async getZBase() {
    const ui = await UI.get();
    return ui.zBase || DEFAULTS.ui.zBase;
  },
  async setZBase(z) {
    const ui = await UI.get();
    await Base.set("ui", _mergeObj(ui, { zBase: Number(z) || DEFAULTS.ui.zBase }));
  },
};

// Chat (daily HTML cache)
const Chat = {
  async getToday() {
    const c = (await Base.get("chat")) || DEFAULTS.chat;
    const dk = dayKey();
    if (c.today?.date !== dk) return { date: dk, html: "" };
    return c.today;
  },
  async saveToday(html) {
    const dk = dayKey();
    try {
      const prefs = await Prefs.get(["persistChatHtmlToday"]);
      const allow = !!prefs.persistChatHtmlToday;
      const htmlToStore = allow ? String(html || "") : "";
      await Base.set("chat", { today: { date: dk, html: htmlToStore } });
    } catch {
      await Base.set("chat", { today: { date: dk, html: "" } });
    }
  },
  async clearIfNewDay() {
    const cur = await Chat.getToday();
    const dk = dayKey();
    if (cur.date !== dk) await Base.set("chat", { today: { date: dk, html: "" } });
  },
};

// ---- Continuity (續聊層) ----
// TTL 與上限（可依需要在未來搬到設定檔；此處以常數管理）
const EMO_TTL_HOURS = 24;
const DIALOG_TTL_HOURS = 12;
const CONTEXT_MAX_ROUNDS = 3;

function _ms(hours) { return Math.max(0, Number(hours || 0)) * 60 * 60 * 1000; }

// 摘要標準化：去頭尾空白/多空白、收斂尾端連續標點、輕度長度限制
function _normalizeSummary(s = "", max = 80) {
  let t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  // e.g. "。！！" → "。"、"!!" → "!"
  t = t.replace(/[。！？!?｡.!?;；]+$/u, (m) => m[0]);
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

async function _getContinuity() {
  return (await Base.get("continuity")) || DEFAULTS.continuity;
}

async function _setContinuity(next) {
  await Base.setImmediate("continuity", next);
}

// 惰性清理：在讀/寫時均可呼叫，確保 TTL 生效與上限裁切
async function _sweepContinuity(now = nowTs()) {
  const c = await _getContinuity();
  let changed = false;

  // Emotion TTL
  if (c.lastEmotion && c.lastEmotion.ts) {
    const expired = now - Number(c.lastEmotion.ts) >= _ms(EMO_TTL_HOURS);
    if (expired) { c.lastEmotion = null; changed = true; }
  }

  // Dialog TTL + 上限 3 筆
  if (Array.isArray(c.lastDialog) && c.lastDialog.length) {
    const minTs = now - _ms(DIALOG_TTL_HOURS);
    const pruned = c.lastDialog.filter((d) => Number(d?.t || 0) >= minTs && d?.summary);
    // 保留最新的最多 3 筆
    pruned.sort((a, b) => Number(b.t) - Number(a.t));
    const capped = pruned.slice(0, CONTEXT_MAX_ROUNDS);
    if (capped.length !== c.lastDialog.length ||
        capped.some((v, i) => v !== c.lastDialog[i])) {
      c.lastDialog = capped;
      changed = true;
    }
  }

  // recentTurnKinds 上限 6 筆（不做 TTL）
  if (Array.isArray(c.recentTurnKinds) && c.recentTurnKinds.length > 6) {
    c.recentTurnKinds = c.recentTurnKinds.slice(0, 6);
    changed = true;
  }

  if (changed) await _setContinuity(c);
  return { continuity: c, changed };
}

const Continuity = {
  // 供 SW 在啟動或處理對話前後呼叫
  async sweepExpired() {
    return await _sweepContinuity(nowTs());
  },
  async getRaw() {
    await _sweepContinuity(nowTs());
    return await _getContinuity();
  },
  async saveEmotion(intensity, styleCode) {
    const c = await _getContinuity();
    c.lastEmotion = { intensity: String(intensity || "mid"), styleCode: String(styleCode || ""), ts: nowTs() };
    await _setContinuity(c);
    return c.lastEmotion;
  },
  async loadEmotionIfValid() {
    const { continuity } = await _sweepContinuity(nowTs());
    const e = continuity.lastEmotion;
    if (!e) return null;
    // 回傳最小必要載荷
    return { intensity: e.intensity, styleCode: e.styleCode, ts: e.ts };
  },
  async clearEmotion() {
    const c = await _getContinuity();
    c.lastEmotion = null;
    await _setContinuity(c);
    return true;
  },
  async setEmotionLine(id) {
    const c = await _getContinuity();
    c.emotionLineId = id ? String(id) : null;
    await _setContinuity(c);
    return c.emotionLineId;
  },
  async isSameEmotionLine(id) {
    const { continuity } = await _sweepContinuity(nowTs());
    if (!id) return false;
    return String(continuity.emotionLineId || "") === String(id);
  },
  async saveLeadIn(ts = nowTs()) {
    const c = await _getContinuity();
    c.lastLeadInAt = Number(ts) || nowTs();
    await _setContinuity(c);
    return c.lastLeadInAt;
  },
  async appendDialogSummary(summaryText) {
    const c = await _getContinuity();
    const arr = Array.isArray(c.lastDialog) ? c.lastDialog.slice(0) : [];

    // 入口先標準化；空字串直接回傳原陣列
    const norm = _normalizeSummary(summaryText);
    if (!norm) return arr;

    const now = nowTs();
    const head = arr[0];
    // 若與最近一筆相同 → 僅更新時間戳，不新增
    if (head && _normalizeSummary(head.summary) === norm) {
     head.t = now;
      arr[0] = head;
    } else {
      arr.unshift({ t: now, summary: norm });
    }

    // 排序 + 上限 3
    arr.sort((a, b) => Number(b.t) - Number(a.t));
    c.lastDialog = arr.slice(0, CONTEXT_MAX_ROUNDS);

    await _setContinuity(c);
    // TTL 惰性清理：立即把超時的剔除，保守再次裁切
    await _sweepContinuity(nowTs());
    return c.lastDialog;
  },
  async loadDialogIfValid() {
    const { continuity } = await _sweepContinuity(nowTs());
    return Array.isArray(continuity.lastDialog) ? continuity.lastDialog.slice(0) : [];
  },
  async clearDialog() {
    const c = await _getContinuity();
    c.lastDialog = [];
    await _setContinuity(c);
    return true;
  },

  async appendTurnKind(kind) {
    const c = await _getContinuity();
    const k = String(kind || "").slice(0, 16);
    if (!k) return Array.isArray(c.recentTurnKinds) ? c.recentTurnKinds.slice(0) : [];
    const arr = Array.isArray(c.recentTurnKinds) ? c.recentTurnKinds.slice(0) : [];
    arr.unshift({ t: nowTs(), kind: k });
    c.recentTurnKinds = arr.slice(0, 6);
    await _setContinuity(c);
    return c.recentTurnKinds;
  },  
};

// ---- bootstrap ----
(async () => {
  await _ensureSchema();
})();

// ---- exported facade ----
export const Storage = {
  Base,
  Settings,
  Runtime,
  Stats,
  Mood,
  Prefs,
  UI,
  Chat,
  Continuity,
  // convenience re-exports for callers who only need CRUD
  get: Base.get,
  getMany: Base.getMany,
  set: Base.set,
  setMany: Base.setMany,
  merge: Base.merge,
  remove: Base.remove,
  observe: Base.observe,
  clearAllSafe: Base.clearAllSafe,
};

export default Storage;
