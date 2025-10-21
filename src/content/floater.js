// SIIHA v0.1 — Floater
(async () => {
  // ===============================
  // Theme palette（固定 3–5 桶，不每碼一色）
  // ===============================
  const THEME_BUCKETS = ["default","warm","neutral","alert"];
  function getThemeBucket(styleCode = "") {
    const s = String(styleCode || "").toLowerCase();
    const p2 = s.slice(0, 2);
    // 白名單（精準碼；三柱）
    if (s === "a7f2") return "warm";
    if (s === "b3c1") return "neutral";
    if (s === "d401") return "alert";
    // 前兩位歸桶（僅三柱家族）
    if (["a6","a7","a8"].includes(p2)) return "warm";
    if (["b2","b3","b4"].includes(p2)) return "neutral";
    if (["d3","d4","d5"].includes(p2)) return "alert";
    return "default";
  }
  function ensureThemeStyles() {
    if (document.getElementById("siiha-theme-styles")) return;
    const style = document.createElement("style");
    style.id = "siiha-theme-styles";
    style.textContent = `
      .siiha-theme-default{border:1px solid #e5e7eb;box-shadow:0 10px 30px rgba(0,0,0,.18)}
      .siiha-theme-warm   {border:1px solid #ffe1b3;box-shadow:0 10px 30px rgba(0,0,0,.18),0 0 0 2px #f59e0b22}
      .siiha-theme-neutral{border:1px solid #cfd8e3;box-shadow:0 10px 30px rgba(0,0,0,.18),0 0 0 2px #3b82f622}
      .siiha-theme-alert  {border:1px solid #f3c0c0;box-shadow:0 10px 30px rgba(0,0,0,.18),0 0 0 2px #ef444422}
      /* chat tokens */
      #siiha-chat-input{font:inherit}
      `;
    document.head.appendChild(style);
  }

  // 動態匯入，保證在任何 content script 環境都能載到 ESM
  const { default: Storage } = await import(
    chrome.runtime.getURL("src/logic/storage.js")
  );

  // 若已掛載就不重複
  if (window.__siihaFloaterMounted__) return;

  // ===============================
  // Stage 1 → 準備工具與全域狀態
  // ===============================

  // 先宣告所有容器變數，避免 TDZ / ReferenceError
  let crisis, chatBox, nudge, bubble, btn, panelWrap, root, btnNopeSlice;
  let crisisBanner; // sticky 危機提示（取代 composer 裡的晶片）
  // dev dot tooltip
  let devTip, devTipPinnedTimer = null, devTipPinnedUntil = 0;
  let groundingBox; // 🧘 container
  // crisis chip session flags（本檔活期）
  let crisisChipDismissedSession = false;
  let crisisChipDismissedAtSession = 0;   // 這個分頁本次點掉的時間（ms）

  // 四向錨點：'lt' | 'rt' | 'lb' | 'rb'
  let anchorMode = "rb"; // 預設右下錨點
  // 長按/移動 才進入拖曳
  const PRESS_MS = 180;
  const MOVE_PX  = 6;
  let dragArmed = false, dragging = false, pressTimer = null;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  const CHAT_BOTTOM_DEFAULT = "88px";
  const CHAT_BOTTOM_RAISED = "180px"; // 與 nudge 堆疊時抬高（垂直堆疊後多為保險）
  const EDGE_GAP = 8;                 // 視窗邊界保留距
  const STACK_GAP = "8px";            // 卡片與泡泡之間的小間距
  const SNAP_PX = 12;                 // 邊緣吸附閾值（px）

  // ---- 小工具 ----
  const css = (el, o) => el && Object.assign(el.style, o);
  const $ = (sel) => document.querySelector(sel);
  // 擴充仍存活？（避免被卸載後還呼叫 storage）
  function extAlive() { try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch { return false; } }

  const CRISIS_URL = chrome.runtime.getURL("src/data/crisis_local.json");
  let __CRISIS_CACHE__ = null;

  // 🧘 grounding data (local)
  const GROUNDING_URL = chrome.runtime.getURL("src/data/grounding_local.json");
  let __GROUNDING_CACHE__ = null;
  async function loadCrisis() {
    if (__CRISIS_CACHE__) return __CRISIS_CACHE__;
    try {
      const res = await fetch(CRISIS_URL, { cache: "no-store" });
      __CRISIS_CACHE__ = await res.json();
      console.log("[SIIHA/Content] Crisis data loaded successfully.");
    } catch (e) {
      console.warn("[SIIHA/Content] Crisis data load failed — using offline fallback.", e);
      __CRISIS_CACHE__ = {
        protective_hold: {
          title: "You’re not alone.",
          subtitle: "Pause for a moment. Let this breath bring you back to safety.",
          steps: [
            "Take one slower breath in, and an even slower breath out.",
            "Place your attention on your feet or your hands for 10 seconds.",
            "Step away from the screen for one minute, have a sip of water.",
            "If you are in real danger, please reach out to local emergency services."
          ],
          disclaimer: "This is an offline support card — not medical advice."
        }
      };
    }
    return __CRISIS_CACHE__;
  }

  // 🧘 load grounding packs (SW 也可能回包；此為保險/本地直讀)
  async function loadGrounding() {
    if (__GROUNDING_CACHE__) return __GROUNDING_CACHE__;
    try {
      const res = await fetch(GROUNDING_URL, { cache: "no-store" });
      const js = await res.json();
      // 將 units 正規化為 packs：同一結構供前景 UI 使用
      const packs = normalizeUnitsToPacks(js?.units || []);
      __GROUNDING_CACHE__ = { packs };
      console.log("[SIIHA/Content] Grounding data loaded & normalized.");
    } catch (e) {
      console.warn("[SIIHA/Content] Grounding data load failed:", e);
      __GROUNDING_CACHE__ = {
        packs: [
          {
            id:"fallback-10",
            duration_s: 10,
            kind: "senses",
            label: "Quick breath • 10 sec",
            intro: "Tiny check-in. Nothing to fix.",
            steps:["Inhale slowly…","Exhale even slower…"],
            guidance: "Read the line once, then tap Next.",
            outro:["That counts. A micro step is still a step."]
          },
          {
            id:"fallback-60",
            duration_s: 60,
            kind: "senses",
            label: "Ground • 1 min",
            intro: "Let’s land in the room together.",
            steps:["Feet on the floor.","Name one color you see.","Relax your jaw."],
            guidance: "Read the line once, then tap Next.",
            outro:["Good. If it helped a little, that’s enough for now."]
          },
          {
            id:"fallback-120",
            duration_s: 120,
            kind: "senses",
            label: "Body scan • 2 min",
            intro: "Two quiet minutes. You can stop anytime.",
            steps:["Place hand on chest.","Feel 3 breaths.","Look around and name 3 shapes."],
            guidance: "Read the line once, then tap Next.",
            outro:["How’s the room feel now—1% different is still different."]
          }
        ]
      };
    }
    return __GROUNDING_CACHE__;
  }

  // 將 schema: units[] → packs[]，並展開 breath 的 beats×loops
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
        const steps = Array.from({length:loops})
          .flatMap((_,i)=> oneCycle.map(s=> s));
        return {
          id: u.id, label: u.label, duration_s: Number(u.duration_s||0),
          kind: "breath",
          intro: u.intro || "We’ll do gentle cycles. Adjust pace if you need.",
          guidance: `Follow the labels at your pace.${loops>1?` We’ll do ${loops} cycles.`:" When you finish one cycle, tap Next."}`,
          steps,
          outro: Array.isArray(u.outro)?u.outro:[]
        };
      }
      // senses / scan
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

  // Prompt API 可用性（預留孔）
  function detectAI() {
    try {
      const ok = !!(globalThis.ai && typeof globalThis.ai?.canCreateTextSession === "function");
      return { aiReady: ok };
    } catch {
      return { aiReady: false };
    }
  }
  const CAP = detectAI();

  // ===============================
  // Stage 2 → 生成所有 DOM 元素
  // ===============================

  // Root（可拖曳的母容器）
  root = document.createElement("div");
  css(root, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    display: "flex",
    flexDirection: "column",   // 垂直堆疊
    alignItems: "flex-end",    // 由右側對齊，展開時不推動按鈕
    gap: STACK_GAP,            // 卡片緊貼泡泡
    zIndex: 2147483642,
    pointerEvents: "auto",
    transition: "transform 0.15s ease-out"
  });
  document.body.appendChild(root);

  // ✅ 成功附著後才標記掛載旗標（便於 console 驗證）
  window.__siihaFloaterMounted__ = true;
  console.log("[SIIHA] Floater successfully attached");

  // Bubble（對話啟動卡）
  bubble = document.createElement("div");
  css(bubble, {
    position: "relative",
    width: "340px",
    minHeight: "120px",
    background: "white",
    borderRadius: "16px",
    boxShadow: "0 10px 30px rgba(0,0,0,.25)",
    padding: "16px",
    display: "none",
    opacity: "0",
    transform: "translateY(8px)",
    transition: "opacity 0.25s ease, transform 0.25s ease",
    zIndex: 2147483647,
    pointerEvents: "auto"
  });
  bubble.innerHTML = `
    <h3 style="margin:0 0 8px;font-weight:600;">Hi, I’m SIIHA.</h3>
    <div style="opacity:.85;line-height:1.6;margin-bottom:8px">
      I’m here to keep you company and offer gentle pauses when life feels heavy.
    </div>
    <div style="font-size:12px;opacity:.7;margin-bottom:12px;">
      This chat stays in your browser — local, private, and short-lived.
    </div>
    <button id="siiha-start-chat"
      style="padding:8px 12px;border-radius:10px;border:none;background:#111;color:#fff;cursor:pointer;">
      Start chat
    </button>
  `;

  // Panel Wrap（包三卡）
  panelWrap = document.createElement("div");
  css(panelWrap, {
    position: "relative",
    display: "flex",
    flexDirection: "column",   // 上 → 下：crisis → chat → nudge
    alignItems: "flex-end",
    gap: STACK_GAP,    
    zIndex: 2147483643,
    pointerEvents: "auto"
  });

  // 小人按鈕
  btn = document.createElement("img");
  btn.src = chrome.runtime.getURL("src/assets/guardian.png");
  css(btn, {
    position: "absolute",      // 讓按鈕咬在 panelWrap 的角落
    width: "56px",
    height: "56px",
    borderRadius: "50%",
    boxShadow: "0 6px 18px rgba(0,0,0,.18)",
    background: "white",
    cursor: "grab",
    transition: "transform 0.2s ease",
    pointerEvents: "auto",
    zIndex: 2147483643
  });

  // Chat 視窗
  chatBox = document.createElement("div");
  css(chatBox, {
    position: "relative",      // 改為相對，跟著 root 垂直堆疊
    width: "432px", minHeight: "240px",   // ↔ 統一寬度
    maxHeight: "60vh",                    // 只讓內層滾動，卡片不長高
    background: "white", borderRadius: "16px",
    boxShadow: "0 10px 30px rgba(0,0,0,.25)",
    padding: "12px 12px 16px",
    boxSizing: "border-box",
    display: "none",
    zIndex: 2147483647,
    flexDirection: "column"
  });
  chatBox.innerHTML = `
    <!-- sticky 危機提示：不擠壓 composer -->
    <button id="siiha-crisis-banner" type="button"
      style="display:none;position:sticky;top:0;z-index:1;margin:-2px -2px 8px -2px;padding:6px 10px;
             border-radius:10px;border:1px solid #f3c0c0;background:#fff7f7;color:#b00020;cursor:pointer;font-size:12px;line-height:18px;">
      I need grounding
    </button>
    <div id="siiha-chat-log" style="flex:1;overflow-y:auto;min-height:160px;margin-bottom:8px;line-height:1.5;font-size:14px;"></div>
    <!-- 🆕 麵包屑列（承接） -->
    <div id="siiha-breadcrumb" style="display:none;margin:-2px 0 6px 0;font-size:12px;color:#6b7280;">
      <span id="siiha-breadcrumb-text"></span>
      <span style="margin-left:8px;opacity:.9">
        <a href="#" id="siiha-bc-toggle" style="color:#6b7280;text-decoration:underline;">Expand context</a>
        <span style="margin:0 6px;">·</span>
        <a href="#" id="siiha-bc-hide" style="color:#6b7280;text-decoration:underline;">Hide</a>
      </span>
      <div id="siiha-breadcrumb-list" style="display:none;margin-top:4px;white-space:pre-line;"></div>
    </div>
    <!-- 🆕 隱私告知（一次性顯示；不落地） -->
    <div id="siiha-privacy-note" data-volatile="1"
         style="display:none;margin:0 0 6px 0;font-size:11px;color:#9ca3af;">
      For your privacy, SIIHA doesn’t save full conversations. It keeps a short recent context so replies can pick up naturally. You can adjust this in Options.
    </div>
    <div id="siiha-composer" style="display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:8px;">
      <button id="siiha-chat-newtopic" title="Start a new topic (clears recent context only)"
        style="padding:8px 10px;border-radius:10px;border:1px solid #ddd;background:#fafafa;cursor:pointer;box-sizing:border-box;min-width:84px;text-align:center;">      
        New topic
      </button>
      <!-- ⬅️ textarea：自動長高至上限，超過改為內卷軸；字體沿用全域 -->
      <textarea id="siiha-chat-input" placeholder="Type a message"
        style="min-width:0;padding:8px 10px;border-radius:10px;border:1px solid #ddd;outline:none;box-sizing:border-box;max-width:100%;
               height:44px;min-height:44px;max-height:104px;overflow:auto;resize:none;line-height:1.4;font:inherit;font-size:14px;"></textarea>
      <button id="siiha-chat-send" style="padding:8px 12px;border-radius:10px;border:none;background:#111;color:#fff;cursor:pointer;box-sizing:border-box;min-width:64px;">Send</button>        
    </div>
  `;
  const chatLog = chatBox.querySelector("#siiha-chat-log");
  crisisBanner = chatBox.querySelector("#siiha-crisis-banner");
  const bcWrap = chatBox.querySelector("#siiha-breadcrumb");
  const bcText = chatBox.querySelector("#siiha-breadcrumb-text");
  const bcList = chatBox.querySelector("#siiha-breadcrumb-list");
  const bcToggle = chatBox.querySelector("#siiha-bc-toggle");
  const bcHide = chatBox.querySelector("#siiha-bc-hide");

  const chatInput = chatBox.querySelector("#siiha-chat-input");
  const chatSend = chatBox.querySelector("#siiha-chat-send");
  const chatNewTopic = chatBox.querySelector("#siiha-chat-newtopic");

  // ⬇️ 讓 textarea 在上限前自動長高（超過則保留內捲軸）
  function autosizeTextarea(el) {
    try {
      const max = parseInt(getComputedStyle(el).maxHeight, 10) || 120;
      el.style.height = "auto";
      const next = Math.min(el.scrollHeight, max);
      el.style.height = next + "px";
    } catch {}
  }
  chatInput.addEventListener("input", () => autosizeTextarea(chatInput));
  // 首次進入時也跑一次，避免還原舊文字時高度不對
  autosizeTextarea(chatInput);
  
  // --- 永遠把聊天視窗捲到最底（排版完成後再捲動，避免卡住） ---
  function scrollChatToBottom() {
    // 兩次 rAF 確保 DOM 與樣式都完成（包含剛 append 的節點高度）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          chatLog.scrollTop = chatLog.scrollHeight;
        } catch {}
      });
    });
  }

  // Chat Close 按鈕
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  css(closeBtn, {
    position: "absolute",
    top: "-6px",
    right: "-6px",
    width: "28px",
    height: "28px",
    border: "none",
    borderRadius: "50%",
    background: "rgba(255,255,255,0.9)",
    boxShadow: "0 1px 4px rgba(0,0,0,.1)",
    fontSize: "18px",
    lineHeight: "26px",
    textAlign: "center",
    cursor: "pointer"
  });
  chatBox.appendChild(closeBtn);
 
  // 🆕 Dev 小點（右上角）+ 命中擴大 wrapper（避免被 btn 吃 hover）
  const devDotWrap = document.createElement("div");
  devDotWrap.id = "siiha-dev-wrap";
  css(devDotWrap, {
    position: "absolute",
    top: "-10px",
    left: "-10px",
    width: "22px",
    height: "22px",
    pointerEvents: "auto",
    display: "none"
  });
  const devDot = document.createElement("div");
  devDot.id = "siiha-dev-dot";
  css(devDot, {
    position: "absolute",
    top: "4px",
    left: "4px",
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    background: "#bbb",
    boxShadow: "0 0 0 2px rgba(255,255,255,.9)",
    display: "none",
    cursor: "default"
  });
  devDotWrap.appendChild(devDot);
  chatBox.appendChild(devDotWrap);

  // 🆕 自製 tooltip（跟著滑鼠、可固定 3 秒）
  devTip = document.createElement("div");
  Object.assign(devTip.style, {
    position: "fixed",
    maxWidth: "260px",
    padding: "6px 8px",
    borderRadius: "6px",
    background: "rgba(17,17,17,.92)",
    color: "#fff",
    fontSize: "12px",
    lineHeight: "1.4",
    whiteSpace: "pre-wrap",
    boxShadow: "0 6px 18px rgba(0,0,0,.25)",
    zIndex: "2147483655", // 會在 applyDynamicZ 中被覆寫抬高
    pointerEvents: "none",
    display: "none"
  });
  document.body.appendChild(devTip);

  // 提醒泡泡（背景鬧鐘觸發）
  nudge = document.createElement("div");
  css(nudge, {
    position: "relative",      // 改為相對，跟著 root 垂直堆疊
    width: "432px", background: "white", borderRadius: "16px",
    boxShadow: "0 10px 30px rgba(0,0,0,.25)", padding: "16px",
    display: "none", zIndex: 2147483647
  });
  nudge.innerHTML = `
    <div style="font-weight:600;margin-bottom:6px;">Take a short pause?</div>
    <div style="opacity:.85;line-height:1.5;margin-bottom:10px">
      You’ve been at it for a while. Two slow breaths, or a quick stretch.
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
      <button id="siiha-snooze" style="flex:1;padding:8px 10px;border-radius:10px;border:1px solid #ddd;background:#fafafa;cursor:pointer">
        Remind me later
      </button>
      <button id="siiha-rest" style="flex:1;padding:8px 10px;border-radius:10px;border:1px solid #ddd;background:#f6faff;cursor:pointer">
        I’ll rest now
      </button>
      <button id="siiha-mute" style="flex:1;padding:8px 10px;border-radius:10px;border:none;background:#111;color:#fff;cursor:pointer">
        Mute today
      </button>
    </div>
    <div style="margin-top:6px;text-align:right;">
      <button id="siiha-manage-rest" type="button"
        style="font-size:12px;opacity:.7;text-decoration:underline;background:none;border:none;padding:0;cursor:pointer;">
        Manage rest reminder
      </button>
    </div>
  `;

  // 🧘 Grounding box
  groundingBox = document.createElement("div");
  css(groundingBox, {
    position: "relative",
    width: "432px",
    background: "#ffffff",
    borderRadius: "16px",
    boxShadow: "0 12px 32px rgba(0,0,0,.20)",
    padding: "16px",
    display: "none",
    zIndex: 2147483646,
    border: "1px solid #cfe9da"
  });
  groundingBox.innerHTML = `
    <div id="siiha-gr-title" style="font-weight:700;margin-bottom:6px;color:#065f46">You're not alone.</div>
    <div id="siiha-gr-sub"   style="opacity:.9;line-height:1.5;margin-bottom:12px">Let’s take this minute together.</div>
    <div id="siiha-gr-body"></div>
  `;
  // 🧘 minimal renderer states
  let __gr_state = {
    packs: [],
    rememberPref: true,
    defaultDuration: 60,
    preferredDuration: null,
    activeDuration: null,
    activeSteps: [],
    activeIdx: 0,
    startedAt: 0,
    activePack: null
  };
  function grReset() {
    __gr_state.activeDuration = null;
    __gr_state.activeSteps = [];
    __gr_state.activeIdx = 0;
    __gr_state.startedAt = 0;
    __gr_state.activePack = null;
  }
  function grShow() {
    bubble.style.display = "none";
    nudge.style.display = "none";
    crisis.style.display = "none";
    groundingBox.style.display = "block";
    reclamp();
    updateBtnNopeSlice();
  }
  function grHide() {
    groundingBox.style.display = "none";
    reclamp();
    updateBtnNopeSlice();
  }
  const grBody = () => groundingBox.querySelector("#siiha-gr-body");

  // 危機卡（protective hold）
  crisis = document.createElement("div");
  css(crisis, {
    position: "relative",      // 改為相對，跟著 root 垂直堆疊
    width: "432px", background: "#fff7f7", borderRadius: "16px",
    boxShadow: "0 12px 32px rgba(180,0,0,.25)", padding: "16px",
    display: "none", zIndex: 2147483647, border: "1px solid #f3c0c0"
  });
  crisis.innerHTML = `
    <div id="siiha-crisis-title" style="font-weight:700;margin-bottom:6px;color:#b00020">You’re not alone.</div>
    <div id="siiha-crisis-sub" style="opacity:.9;line-height:1.5;margin-bottom:10px">Let’s pause for a moment. Your safety comes first.</div>
    <ol id="siiha-crisis-steps" style="margin:0 0 10px 18px;line-height:1.6"></ol>
    <div id="siiha-crisis-disc" style="font-size:12px;opacity:.7;margin-bottom:10px"></div>
    <div style="display:flex;gap:8px">
      <button id="siiha-crisis-close" style="flex:1;padding:8px 10px;border-radius:10px;border:1px solid #e0b3b3;background:#fff;cursor:pointer">
        I'll pause for a bit
      </button>
      <button id="siiha-crisis-hide" style="flex:1;padding:8px 10px;border-radius:10px;border:none;background:#b00020;color:#fff;cursor:pointer">
        I'm okay for now
      </button>
    </div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <!-- 🧘 new CTA to open grounding -->
      <button id="siiha-crisis-grounding" style="flex:1;padding:8px 10px;border-radius:10px;border:1px solid #cfe9da;background:#f6fffb;color:#065f46;cursor:pointer">
        I need grounding (2–3 min)
      </button>      
    </div>
  `;

  // Root 結構（panelWrap（三卡+btn） + bubble）
  panelWrap.appendChild(crisis);
  panelWrap.appendChild(chatBox);
  ensureThemeStyles(); // 🆕 安裝主題樣式（一次性）
  panelWrap.appendChild(nudge);
  panelWrap.appendChild(groundingBox);   // 🧘 mount grounding card
  panelWrap.appendChild(btn);          // ⬅️ 把按鈕收進 panelWrap，才能固定在角落
  root.appendChild(panelWrap);
  root.appendChild(bubble);

  // 🆕 按鈕左上角「不吃事件」遮片（避免與 dev-dot 命中互咬）
  // 使用 fixed + z-index 介於 btn 與 devDotWrap 之間；攔截事件但不做任何事。
  btnNopeSlice = document.createElement("div");
  Object.assign(btnNopeSlice.style, {
    position: "fixed",
    width: "16px",
    height: "16px",
    // 透明但可截流事件
    background: "transparent",
    pointerEvents: "auto",
    // zIndex 會在 applyDynamicZ() 內統一設定
    zIndex: "2147483647",
    // 預設隱藏，等有 btn 位置後再顯示
    display: "none",
    // 降低誤導：游標維持預設
    cursor: "default"
  });
  // 截流所有指標/滑鼠事件，避免傳到按鈕造成 hover/drag
  ["pointerdown","pointerup","pointermove","click","mousedown","mouseup","mousemove","touchstart","touchend","touchmove","mouseenter","mouseover"].forEach(ev=>{
    btnNopeSlice.addEventListener(ev, (e)=>{ e.stopPropagation(); e.preventDefault(); }, { passive:false });
  });
  document.body.appendChild(btnNopeSlice);

  function updateBtnNopeSlice() {
    try {
      const r = btn.getBoundingClientRect();
      // 固定覆蓋按鈕「左上角」16×16，輕微內縮避免貼邊抖動
      btnNopeSlice.style.left = (Math.max(0, r.left) + 2) + "px";
      btnNopeSlice.style.top  = (Math.max(0, r.top)  + 2) + "px";
      btnNopeSlice.style.display = (btn.style.display === "none") ? "none" : "block";
    } catch { /* noop */ }
  }

  // 統一層級（初始）
  css(crisis, { position: "relative", zIndex: 2147483646 });
  css(chatBox, { position: "relative", zIndex: 2147483645 });
  css(nudge,  { position: "relative", zIndex: 2147483644 });
  css(bubble, { zIndex: 2147483647 });
  css(btn,    { zIndex: 2147483648 }); // 稍微墊高，避免被卡片邊緣遮住
  css(root,   { zIndex: 2147483642 });

  // ===============================
  // Stage 3 → 掛載事件監聽與動態調整
  // ===============================

  // --- 依錨點把按鈕貼在 panelWrap 的角落 ---
  // 依按鈕位置在 panelWrap 內側留白，避免按鈕覆蓋任何卡片文字
  const BTN_SIZE = 56;          // 與按鈕寬高一致
  const BTN_OVERLAP = 6;        // P = "-6px" 的外擴量
  const BTN_CLEAR = Math.max(0, Math.ceil(BTN_SIZE/2) - BTN_OVERLAP + 4); // ≈ 26px
  function applyBtnClearance() {
    // 先清空
    panelWrap.style.paddingTop = panelWrap.style.paddingRight =
      panelWrap.style.paddingBottom = panelWrap.style.paddingLeft = "0px";
    // 針對按鈕所在角落加內距，讓卡片內容不被覆蓋
    if (anchorMode === "lt") { panelWrap.style.paddingTop = BTN_CLEAR + "px"; panelWrap.style.paddingLeft  = BTN_CLEAR + "px"; }
    if (anchorMode === "rt") { panelWrap.style.paddingTop = BTN_CLEAR + "px"; panelWrap.style.paddingRight = BTN_CLEAR + "px"; }
    if (anchorMode === "lb") { panelWrap.style.paddingBottom = BTN_CLEAR + "px"; panelWrap.style.paddingLeft  = BTN_CLEAR + "px"; }
    if (anchorMode === "rb") { panelWrap.style.paddingBottom = BTN_CLEAR + "px"; panelWrap.style.paddingRight = BTN_CLEAR + "px"; }
  }
  function positionBtnByAnchor() {
    // 視覺外擴 6px，讓 btn 貼邊但不壓到卡片圓角
    const P = "-6px";
    btn.style.left = "auto"; btn.style.right = "auto";
    btn.style.top  = "auto"; btn.style.bottom = "auto";
    if (anchorMode === "lt") { btn.style.left = P;  btn.style.top = P; }
    if (anchorMode === "rt") { btn.style.right = P; btn.style.top = P; }
    if (anchorMode === "lb") { btn.style.left = P;  btn.style.bottom = P; }
    if (anchorMode === "rb") { btn.style.right = P; btn.style.bottom = P; }
    applyBtnClearance();
  }
  positionBtnByAnchor();

  updateBtnNopeSlice();
  // 根據左右錨點調整 root 的對齊，使卡片永遠往畫面內側展開
  function syncFlexByAnchor() {
    const isLeft = anchorMode.startsWith("l");
    root.style.alignItems = isLeft ? "flex-start" : "flex-end";
  }
  syncFlexByAnchor();
  // 先把遮片和 tooltip 拉到位
  updateBtnNopeSlice();

  // --- 夾限工具：確保 root 不超出視窗（支援四向錨點） ---
  function reclamp() {
    const rect = root.getBoundingClientRect();
    const w = rect.width || root.offsetWidth || 0;
    const h = rect.height || root.offsetHeight || 0;
    const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
    switch (anchorMode) {
      case "lt": {
        const nx = clamp(rect.left, EDGE_GAP, Math.max(EDGE_GAP, window.innerWidth - w - EDGE_GAP));
        const ny = clamp(rect.top,  EDGE_GAP, Math.max(EDGE_GAP, window.innerHeight - h - EDGE_GAP));
        css(root, { left: `${nx}px`, top: `${ny}px`, right: "auto", bottom: "auto" });
        return { x: nx, y: ny };
      }
      case "rt": {
        const rg = clamp(window.innerWidth - (rect.left + w), EDGE_GAP, window.innerWidth);
        const ny = clamp(rect.top, EDGE_GAP, Math.max(EDGE_GAP, window.innerHeight - h - EDGE_GAP));
        css(root, { right: `${rg}px`, top: `${ny}px`, left: "auto", bottom: "auto" });
        return { right: rg, top: ny };
      }
      case "lb": {
        const nx = clamp(rect.left, EDGE_GAP, Math.max(EDGE_GAP, window.innerWidth - w - EDGE_GAP));
        const bg = clamp(window.innerHeight - (rect.top + h), EDGE_GAP, window.innerHeight);
        css(root, { left: `${nx}px`, bottom: `${bg}px`, right: "auto", top: "auto" });
        return { left: nx, bottom: bg };
      }
      case "rb":
      default: {
        const rg = clamp(window.innerWidth  - (rect.left + w), EDGE_GAP, window.innerWidth);
        const bg = clamp(window.innerHeight - (rect.top  + h), EDGE_GAP, window.innerHeight);
        css(root, { right: `${rg}px`, bottom: `${bg}px`, left: "auto", top: "auto" });
        return { right: rg, bottom: bg };
      }
    }
    // 每次夾限完成也重新計算角落留白
    applyBtnClearance();    
  }

  function applyAnchor(mode, offsets) {
    anchorMode = mode;
    const st = { left: "auto", top: "auto", right: "auto", bottom: "auto" };
    if (mode === "lt") Object.assign(st, { left: `${offsets.x}px`,     top: `${offsets.y}px` });
    if (mode === "rt") Object.assign(st, { right: `${offsets.right}px`, top: `${offsets.top}px` });
    if (mode === "lb") Object.assign(st, { left: `${offsets.left}px`,  bottom: `${offsets.bottom}px` });
    if (mode === "rb") Object.assign(st, { right: `${offsets.right}px`, bottom: `${offsets.bottom}px` });
    css(root, st);
    positionBtnByAnchor(); // 依錨點把按鈕移到對應角
    syncFlexByAnchor();    // 依左右錨點切換對齊，面板往內側展開
    updateBtnNopeSlice();
    applyBtnClearance();
  }
  function persistAnchor(mode, offsets) {
    // 由統一門面持久化
    Storage.UI.setAnchor(mode, offsets || {});
  }

  // 無條件找最近的左右 + 上下，回傳四象限錨點與偏移（永遠吸邊，沒有中間）
  function computeNearestDock(rect) {
    const w = rect.width, h = rect.height;
    const dL = rect.left;
    const dT = rect.top;
    const dR = window.innerWidth  - (rect.left + w);
    const dB = window.innerHeight - (rect.top  + h);
    const sideX = (dL <= dR) ? "l" : "r";
    const sideY = (dT <= dB) ? "t" : "b";
    const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
    if (sideX === "l" && sideY === "t") return { mode: "lt", offsets: { x: EDGE_GAP, y: EDGE_GAP } };
    if (sideX === "r" && sideY === "t") return { mode: "rt", offsets: { right: EDGE_GAP, top: EDGE_GAP } };
    if (sideX === "l" && sideY === "b") return { mode: "lb", offsets: { left: EDGE_GAP, bottom: EDGE_GAP } };
    // rb
    return { mode: "rb", offsets: { right: EDGE_GAP, bottom: EDGE_GAP } };
  }

  // --- Bubble 顯示/隱藏 ---
  function showBubble() {
    bubble.style.display = "block";
    requestAnimationFrame(() => {
      bubble.style.opacity = "1";
      bubble.style.transform = "translateY(0)";
      // 開啟後做一次夾限（不改錨點，不回寫座標型別）
      reclamp();
    });
  }
  function hideBubble() {
    bubble.style.opacity = "0";
    bubble.style.transform = "translateY(8px)";
    setTimeout(() => {
      bubble.style.display = "none";
      reclamp();
      positionBtnByAnchor();
    }, 250);
    updateBtnNopeSlice();
  }

  // --- 小人 hover 動效 ---
  btn.addEventListener("mouseenter", () => (btn.style.transform = "scale(0.98)"));
  btn.addEventListener("mouseleave", () => (btn.style.transform = "scale(1)"));

  // --- 位置恢復 / 儲存 / 自動校正 ---
  async function restorePosition() {
    const { anchorMode: storedMode, position } = await Storage.UI.getAnchor();
    anchorMode = ["lt","rt","lb","rb"].includes(storedMode) ? storedMode : "rb";
    const p = position || {};
    switch (anchorMode) {
      case "lt": applyAnchor("lt", { x: p.x ?? 16, y: p.y ?? (window.innerHeight - 72) }); break;
      case "rt": applyAnchor("rt", { right: p.right ?? 16, top: p.top ?? 16 }); break;
      case "lb": applyAnchor("lb", { left: p.left ?? 16, bottom: p.bottom ?? 16 }); break;
      case "rb":
      default:   applyAnchor("rb", { right: p.right ?? 16, bottom: p.bottom ?? 16 }); break;
    }
    reclamp();
    applyBtnClearance();
  }
  restorePosition();

  // 可拖曳（長按或移動超過閾值才啟動）
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    dragArmed = true; dragging = false;
    const rect = root.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    pressTimer = setTimeout(() => {
      if (!dragArmed || dragging) return;
      dragging = true;
      btn.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      anchorMode = "lt";
      css(root, { left: `${rect.left}px`, top: `${rect.top}px`, right: "auto", bottom: "auto" });
      positionBtnByAnchor();
    }, PRESS_MS);
  });
  btn.addEventListener("pointermove", (e) => {
    if (!dragArmed) return;
    const moved = Math.abs(e.clientX - startX) > MOVE_PX || Math.abs(e.clientY - startY) > MOVE_PX;
    if (moved && !dragging) {
      // 提前進入拖曳
      clearTimeout(pressTimer);
      dragging = true;
      btn.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      anchorMode = "lt";
      css(root, { left: `${startLeft}px`, top: `${startTop}px`, right: "auto", bottom: "auto" });
      positionBtnByAnchor();
    }
    if (!dragging) return;
    const newX = startLeft + (e.clientX - startX);
    const newY = startTop  + (e.clientY - startY);
    css(root, { left: `${newX}px`, top: `${newY}px`, right: "auto", bottom: "auto" });
    reclamp();
    root.style.transition = "none";
    updateBtnNopeSlice();
  });
  btn.addEventListener("pointerup", (e) => {
    clearTimeout(pressTimer);
    btn.releasePointerCapture?.(e.pointerId);
    if (dragging) {
      dragArmed = false; dragging = false;
      btn.style.cursor = "grab";
      document.body.style.userSelect = "";
      const rect = root.getBoundingClientRect();
      // 直接就近四象限吸邊並持久化
      const dock = computeNearestDock(rect);
      applyAnchor(dock.mode, dock.offsets);
      persistAnchor(dock.mode, dock.offsets);
      reclamp();
      positionBtnByAnchor();
      return; // 拖曳結束，不當點擊
      // note: updateBtnNopeSlice() 會在 applyAnchor() 之後被呼叫
    }
    // 非拖曳：才當點擊切換
    dragArmed = false;
    console.log("[SIIHA/Content] toggle SIIHA bubble");
    const toShow = bubble.style.display === "none" || bubble.style.opacity === "0";
    if (toShow) showBubble(); else hideBubble();
    chatBox.style.display = "none";
    reclamp();
    positionBtnByAnchor();
    updateBtnNopeSlice();
  });

  // 視窗尺寸變動 → 自動校正 & 重新貼齊
  window.addEventListener("resize", async () => {
    reclamp();
    syncPanelsAfterRestore();
    positionBtnByAnchor();
    updateBtnNopeSlice();
    applyBtnClearance();
  });

  // --- 三卡與泡泡跟隨/層級 ---
  let animFrame = null;
  function updatePanelPosition(_x, _y) {
    cancelAnimationFrame(animFrame);
    animFrame = requestAnimationFrame(() => {
      // 垂直堆疊下僅維持小間距
      [crisis, chatBox, nudge, bubble].forEach((el) => {
        if (!el) return;
        el.style.marginTop = STACK_GAP;
        el.style.marginRight = "0px";
      });
      // 層級集中統一（再次保險）
      css(root,   { zIndex: 2147483642 });
      css(btn,    { zIndex: 2147483648 });
      css(panelWrap, { zIndex: 2147483643 });
      css(nudge,  { zIndex: 2147483644 });
      css(chatBox,{ zIndex: 2147483645 });
      css(crisis, { zIndex: 2147483646 });
      css(bubble, { zIndex: 2147483647 });
    });
  }

  function ensureBubbleAttached() {
    if (!bubble || !document.body.contains(root)) return;
    if (!root.contains(bubble)) root.insertBefore(bubble, root.firstChild);
    css(bubble, { zIndex: 2147483647 });
  }

  const observer = new MutationObserver(() => {
    ensureBubbleAttached();
    syncPanelsAfterRestore();
  });
  observer.observe(root, { childList: true });

  async function syncPanelsAfterRestore() {
    const { position } = await Storage.UI.getAnchor();
    if (position) updatePanelPosition(position.x ?? position.right, position.y ?? position.top);
  }
  window.addEventListener("load", syncPanelsAfterRestore);
  setTimeout(() => restorePosition().then(syncPanelsAfterRestore), 300);

  // 初次定位後再保險更新一次遮片位置
  // --- 小人點擊：開合對話泡泡 / Chat 面板 ---
  btn.addEventListener("click", () => {
    // 由 pointer 事件統一處理點擊/拖曳，避免雙觸發
    // 此處留白（防止舊瀏覽器冒泡造成二次切換）
  });

  bubble.addEventListener("click", (e) => {
    if (e.target?.id === "siiha-start-chat") {
      bubble.style.display = "none";
      chatBox.style.display = "flex";
      scrollChatToBottom();
      // 🆕 首次承接：presence 一句（不落地）
      ensurePresenceLine();
      // 🆕 麵包屑列
      renderBreadcrumb();
      // 🆕 隱私告知（一次性）
      showPrivacyBannerOnce();
      // 🆕 危機晶片（依 runtime）
      updateCrisisChipFromRuntime();
    }
  });

  closeBtn.addEventListener("mouseenter", () => (closeBtn.style.background = "rgba(240,240,240,1)"));
  closeBtn.addEventListener("mouseleave", () => (closeBtn.style.background = "rgba(255,255,255,0.9)"));
  closeBtn.addEventListener("click", async () => {
    chatBox.style.display = "none";
    bubble.style.display = "none";
    await saveChatLog();
  });

  // --- Chat 持久化（daily memory）與跨日清理 ---
  async function saveChatLog() {
    try {
      // 🆕 送存前看偏好（預設不存全文）
      const prefs = await Storage.Prefs.get(["persistChatHtmlToday"]);
      if (prefs && prefs.persistChatHtmlToday === false) {
        // 尊重偏好：不落地全文（可選：改為落空字串）
        // await Storage.Chat.saveToday(""); // 若想顯式清空可打開
        return;
      }
      // 🆕 避免把 presence/隱私告知落地：移除 data-volatile
      const clone = chatLog.cloneNode(true);
      clone.querySelectorAll("[data-volatile='1']").forEach(n => n.remove());
      await Storage.Chat.saveToday(clone.innerHTML); // 偏好開啟才會寫入
    } catch (e) {
      console.warn("[SIIHA/Content] saveChatLog failed:", e);
    }
  }
  async function restoreChatLog() {
    try {
      const today = await Storage.Chat.getToday();
      if (today?.html) {
        chatLog.innerHTML = today.html;
        console.debug("[SIIHA/Content] Chat log restored for", today.date);
        scrollChatToBottom();       
      }
    } catch (e) {
      console.warn("[SIIHA/Content] restoreChatLog failed:", e);
    }
  }
  restoreChatLog();

  // 🛎️ 監看 runtime：任何地方改變（SW/Options/console）都即時重算危機晶片顯示
  let __unsubRuntime = null;
  try {
    __unsubRuntime = Storage.Runtime.subscribe?.(() => {
      try { updateCrisisChipFromRuntime(); } catch {}
    });
  } catch {}
  // 統一清理點（替代 unload）
  function cleanup() {
    try { __unsubRuntime && __unsubRuntime(); } catch {}
    try { clearInterval(__intervalId); } catch {}
  }
  // 在頁面隱藏或離場時清理，避免 permissions policy + 失效背景呼叫
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") cleanup();
  }, { capture: true });
  window.addEventListener("pagehide", cleanup, { once: true, capture: true });

  // 週期任務：只在分頁可見且擴充仍存活時執行
  let __intervalId = setInterval(async () => {
    if (!extAlive() || document.visibilityState !== "visible") return;
    try {
      await Storage.Chat.clearIfNewDay();
    } catch (e) {
      // 內容腳本被卸載或 SW 重啟時，避免持續報錯
      if (/Extension context invalidated/i.test(String(e))) cleanup();
    }
  }, 600000); // 10 分鐘

  async function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    chatLog.innerHTML += `<div style="text-align:right;margin:4px 0;">🫵 ${text}</div>`;
    scrollChatToBottom();
    // 清空並把 textarea 高度恢復為單行
    chatInput.value = "";
    chatInput.style.height = "44px";
    // 只送出，等待 Service Worker 回覆再統一顯示；語言統一英文
    await chrome.runtime.sendMessage({ type: "CHAT_PROMPT", text, meta: { locale: "en" } });
    await saveChatLog();
  }
  chatSend.addEventListener("click", sendChat);
  // textarea：Enter 送出；Shift+Enter 換行
  chatInput.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // IME 組字時不要送出
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
      return;
    }
    // 其他情況讓瀏覽器處理（含 Shift+Enter 換行）
  });

  // --- 新話題：清語境層（保留心緒層），不寫任何全文 ---
  chatNewTopic.addEventListener("click", async () => {
    try {
      const r = await chrome.runtime.sendMessage({ type: "CLEAR_DIALOG" });
      console.debug("[SIIHA/Content] CLEAR_DIALOG ->", r);
      chatLog.innerHTML += `<div style="text-align:center;margin:6px 0;color:#888;font-size:12px;">— new topic —</div>`;
      scrollChatToBottom();
      await saveChatLog();
      // 新話題後，重畫麵包屑（承接清淡）
      renderBreadcrumb();
    } catch (err) {
      console.warn("[SIIHA/Content] CLEAR_DIALOG failed:", err);
    }
  });

  // --- 提醒泡泡控制 ---
  function closeNudge() {
    if (nudge.style.display !== "none") {
      nudge.style.display = "none";
      reclamp();
    }
  }
  // 🆕 簡易 toast（不入庫，純視覺）
  function showToast(text = "", ms = 1800) {
    try {
      const t = document.createElement("div");
      t.textContent = String(text || "");
      css(t, {
        position: "fixed",
        left: "50%",
        bottom: "24px",
        transform: "translateX(-50%)",
        padding: "10px 14px",
        background: "rgba(0,0,0,.8)",
        color: "#fff",
        borderRadius: "999px",
        fontSize: "13px",
        boxShadow: "0 6px 18px rgba(0,0,0,.25)",
        zIndex: 2147483647,
        opacity: "0",
        transition: "opacity .18s ease"
      });
      document.body.appendChild(t);
      requestAnimationFrame(() => (t.style.opacity = "1"));
      setTimeout(() => {
       t.style.opacity = "0";
        setTimeout(() => t.remove(), 220);
      }, ms);
    } catch {}
  }

  nudge.addEventListener("click", async (e) => {
    const id = e.target?.id;
    if (id === "siiha-snooze") {
      console.log("[SIIHA/Content] user clicked: Remind me later");
      try {
        const r = await chrome.runtime.sendMessage({ type: "SNOOZE" });
        console.log("[SIIHA/Content] SNOOZE ->", r);
      } catch (err) {
        console.warn("[SIIHA/Content] SNOOZE failed:", err);
      }
      closeNudge();
    } else if (id === "siiha-mute") {
      console.log("[SIIHA/Content] user clicked: Mute today");
      try {
        const r = await chrome.runtime.sendMessage({ type: "MUTE_TODAY" });
        console.log("[SIIHA/Content] MUTE_TODAY ->", r);
      } catch (err) {
        console.warn("[SIIHA/Content] MUTE_TODAY failed:", err);
      }
      closeNudge();
    } else if (id === "siiha-rest") {
      console.log("[SIIHA/Content] user clicked: I’ll rest now");
      try {
        const r = await chrome.runtime.sendMessage({ type: "REST_DONE" });
        console.log("[SIIHA/Content] REST_DONE ->", r);
        closeNudge();
        // 根據重啟模式顯示不同提示（immediate / fixed）
        const mode = (r && r.restarted) || "immediate";
        if (mode === "immediate") {
          const mins = (r && r.nextInMinutes) || null;
          showToast(mins ? `Okay. I’ll remind you again in ~${mins} min.` : `Okay. I’ll remind you again later.`);
        } else {
          showToast(`Got it. I’ll keep the original schedule.`);
        }
      } catch (err) {
       console.warn("[SIIHA/Content] REST_DONE failed:", err);
        closeNudge();
        showToast(`Saved. You can change this in Options.`);
      }
    } else if (id === "siiha-manage-rest") {
      try {
        const r = await chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
        if (!r?.ok) throw new Error("bg rejected");
      } catch (err) {
        console.warn("[SIIHA/Content] OPEN_OPTIONS failed:", err);
        showToast("Couldn’t open Options. Try the extension menu.");
      }
    }
  });

  // --- 危機卡顯示 ---
  async function showCrisis() {
    try {
      const data = await loadCrisis();
      const ph = data?.protective_hold || {};
      crisis.querySelector("#siiha-crisis-title").textContent = ph.title || "You’re not alone.";
      crisis.querySelector("#siiha-crisis-sub").textContent = ph.subtitle || "";
      crisis.querySelector("#siiha-crisis-disc").textContent = ph.disclaimer || "";
      const list = crisis.querySelector("#siiha-crisis-steps");
      list.innerHTML = "";
      (ph.steps || []).forEach((s) => {
        const li = document.createElement("li");
        li.textContent = s;
        list.appendChild(li);
      });
    } catch (e) {
      console.warn("[SIIHA/Content] showCrisis fallback due to load error:", e);
    }
    bubble.style.display = "none";
    nudge.style.display = "none";
    crisis.style.display = "block";
  }

  crisis.addEventListener("click", (e) => {
    const id = e.target?.id;
    if (id === "siiha-crisis-close" || id === "siiha-crisis-hide") {
      console.log("[SIIHA/Content] crisis dismissed:", id);
      crisis.style.display = "none";
    } else if (id === "siiha-crisis-grounding") {
      // 🧘 crisis CTA → ask SW to open grounding
      chrome.runtime.sendMessage({ type: "GROUNDING_OPEN", source: "crisis" }, async (res) => {
        try { await handleGroundingResponse(res); } catch (e) {
          console.warn("[SIIHA/Content] grounding open failed:", e);
        }
      });      
    }
  });

  // --- 卡片關閉後自動貼齊（transitionend 後再排位） ---
  [crisis, chatBox, nudge].forEach((el) => {
    el.addEventListener("transitionend", () => {
      if (el.style.display === "none") {
        Storage.UI.getAnchor().then(({ position }) => {
          if (position) updatePanelPosition(position.x ?? position.right, position.y ?? position.top);
        });
      }
    });
  });

  // --- 智慧 z-index 偵測 ---
  let baseZ = 2147483600;

  function detectMaxZ() {
    let max = 0;
    document.querySelectorAll("*").forEach((el) => {
      const z = parseInt(window.getComputedStyle(el).zIndex);
      if (!isNaN(z)) max = Math.max(max, z);
    });
    return max;
  }
  function applyDynamicZ(base) {
    css(root,      { zIndex: base });
    css(panelWrap, { zIndex: base + 1 });
    css(nudge,     { zIndex: base + 2 });
    css(chatBox,   { zIndex: base + 3 });
    css(crisis,    { zIndex: base + 4 });
    css(bubble,    { zIndex: base + 5 });
    css(btn,       { zIndex: base + 6 });
    // 🆕 讓 dev dot 永遠壓過 btn，避免 hover 被吃掉
    if (devDotWrap) css(devDotWrap, { zIndex: base + 8 });
    if (devDot) css(devDot, { zIndex: base + 9 });
    // 🆕 自製 tooltip 最高（避免被覆蓋）
    if (devTip) devTip.style.zIndex = String(base + 10);
    // 🆕 按鈕左上角「不吃事件」遮片：介於 btn 與 devDot 之間
    if (btnNopeSlice) btnNopeSlice.style.zIndex = String(base + 7);
    updateBtnNopeSlice();       
    console.debug("[SIIHA/Z] adjusted dynamic z-index base:", base);
  }

  (async () => {
    // 若曾記錄過 baseZ 先用舊值
    const stored = await Storage.UI.getZBase();
    if (stored) {
      baseZ = stored;
      applyDynamicZ(baseZ);
      console.debug("[SIIHA/Z] restored z-index base:", baseZ);
    }
    // 再以當前頁面最高 z 值做校正
    const detected = detectMaxZ() + 10;
    if (detected > baseZ) {
      baseZ = detected;
      applyDynamicZ(baseZ);
      try {
        await Storage.UI.setZBase(baseZ);
        console.debug("[SIIHA/Z] initial z-index base stored:", baseZ);
      } catch (err) {
        console.warn("[SIIHA/Z] initial z-index store failed:", err);
      }
    }
  })();

  let zDebounce;
  function debouncedZCheck() {
    clearTimeout(zDebounce);
    zDebounce = setTimeout(async () => {
      const newMax = detectMaxZ();
      if (newMax > baseZ) {
        baseZ = newMax + 10;
        applyDynamicZ(baseZ);
        await Storage.UI.setZBase(baseZ);
      }
    }, 1000);
  }
  window.addEventListener("scroll", debouncedZCheck);
  window.addEventListener("resize", debouncedZCheck);

  // 任何訊息造成 UI 變化後，也順手刷新遮片位置
  // --- 背景訊息監聽（NUDGE / CRISIS_SHOW / CHAT_REPLY） ---
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    
    if (msg.type === "NUDGE") {
      console.log("[SIIHA/Content] got NUDGE");
      if (!extAlive()) return;
      if (bubble.style.display !== "none") bubble.style.display = "none";
      nudge.style.display = "block";
      // 顯示後做一次夾限（不切換錨點）
      reclamp();
      updateBtnNopeSlice();         
      return;
    }

    if (msg.type === "CRISIS_SHOW" && msg.payload) {
      const card = msg.payload;
      console.log("[SIIHA/Content] got CRISIS_SHOW:", card);

      crisis.querySelector("#siiha-crisis-title").textContent = card.title || "You’re not alone.";
      crisis.querySelector("#siiha-crisis-sub").textContent = card.subtitle || "";
      crisis.querySelector("#siiha-crisis-disc").textContent = card.disclaimer || "";

      const list = crisis.querySelector("#siiha-crisis-steps");
      list.innerHTML = "";
      (card.steps || []).forEach((s) => {
        const li = document.createElement("li");
        li.textContent = s;
        list.appendChild(li);
      });

      // 標記新的一次危機事件
      try { Storage.Runtime.patch?.({ crisisEligible: true, lastCrisisLockAt: Date.now(), crisisChipDismissed: false }); } catch {}
      bubble.style.display = "none";
      closeNudge();
      crisis.style.display = "block";
      // 顯示後做一次夾限（不切換錨點）
      reclamp();
      updateBtnNopeSlice();

      chrome.runtime.sendMessage({
        type: "CRISIS_ACTION",
        payload: { action: "shown", cardId: card.id || "unknown" }
      });

      const clickHandler = async (e) => {
        if (e.target?.id === "siiha-crisis-close") {
          console.log("[SIIHA/Content] crisis accept");
          await chrome.runtime.sendMessage({
            type: "CRISIS_ACTION",
            payload: { action: "accept", cardId: card.id || "unknown" }
          });
          crisis.style.display = "none";
          reclamp();
          positionBtnByAnchor();
        } else if (e.target?.id === "siiha-crisis-hide") {
          console.log("[SIIHA/Content] crisis dismiss");
          await chrome.runtime.sendMessage({
            type: "CRISIS_ACTION",
            payload: { action: "dismiss", cardId: card.id || "unknown" }
          });
          crisis.style.display = "none";
          reclamp();
          positionBtnByAnchor();
        }
      };
      crisis.addEventListener("click", clickHandler, { once: true });
      console.debug("[SIIHA/Content] Crisis card shown → SW stats logging active.");
      return;
    }

    if (msg.type === "CHAT_REPLY" && msg.text) {
      if (!extAlive()) return;
      // 主題微承接：依 styleCode 做輕量邊框/陰影變化（純視覺，不入庫）
      if (msg.meta && msg.meta.styleCode) {
        try { applyThemeByBucket(msg.meta.styleCode); } catch {}
      }
      chatLog.innerHTML += `<div style="text-align:left;margin:4px 0;">🤍 ${msg.text}</div>`;
      try { 
        updateDevDot(msg.meta || {}); 
        // 🆕 把這輪實際使用語言回寫 runtime（方便下輪沒有輸入時沿用）
        try {
          Storage.Runtime.patch({ lastUsedLocale: "en" }).catch(()=>{});
        } catch {}
        // 🆕 純觀測：把一筆輕量路由/延遲資訊寫進 runtime.lastTurns（供 Options 粗統計）
        const m = msg.meta || {};
        const dbg = m.debug || {};
        const rec = {
          ts: new Date().toISOString(),
          source: m.source || "template",
          model_state: (dbg.model_state || m.env?.model_state || "none"),
          model_backend: (dbg.model_backend || "local"),
          latency_ms: Number(dbg.latency_ms || 0),
          parse_ok: !!dbg.parse_ok,
          errorStage: (dbg.errorStage || null),
          crisis_lock: !!(dbg.guardrails?.crisis_lock),
          style: String(m.styleCode || "")
        };
        // fire-and-forget：不阻塞訊息處理，不要求回傳值
        try { Storage.Runtime.append("lastTurns", rec, { cap: 40 }).catch(()=>{}); } catch {}
      } catch {}
      // 🆕 接到危機 guardrail → 顯示晶片
      try {
        const locked = !!(msg?.meta?.debug?.guardrails?.crisis_lock);
        if (locked && crisisBanner) {
          crisisChipDismissedSession = false;
          crisisChipDismissedAtSession = 0;
          Storage.Runtime.patch?.({
            crisisEligible: true,
            crisisChipDismissed: false,
            lastCrisisLockAt: Date.now()
          }).catch?.(()=>{});
          crisisBanner.style.display = "inline-block";
        }
      } catch {}
      scrollChatToBottom();
      saveChatLog();
      updateBtnNopeSlice();
      return;
    }
  });
 
  // 🆕 依回覆來源更新 dev 小點（顏色保留）+ 一般用戶版 tooltip
  async function updateDevDot(meta = {}) {
    const src = (meta && meta.source) || null;
    if (!src) { devDot.style.display = "none"; devDotWrap.style.display = "none"; return; }
    const map = { model:"#2563eb", hybrid:"#7c3aed", template:"#6b7280" };
    devDot.style.background = map[src] || "#6b7280";
    devDot.style.display = "block";
    devDotWrap.style.display = "block";

    // ==== 使用者版 Tooltip：只顯示「Mode/Status」＋必要引導 ====
    // 來源訊號（model_state 以 meta.env 優先，再回退 debug，不以 CAP 覆寫）
    const modelState = meta?.env?.model_state || meta?.debug?.model_state || "none";
    // 新增：取樣式碼，用於判斷是否為 d401（危機）
    const styleCode = (meta?.styleCode || meta?.style_id || meta?.debug?.style_id || "").toString();
    const isCrisisStyle = styleCode.toLowerCase() === "d401";
    const isBlueDot = src === "model";    
    const consent = (meta?.debug?.consent && meta.debug.consent.granted === true)
      ? true
      : (() => {
          // 保險：若 SW 沒帶 consent，就從 Storage 讀一次
          try { return !!(window.__SIIHA_SETTINGS_CACHE__?.cloudHybridConsent?.granted); } catch { return false; }
        })();
    // 快取 Settings（避免每回合反覆 IO）
    try {
      if (!window.__SIIHA_SETTINGS_CACHE__) {
        const s = await Storage.Settings.get();
        window.__SIIHA_SETTINGS_CACHE__ = s || {};
      }
    } catch {}

    const online = navigator.onLine === true;
    // Prompt API 可用性（弱提示；僅用於下載建議，不參與 Mode 判斷）
    const promptApiReady = !!CAP?.aiReady;

    // 模式判斷優先序：
    // 1) hybrid && consent && online → Cloud assist (granted)
    // 2) model && model_state==='ready-local' → Local language model
    // 3) model && model_state==='ready-online' → Online model
    // 4) 其他 → Local templates
    let modeLabel = "Local templates";
    if (src === "hybrid" && consent && online) {
      modeLabel = "Cloud assist (granted)";
    } else if (src === "model" && modelState === "ready-local") {
      modeLabel = "Local language model";
    } else if (src === "model" && modelState === "ready-online") {
      modeLabel = "Online model";
    }

    // 連線文字
    const onlineLabel = online ? "Online" : "Offline";

    // 引導（依情境加行）
    const guides = [];
    // 下載引導條件（收斂 + 兩個新的抑制條件）：
    // - 原則：mode !== 'Local language model' && model_state !== 'ready-local' && CAP.aiReady !== true
    // - 不顯示於：hybrid+granted+online、藍點(model source)、危機樣式 d401
    const needDownload =
      !(src === "hybrid" && consent && online) &&           // hybrid granted 不顯示
      !isBlueDot &&                                          // 藍點不顯示
      !isCrisisStyle &&                                      // d401 不顯示
      modeLabel !== "Local language model" &&
      modelState !== "ready-local" &&
      promptApiReady !== true;
    if (needDownload) {
      guides.push("Download a local model for smoother replies. Open Options ›");
    }
    // 離線引導只看 navigator.onLine
    if (!online) {
      guides.push("You’re offline. SIIHA still works (templates and any local model).");
    }

    const userTip = [
      `Mode: ${modeLabel}`,
      `Status: ${onlineLabel}`,
      guides.length ? "—" : "",
      ...guides
    ].filter(Boolean).join("\n");

    // 一般人預設看到的是 userTip（工程細節都保留由 SW console 觀測）
    devDot.setAttribute("data-tip", userTip);
  }

  // 🆕 dev dot tooltip 行為（hover 追隨滑鼠、點擊固定 3 秒）
  function showDevTipAt(x, y, text) {
    if (!devTip) return;
    devTip.textContent = text || "";
    devTip.style.display = "block";
    // 微離游標，避免遮到
    const nx = Math.min(window.innerWidth  - 12, x + 12);
    const ny = Math.min(window.innerHeight - 12, y + 12);
    devTip.style.left = nx + "px";
    devTip.style.top  = ny + "px";
  }
  function hideDevTip() {
    if (!devTip) return;
    // 若被釘住到期之前，不收
    if (Date.now() < devTipPinnedUntil) return;
    devTip.style.display = "none";
  }
  devDotWrap.addEventListener("mousemove", (e) => {
    const t = devDot.getAttribute("data-tip") || "";
    showDevTipAt(e.clientX, e.clientY, t);
  });
  devDotWrap.addEventListener("mouseenter", (e) => {
    const t = devDot.getAttribute("data-tip") || "";
    showDevTipAt(e.clientX, e.clientY, t);
  });
  devDotWrap.addEventListener("mouseleave", () => {
    hideDevTip();
  });
  // 點一下固定 3 秒
  devDotWrap.addEventListener("click", (e) => {
    const t = devDot.getAttribute("data-tip") || "";
    showDevTipAt(e.clientX, e.clientY, t);
    devTipPinnedUntil = Date.now() + 3000;
    clearTimeout(devTipPinnedTimer);
    devTipPinnedTimer = setTimeout(() => {
      devTipPinnedUntil = 0;
      hideDevTip();
    }, 3000);
    // If the tooltip suggests getting the local model, jump to Options (devTip remains pointerEvents:none)
    try {
      const tip = devDot.getAttribute("data-tip") || "";
      if (/Get it \u203a|Get it ›/i.test(tip)) {
        chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
      }
    } catch {}    
  }); 

  // 🧪 Dev hook：可在頁面 Console 手動驗證 tooltip
  try {
    globalThis.__SIIHA_DEV = Object.assign(globalThis.__SIIHA_DEV || {}, {
      showDevDot: (meta) => updateDevDot(meta || {
        source: "template",
        debug: { model_state: "ready-online", model_backend:"local", latency_ms:123, parse_ok:true, errorStage:"-" },
        style_id: "demo"
      })
    });
  } catch {}

  // ==============
  // Theme helpers（以「桶」套 class）
  // ==============
  function applyThemeByBucket(styleCode = "") {
    // 先移除舊桶 class，再套新桶
    THEME_BUCKETS.forEach(b => chatBox.classList.remove(`siiha-theme-${b}`));
    const bucket = getThemeBucket(styleCode);
    chatBox.classList.add(`siiha-theme-${bucket}`);
    // 其他內聯背景維持白底，避免文字對比問題
    chatBox.style.background = "white";
  } 

  // ===============================
  // 🧘 Grounding UI logic
  // ===============================
  function renderEntry() {
    const pref = Number(__gr_state.preferredDuration || __gr_state.defaultDuration || 60);
    const btnHtml = (dur, label) => {
      const hi = (__gr_state.rememberPref && dur === pref) ? "font-weight:700;border:2px solid #10b981;background:#ecfdf5" : "border:1px solid #ddd;background:#fafafa";
      return `<button data-dur="${dur}" class="siiha-gr-pick" style="flex:1;padding:10px;border-radius:10px;${hi};cursor:pointer">${label}</button>`;
    };
    grBody().innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        ${btnHtml(10, "10 sec")}
        ${btnHtml(60, "1 min")}
        ${btnHtml(120,"2 min")}
      </div>
      <div style="text-align:right">
        <button id="siiha-gr-oknow" style="font-size:12px;opacity:.8;background:none;border:none;text-decoration:underline;cursor:pointer">I’m okay for now</button>
      </div>
    `;
    // events
    grBody().querySelectorAll(".siiha-gr-pick").forEach(b => {
      b.addEventListener("click", () => {
        const dur = Number(b.getAttribute("data-dur") || 60);
        startPractice(dur);
      });
    });
    const ok = grBody().querySelector("#siiha-gr-oknow");
    ok?.addEventListener("click", async () => {
      grHide();
      try {
        await chrome.runtime.sendMessage({ type: "GROUNDING_DONE", payload: { duration_s: 0, exit: "ok" } });
      } catch {}
    });
  }

  // 取/存輪播指標（跨分頁保留）
  async function getRoundRobinMap() {
    try { const rt = await Storage.Runtime.get(); return rt?.groundingRoundRobin || {}; } catch { return {}; }
  }
  async function setRoundRobinMap(map) {
    try { await Storage.Runtime.patch({ groundingRoundRobin: map }); } catch {}
  }
  async function pickPackForDuration(dur) {
    const pool = (__gr_state.packs || []).filter(p => Number(p.duration_s) === Number(dur));
    if (!pool.length) return null;
    const rr = await getRoundRobinMap();
    const key = String(dur);
    const idx = Number(rr[key] || 0);
    const pack = pool[idx % pool.length];
    rr[key] = (idx + 1) % pool.length;
    await setRoundRobinMap(rr);
    return pack;
  }

  async function startPractice(dur) {
    __gr_state.activeDuration = Number(dur);
    const pack = (await pickPackForDuration(dur)) || { kind:"senses", intro:"Tiny check-in.", guidance:"Read and tap Next.", steps: ["Breathe in…","Breathe out…"], outro: [] };
    __gr_state.activePack = pack;    
    __gr_state.activeSteps = (pack.steps || []).slice(0);
    __gr_state.activeIdx = 0;
    __gr_state.startedAt = Date.now();
    renderPractice();
  }

  function renderPractice() {
    const i = __gr_state.activeIdx;
    const steps = __gr_state.activeSteps;
    const total = steps.length || 1;
    const cur = steps[i] || "…";
    const dots = Array.from({length: total}).map((_,k)=> `<span style="width:6px;height:6px;border-radius:50%;display:inline-block;margin:0 3px;${k<=i?'background:#10b981':'background:#d1d5db'}"></span>`).join("");
    const intro = __gr_state.activePack?.intro || "";
    const guide = __gr_state.activePack?.guidance || "";
    grBody().innerHTML = `
      <div style="opacity:.9;margin-bottom:6px">${intro}</div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:10px">${guide}</div>
      <div style="font-weight:600;margin-bottom:6px">${i+1}/${total}</div>
      <div style="line-height:1.6;margin-bottom:10px">${cur}</div>
      <div style="margin-bottom:10px">${dots}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="siiha-gr-next" style="flex:1;padding:8px 10px;border-radius:10px;border:1px solid #ddd;background:#f6faff;cursor:pointer">Next</button>
        <button id="siiha-gr-exit" style="flex:1;padding:8px 10px;border-radius:10px;border:1px solid #ddd;background:#fafafa;cursor:pointer">I’m okay for now</button>
      </div>
    `;
    grBody().querySelector("#siiha-gr-next")?.addEventListener("click", () => {
      if (__gr_state.activeIdx < steps.length - 1) {
        __gr_state.activeIdx += 1;
        renderPractice();
      } else {
        renderAfterPracticeChoices();
      }
    });
    grBody().querySelector("#siiha-gr-exit")?.addEventListener("click", () => renderExitPoll());
  }

  function renderAfterPracticeChoices() {
    const outro = (__gr_state.activePack?.outro || [])[0] || "Nice. Another tiny step, or move on?";
    grBody().innerHTML = `
      <div style="line-height:1.6;margin-bottom:10px">${outro}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="siiha-gr-again" style="flex:1;padding:8px 10px;border-radius:10px;border:1px solid #ddd;background:#ecfdf5;cursor:pointer">Again</button>
        <button id="siiha-gr-nextstep" style="flex:1;padding:8px 10px;border-radius:10px;border:1px solid #ddd;background:#fafafa;cursor:pointer">Next step</button>
        <button id="siiha-gr-exit2" style="flex:1;padding:8px 10px;border-radius:10px;border:none;background:#111;color:#fff;cursor:pointer">I’m okay for now</button>
      </div>
    `;
    grBody().querySelector("#siiha-gr-again")?.addEventListener("click", () => {
      startPractice(__gr_state.activeDuration || 60);
    });
    grBody().querySelector("#siiha-gr-nextstep")?.addEventListener("click", () => {
      const choices = [10,60,120].filter(v => v !== (__gr_state.activeDuration||60));
      const pick = choices[Math.floor(Math.random()*choices.length)];
      startPractice(pick);
    });
    grBody().querySelector("#siiha-gr-exit2")?.addEventListener("click", () => renderExitPoll());
  }

  function renderExitPoll() {
    const elapsed = Math.round(Math.max(0, (Date.now() - (__gr_state.startedAt||Date.now())) / 1000));
    grBody().innerHTML = `
      <div style="line-height:1.6;margin-bottom:12px">How are you leaving?</div>
      <div style="display:flex;gap:8px">
        <button id="siiha-gr-bit"  style="flex:1;padding:8px 10px;border-radius:10px;border:1px solid #ddd;background:#ecfdf5;cursor:pointer">A bit better</button>
        <button id="siiha-gr-not"  style="flex:1;padding:8px 10px;border-radius:10px;border:1px solid #ddd;background:#fafafa;cursor:pointer">Not much</button>
      </div>
    `;
    const sendDone = async (exitKey) => {
      try {
        await chrome.runtime.sendMessage({
          type: "GROUNDING_DONE",
          payload: { duration_s: __gr_state.activeDuration || 0, exit: exitKey }
        });
      } catch {}
      grHide();
      // small “exit” confirmation toast
      showToast(elapsed ? `Thanks for pausing ~${elapsed}s.` : `Thanks for checking in.`);
      grReset();
    };
    grBody().querySelector("#siiha-gr-bit")?.addEventListener("click", () => sendDone("a_bit_better"));
    grBody().querySelector("#siiha-gr-not")?.addEventListener("click", () => sendDone("not_much"));
  }

  async function handleGroundingResponse(res) {
    if (res && res.cooldown) {
      const left = Math.max(0, Math.round((res.remainingMs || 0)/1000));
      showToast(`We just grounded recently. Let’s give it a few minutes (${left}s).`);
      return;
    }
    // payload path
    const payload = res?.payload || {};
    const local = (await loadGrounding()) || {};
    // prefer SW-provided packs; fallback to local file
    __gr_state.packs = Array.isArray(payload.packs) && payload.packs.length ? payload.packs : (local.packs || []);
    __gr_state.rememberPref = !!payload.rememberPref;
    __gr_state.defaultDuration = Number(payload.defaultDuration || 60);
    // SW 可能未帶出偏好；安靜嘗試從 Prefs 讀（不阻塞）
    try {
      const p = await Storage.Prefs.get(["groundingPreferredDuration"]);
      __gr_state.preferredDuration = Number(p?.groundingPreferredDuration || __gr_state.defaultDuration || 60);
    } catch {
      __gr_state.preferredDuration = __gr_state.defaultDuration || 60;
    }
    grReset();
    renderEntry();
    grShow();
    // 計一次打開（以防 SW 端漏記）
    try { await Storage.Stats.bumpImmediate("grounding.open"); } catch {}
  }

  // Optional: expose a tiny hook for future entry points (e.g., chat quick action)
  async function openGroundingFrom(source = "dialog") {
    chrome.runtime.sendMessage({ type: "GROUNDING_OPEN", source }, async (res) => {
      try { await handleGroundingResponse(res); } catch (e) {
        console.warn("[SIIHA/Content] grounding open (manual) failed:", e);
      }
    });
  }

  // ===============================
  // 🆕 Presence / Breadcrumb / Privacy / Crisis chip helpers
  // ===============================
  async function ensurePresenceLine() {
    try {
      // 僅在 chatLog「看起來是空」時插入一次
      const hasContent = /\S/.test(chatLog.textContent || "");
      if (hasContent) return;
      const emo = await Storage.Continuity.loadEmotionIfValid().catch(() => null);
      if (!emo) return;
      const line = document.createElement("div");
      line.setAttribute("data-volatile","1");
      line.style.cssText = "text-align:left;margin:2px 0 6px 0;color:#6b7280;font-size:12px;";
      line.textContent = "We’ll keep the pace from before. I’m here with you.";
     chatLog.appendChild(line);
      scrollChatToBottom();
    } catch {}
  }

  async function renderBreadcrumb() {
    try {
      const prefs = await Storage.Prefs.get(["breadcrumbHidden"]).catch(() => ({}));
      const hidden = !!prefs?.breadcrumbHidden;
      const list = await Storage.Continuity.loadDialogIfValid().catch(() => null);
      const items = Array.isArray(list) ? list.map(d => String(d?.summary||"").trim()).filter(Boolean).slice(0,3) : [];
      if (hidden || items.length === 0) {
        bcWrap.style.display = "none";
        bcList.style.display = "none";
        return;
      }
      bcText.textContent = `Picking up:${items[0]}${items.length>1 ? "…" : ""}`;
      bcWrap.style.display = "block";
      bcList.textContent = items.join("\n");
      // 展開/隱藏切換
      bcToggle.onclick = (e) => {
        e.preventDefault();
        const show = bcList.style.display !== "block";
        bcList.style.display = show ? "block" : "none";
        bcToggle.textContent = show ? "Collapse context" : "Expand context";
      };
      bcHide.onclick = async (e) => {
        e.preventDefault();
        try { await Storage.Prefs.patch({ breadcrumbHidden: true }); } catch {}
        bcWrap.style.display = "none";
        bcList.style.display = "none";
      };
    } catch (e) {
      // 靜默失敗
    }
  }

  async function showPrivacyBannerOnce() {
    try {
      const prefs = await Storage.Prefs.get(["privacyBannerSeen"]).catch(() => ({}));
      if (prefs && prefs.privacyBannerSeen) return;
      const note = chatBox.querySelector("#siiha-privacy-note");
      if (note) note.style.display = "block";
      // 標記已看
      try { await Storage.Prefs.patch({ privacyBannerSeen: true }); } catch {}
      // 幾秒後自動淡出（不強制）
      setTimeout(() => { if (note) note.style.display = "none"; }, 6000);
    } catch {}
  }

  async function updateCrisisChipFromRuntime() {
    try {
      const rt = await Storage.Runtime.get().catch(() => ({}));
      if (!crisisBanner) return;
      // 旗標 + 時間戳（兩邊都看：runtime 與 session）
      const dismissedFlag = !!rt?.crisisChipDismissed || crisisChipDismissedSession;
      const dismissedAt   = Number(rt?.crisisChipDismissedAt || 0);
      const sessionAt     = Number(crisisChipDismissedAtSession || 0);
      const effectiveDismissAt = Math.max(dismissedAt, sessionAt);
      const lockedAt = Number(rt?.lastCrisisLockAt || 0);

      // 規則：有資格，且（沒被點掉，或「新的鎖時間」晚於「點掉時間」）→ 顯示
      if (rt?.crisisEligible && (!dismissedFlag || lockedAt > effectiveDismissAt)) {
        crisisBanner.style.display = 'inline-block';
      } else {
        crisisBanner.style.display = 'none';
      }
    } catch {}
  }

  // sticky 危機提示點擊：開保護卡
  if (crisisBanner) {
    crisisBanner.addEventListener("click", async () => {
      // 直接本地打開；若要由 SW 派卡，可改發 CRISIS_TEST
      await showCrisis();
      // 🆕 前景補發：通知 SW「晶片被點擊 → 開卡」
      try {
        const r = await chrome.runtime.sendMessage({ type: "CRISIS_OPENED" });
        if (!r?.ok) {
          console.debug("[SIIHA/Content] CRISIS_OPENED not acknowledged by SW.");
        } else {
          console.debug("[SIIHA/Content] CRISIS_OPENED logged.");
        }
      } catch (e) {
        console.warn("[SIIHA/Content] CRISIS_OPENED send failed:", e);
      }
      // 點過就消失：session + runtime 兩邊都記
      crisisChipDismissedSession = true;
      crisisChipDismissedAtSession = Date.now();
      try {
        await Storage.Runtime.patch({
          crisisChipDismissed: true,
          crisisChipDismissedAt: crisisChipDismissedAtSession
        });
      } catch {}
      crisisBanner.style.display = "none";
    });
  }
})();
