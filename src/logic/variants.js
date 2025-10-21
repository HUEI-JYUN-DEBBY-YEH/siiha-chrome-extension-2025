// src/logic/variants.js
// Neutral helpers + pillar/length resolver.
// Shared by Ext/UI with external configs (jitter.*, routeWeights.*).

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s = "") {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function shuffle(list, rnd) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Deterministic bucket rotation across devices/audiences.
 * @param {Array<any>} arr
 * @param {number} seed
 * @param {string} salt - e.g., "ext" or "ui"
 * @returns {Array<any>}
 */
function rotateBuckets(arr, seed, salt = "") {
  const rnd = mulberry32(hashString(String(seed) + "::" + String(salt)));
  return shuffle(arr, rnd);
}

// --- light text variation helpers ---

// quick CJK detector to avoid English-specific tweaks on CJK lines
function hasCJK(str) {
  return /[\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF]/.test(str || "");
}

/**
 * Apply small, probabilistic surface variations to a single line.
 * The probability should come from jitter config: textVariation.probability
 * @param {string} s
 * @param {{probability:number}} cfg
 * @param {Function} rnd
 */
function microTweakLine(s, cfg = { probability: 0 }, rnd = Math.random) {
  if (!s) return s;
  const prob = Math.max(0, Math.min(1, Number(cfg.probability || 0)));
  if (prob === 0) return s;

  const p = rnd();
  let out = s;

  // punctuation swap (em/en dash)
  if (p < prob * 0.33) {
    out = out.replace(/—/g, "–");
  }
  // subtle contraction swap — skip for CJK lines
  else if (p < prob * 0.66 && !hasCJK(out)) {
    out = out.replace(/\bI am\b/g, "I’m").replace(/\bI’m\b/g, "I'm");
  }
  // softener phrase — skip for CJK lines
  else if (p < prob && !hasCJK(out)) {
    out = out.replace(/\bTry\b/g, "You could try");
  }

  return out;
}

/**
 * Apply micro tweaks to an array of lines
 * @param {string[]} lines
 * @param {{probability:number}} cfg
 * @param {Function} rnd
 */
function microTweakLines(lines = [], cfg = { probability: 0 }, rnd = Math.random) {
  return lines.map(line => microTweakLine(line, cfg, rnd));
}

/**
 * Thin wrapper for jitter config block: { enabled, probability }
 * @param {string[]} lines
 * @param {{enabled:boolean, probability:number}} textVariationCfg
 * @param {Function} rnd
 */
function applyTextVariation(lines = [], textVariationCfg = { enabled: false, probability: 0 }, rnd = Math.random) {
  if (!textVariationCfg?.enabled) return lines;
  return microTweakLines(lines, { probability: textVariationCfg.probability || 0 }, rnd);
}

/**
 * Lightweight weighted-pick from [{item, weight}]
 * @param {{item:any, weight:number}[]} items
 * @param {Function} rnd
 */
function weightedPick(items = [], rnd = Math.random) {
  const total = items.reduce((s, it) => s + (it.weight || 0), 0);
  if (total <= 0) return items[0]?.item;
  let r = rnd() * total;
  for (const it of items) {
    r -= (it.weight || 0);
    if (r <= 0) return it.item;
  }
  return items[items.length - 1]?.item;
}

// ======================================================================
// Pillar resolver: (pillar, length, locale, continuation?) → structure & keys
// ======================================================================
const __TL = {
  tri:   (loc) => `tri.short.${loc}`, 
  lp_u:  (loc) => `lp.u.${loc}`,      
  lp_e:  (loc) => `lp.e.${loc}`      
};

function __normLoc(localeLike) {
  return "en";
}

/**
 * @param {"a7f2"|"b3c1"|"d401"} pillar
 * @param {"short"|"medium"|"long"} length
 * @param {string} localeLike
 * @param {boolean} [isContinuation=false]
 * @returns {{assemble:string[], templateKeys:Object, paragraphs:number, localeHint:string}}
 */
function resolvePillarVariant(pillar, length, localeLike, isContinuation = false) {
  const loc = __normLoc(localeLike);
  const out = { assemble: [], templateKeys: {}, paragraphs: 1, localeHint: loc };
  if (isContinuation) {
    out.assemble = ["handoff", "a", "b"];
    out.templateKeys = {
      handoff: `ph.${loc}.pool`,
      a: `${__TL.tri(loc)}.a`,
      b: `${__TL.tri(loc)}.b`
    };
    out.paragraphs = 1;
    return out;
  }
  // 一般：依段長組結構（pillar 不改結構，只決定模板池）
  if (length === "short") {
    out.assemble = ["a", "b", "c"];
    out.templateKeys = {
      a: `${__TL.tri(loc)}.a`,
      b: `${__TL.tri(loc)}.b`,
      c: `${__TL.tri(loc)}.c`
    };
    out.paragraphs = 1;
  } else if (length === "medium") {
    out.assemble = ["p1", "p2"];
    out.templateKeys = {
      p1: `${__TL.lp_u(loc)}.p1`,
      p2: `${__TL.lp_u(loc)}.p2`
    };
    out.paragraphs = 2;
  } else { // long
    out.assemble = ["p1", "p2", "p3"];
    out.templateKeys = {
      p1: `${__TL.lp_e(loc)}.p1`,
      p2: `${__TL.lp_e(loc)}.p2`,
      p3: `${__TL.lp_e(loc)}.p3`
    };
    out.paragraphs = 3;
  }
  return out;
}

// --- ESM exports (preferred) ---
export {
  mulberry32,
  hashString,
  shuffle,
  rotateBuckets,
  microTweakLine,
  microTweakLines,
  applyTextVariation,
  weightedPick,
  resolvePillarVariant
};

// --- Optional CommonJS fallback (Node without ESM) ---
// eslint-disable-next-line no-undef
if (typeof module !== 'undefined' && module.exports) {
  // eslint-disable-next-line no-undef
  module.exports = {
    mulberry32,
    hashString,
    shuffle,
    rotateBuckets,
    microTweakLine,
    microTweakLines,
    applyTextVariation,
    weightedPick,
    resolvePillarVariant
  };
}
