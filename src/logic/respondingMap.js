// src/logic/respondingMap.js
// Tone router + renderer (MV3-friendly, manifest-driven, neutral naming).
// - 由 dist/manifest.responding.json 指定資源路徑（templates / weights / jitter / overlays / supplement）
// - 本版新增：OVERLAYS.overlays 條件式 bias 與 JITTER.styleTweaks 輕量文本處理
// - Externalized knobs（同前）但改為透過 manifest 定址與載入
// - Pipeline：primary decision → candidate assembly（含 neighborAffinity / softZero）→ overlays & gates → weighted pick
// - 覆寫機率僅取自 routeWeights.*；jitter.* 僅做閾值抖動/旋桶/文案微變
// - 無網路呼叫，僅讀取打包進擴充的 JSON 檔（chrome.runtime.getURL）

import {
  mulberry32 as rng,
  hashString,
  shuffle,
  rotateBuckets,
  applyTextVariation,
  weightedPick
} from "./variants.js";
import { resolvePillarVariant } from "./variants.js";

let TEMPLATES = null;            
let SEED = 0;                    
let DEVICE_ID = "";              
let ROUTE = null;                 
let JITTER = null;              
let OVERLAYS = null;           
let SUPP = null;                
let MANIFEST = null;            
const MANIFEST_URL = "dist/manifest.responding.json";

// 🔒 Only allow the three core styles
const ALLOWED_STYLES = new Set(["a7f2", "b3c1", "d401"]);

const STORAGE_KEYS = {
  seed: "__tone_seed_v1",
  device: "__tone_device_id_v1",
  lastUsePrefix: "__style_last_use_",
  lastUseFamilyPrefix: "__fam_last_use_",
  miniSumCooldownUntil: "__mini_summary_cooldown_until_v1",
  askApproachLatchUntil: "__ask_approach_latch_until_v1"
};

function pick(arr, rnd) { if (!arr || !arr.length) return null; return arr[Math.floor(rnd() * arr.length)]; }

// ---------- light helpers ----------
function bannedHit(text, bannedList) {
  const t = text.toLowerCase();
  return (bannedList || []).some(k => t.includes(String(k).toLowerCase()));
}
function griefy(emotion = "") {
  const g = new Set(["sad","lonely","tired","numb","empty","burnout","weary"]);
  return g.has(String(emotion||"").toLowerCase());
}
function jitter(base, delta, rnd) { return base + ((rnd()*2 - 1) * delta); }

// ---------- accel signal helper (身體加速/生理訊號/長句無標點) ----------
function hasAccelSignal(input, tagSet) {
  // tags: grounding_cue / physio 等上游門牌優先
  if (tagSet && (tagSet.has("grounding_cue") || tagSet.has("physio"))) return true;
  const t = String(input?.youSaid || "").trim();
  if (!t) return false;
  // 長句無標點：很長且標點極少，視為加速（中文/英文皆可）
  const punct = (t.match(/[.,;!?，。；？！…]/g) || []).length;
  if (t.length >= 80 && punct <= 1) return true;
  // 生理詞彙線索（中英混搭，輕量關鍵字）
  const physioRe = /(喘|緊|胸悶|心跳|心跳快|胃縮|發抖|冒汗|頭暈|panic|panicky|tight( chest)?|heart\s*racing|stomach\s*knot|dizzy)/i;
  return physioRe.test(t);
}

// ---------- tiny time/tag helpers for overlays ----------
function __nowHour() { try { return new Date().getHours(); } catch { return 0; } }
function __hasAny(setOrArr, arr) {
  const S = new Set(Array.isArray(setOrArr) ? setOrArr : Array.from(setOrArr || []));
  return (arr || []).some(x => S.has(x));
}
function __hasAll(setOrArr, arr) {
  const S = new Set(Array.isArray(setOrArr) ? setOrArr : Array.from(setOrArr || []));
  return (arr || []).every(x => S.has(x));
}
function __hourMatches(hoursAny, h) {
  if (!Array.isArray(hoursAny) || hoursAny.length === 0) return true;
  return hoursAny.includes(h);
}

// ---------- mini-summary & triage ask (overlay, not template-bound) ----------
function pickOne(arr, rnd) { return arr[Math.floor(rnd()*arr.length)] }
function buildMiniSummary(_lang, raw, rnd) {
  const t = String(raw || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const trimmed = `${t.slice(0, 120)}${t.length>120?"…":""}`;
  const en = [
    `I’m hearing: “${trimmed}”`,
    `I hear you saying: “${trimmed}”`,
    `Got you — “${trimmed}”`
  ];
  return pickOne(en, rnd);
}
function buildTriageAsk(_lang) {
  return "Right now, do you want action or just listening?";
}

 // ---------- placeholders & micro-variation ----------
function ensurePlaceholders(s, slots) {
  if (!s) return s;
  return s
    // 若已預先選定，使用固定值；否則退回隨機抽
    .replace(/\{\{feeling_word\}\}/g, (slots.__chosenFeeling || pick(slots.w1, slots.__rnd) || "heavy"))
    .replace(/\{\{micro_action\}\}/g, (slots.__chosenAction  || pick(slots.m1.ground, slots.__rnd) || "one slow breath"))
    // anchors (generic, shortcodes only)
    .replace(/\{\{a1\}\}/g, slots.a1 || "")
    .replace(/\{\{a2\}\}/g, slots.a2 || "")
    .replace(/\{\{you_said\}\}/g, slots.you_said || "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- load templates + seeds + configs ----------
async function loadManifestOnce() {
  if (MANIFEST) return;
  const murl = chrome.runtime.getURL(MANIFEST_URL);
  const mres = await fetch(murl);
  MANIFEST = await mres.json();
}

async function loadAssetsOnce() {
  if (TEMPLATES && ROUTE && JITTER && OVERLAYS && SUPP) return;
  await loadManifestOnce();
  const a = MANIFEST?.assets || {};
  const [tRes, wRes, jRes, oRes, sRes] = await Promise.all([
    fetch(chrome.runtime.getURL(a.templates)),
    fetch(chrome.runtime.getURL(a.weights)),
    fetch(chrome.runtime.getURL(a.jitter)),
    fetch(chrome.runtime.getURL(a.overlays)),
    fetch(chrome.runtime.getURL(a.supplement))
  ]);
  TEMPLATES = await tRes.json();
  ROUTE     = await wRes.json();
  JITTER    = await jRes.json();
  OVERLAYS  = await oRes.json();
  SUPP      = await sRes.json();

  const kv = await chrome.storage.local.get([STORAGE_KEYS.seed, STORAGE_KEYS.device]);
  let seed = kv[STORAGE_KEYS.seed];
  let device = kv[STORAGE_KEYS.device];

  if (!device) {
    // 在非瀏覽器（例如 Node 測試）時 navigator 可能不存在
    const ua =
      (typeof navigator !== "undefined" && navigator.userAgent)
        ? navigator.userAgent
        : (typeof process !== "undefined" && process.version)
          ? `node ${process.version}`
          : "unknown";
    device = "d" + (Date.now() ^ hashString(ua)).toString(36);
    await chrome.storage.local.set({ [STORAGE_KEYS.device]: device });
  }
  if (!seed) {
    seed = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
    await chrome.storage.local.set({ [STORAGE_KEYS.seed]: seed });
  }
  DEVICE_ID = device;
  SEED = seed;
}

function resolveLang(lang) {
  return "en";
}
function resolveLengthBucket(input) {
  const b = String(input.length_bucket || "").toLowerCase();
  if (b === "short" || b === "medium" || b === "long") return b;
  // 後備：依字數粗分（與 promptClient 的邏輯對齊）
  const t = String(input.youSaid || "").trim();
  if (!t) return "short";
  const chars = t.replace(/\s+/g, "").length;
  if (chars <= 30) return "short";
  if (chars <= 180) return "medium";
  return "long";
}
function resolveTargetLocale(input) {
  return "en";
}
function slotBundle(input, rnd) {
  const s = TEMPLATES.slots || {};
  // support obfuscated slot keys: w1/m1
  return {
    w1: s.w1 || ["heavy"],
    m1: s.m1 || { ground: ["one slow breath"] },
    you_said: input.youSaid ? String(input.youSaid).slice(0, 200) : "",
    // anchors from SW shortcodes: k.top is an array (0–2)
    a1: Array.isArray(input?.k?.top) && input.k.top[0] ? String(input.k.top[0]).slice(0, 80) : "",
    a2: Array.isArray(input?.k?.top) && input.k.top[1] ? String(input.k.top[1]).slice(0, 80) : "",
    __rnd: rnd
  };
}

// ---------- routing (use real style codes, no mapping) ----------
function chooseStyleCode(input, rnd) {
  // 🧩 Grounding cue 準硬鎖增強：支援陣列與字串型態
  const tagsInput = input.tags || [];
  const tags = Array.isArray(tagsInput) ? new Set(tagsInput) : new Set(String(tagsInput).split("|").map(t => t.trim()).filter(Boolean));
  const intensity = String(input.intensity || "low").toLowerCase();

  // ================================================
  // 🧩 Grounding 準硬鎖（陣列 / 字串兜底保留）
  // ================================================
  if (tags.has("grounding_cue") ||
      (Array.isArray(tagsInput) && tagsInput.includes("grounding_cue")) ||
      (typeof tagsInput === "string" && tagsInput.includes("grounding_cue"))) {
    // Grounding 命中 → b3c1（p03）
    const vk = pickVariantKey("b3c1", rnd) || "p01";
    const safeVk = (vk === "p03" && !tags.has("rj")) ? (rnd() < 0.8 ? "p01" : "p02") : vk;
    return { styleCode: "b3c1", variantKey: safeVk, reason: "grounding_lock_fallback" };
  }

  // ================================================
  // 🔒 Presence-like gate
  // ================================================
  if (tags.has("p1")) {
    const vk = pickVariantKey("b3c1", rnd) || "p01";
    const safeVk = (vk === "p03") ? "p01" : vk;
    return { styleCode: "b3c1", variantKey: safeVk, reason: "p1_lock" };
  }

  // 危機語仍維持安全硬鎖（防止被其他路由稀釋）
  if (tags.has("crisis_lang")) {
    const vk = pickVariantKey("d401", rnd) || "p01";
    return { styleCode: "d401", variantKey: vk, reason: "safety_lock" };
  }

  if (tags.has("rj")) {
    return { styleCode: "b3c1", variantKey: "p03", reason: "rj_lock" };
  }
  
  const grief = griefy(input.emotion);
  const accel = hasAccelSignal(input, tags);
  // 🧭 使用者「要方法」但同時有加速/生理或 Grounding 線索
  if (tags.has("ask_approach")) {
    const accel = hasAccelSignal(input, tags);
    const askedBodyWork = accel || tags.has("grounding_cue");
    if (askedBodyWork) {
      const vk = pickVariantKey("b3c1", rnd) || "p01";
      const safeVk = (vk === "p03") ? "p01" : vk;
      return { styleCode: "b3c1", variantKey: safeVk, reason: "ask_grounding" };
    }
    // 先落傾聽，但變體讓 weights 決定
    const avk = pickVariantKey("a7f2", rnd) || "p01";
    return { styleCode: "a7f2", variantKey: avk, reason: "ask_approach_listen" };
  }
  // 🧩 悲傷 + 加速訊號
  if (grief && accel) {
    const vk = pickVariantKey("b3c1", rnd) || "p01";
    const safeVk = (vk === "p03" && !tags.has("rj")) ? (rnd() < 0.8 ? "p01" : "p02") : vk;
    return { styleCode: "b3c1", variantKey: safeVk, reason: "grief_with_accel" };
  }

  // override probability: ONLY from routeWeights.*; if missing, audience-tuned defaults
  const aud = (input.audience === "ui") ? "ui" : "ext";
  const ovMin = Number(ROUTE?.overrideProbability?.min ??
                       (aud === "ui" ? 0.06 : 0.10));
  const ovMax = Number(ROUTE?.overrideProbability?.max ??
                       (aud === "ui" ? 0.10 : 0.16));
  const overrideChance = ovMin + (ovMax - ovMin) * rnd();

  if (intensity === "medium") {
    let vk = pickVariantKey("a7f2", rnd) || "p01";
    if (grief && vk === "p01" && rnd() < 0.35) vk = "p02"; 
    return { styleCode: "a7f2", variantKey: vk, reason: grief ? "med_grief" : "med_nongrief" };
  }

  if (intensity === "low") {
    // 基準讓 weights 決定，再用 jitter 做輕微變體抖動
    let vk = pickVariantKey("a7f2", rnd) || "p01";
    const base = Number(JITTER?.thresholds?.lowMediumBase ?? 0.5);
    const delta = Number(JITTER?.thresholds?.lowMediumJitter ?? 0.15);
    const lowTilt = jitter(base, delta, rnd);
    if (!grief && lowTilt >= 0.5 && vk === "p01") vk = "p02";
    return { styleCode: "a7f2", variantKey: vk, reason: "low_listen" };
  }

  // Fallback
  return { styleCode: "a7f2", variantKey: (pickVariantKey("a7f2", rnd) || "p01"), reason: "fallback_listen" };
}

// ---------- candidate assembly & eligibility ----------
function styleBaseWeight(styleCode, audience) {
  const s = ROUTE?.styles?.[styleCode];
  const base = Number(s?.base ?? 1.0);
  const bias = Number(ROUTE?.audienceBias?.[audience]?.[styleCode] ?? 0);
  const soft = (OVERLAYS?.softZero || []).includes(styleCode) ? 0 : 1;
  return Math.max(0, base + bias) * soft;
}

function pickVariantKey(styleCode, rnd) {
  const variants = ROUTE?.styles?.[styleCode]?.variants || null;
  if (!variants) return "p01";
  const items = Object.entries(variants).map(([vk, w]) => ({ item: vk, weight: Number(w || 0) }));
  const chosen = weightedPick(items, rnd);
  return chosen || "p01";
}

function assembleCandidates(primary) {
  const base = [primary.styleCode];
  const na = ROUTE?.neighborAffinity?.[primary.styleCode] || {};
  const neighbors = Object.keys(na);
  const softZero = (OVERLAYS?.softZero || []).slice();
  const uniq = Array.from(new Set([...base, ...neighbors, ...softZero]));
  return uniq.filter(sc => ALLOWED_STYLES.has(sc));
}

// ---------- overlay bias (fit routingOverlays.json schema) ----------
function buildOverlayBias(input, audience) {
  const bias = {}; // styleCode -> number (additive)
  const rules = Array.isArray(OVERLAYS?.overlays) ? OVERLAYS.overlays : [];
  if (!rules.length) return bias;

  // normalize
  const tagArr = Array.isArray(input.tags)
    ? input.tags.slice()
    : String(input.tags || "").split("|").map(s => s.trim()).filter(Boolean);
  const tags = new Set(tagArr);
  const intensity = String(input.intensity || "low").toLowerCase();
  const locale = String(input.lang || "en").toLowerCase();

  for (const r of rules) {
    const cond = r?.conditions || {};
    const eff  = r?.effects || {};
    const t    = r?.targets || {};
    const scs  = Array.isArray(t?.styleCodes) ? t.styleCodes : [];

    // audience gate
    if (r?.audience && r.audience !== audience) continue;
    // locale gate (string or array)
    if (cond.locale) {
      const ok = Array.isArray(cond.locale)
        ? cond.locale.map(x=>String(x).toLowerCase()).includes(locale)
        : String(cond.locale).toLowerCase() === locale;
      if (!ok) continue;
    }
    // intensity gate (string or array)
    if (cond.intensity) {
      const ok = Array.isArray(cond.intensity)
        ? cond.intensity.map(x=>String(x).toLowerCase()).includes(intensity)
        : String(cond.intensity).toLowerCase() === intensity;
      if (!ok) continue;
    }
    // tags gates
    if (Array.isArray(cond.requiresTags) && cond.requiresTags.length && !__hasAll(tags, cond.requiresTags)) continue;
    if (Array.isArray(cond.excludesTags) && cond.excludesTags.length && __hasAny(tags, cond.excludesTags)) continue;

    const delta = Number(eff.bias || 0);
    if (!isFinite(delta) || !scs.length) continue;
    for (const sc of scs) bias[sc] = (bias[sc] || 0) + delta;
  }
  return bias;
}

function fetchPoolRaw(styleCode, variantKey, lang) {
  const L = TEMPLATES.lang[lang] || {};
  const S = L.styles?.[styleCode];
  const primary = (S?.variants?.[variantKey]) || [];

  // merge supplemental templates if present
  const supArr = SUPP?.lang?.[lang]?.styles?.[styleCode]?.variants?.[variantKey] || [];
  return [...primary, ...supArr];
}

// audience filter: allow "both" + matching audience
function filterByAudience(arr, audience) {
  const pool = arr.filter(x => x.aud === "both" || x.aud === audience);
  return pool.length ? pool : arr;
}

// meta gates check
function passesGates(tpl, input, rnd) {
  const meta = tpl.meta || {};
  // overlay gateHint by style
  const gh = OVERLAYS?.gateHints?.[input.styleProbe || ""] || null;
  // if overlay requires gate, attach as virtual requirement (soft)
  if (gh && input.styleProbe && input.styleProbe === tpl?.id?.slice(0,4)) {
    // noop: we keep per-template meta primary
  }
  // requiresSlots
  if (meta.requiresSlots && meta.requiresSlots.length) {
    const have = new Set(Object.keys(input || {}));

    const ok = meta.requiresSlots.every(k => have.has(k));
    if (!ok) return { ok: false, reason: "requiresSlots" };
  }

  if (typeof meta.gateHint === "string" && meta.gateHint.startsWith("hp:")) {
    const need = meta.gateHint.slice(3) || "";
    const h = (hashString(DEVICE_ID).toString(16)).slice(0, need.length);
    if (h !== need) return { ok: false, reason: "gateHint" };
  }
  // timeWindow
  if (meta.timeWindow) {
    const now = new Date();
    if (meta.timeWindow.weekdayOnly) {
      const d = now.getDay(); // 0 Sun .. 6 Sat
      if (d === 0 || d === 6) return { ok: false, reason: "timeWindow" };
    }
    if (Array.isArray(meta.timeWindow.hours) && meta.timeWindow.hours.length) {
      const hh = now.getHours();
      if (!meta.timeWindow.hours.includes(hh)) return { ok: false, reason: "timeWindow" };
    }
  }
  // cooldown: if set, require lastUsed older than threshold
  if (Number.isFinite(meta.cooldownMs) && meta.cooldownMs > 0) {
    // look up per-template last use
    // if absent → treat as "now", i.e., still cooling (decoy safe)
    const key = STORAGE_KEYS.lastUsePrefix + (tpl.id || "unknown");
  }
  return { ok: true };
}

async function passesCooldown(tpl) {
  const meta = tpl.meta || {};
  if (!Number.isFinite(meta.cooldownMs) || meta.cooldownMs <= 0) return { ok: true };
  const key = STORAGE_KEYS.lastUsePrefix + (tpl.id || "unknown");
  const kv = await chrome.storage.local.get([key]);
  const last = Number(kv[key] || Date.now()); // default "now" → blocks immediately (decoy safe)
  const ok = (Date.now() - last) >= meta.cooldownMs;
  return { ok, reason: ok ? undefined : "cooldown" };
}

async function markUsed(tpl) {
  const key = STORAGE_KEYS.lastUsePrefix + (tpl.id || "unknown");
  await chrome.storage.local.set({ [key]: Date.now() });
  // optional: family-level cooldown if provided
  const fam = tpl?.meta?.family || null;
  const famMs = Number(tpl?.meta?.familyCooldownMs || 0);
  if (fam && famMs > 0) {
    const fkey = STORAGE_KEYS.lastUseFamilyPrefix + String(fam);
    await chrome.storage.local.set({ [fkey]: Date.now() });
  }
}

// ---------- compose + scrub ----------
function composeLines(chosen, slots, rnd, tvOverride) {
  const lines = [chosen.opening, chosen.middle, chosen.closing]
    .map(x => ensurePlaceholders(x, slots));
  // text variation：style 專屬覆蓋 > 全域
  const baseTV = {
    enabled: Boolean(JITTER?.textVariation?.enabled),
    probability: Number(JITTER?.textVariation?.probability || 0)
  };
  const tv = tvOverride
    ? { enabled: Boolean(tvOverride.enabled), probability: Number(tvOverride.probability || 0) }
    : baseTV;
  return applyTextVariation(lines, tv, rnd);
}

// styleTweaks
function getStyleTweakConfig(styleCode, lengthBucket, locale) {
  const k1 = `${styleCode}.${lengthBucket}.${locale}`;
  const k2 = `${styleCode}.${lengthBucket}`;
  const k3 = `${styleCode}.default`;
  return JITTER?.styleTweaks?.[k1] || JITTER?.styleTweaks?.[k2] || JITTER?.styleTweaks?.[k3] || null;
}

// apply styleTweaks to final lines
function applyStyleTweaks(styleCode, lines, lengthBucket, locale) {
  const cfg = getStyleTweakConfig(styleCode, lengthBucket, locale);
  if (!cfg) return lines;
  let out = lines.slice();
  const maxEll = Number(cfg.maxEllipsisPerLine || 0);
  const stripExcess = Boolean(cfg.stripExcessEllipsis);
  if (stripExcess || maxEll > 0) {
    out = out.map(l => {
      let s = String(l).replace(/\.{4,}/g, "...");
      if (maxEll > 0) {
        let count = 0;
        s = s.replace(/\.\.\./g, m => (++count <= maxEll) ? m : ".");
      }
      return s;
    });
  }

  if (cfg.enforceThreeBeat && out.length > 3) {
    out = out.slice(0, 3);
  }  
  return out;
}

function scrubOrFallback(lines, banned, lang, rnd, audience) {
  const text = lines.join(" ");
  if (bannedHit(text, banned)) {
    const raw = fetchPoolRaw("a7f2", "p01", lang);
    const pool = filterByAudience(raw, audience);
    const picked = pick(pool, rnd) || pool[0];
    const slots = {
      w1: TEMPLATES.slots.w1,
      m1: TEMPLATES.slots.m1,
      you_said: "",
      __rnd: rnd
    };
    return composeLines(picked, slots, rnd);
  }
  return lines;
}

// ---------- pool helpers ----------
function isRepairTpl(tpl) {
  const id = String(tpl?.id || "");
  const f = tpl?.meta?.flags || [];
  const kind = String(tpl?.meta?.kind || "");
  return kind === "rep" || f.includes("rep") || /(^|_)rep(_|$)/i.test(id);
}

async function firstUsableByCooldown(rotated) {
  for (const t of rotated) {
    const cool = await passesCooldown(t);
    if (cool.ok) return t;
  }

  return rotated[0] || null;
}

/**
 * Public: route + render (with decoy-considered but never selected)
 * @param {Object} input { lang, emotion, intensity, tags, context, youSaid, audience? }
 * @returns {Promise<{styleCode,variantKey,lines,meta}>}
 */
export async function routeAndRender(input) {
  const audience = input.audience === "ui" ? "ui" : "ext";
  await loadAssetsOnce();

  const salt = hashString((input.lang || "") + (input.emotion || "") + (input.intensity || "") + DEVICE_ID);
  const rnd = rng((SEED ^ salt) >>> 0);

  const lang = "en";
  const lengthBucket = resolveLengthBucket(input);
  const targetLocale = "en";
  const primary = chooseStyleCode(input, rnd);

  // =========================
  // 🔒 Safety hard-lock (d401)
  // 以 styleCode === "d401" 為唯一硬鎖條件（不依賴 reason 字串）。
  // 命中後：不做鄰近樣式組裝與加權挑選，避免被其它樣式稀釋。
  // =========================
  if (primary?.styleCode === "d401") {
    const raw = fetchPoolRaw(primary.styleCode, primary.variantKey, lang);
    const pool = filterByAudience(raw, audience);
    const rotated = rotateBuckets(pool, SEED, JITTER?.rotation?.salt || audience);
    const chosenTpl = rotated[0] || pool[0] || raw[0];

    // 固定一次 slot 選值（同一輪一致）
    const slots = slotBundle(input, rnd);
    const __chosenFeeling = pick(slots.w1, slots.__rnd) || "heavy";
    const __chosenAction  = pick(slots.m1.ground, slots.__rnd) || "one slow breath";
    const slotsFixed = { ...slots, __chosenFeeling, __chosenAction };
    const tvCfg = getStyleTweakConfig(primary.styleCode, lengthBucket, targetLocale)?.textVariation || null;
    const lines0 = composeLines(chosenTpl, slotsFixed, rnd, tvCfg);
    const banned = TEMPLATES.safety?.banned || [];
    let lines = scrubOrFallback(lines0, banned, lang, rnd, audience);
    lines = applyStyleTweaks(primary.styleCode, lines, lengthBucket, targetLocale);    

    try { if (chosenTpl?.id) await markUsed(chosenTpl); } catch {}

    return {
      styleCode: primary.styleCode,
      variantKey: primary.variantKey,
      lines,
      meta: {
        lang,
        pickedId: chosenTpl?.id || null,
        style_id: chosenTpl?.id || null,
        anchors_used: [__chosenFeeling, __chosenAction].filter(Boolean),
        reasons: [primary.reason],
        version: TEMPLATES.version || null,
        schema: TEMPLATES.schema || null,
        audience,
        considered: [primary.styleCode],
        rejected: []
      }
    };
  }

  // assemble candidates: primary + neighbors + decoys
  const styleList = assembleCandidates(primary);

  // for each style, build a small candidate record
  const considered = [];
  const rejected = [];

  // Build pools per style (audience filtered later) and pick one representative per style
  const candidatePool = [];
  // NOTE: avoid colliding with later overlay-scoped tag set
  const candTags = new Set(Array.isArray(input.tags) ? input.tags : (String(input.tags||"").split("|").filter(Boolean)));
  // precompute overlay bias once per routing call
  const overlayBias = buildOverlayBias(input, audience);

  for (const sc of styleList) {
    // variantKey chosen using routeWeights variant weights
    const vk = (sc === primary.styleCode) ? primary.variantKey : pickVariantKey(sc, rnd);
    const raw = fetchPoolRaw(sc, vk, lang);
    if (!raw.length) { rejected.push({ style: sc, reason: "noTemplates" }); continue; }

    // audience filter (first gate)
    const byAud = filterByAudience(raw, audience);
    if (!byAud.length) { rejected.push({ style: sc, reason: "audience" }); continue; }

    // meta gates (requires*, hashPrefix, timeWindow)
    // test first item (all items in same variant share meta pattern in our data)
    const probe = byAud[0];
    // annotate styleProbe for overlay gate evaluation (non-invasive)
    const gateCheckInput = { ...input, styleProbe: sc };
    const g = passesGates(probe, gateCheckInput, rnd);
    if (!g.ok) { rejected.push({ style: sc, reason: g.reason }); continue; }

    // quotas from overlays
    const cap = Number(OVERLAYS?.styleCaps?.[sc] ?? Infinity);
    if (cap === 0) { rejected.push({ style: sc, reason: "quota" }); continue; } 

    // cooldown (async) – check when picking actual template below (per-template), not only probe

    // style base weight
    let w = styleBaseWeight(sc, audience);
    // neighbor affinity boost (small) if neighbor of primary
    const aff = Number(ROUTE?.neighborAffinity?.[primary.styleCode]?.[sc] ?? 0);
    w = Math.max(0, w + aff);
    // overlays conditional bias
    if (Number.isFinite(overlayBias?.[sc])) {
      w = Math.max(0, w + Number(overlayBias[sc]));
    }    

    // multiply by variant weight (already applied in pickVariantKey; keep w as style-level)
    if (w <= 0) { rejected.push({ style: sc, reason: "weight0" }); continue; }

    // rotation: device/audience-based ordering (does not change content, only pick index)
    let rotated = rotateBuckets(byAud, SEED, JITTER?.rotation?.salt || audience);

    // If user pushback/repeat → prefer repair variants within b3c1
    if ((candTags.has("rj") || candTags.has("rp")) && sc === "b3c1") {
      const repairs = rotated.filter(isRepairTpl);
      const others  = rotated.filter(t => !isRepairTpl(t));
      rotated = [...repairs, ...others];
      // small weight bump for b3c1 under rj/rp
      w = w * 1.15;
    }
    candidatePool.push({ styleCode: sc, variantKey: vk, weight: w, pool: rotated });
  }

  // record considered
  for (const sc of styleList) {
    if (!rejected.find(r => r.style === sc) && !candidatePool.find(c => c.styleCode === sc)) {
      // styles with noTemplates already handled; others implicitly dropped
      rejected.push({ style: sc, reason: "dropped" });
    }
  }

  // If nothing survived (extreme gating), fall back to primary raw pool ignoring non-safety gates
  let chosenStyle = primary.styleCode;
  let chosenVariant = primary.variantKey;
  let chosenTpl = null;

  if (!candidatePool.length) {
    const raw = fetchPoolRaw(primary.styleCode, primary.variantKey, lang);
    const pool = filterByAudience(raw, audience);
    const rotated = rotateBuckets(pool, SEED, JITTER?.rotation?.salt || audience);
    chosenTpl = await firstUsableByCooldown(rotated) || pool[0] || raw[0];
  } else {
    // weighted pick among survivors
    const pickedC = weightedPick(candidatePool.map(c => ({ item: c, weight: c.weight })), rnd) || candidatePool[0];
    const pool = pickedC.pool;
    // pick first passing cooldown to enforce Anti-Echo at template level
    chosenTpl = await firstUsableByCooldown(pool);
    chosenStyle = pickedC.styleCode;
    chosenVariant = pickedC.variantKey;
  }

  // 固定一次 slot 選值（同一輪一致）
  const slots = slotBundle(input, rnd);
  const __chosenFeeling = pick(slots.w1, slots.__rnd) || "heavy";
  const __chosenAction  = pick(slots.m1.ground, slots.__rnd) || "one slow breath";
  const slotsFixed = { ...slots, __chosenFeeling, __chosenAction };
  const tvCfg = getStyleTweakConfig(chosenStyle, lengthBucket, targetLocale)?.textVariation || null;
  const lines0 = composeLines(chosenTpl, slotsFixed, rnd, tvCfg);

  const banned = TEMPLATES.safety?.banned || [];
  let lines = scrubOrFallback(lines0, banned, lang, rnd, audience);

  // —— styleTweaks：針對實際選中的 style 做表面節奏微調（無副作用）
  lines = applyStyleTweaks(chosenStyle, lines, lengthBucket, "en");

  // —— 模板守門（行動模板需要「數字/步驟」）：若未命中 requirePatterns，就換下一個
  try {
    const meta = chosenTpl?.meta || {};
    const flags = Array.isArray(meta.flags) ? meta.flags : [];
    const reqs  = Array.isArray(meta.requirePatterns) ? meta.requirePatterns : [];
    const needActCheck = flags.includes("act") && reqs.length > 0;
    if (needActCheck) {
      const textProbe = lines.join(" ");
      const ok = reqs.some(p => {
        const re = (p instanceof RegExp) ? p : new RegExp(String(p), "i");
        return re.test(textProbe);
      });
      if (!ok) {
        // 換下一個同家族（先不重抽 style，只在目前池內找）
        const pool = candidatePool.find(c => c.styleCode === chosenStyle)?.pool || [];
        const alt = pool.find(t => (t.meta?.flags||[]).includes("act") && (t.meta?.requirePatterns||[]).length > 0) || null;
        if (alt) {
          const altLines = composeLines(alt, slotsFixed, rnd);
          lines = scrubOrFallback(altLines, banned, lang, rnd, audience);
          chosenTpl = alt;
        }
      }
    }
  } catch {}

  // —— overlay：mini-summary + triage（僅非危機、且非 ask_approach）
  const wantMini = (String(input.youSaid||"").trim().length >= 10);
  const overlayTags = new Set(Array.isArray(input.tags) ? input.tags : (String(input.tags||"").split("|").filter(Boolean)));
  const safeToOverlay = !overlayTags.has("crisis_lang");
  // cooldown for mini-summary (avoid appearing too close together)
  let miniOk = true;
  try {
    const kv = await chrome.storage.local.get([STORAGE_KEYS.miniSumCooldownUntil]);
    const until = Number(kv[STORAGE_KEYS.miniSumCooldownUntil] || 0);
    if (Date.now() < until) miniOk = false;
  } catch {}

  // 迷你摘要：改為「條件 + 冷卻」，無機率抽籤；且 ask_approach 或 latch 期間一律關閉
  const msAllowedContext = (overlayTags.has("p1") || overlayTags.has("rj"));
  let msUsed = false;
  let triageUsed = false;
  if (safeToOverlay && wantMini && miniOk && !overlayTags.has("ask_approach") && msAllowedContext) {
    const ms = buildMiniSummary(lang, input.youSaid, rnd);
    if (ms) {
      lines = [ms, ...lines];
      msUsed = true;
    }
    // 預設關閉
    if (overlayTags.has("triage_ok")) {
      const ask = buildTriageAsk(lang);
      if (ask) {
        lines = [...lines, ask];
        triageUsed = true;
      }
    }
    // set cooldown (configurable via OVERLAYS or JITTER, fallback 180s)
    const cdMs =
      Number(OVERLAYS?.miniSummary?.cooldownMs) ||
      Number(JITTER?.overlays?.miniSummaryCooldownMs) ||
      180_000;
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.miniSumCooldownUntil]: Date.now() + cdMs });
    } catch {}
  }

  // mark last-used for cooldown accounting
  try { if (chosenTpl?.id) await markUsed(chosenTpl); } catch {}

  return {
    styleCode: chosenStyle,
    variantKey: chosenVariant,
    lines,
    meta: {
      lang: "en",
      lengthBucket,
      targetLocale: "en",     
      pickedId: chosenTpl?.id || null,
      style_id: chosenTpl?.id || null,
      anchors_used: [__chosenFeeling, __chosenAction, slots.a1, slots.a2].filter(Boolean),
      reasons: [primary.reason],
      overlays: {
        minisum_used: Boolean(msUsed),
        triage_used:  Boolean(triageUsed)
      },
      version: TEMPLATES.version || null,
      schema: TEMPLATES.schema || null,
      audience,
      considered: assembleCandidates(primary),
      rejected
    }
  };
}

export async function getVersion() {
  await loadAssetsOnce();
  return { version: TEMPLATES.version || null, schema: TEMPLATES.schema || null };
}