// src/logic/promptClient.js
// 模式編排器：先做環境偵測 → 選擇 tone 訊號供應器（local/prompt） → 再走鎖定英文的 pacing 引擎。
// - 不直接做情緒規則；改由 intensityGate 的 provider 提供輕量訊號。
// - 本期不實作 hybrid；如偵測建議為 hybrid 亦落回 local。
import { routeAndRender, getVersion } from "./respondingMap.js";
import { detectTone } from "./intensityGate.js";
// envCheck 實際放在 src/utils/
import { envCheck } from "../utils/envCheck.js";
import Storage from "./storage.js";

// ===== Router（外殼；僅做判讀與決策，不改生成路徑）=====
// 目標：先讓入口看得懂長短/危機旗標，回傳決策物件供觀測；語言固定英語。
function __quickNormalizeLocaleFlag(langLike) {
  // 語言旗標一律視為英文
  return "en";
}
function __targetLocaleFromFlag(flag) {
  // 目標語系一律英文
  return "en";
}
function __countSentencesAndChars(text) {
  const t = String(text || "").trim();
  if (!t) return { sentences: 0, chars: 0 };
  // 中英標點都算：。，！？!?…; 也把換行當作句界
  const parts = t
    .split(/[\u3002\uFF0C\uFF1F\uFF01\.\,\?\!…;\n]+/g)
    .map(s => s.trim())
    .filter(Boolean);
  const sentences = parts.length;
  const chars = t.replace(/\s+/g, "").length;
  return { sentences, chars };
}
function __lengthBucket(text) {
  const { sentences, chars } = __countSentencesAndChars(text);
  // 粗分桶（先求穩）：短 ≤ 1 句或 ≤ 30 字；中 ≤ 5 句或 ≤ 180 字；其餘長
  if (sentences <= 1 || chars <= 30) return { bucket: "short", sentences, chars };
  if (sentences <= 5 || chars <= 180) return { bucket: "medium", sentences, chars };
  return { bucket: "long", sentences, chars };
}
/**
 * Router 外殼：只產出判讀，不做實際模板/LLM 的改動。
 * @param {{ youSaid?:string, context?:string, lang?:string, intensity?:string, tags?:string[] }} input
 * @returns {{ length_bucket:"short"|"medium"|"long", targetLocale:"en", pacing_mode:string, router_flags:{ crisisSuspicious:boolean }, metrics:{sentences:number, chars:number}, router_version:string }}
 */
export function route(input = {}) {
  const text = String(input.youSaid || input.context || "");
  const langFlag = __quickNormalizeLocaleFlag("en");
  const targetLocale = __targetLocaleFromFlag(langFlag);
  const { bucket, sentences, chars } = __lengthBucket(text);
  // pace 命名：先用粗粒度標籤，後續 variants/overlays 再細化
  const pacing_mode =
    bucket === "short"  ? "len.short" :
    bucket === "medium" ? "len.medium"    :
                           "len.long";
  const tags = Array.isArray(input.tags) ? input.tags : [];
  const crisisSuspicious =
    tags.includes("crisis_lang") || String(input.intensity || "").toLowerCase() === "high";
  return {
    length_bucket: bucket,
    targetLocale,
    pacing_mode,
    router_flags: { crisisSuspicious },
    metrics: { sentences, chars },
    router_version: "0.1"
  };
}

// ===== 内部：韌性 JSON 解析（與 tone 偵測同級強度） =====
function __robustParseJSON(raw) {
  if (raw == null) return { ok:false, reason:"empty" };
  let s = String(raw).trim();
  try { return { ok:true, value: JSON.parse(s), stage:"raw" }; } catch {}
  if (/^```/m.test(s)) {
    const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (m && m[1]) {
      const t = m[1].trim();
      try { return { ok:true, value: JSON.parse(t), stage:"fence" }; } catch {}
      s = t;
    }
  }
  s = s.replace(/^\s*(?:json\s*:|output\s*:)\s*/i, "");
  const i = s.indexOf("{");
  if (i >= 0) {
    let depth = 0, j = -1;
    for (let k = i; k < s.length; k++) {
      const ch = s[k];
      if (ch === "{") depth++;
      if (ch === "}") { depth--; if (depth === 0) { j = k; break; } }
    }
    if (j > i) {
      const seg = s.slice(i, j + 1);
      try { return { ok:true, value: JSON.parse(seg), stage:"balanced" }; } catch {}
    }
  }
  let relaxed = s;
  if (/\'/.test(relaxed) && !/\".*\'/.test(relaxed)) {
    relaxed = relaxed.replace(/'/g, "\"");
  }
  relaxed = relaxed.replace(/,\s*([}\]])/g, "$1");
  try { return { ok:true, value: JSON.parse(relaxed), stage:"relaxed" }; } catch {}
  return { ok:false, reason:"parse_failed" };
}

// ===== 内部：Schema 驗證（最小回應格式） =====
function __validateReplyJSON(obj) {
  const out = { lines:[], ask:false, allow:true, micro:[] };
  if (!obj || typeof obj !== "object") return { ok:false, missing:["lines","ask","allow","micro"], value: out };
  const missing = [];
  // lines
  if (Array.isArray(obj.lines)) out.lines = obj.lines.map(x => String(x)).filter(Boolean).slice(0, 6);
  else missing.push("lines");
  // ask / allow
  if (typeof obj.ask === "boolean") out.ask = obj.ask; else missing.push("ask");
  if (typeof obj.allow === "boolean") out.allow = obj.allow; else missing.push("allow");
  // micro
  if (Array.isArray(obj.micro)) out.micro = obj.micro.map(x => String(x)).filter(Boolean).slice(0, 6);
  else missing.push("micro");
  return { ok: missing.length === 0 && out.lines.length > 0, missing, value: out };
}

// ===== 内部：本地 Prompt 生成器（有 gate 才呼叫；逾時回退） =====
async function __tryLocalModelGenerate(input, { timeoutMs = 2500 } = {}) {
  const LM = globalThis.LanguageModel || globalThis.ai?.languageModel;
  if (!LM) throw new Error("prompt_api_unavailable");
  // 可用性先探
  try {
    const a = typeof LM.availability === "function" ? await LM.availability() : "available";
    if (String(a).toLowerCase() !== "available") throw new Error("prompt_api_not_ready:" + a);
  } catch {
    throw new Error("prompt_api_not_ready");
  }

  const __t0 = Date.now();
  const session = await Promise.race([
    LM.create({ temperature: 0.2, topK: 1 }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("prompt_api_timeout_create")), timeoutMs))
  ]);

  try {
    const sys = [
      "You produce a SINGLE JSON object for a supportive reply.",
      "NO code fences. NO extra text.",
      "Schema: { lines: string[], ask: boolean, allow: boolean, micro: string[] }",
      "If unsure, return minimal but valid schema with one gentle line."
    ].join("\n");
    const user = [
      "User intent/context (brief):",
      JSON.stringify({
        lang: input.lang,
        emotion: input.emotion,
        intensity: input.intensity,
        tags: input.tags || [],
        youSaid: String(input.youSaid || "").slice(0, 400),
        context: String(input.context || "").slice(0, 400)
      })
    ].join("\n");

    const raw = await Promise.race([
      session.prompt(sys + "\n\n" + user),
      new Promise((_, rej) => setTimeout(() => rej(new Error("prompt_api_timeout_infer")), timeoutMs))
    ]);
    const parsed = __robustParseJSON(raw);
    if (!parsed.ok) throw new Error("prompt_api_bad_response");
    const norm = __validateReplyJSON(parsed.value);
    const latency = Date.now() - __t0;
    return { latency_ms: latency, parsed_stage: parsed.stage || "unknown", result: norm };
  } finally {
    try { session?.destroy?.(); } catch {}
  }
}

/**
 * @typedef {Object} ToneInput
 * @property {"en"|string} [lang]                 // 一律英語；保留欄位以兼容呼叫端
 * @property {string} [emotion]                // normalized label, e.g., "sad"
 * @property {"low"|"medium"|"high"} intensity
 * @property {string[]} [tags]                 // e.g., ["crisis_lang","grounding_cue"]
 * @property {string[]} [anchored_entities]    // DEPRECATED: use k.top; kept for SW pass-through
 * @property {{ top?: string[] }} [k]          // obfuscated anchors container; k.top carries short phrases
 * @property {string} [context]                // optional brief hints (續聊：SW 傳入 summaries.join(" / "))
 * @property {string} [youSaid]                // raw or trimmed user text
 * @property {"ext"|"ui"} [audience]           // selection for bucket rotation; default "ext"
 * @property {"low"|"medium"|"high"} [intensityHint]  // 續聊：SW 提示的強度（可被覆寫）
 * @property {string} [styleCodeHint]                 // 續聊：上輪 style（路由器可選擇採用）
 */

/**
 * @param {ToneInput & { forceMode?: "local"|"hybrid"|"demo" }} payload
 * @returns {Promise<{text:string, lines:string[], meta:any}>}
 */
export async function generateReply(payload) {
  // 0) 讀取使用者偏好（若有）
  let settings = {};
  try {
    // 輕量讀取 → 直接從 Prefs 子域拿全部後解構
    const { modePreference, toneTimeoutMs, languagePref } = await Storage.Prefs.get();
    settings = {
      modePreference: modePreference || null,   // "local" | "demo" | null
      toneTimeoutMs: Number(toneTimeoutMs ?? 1600),
      languagePref: "en"
    };
  } catch {}

  // 1) 環境偵測（內建 10s 快取）
  const env = await envCheck();

  // 2) 決定模式（允許呼叫端以 forceMode 覆寫）
  const mode = payload?.forceMode
    ? (payload.forceMode === "local" ? "local" : "demo")    // 本期無 hybrid
    : (settings.modePreference === "local" || settings.modePreference === "demo"
        ? settings.modePreference
        : (env.recommendedMode === "local" ? "local" : "demo"));

  // 3) 取得 tone 訊號（auto：若可用 Prompt API 就嘗試，失敗回退 local）
  const sourceText = (payload?.youSaid || payload?.context || "").toString();
  const tone = await detectTone(sourceText, {
    mode: (mode === "local" && env.canUsePromptAPI) ? "auto" : "local",
    env,
    timeoutMs: settings.toneTimeoutMs || 1600
  });

  // 4) 組裝 pacing 引擎的輸入（payload 可覆寫；tags 取聯集）
  const mergedTags = Array.from(new Set([...(payload?.tags || []), ...(tone.tags || [])]));
  const intensity =
    (payload?.intensity
      ? String(payload.intensity).toLowerCase()
      : (payload?.intensityHint
          ? String(payload.intensityHint).toLowerCase()
          : (tone.level || "low")));

  // 4.a) Anchors（只觀測不決策；名稱去語義化 → k.top，同時提供 p.anchors 供路由/模板吃）
  const anchorsRaw =
    (Array.isArray(payload?.k?.top) ? payload.k.top :
    (Array.isArray(payload?.anchored_entities) ? payload.anchored_entities : []));
  const anchors = Array.isArray(anchorsRaw)
    ? anchorsRaw.map(x => String(x)).filter(Boolean).slice(0, 3)
    : [];

  const p = {
    // 語言旗標：一律英語（保留欄位供觀測）
    lang: "en",
    emotion: payload?.emotion || "unknown",
    intensity,
    tags: mergedTags,
    context: payload?.context || "",
    youSaid: payload?.youSaid || "",
    audience: payload?.audience || "ext",
    // Anchors：路由/模板使用；同時在 k.top 保留去語義化表徵
    anchors,
    k: { ...(payload?.k || {}), top: anchors },    
    // 續聊：將上輪 style 作為「提示」，讓路由器可選擇承接或覆寫
    styleCodeHint: payload?.styleCodeHint || null
  };

  // 🔎 本地補強：若 SW 漏標，這裡再做一次「要建議/步驟/平衡」偵測，補上 ask_approach
  try {
    const txt = (p.youSaid || "").toString();
    const reAsk =
      /\b(analyz(e|is)|how\s+(do|can)\s+i|how\s+to|what\s+should\s+i|suggest(ion)?s?|advice(s)?|tips?|plan|roadmap|steps?)\b/i;
    const reBalance = /\bbalance\b.{0,80}\band\b/i; // 支援多詞 X and Y
    if (reAsk.test(txt) || reBalance.test(txt)) {
      const s = new Set(p.tags || []);
      s.add("ask_approach");
      p.tags = Array.from(s);
    }
  } catch {}
  // 3.5) 先跑 Router（只判讀；不改變後續生成分支）
  const routing = route({
    youSaid: p.youSaid,
    context: p.context,
    lang: p.lang,
    intensity: p.intensity,
    tags: p.tags
  });
  // 可觀測：先行輸出，方便驗收
  try {
    console.debug("[SIIHA/Router.v" + routing.router_version + "]", {
      pacing_mode: routing.pacing_mode,
      length_bucket: routing.length_bucket,
      targetLocale: routing.targetLocale,
      metrics: routing.metrics,
      crisisSuspicious: routing.router_flags?.crisisSuspicious ?? false,
      // 遙測最小化：僅記錄 anchors 計數，不輸出原文
      k_count: anchors.length
    });
  } catch {}

  // 🆕 規則性補標：triage_ok（在 p1 或 rj 的脈絡下允許極簡 triage 問句）
  try {
    const tagSet = new Set(p.tags || []);
    if (tagSet.has("p1") || tagSet.has("rj")) tagSet.add("triage_ok");
    // 🆕 續聊偵測：若有歷史摘要（由 route 計出長短即可推知），加上一個無語義的 cont 記號
    //   - 僅作為覆層/節奏參考，不直接驅動樣式
    if ((routing?.metrics?.sentences ?? 0) >= 0) {
      // 續聊與否無法直接由 routing.metrics判，但這裡允許前景或 SW 補強；先保守：若 payload.context 存在即視為續聊
      if (String(payload?.context || "").trim().length > 0) tagSet.add("cont");
    }
    p.tags = Array.from(tagSet);
  } catch {}
  
  // ====== 生成分支（gate） ======
  const crisis_lock = Array.isArray(mergedTags) && mergedTags.includes("crisis_lang");
  const model_state = env.model_state || "none";
  let gen = null;
  let source = "template";                 // 預設：模板
  let parse_ok = true;
  let errorStage = null;
  let latency_ms = null;
  let model_backend = null;
  let model_out = null;

  const canTryModel =
    !crisis_lock &&
    (String(intensity) !== "high") &&
    (model_state === "ready-offline" || model_state === "ready-online");

  if (canTryModel) {
    try {
      gen = await __tryLocalModelGenerate(p, { timeoutMs: 2400 });
      latency_ms = gen.latency_ms;
      model_backend = "local";
      parse_ok = Boolean(gen?.result?.ok);
      model_out = gen?.result?.value || null;
    } catch (e) {
      parse_ok = false;
      model_backend = "local";
      errorStage = /timeout_create/i.test(String(e)) ? "model_create"
                 : /timeout_infer/i.test(String(e))  ? "model_infer"
                 : /bad_response/i.test(String(e))   ? "model_parse"
                 : /not_ready|unavailable/i.test(String(e)) ? "availability"
                 : "unknown";
    }
  }

  // ====== 決定三態 + 內容 ======
  let finalLines = null;
  let styleCode = null;
  let variantKey = null;
  let meta = null;

  if (gen && gen.result) {
    const missing = gen.result.missing || [];
    if (gen.result.ok) {
      // 完整可用 → 直接採模型
      finalLines = (gen.result.value.lines || []).filter(Boolean);
      source = "model";
    } else if ((gen.result.value.lines || []).length > 0) {
      // 有料但缺欄 → hybrid：模型行 + 模板補缺
      const tpl = await routeAndRender(p);
      styleCode = tpl.styleCode; variantKey = tpl.variantKey; meta = tpl.meta;
      finalLines = (gen.result.value.lines || []).filter(Boolean);
      source = "hybrid";
      errorStage = "missing_keys:" + missing.join(",");
    } else {
      // 解析失敗或無內容 → 模板
      parse_ok = false;
      errorStage = errorStage || "model_parse";
      const tpl = await routeAndRender(p);
      styleCode = tpl.styleCode; variantKey = tpl.variantKey; meta = tpl.meta;
      finalLines = tpl.lines;
      source = "template";
    }
  } else {
    // 未進模型或模型路徑報錯 → 模板
    const tpl = await routeAndRender({
      ...p,
      // 🆕 傳遞長短桶與目標語系（固定 en），供渲染器挑 styleTweaks 與模板鍵
      length_bucket: routing.length_bucket,
      targetLocale: routing.targetLocale
    });
    styleCode = tpl.styleCode; variantKey = tpl.variantKey; meta = tpl.meta;
    finalLines = tpl.lines;
    source = "template";
  }

  // 若尚未取得模板 meta（model/hybrid 也要補齊模板側觀測）
  if (!meta) {
    const tpl = await routeAndRender({
      ...p,
      length_bucket: routing.length_bucket,
      targetLocale: routing.targetLocale
    });
    styleCode = tpl.styleCode; variantKey = tpl.variantKey; meta = tpl.meta;
    if (!finalLines || !finalLines.length) finalLines = tpl.lines;
  }

  const lines = (finalLines || []).filter(Boolean).slice(0, 6);
  const text = lines.join(" ");

  const v = await getVersion();
  // === 觀測聚合 ===
  const debug = {
    model_state,
    style_id: meta?.style_id || meta?.pickedId || null,
    minisum_used: !!meta?.overlays?.minisum_used,
    triage_used:  !!meta?.overlays?.triage_used,    
    // Router 外殼觀測（本步驟僅記錄，不驅動生成）
    router_version: routing?.router_version || "0.1",
    pacing_mode: routing?.pacing_mode || null,
    length_bucket: routing?.length_bucket || null,
    input_len: routing?.metrics ? routing.metrics.chars : null,
    lead_in_used: false,
    micro_actions: Array.isArray(meta?.micro) ? meta.micro.length : null,
    crisis_delay_ms: null,
    router_flags: routing?.router_flags || {},
    anchors_used: Array.isArray(meta?.anchors_used) ? meta.anchors_used.slice(0, 4) : [],
    k_count: anchors.length,
    guardrails: {
      crisis_lock,
      one_question: false,
      dedup: false
    },
    route_reason: Array.isArray(meta?.reasons) ? meta.reasons[0] : null,
    parse_ok,
    errorStage,
    latency_ms,
    model_backend
  };

  // 🧪 追加：在 SW console 顯示「桶分 + 實際樣式」
  try {
    console.debug("[SIIHA/Render]", {
      pacing_mode: debug.pacing_mode,
      length_bucket: debug.length_bucket,
      style_id: debug.style_id,
      styleCode,
      variantKey,
      pickedId: meta?.pickedId,
      audience: meta?.audience
    });
  } catch {}

  return {
    text,
    lines,
    source,
    meta: {
      ...meta,
      // 把 Router 的目標 locale 帶回（固定 en）
      locale: "en",    
      // 帶回呼叫端傳入的語言（可被 SW 以完整 locale 記錄）
      styleCode,
      variantKey,
      engine: v,
      mode,
      contextEcho: (payload?.context || "").slice(0, 600),
      styleCodeHint: payload?.styleCodeHint || null,
      env: {
        platform: env.platform,
        canUsePromptAPI: env.canUsePromptAPI,
        hasNetwork: env.hasNetwork,
        policyLocked: env.policyLocked,
        chromeMajor: env.chromeMajor ?? null,
        lmAvailability: env.lmAvailability || "unknown",
        model_state
      },
      toneProvider: tone?.meta?.provider || "local",
      toneFallback: Boolean(tone?.meta?.fallback),
      debug,
      // 供前景排查（暫不驅動 UI）
      model_out
    }
  };



}
