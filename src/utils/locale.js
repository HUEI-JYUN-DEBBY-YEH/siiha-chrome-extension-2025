// utils/locale.js
// 單一口徑：語言決策已統一鎖定英語。
// 注意：classifyZh 只供偵測/分數用，不參與路由或模板語言選擇。

export function classifyZh(s) {
  if (!s) return false;
  return /[\u4E00-\u9FFF]/.test(String(s));
}

export function normalizeLocale(raw) {
  // 無論輸入為何，一律回 'en'
  return "en";
}

export async function resolvePreferredLocale({ text, Prefs, Runtime } = {}) {
  // 一律英語，避免任何外部條件（文字/偏好/UI/navigator）改變語言。
  return "en";
}

// （選擇 style_id 時可能需要）按 locale 給出語言優先順序片段
export function preferenceOrderFromLocale(locale = "en") {
  // 僅保留英語模板鍵
  return ["_en_"];
}
