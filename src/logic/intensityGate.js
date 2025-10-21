// src/logic/intensityGate.js
// 訊號供應器（pluggable）：Local 規則為基礎，若環境允許可嘗試 Prompt API 補強。
// - 不動 DOM、不碰 storage。
// - 對外主介面：detectTone(text, { mode, env, timeoutMs })；scoreText() 仍保留作別名。
// - 本檔加入：嚴格格式約束的 prompt、韌性解析器、嚴格驗證與觀測欄位。
// - 🧩 續聊鉤子：提供「超輕摘要」與「關鍵詞」純函式（供 SW 生成語境摘要）。

const LEX = {
  high: [
    /suicid(e|al)|自殺|不想活|活不下去|kill myself/i,
    /panic|恐慌|崩潰|受不了|絕望/i,
    /die|死亡|去死/i,
  ],
  mid: [
    /anxious|anxiety|焦慮|心悸|壓力/i,
    /sad|沮喪|低落|難過|失眠/i,
    /tired|burn(ed)?\s?out|倦|疲憊/i,
  ],
  grounding: [/呼吸|breath|深呼吸|冷靜|calm/i],
  // 生理線索（用於 physio 標籤與 b3c1 偏壓）
  physio: [
    /心跳(?:快|很快)|心悸|胸悶|喘|呼吸不順|胃縮|發抖|手抖|出汗|冒汗|頭暈|胸口緊/i,
    /\b(heart\s*racing|tight(\s*chest)?|short(ned)?\s*breath|stomach\s*knot|dizz(y|iness)|sweat(ing)?)\b/i
  ],  
  // 使用者要「作法/分析/建議/回饋」
  ask: [
    /\b(approach|approaches|suggestions?|advice|feedback|analy[sz]e|analysis)\b/i,
    /作法|方法|做法|步驟|建議|意見|回饋|分析|怎麼面對|怎麼處理|怎麼溝通/i
  ],  
  // 🔎 Light heuristics for locks & soft rejections
  // p1 = gate.p1
  p1: [
    /\b(stay (?:right )?here|just be here|sit with me|stay with me)\b/i,
    /\b(listen|just listen|hear me)\b(?!.*(plan|fix|solve))/i,
    /只要陪我|就陪我|陪著我|在這裡就好|留在這裡|先陪我一下/i
  ],
  // rj = sig.rj
  rj: [
    /\b(no advice|don'?t (try to )?fix|stop fixing|not helping|i don'?t want solutions?)\b/i,
    /不要(?:給)?建議|別(?:再)?分析|不要解決|先不要(?:討論|處理)|沒在聽/i
  ]
};

// —— 輔助：焦慮線的片語/型態線索（映射成 anxious_cue）
function __anxiousHeuristics(text) {
  const s = String(text || "").toLowerCase();
  if (!s) return false;
  // 同義詞／近義詞（心理語意）
  const lexHit =
    /\b(anxious|anxiety|worried|worry|nervous|stressed|overwhelmed|uneasy|jittery|scared|afraid|fear|dread|panic)\b/.test(s) ||
    /(擔心|緊張|焦躁|焦慮|發慌|心慌|害怕|怕失控|壓力好大|好焦|很慌)/.test(s) ||
    /(腦袋停不下來|睡不著|轉個不停|一直在想|想很多)/.test(s) ||
    /\bwhat\s+if\b/.test(s);
  // 型態線索：問號密度↑、短句連發、未來向、否定反覆
  const qm = (s.match(/\?/g) || []).length;
  const sentences = s.split(/[.!?。！？；;]+/).filter(x => x.trim().length);
  const shortBursts = sentences.filter(x => x.trim().length <= 25).length >= 3;
  const futurey = /(明天|下週|下周|如果|萬一|\bif\b|\btomorrow\b|\bnext (week|month)\b)/.test(s);
  const negRepeat = /(不行|不夠|不會|沒辦法|no way|can'?t|won'?t)/i.test(s) && (s.match(/不|no|n't/gi) || []).length >= 3;
  return lexHit || qm >= 2 || shortBursts || futurey || negRepeat;
}

// --- Local 規則供應器（原本邏輯封裝） ---
function localRulesProvider(inputText) {
  const text = (inputText || "").toString().trim();
  if (!text) {
    return {
      level: "low",
      score: 0,
      tags: ["empty"],
      signals: {},
      meta: { provider: "local", fallback: false, summaryHint: "", keywords: [] }
    };
  }

  let score = 0;
  const hits = { high: [], mid: [], grounding: [], physio: [], p1: [], rj: [], ask: [] };

  LEX.high.forEach((re) => { if (re.test(text)) hits.high.push(re.source); });
  LEX.mid.forEach((re)  => { if (re.test(text)) hits.mid.push(re.source); });
  LEX.grounding.forEach((re) => { if (re.test(text)) hits.grounding.push(re.source); });
  LEX.physio.forEach((re) => { if (re.test(text)) hits.physio.push(re.source); });
  (LEX.ask||[]).forEach((re) => { if (re.test(text)) hits.ask.push(re.source); });  
  LEX.p1.forEach((re) => { if (re.test(text)) hits.p1.push(re.source); });
  LEX.rj.forEach((re) => { if (re.test(text)) hits.rj.push(re.source); });

  // 簡單打分：命中 high/mid 疊加；長度與嘆詞輕微加權
  score += hits.high.length * 2.0;
  score += hits.mid.length * 1.0;
  // 焦慮線索下限微提分，避免被判太低張
  if (__anxiousHeuristics(text)) score += 0.5;

  const len = Math.min(200, text.length);
  if (len > 40) score += 0.3;
  // 🧩 標點張力強化（多重感嘆／疑問提升權重）
  if (/[!?]{2,}/.test(text)) score += 0.4;
  if (/[!?]{4,}/.test(text)) score += 2.2; // 極端標點直接提升至 mid 區間

  // 限制在 0~5
  score = Math.max(0, Math.min(5, Number(score.toFixed(2))));

  let level = "low";
  if (score >= 3.6) level = "high";
  else if (score >= 2.1) level = "mid";

  const tags = [];
  if (hits.high.length) tags.push("crisis_lang");
  if (hits.mid.length)  tags.push("distress_lang");
  if (hits.grounding.length) tags.push("grounding_cue");
  if (hits.physio.length) tags.push("physio");
  if (hits.ask.length) tags.push("ask_approach");
  // 若同時「要方法」且帶有身體/grounding 線索，補一個語意更窄的提示（供將來觀測/疊代；不影響既有路由）
  if (hits.ask.length && (hits.grounding.length || hits.physio.length)) {
    tags.push("ask_grounding");
  }
  // 統一映射：焦慮線（情緒/片語/型態任一命中）→ anxious_cue
  if (__anxiousHeuristics(text)) tags.push("anxious_cue");
  // 以 SW 決策為主；此層僅兜底地標記短碼 tags
  if (hits.p1.length) tags.push("p1");   // gate.p1
  if (hits.rj.length) tags.push("rj");   // sig.rj

  return {
    level,
    score,
    tags,
    signals: hits,
    meta: { provider: "local", fallback: false, summaryHint: makeUltraBrief(text), keywords: extractSummaryKeywords(text) }
  };
}

// --- Prompt API 供應器（可用時嘗試；失敗時回退 local） ---
// 冷啟動較慢：第一次給寬鬆 timeout，成功後縮短。
let __LM_WARMED = false;
// 內部：韌性解析（支援去除 code fence / 取第一個平衡大括號 / 輕度修復）
function __robustParseJSON(raw) {
  if (raw == null) return { ok:false, reason:"empty" };
  let s = String(raw).trim();
  // 快路徑：直接 parse
  try { return { ok:true, value: JSON.parse(s), stage:"raw" }; } catch {}
  // code fence 抽取
  if (/^```/m.test(s)) {
    const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (m && m[1]) {
      const t = m[1].trim();
      try { return { ok:true, value: JSON.parse(t), stage:"fence" }; } catch {}
      s = t; // 繼續後續步驟
    }
  }
  // 去除常見前綴（json:, JSON:, Output: 等）
  s = s.replace(/^\s*(?:json\s*:|output\s*:)\s*/i, "");
  // 取第一個平衡大括號區段
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
  // 輕度修復：單引號轉雙引號（只在沒有雙引號時嘗試）、移除尾逗號
  let relaxed = s;
  if (/\'/.test(relaxed) && !/\".*\'/.test(relaxed)) {
    relaxed = relaxed.replace(/'/g, "\"");
  }
  relaxed = relaxed.replace(/,\s*([}\]])/g, "$1");
  try { return { ok:true, value: JSON.parse(relaxed), stage:"relaxed" }; } catch {}
  return { ok:false, reason:"parse_failed" };
}

// 內部：驗證與規範化
function __validateToneJSON(obj) {
  const out = { level:"low", tags:[], crisis:false };
  if (obj && typeof obj === "object") {
    const map = { low:"low", mid:"mid", medium:"mid", high:"high" };
    const lv = String(obj.level ?? "").toLowerCase();
    out.level = map[lv] || "low";
    if (Array.isArray(obj.tags)) {
      out.tags = Array.from(new Set(obj.tags.map(x => String(x)).filter(Boolean))).slice(0, 12);
    }
    out.crisis = Boolean(obj.crisis);
  }
  return out;
}

async function promptApiProvider(inputText, { timeoutMs } = {}) {
  // 1) 抓命名空間（LanguageModel 優先，保留 ai.languageModel 相容）
  const LM = globalThis.LanguageModel || globalThis.ai?.languageModel;
  if (!LM) throw new Error("prompt_api_unavailable");

  // 2) 可用性檢查：不是 available 就不要硬等，直接回退
  try {
    const a = typeof LM.availability === "function" ? await LM.availability() : "available";
    var __LM_AVAIL = String(a).toLowerCase();
    if (__LM_AVAIL !== "available") throw new Error("prompt_api_not_ready:" + __LM_AVAIL);
  } catch {
    throw new Error("prompt_api_not_ready");
  }

  // 3) 逾時策略：冷啟動較長（預設 6000ms），暖機後 2000ms；呼叫端可覆寫
  const coldDefault = 6000;
  const warmDefault = 2000;
  const effTimeout = Number(timeoutMs ?? (__LM_WARMED ? warmDefault : coldDefault));

  // 4) 建立 session（用 Promise.race 控制逾時；避免依賴 AbortController.signal）
  const __t0 = Date.now();
  const session = await Promise.race([
    // 低溫 + 低 topK，降低多話
    LM.create({ temperature: 0.2, topK: 1 }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("prompt_api_timeout_create")), effTimeout))
  ]);

  try {
    const __tCreate = Date.now() - __t0;
    // 嚴格格式約束 + 正反例 + fallback 指令
    const prompt = [
      "You are a strict classifier.",
      "Return ONLY a single JSON object. No code fences, no markdown, no explanations.",
      "Schema: { level: 'low|mid|high', tags: string[], crisis: boolean }",
      "If unsure, return: {\"level\":\"low\",\"tags\":[],\"crisis\":false}",
      "",
      "Good example:",
      "{\"level\":\"mid\",\"tags\":[\"distress_lang\"],\"crisis\":false}",
      "Bad examples (do NOT do this):",
      "```json {\"level\":\"mid\"} ```",
      "Output: {\"level\":\"mid\"}",
      "",
      "Text:",
      JSON.stringify(String(inputText || "").slice(0, 800))
    ].join("\n");

    const __t1 = Date.now();
    const raw = await Promise.race([
      session.prompt(prompt),
      new Promise((_, rej) => setTimeout(() => rej(new Error("prompt_api_timeout_infer")), effTimeout))
    ]);
    const __tInfer = Date.now() - __t1;

    // 韌性解析 + 驗證
    const parsedTry = __robustParseJSON(raw);
    if (!parsedTry.ok) throw new Error("prompt_api_bad_response");
    const normalized = __validateToneJSON(parsedTry.value);
    if (!normalized || !normalized.level) throw new Error("prompt_api_bad_response");

    // 一次成功後視為暖機完成
    __LM_WARMED = true;

    // 規範化輸出
    const level = normalized.level;
    const tags = normalized.tags.slice();
    if (normalized.crisis === true && !tags.includes("crisis_lang")) tags.push("crisis_lang");

    // 以極小 heuristics 合併本地 hits（避免過度依賴）
    const local = localRulesProvider(inputText);
  // ================================================
  // 🧩 修二：危機降躁（雙側確認才升級）
  // ================================================
  const localHighHit = local.tags.includes("crisis_lang") || (local.signals.high?.length > 0);
  let mergedTags = Array.from(new Set([...local.tags, ...tags]));

  // 雙側同時命中才升級為危機
  let crisis = false;
  if (tags.includes("crisis_lang") && localHighHit) {
    crisis = true;
    if (!mergedTags.includes("crisis_lang")) mergedTags.push("crisis_lang");
  } else {
    // 單側命中則降躁為 distress_lang
    mergedTags = mergedTags.filter(t => t !== "crisis_lang");
    if (!mergedTags.includes("distress_lang")) mergedTags.push("distress_lang");
  }

  // ================================================
  // 🧩 修三：Mid 下限（焦慮/壓力/睡不好 → 最低 mid）
  // ================================================
  let mergedLevel = "low";
  if (crisis) {
    mergedLevel = "high";
  } else if (level === "mid" || local.level === "mid") {
    mergedLevel = "mid";
  } else {
    const txt = String(inputText || "").toLowerCase();
    if (/(anxiety|anxious|stress|壓力|焦慮|睡不好)/i.test(txt)) {
      mergedLevel = "mid";
    } else {
      mergedLevel = "low";
    }
  }

  // 🩹 補釘：在 prompt 路徑也套用本地的 p1/rj 輕規則
  const textL = String(inputText || "");
  const p1Hit = LEX.p1.some(re => re.test(textL));
  const rjHit = LEX.rj.some(re => re.test(textL));
  if (p1Hit && !mergedTags.includes("p1")) mergedTags.push("p1");
  if (rjHit && !mergedTags.includes("rj")) mergedTags.push("rj");
  // 焦慮與生理：與 local 對齊，補上 anxious_cue / physio
  if (__anxiousHeuristics(textL) && !mergedTags.includes("anxious_cue")) mergedTags.push("anxious_cue");
  if (LEX.physio.some(re => re.test(textL)) && !mergedTags.includes("physio")) mergedTags.push("physio");

  return {
    level: mergedLevel,
    score: local.score,
    tags: Array.from(new Set([
      ...mergedTags,
      ...((local.signals?.ask?.length || 0) ? ["ask_approach"] : [])
    ])),
    signals: { prompt: normalized, local: local.signals },
    meta: {
      provider: "prompt",
      fallback: false,
      // 供續聊語境使用（不存全文）：
      summaryHint: makeUltraBrief(String(inputText || "")),
      keywords: extractSummaryKeywords(String(inputText || "")),      
      debug: {
        lmAvail: __LM_AVAIL || "unknown",
        usedTimeoutMs: effTimeout,
        warmedBefore: __LM_WARMED,
        t: {
          createMs: __tCreate,
          inferMs: __tInfer,
          totalMs: (Date.now() - __t0)
        },
        rawPreview: String(raw).slice(0, 200),
       parseStage: parsedTry.stage || "unknown"
      }
    }
  };
  } finally {
    try { session?.destroy?.(); } catch {}
  }
}

/**
 * 對外主介面：自動或指定 provider，並具備逾時/回退。
 * @param {string} inputText
 * @param {{mode?: "auto"|"local"|"prompt", env?: any, timeoutMs?: number}} opts
 */
export async function detectTone(inputText, opts = {}) {
  const mode = opts.mode || "auto";
  if (mode === "local") return localRulesProvider(inputText);
  if (mode === "prompt") {
    try {
      return await promptApiProvider(inputText, { timeoutMs: opts.timeoutMs });
    } catch (e) {
      const r = localRulesProvider(inputText);
      r.meta.fallback = true;
      // 附帶錯誤原因與階段，方便除錯
      try {
        const msg = String(e && (e.message || e));
        r.meta.error = msg;
        if (/timeout_create/i.test(msg)) r.meta.errorStage = "create";
        else if (/timeout_infer/i.test(msg)) r.meta.errorStage = "infer";
        else if (/not_ready/i.test(msg)) r.meta.errorStage = "availability";
        else if (/bad_response/i.test(msg)) r.meta.errorStage = "parse";        
      } catch {}
      return r;
    }
  }
  // auto：依 env.canUsePromptAPI 決定
  if (opts.env?.canUsePromptAPI) {
    try {
      return await promptApiProvider(inputText, { timeoutMs: opts.timeoutMs });
    } catch (e) {
      const r = localRulesProvider(inputText);
      r.meta.fallback = true;
      try {
        const msg = String(e && (e.message || e));
        r.meta.error = msg;
        if (/timeout_create/i.test(msg)) r.meta.errorStage = "create";
        else if (/timeout_infer/i.test(msg)) r.meta.errorStage = "infer";
        else if (/not_ready/i.test(msg)) r.meta.errorStage = "availability";
        else if (/bad_response/i.test(msg)) r.meta.errorStage = "parse";
      } catch {}
      return r;
    }
  }
  return localRulesProvider(inputText);
}

// 兼容舊接口：保留 scoreText() 名稱，等同 detectTone()
export function scoreText(input) {
  return localRulesProvider(input);
}

// =============================
// 🧩 續聊鉤子（純函式；不觸庫）
// =============================
/**
* 取第一句/主要子句，去除多餘空白與包引號，限制長度。
 * 與 SW 版本邏輯對齊；此處暴露給呼叫端當作「摘要建議」。
 */
export function makeUltraBrief(s = "", max = 80) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const first = t.split(/(?<=[。！？!?｡]|\.|\?|!|;|；)/)[0] || t;
  const cleaned = first.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

 /**
 * 超輕量關鍵詞抽取（英/中粗略版；無外依賴）
 * - 英文：長度≥3 的單字，頻次排序
 * - 中文：去除常見助詞/虛詞的單字，頻次排序（保守；避免洩露全文）
 * 回傳不超過 max 個去重關鍵詞（小寫/原樣混合，僅供 UI/摘要提示）
 */
export function extractSummaryKeywords(text = "", max = 5) {
  const s = String(text || "").trim();
  if (!s) return [];
  const en = (s.match(/\b[a-zA-Z]{3,}\b/g) || []).map(w => w.toLowerCase());
  const zhChars = (s.match(/[\u4e00-\u9fff]/g) || []);

  const EN_STOP = new Set([
    "the","and","for","with","that","this","have","from","your","about",
    "just","really","very","much","been","into","will","what","when","where",
    "how","why","like","feel","feelings","today","these","those","over","under"
  ]);
  const ZH_STOP = new Set(["我","你","他","她","它","們","的","了","呢","嗎","在","是","很","不","沒","無","與","和","及","就","也","而","還","又","都","被","把","要","會","像","讓","著"]);

  const freq = new Map();
  for (const w of en) {
    if (EN_STOP.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  for (const ch of zhChars) {
    if (ZH_STOP.has(ch)) continue;
    // 過濾數字/標點
    if (!/[\u4e00-\u9fff]/.test(ch)) continue;
    freq.set(ch, (freq.get(ch) || 0) + 1);
  }
  const ranked = [...freq.entries()].sort((a,b) => b[1]-a[1]).map(x => x[0]);
  return ranked.slice(0, Math.max(1, Math.min(12, Number(max)||5)));
}