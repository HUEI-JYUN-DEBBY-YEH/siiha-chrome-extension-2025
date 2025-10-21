// src/logic/envCheck.js
// 目的：在任何 AI/模板流程之前偵測環境能力，輸出單一快照供決策。
// 不發送使用者文本、只做功能探測。
// - 本檔加入：將 LanguageModel 可用性字串納入 snapshot 以便觀測。

// --- 模組級快取（避免頻繁探針） ---
let __ENV_CACHE = null;      // { snapshot, ts }
const __ENV_TTL = 10_000;    // 10s 內直接回快取

/**
 * 粗略平台判斷
 */
function detectPlatform() {
  const ua = navigator.userAgent || "";
  const isChrome = /\bChrome\/\d+/.test(ua) || /\bChromium\/\d+/.test(ua);
  const isAndroid = /Android/i.test(ua);
  const isMobile = /Mobile/i.test(ua);
  if (isChrome && !isMobile && !isAndroid) return "chrome-desktop";
  if (isChrome && (isMobile || isAndroid)) return "chrome-mobile";
  return "other";
}

/**
 * 擷取 Chrome 主版號；未知回 null
 */
function getChromeMajor() {
  const ua = navigator.userAgent || "";
  const m = ua.match(/\bChrome\/(\d+)/) || ua.match(/\bChromium\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * 嘗試檢查 Prompt API 是否可用（不送使用者內容）
 * - 存在 globalThis.ai.languageModel
 * - 能夠成功 create（或至少不被 policy 拒絕）
 */
async function probePromptAPI() {
  const out = { canUse: false, policyLocked: false, explain: [], availability: "unknown" };
  try {
    // ✅ 以 LanguageModel 為主；保留 ai.languageModel 相容
    const LM = globalThis.LanguageModel || globalThis.ai?.languageModel;
    if (!LM) {
      out.explain.push("No built-in AI is available here (LanguageModel unavailable).");
      return out;
    }

    // 先讀可用性（available / downloadable / downloading / unavailable）
    if (typeof LM.availability === "function") {
      try { out.availability = await LM.availability(); } catch {}
    }
    const a = String(out.availability || "").toLowerCase();

    // 視作「可用」的情況：已可用、可下載、或下載中（首次使用會觸發下載）
    if (a === "available" || a === "downloadable" || a === "downloading") out.canUse = true;
    if (a === "downloadable") out.explain.push("The model can be downloaded. Chrome will fetch it automatically the first time.");
    if (a === "downloading")  out.explain.push("The model is downloading…");
    if (a === "unavailable")  out.explain.push("This device doesn’t support built-in models, or requirements aren’t met.");

    // 僅在 truly available 時做最小 create 驗證；逾時只記錄，不強制 canUse=false
    if (a === "available" && typeof LM.create === "function") {
      try {
        const session = await Promise.race([
          LM.create(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("probe_timeout")), 900))
        ]);
        try { session?.destroy?.(); } catch {}
      } catch (err) {
        const msg = String(err?.message || err || "");
        if (/policy|enterprise|managed|disabled/i.test(msg)) {
          out.policyLocked = true;
          out.explain.push("Built-in AI may be disabled by an enterprise policy on this device.");
        } else if (/timeout/i.test(msg)) {
          out.explain.push("Timed out creating the built-in AI (it may still be initializing).");
        } else {
          out.explain.push("Failed to create the built-in AI (it may be temporarily unavailable).");
        }
      }
    }
  } catch {
    out.explain.push("An error occurred while checking the built-in AI.");
  }
  return out;
}

/**
 * 網路可達性（僅供建議用途）
 */
function hasNetworkNow() {
  // navigator.onLine 並不保證能上網，但足夠做建議分流
  return navigator.onLine;
}

/**
 * 將能力映射成建議模式（本期不做 hybrid → 僅 local/demo）
 */
function decideMode({ platform, canUse, policyLocked, online, chromeOK }) {
  // 版本不足或非桌面：demo
  if (!chromeOK || platform !== "chrome-desktop") return "demo";
  // 桌面且 Prompt API 可用：local
  if (canUse) return "local";
  // 其餘（含政策鎖/尚未下載模型/線上線下）先統一走 demo（不開 hybrid）
  return "demo";
}

/**
 * Public: 產生環境快照
 * 可傳入 preferMode 覆寫（"local"|"demo"），以及是否忽略快取。
 * @returns {Promise<{canUsePromptAPI:boolean, hasNetwork:boolean, platform:string, policyLocked:boolean, recommendedMode:"local"|"demo", explain:string[], chromeMajor:number|null}>}
 */
export async function envCheck(opts = {}) {
  const now = Date.now();
  if (!opts.force && __ENV_CACHE && (now - __ENV_CACHE.ts) < __ENV_TTL) {
    return __ENV_CACHE.snapshot;
  }

  const explain = [];
  const platform = detectPlatform();
  const online = hasNetworkNow();
  const chromeMajor = getChromeMajor();
  const chromeOK = (chromeMajor ?? 0) >= 138;

  const probe = await probePromptAPI();
  if (platform !== "chrome-desktop") {
    explain.push("Use desktop Chrome 138+ to enable built-in AI.");
  }
  if (platform === "chrome-desktop" && !chromeOK) {
    explain.push(`Detected Chrome ${chromeMajor ?? "unknown"}(requires 138+). Please update your browser.`);
  }
  if (!probe.canUse && !probe.policyLocked) {
    explain.push("Built-in AI isn’t enabled or the model isn’t downloaded. Follow the guide to enable it, or use another mode for now.");
    if (platform === "chrome-desktop" && chromeOK) {
      explain.push("Tip: check chrome://flags to see if Prompt API / AI features are enabled (enterprise devices may be locked).");
    }
  }
  if (probe.policyLocked) {
    explain.push("Possible enterprise policy detected — switching to Demo mode.");
  }
  if (!online) {
    explain.push("Offline detected: if the model hasn’t been downloaded before, we’ll use Demo for now.");
  }

  const recommendedMode = decideMode({
    platform,
    canUse: probe.canUse,
    policyLocked: probe.policyLocked,
    online,
    chromeOK
  });

  // 合併子訊息
  const finalExplain = [...probe.explain, ...explain];

  const snapshot = {
    canUsePromptAPI: probe.canUse,
    hasNetwork: online,
    platform,
    policyLocked: probe.policyLocked,
    recommendedMode,
    explain: finalExplain,
    chromeMajor,
    lmAvailability: String(probe.availability || "unknown"),
    // 🆕 對外四態（供 orchestrator/UI 判讀）
    model_state: (() => {
      const a = String(probe.availability || "unknown").toLowerCase();
      if (a === "available")   return online ? "ready-online" : "ready-offline";
      if (a === "downloading") return "downloading";
      if (a === "downloadable")return online ? "downloading" : "none";
      return "none";
    })(),
    // 🆕 探針時間（本地毫秒）
    last_checked_ts: now
  };

  __ENV_CACHE = { snapshot, ts: now };
  return snapshot;
}

export default envCheck;

// --- 線上/離線事件：自動更新快取（僅更新 hasNetwork 與時間戳） ---
try {
  window.addEventListener("online", () => {
    if (__ENV_CACHE?.snapshot) {
      __ENV_CACHE.snapshot.hasNetwork = true;
      __ENV_CACHE.ts = Date.now();
    }
  });
  window.addEventListener("offline", () => {
    if (__ENV_CACHE?.snapshot) {
      __ENV_CACHE.snapshot.hasNetwork = false;
      __ENV_CACHE.ts = Date.now();
    }
  });
} catch {}