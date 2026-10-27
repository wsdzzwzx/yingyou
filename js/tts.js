/* =====================================================================
 * 安全小卫士大闯关 — 语音朗读模块（悬停 / 聚焦 / 触摸即读）
 * ---------------------------------------------------------------------
 * 两层策略，自动降级：
 *   1) 预生成音频优先：audio/tts/manifest.json 中登记的文案直接播放 mp3
 *      （零延迟、音质统一、可离线；文件不存在时自动回退第 2 层）
 *   2) 浏览器内置合成：Web Speech API（speechSynthesis），零依赖零成本
 *
 * 用法：
 *   TTS.speak("要读的话");
 *   TTS.hover(el, "文字" | function () { return 文字; });
 *   TTS.bindToggle(btn);
 *   TTS.stop() / TTS.unlock() / TTS.setEnabled(bool)
 *
 * 注意：
 *   - getVoices() 首帧为空数组，必须等 voiceschanged 事件
 *   - Chrome 在 cancel() 后立即 speak() 会被吞，需延迟一帧
 *   - iOS Safari 首次发声必须在用户手势内，故用 unlock() 预热
 *   - 移动端没有 hover，需额外绑定 touchstart
 * ===================================================================== */
(function () {
  "use strict";

  var STORE_KEY = "sws-tts-on";
  var MANIFEST_URL = "audio/tts/manifest.json";

  var supported = !!(window.speechSynthesis && window.SpeechSynthesisUtterance);

  var enabled = true;
  try { enabled = localStorage.getItem(STORE_KEY) !== "0"; } catch (e) {}

  var voice = null;          // 选中的中文语音
  var fileMap = null;        // { 原文: "文件名.mp3" }
  var audioEl = null;        // 复用的 <audio>，避免连点创建一堆实例
  var lastText = "";         // 去重：同一句话 700ms 内不重复读
  var lastAt = 0;
  var speakTimer = 0;
  var toggles = [];          // 所有开关按钮，状态统一同步
  var unlocked = false;

  /* ---------------- 静音解锁（微信 / iOS 必需） ----------------
   * 微信内置浏览器（安卓 X5、iOS WKWebView）不允许"非手势"触发媒体播放。
   * 标准解法：在第一次用户手势里，用一个极短的静音 wav 播一次，把这个
   * <audio> 元素"点亮"；之后同元素换 src 再播就不再被拦。
   * 不依赖网络（data/blob 本地生成），哪怕清单还没加载完也能立即解锁。 */
  var SILENT_URL = null;
  function silentUrl() {
    if (SILENT_URL) return SILENT_URL;
    try {
      var rate = 8000, n = 400;                       // 0.05s 静音
      var buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
      var ws = function (off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
      ws(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
      v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      ws(36, "data"); v.setUint32(40, n * 2, true);
      SILENT_URL = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    } catch (e) { SILENT_URL = ""; }
    return SILENT_URL;
  }

  function ensureAudio() {
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.preload = "auto";
      audioEl.setAttribute("playsinline", "");
      audioEl.setAttribute("webkit-playsinline", "");
    }
    return audioEl;
  }

  /* 必须在用户手势的同步调用栈里执行，不能放进 setTimeout / Promise */
  function prime() {
    var el = ensureAudio();
    var url = silentUrl();
    if (!url) return;
    try {
      el.onended = el.onerror = null;
      el.src = url;
      el.volume = 0;
      var p = el.play();
      if (p && p.then) p.then(function () {
        // 已被正式音频接管（同一手势里紧跟着朗读）时不要暂停，否则会把刚播的 mp3 掐掉
        if (el.src && el.src !== url) { el.volume = 1; return; }
        try { el.pause(); el.currentTime = 0; } catch (e) {}
        el.volume = 1;
      }).catch(function () { el.volume = 1; });
    } catch (e) {}
  }

  var WECHAT = /MicroMessenger/i.test(navigator.userAgent || "");
  // 微信在 JS Bridge 就绪后才允许播放（安卓 X5 尤其明显），这也是一个可用时机
  if (WECHAT) {
    document.addEventListener("WeixinJSBridgeReady", function () { prime(); }, false);
    if (window.WeixinJSBridge) prime();
  }

  /* ---------------- 语音挑选 ---------------- */
  function pickVoice() {
    if (!supported) return;
    var list = [];
    try { list = window.speechSynthesis.getVoices() || []; } catch (e) { return; }
    if (!list.length) return;                       // 还没加载好，等事件
    var zh = list.filter(function (v) { return /^zh([-_]|$)/i.test(v.lang || ""); });
    var pool = zh.length ? zh : list;
    // 优先级：Edge 在线自然音 > 系统中文女声 > 任意中文
    var rules = [
      /Xiaoxiao.*Natural/i, /Yunxi.*Natural/i, /Xiaoyi.*Natural/i,
      /Natural.*Chinese/i, /Xiaoxiao/i, /Xiaoyi/i,
      /Huihui/i, /Yaoyao/i, /Kangkang/i, /Chinese/i
    ];
    for (var i = 0; i < rules.length; i++) {
      for (var j = 0; j < pool.length; j++) {
        if (rules[i].test(pool[j].name || "")) { voice = pool[j]; return; }
      }
    }
    voice = pool[0] || null;
  }
  if (supported) {
    pickVoice();
    window.speechSynthesis.addEventListener("voiceschanged", pickVoice);
    // 兜底轮询：个别浏览器不派发 voiceschanged
    var tries = 0;
    var poll = setInterval(function () {
      tries++;
      pickVoice();
      if (voice || tries > 20) clearInterval(poll);
    }, 250);
  }

  /* ---------------- 预生成音频清单 ---------------- */
  function loadManifest() {
    if (!window.fetch) return;
    fetch(MANIFEST_URL, { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) {
        if (!json) return;
        fileMap = json.items || json;             // 兼容 {items:{}} 与扁平映射
        if (!fileMap || !Object.keys(fileMap).length) fileMap = null;
      })
      .catch(function () {});                     // file:// 或未生成时静默
  }
  loadManifest();

  function playFile(file, text) {
    try {
      var el = ensureAudio();
      // 播放被拒（自动播放策略）或文件缺失时回退合成。
      // 注意：绝不能把 audioEl 置空——微信/iOS 里元素一旦被手势点亮，
      // 重新 new 出来的新元素又回到"未解锁"状态，必须始终复用同一个。
      var fellBack = false;
      var fallback = function () {
        if (fellBack) return;
        fellBack = true;
        speech(text);
      };
      el.onended = null;
      el.onerror = fallback;
      el.pause();
      el.src = "audio/tts/" + file;
      el.currentTime = 0;
      var p = el.play();
      if (p && p.catch) p.catch(fallback);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- 浏览器合成 ---------------- */
  /* 长文本按句切段：Chrome 对超长 utterance 会在十几秒后自行中断，
     分段排队可绕开该限制；短句（选项文字）只有一段，无额外停顿 */
  function chunk(text) {
    var segs = String(text).match(/[^。！？；!?;\n]+[。！？；!?;\n]?/g) || [String(text)];
    var out = [], buf = "";
    segs.forEach(function (s) {
      if (buf && (buf + s).length > 60) { out.push(buf); buf = s; }
      else { buf += s; }
    });
    if (buf) out.push(buf);
    return out.filter(function (s) { return s.replace(/[\s。！？；!?;，,、]/g, "") !== ""; });
  }

  function speech(text) {
    if (!supported) return;
    var synth = window.speechSynthesis;
    try { synth.cancel(); } catch (e) {}

    // 修饰性符号转成停顿，避免引擎把 "·" "─◇─" 念成奇怪的东西
    text = clean(text);
    var segs = chunk(text);
    clearTimeout(speakTimer);
    // Chrome: cancel 后立刻 speak 会被吞掉，延迟一帧再入队
    speakTimer = setTimeout(function () {
      try {
        if (synth.paused) synth.resume();
        segs.forEach(function (seg) {
          var u = new SpeechSynthesisUtterance(seg);
          u.lang = "zh-CN";
          u.rate = 0.98;      // 略慢，方便小朋友听清
          u.pitch = 1.06;     // 稍亮一点，更亲和
          u.volume = 1;
          if (voice) u.voice = voice;
          synth.speak(u);
        });
      } catch (e) {}
    }, 40);
  }

  /* ---------------- 文案归一化 ----------------
   * 修饰性符号转成停顿，避免引擎把 "·" "─◇─" 念成奇怪的东西。
   * 必须与 tools/extract-tts-lines.mjs 的 norm() 完全一致：
   * manifest.json 的 key 是清洗后的文本，前端也按清洗后的文本查表。 */
  function clean(s) {
    return String(s == null ? "" : s)
      .replace(/[─◇·•]/g, "，")
      .replace(/\s*，\s*/g, "，")
      .replace(/，{2,}/g, "，")
      .replace(/\s+/g, " ")
      .trim();
  }

  /* ---------------- 对外：朗读 ---------------- */
  function speak(text, opts) {
    // 注意：这里只判断"开关"，不能判断 speechSynthesis 是否存在。
    // 微信安卓内核没有中文语音引擎，但预生成 mp3 依然能播——早退会把整条链路废掉。
    if (!enabled) return;
    text = clean(text);
    if (!text) return;

    var now = Date.now();
    var force = opts && opts.force;
    if (!force && text === lastText && now - lastAt < 700) return;
    lastText = text; lastAt = now;

    // 打断上一句 / 队列（翻页、换选项时不残留）
    queue = [];
    if (audioEl) { audioEl.onended = null; try { audioEl.pause(); } catch (e) {} }
    if (supported) { try { window.speechSynthesis.cancel(); } catch (e) {} }

    var file = fileMap && fileMap[text];
    if (file && !(opts && opts.forceSpeech)) {
      if (playFile(file, text)) return;
    }
    speech(text);          // 内部自带 supported 判断
  }

  function stop() {
    lastText = ""; lastAt = 0;
    queue = [];
    clearTimeout(speakTimer);
    if (audioEl) { audioEl.onended = null; try { audioEl.pause(); } catch (e) {} }
    if (supported) { try { window.speechSynthesis.cancel(); } catch (e) {} }
  }

  /* ---------------- 队列播放（触屏自动读题） ----------------
   * 触屏设备没有 hover，靠面板弹出后自动逐条朗读；
   * 逐条独立播放才能逐条命中预生成 mp3 —— 国产安卓普遍没有
   * 中文系统 TTS 引擎，纯合成方案在那些设备上会整段无声。 */
  var queue = [], queuePos = 0;

  function playQueue(items) {
    queue = items.slice();
    queuePos = 0;
    nextInQueue();
  }

  function nextInQueue() {
    if (queuePos >= queue.length) { queue = []; return; }
    var it = queue[queuePos++];
    try {
      var el = ensureAudio();
      el.onended = nextInQueue;
      el.onerror = function () { queue = []; speech(it.text); };
      el.pause();
      el.src = "audio/tts/" + it.file;
      el.currentTime = 0;
      var p = el.play();
      if (p && p.catch) p.catch(function () { queue = []; speech(it.text); });
    } catch (e) {
      queue = [];
    }
  }

  function readSequence(texts) {
    if (!enabled) return;                 // 同上：不能因缺 speechSynthesis 而整段放弃
    var list = (texts || []).map(clean).filter(Boolean);
    if (!list.length) return;
    stop();
    var allMp3 = fileMap && list.every(function (t) { return fileMap[t]; });
    if (allMp3) {
      playQueue(list.map(function (t) { return { file: fileMap[t], text: t }; }));
      return;
    }
    if (supported) {
      // 个别文案没预生成：整段合并走合成，保证节奏完整
      speech(list.join("，"));
      return;
    }
    // 无系统语音引擎（微信安卓）+ 部分文案缺 mp3：能读几条读几条
    var items = list.filter(function (t) { return fileMap && fileMap[t]; })
                    .map(function (t) { return { file: fileMap[t], text: t }; });
    if (items.length) playQueue(items);
  }

  /* ---------------- 手势预热 ----------------
   * iOS / 微信只允许在用户手势里触发第一次媒体播放（微信比浏览器更严：
   * 安卓 X5 甚至要等 WeixinJSBridgeReady）。点"开始游玩"时同步调一次：
   * 静音解锁复用的 audio 元素 + 解 speechSynthesis。
   * 注意不要依赖 manifest：清单是异步 fetch 的，微信里首点往往还没回来。 */
  function warmAudio() {
    prime();
  }

  /* ---------------- 对外：悬停绑定 ---------------- */
  function hover(el, getText) {
    if (!el) return el;
    var fire = function () {
      var t = typeof getText === "function" ? getText() : getText;
      speak(t);
    };
    el.addEventListener("mouseenter", fire);
    el.addEventListener("focus", fire);
    // 移动端无 hover，补触摸
    el.addEventListener("touchstart", fire, { passive: true });
    return el;
  }

  /* ---------------- 开关 ---------------- */
  function syncToggles() {
    toggles.forEach(function (b) {
      var compact = b.hasAttribute("data-compact");
      b.textContent = compact ? (enabled ? "🔊" : "🔇")
                             : (enabled ? "🔊 朗读开" : "🔇 朗读关");
      b.classList.toggle("off", !enabled);
      b.setAttribute("aria-pressed", enabled ? "true" : "false");
      b.title = enabled ? "悬停文字即朗读（点击关闭）" : "朗读已关闭（点击开启）";
    });
  }

  function setEnabled(v) {
    enabled = !!v;
    try { localStorage.setItem(STORE_KEY, enabled ? "1" : "0"); } catch (e) {}
    if (!enabled) stop();
    syncToggles();
  }

  function bindToggle(btn) {
    if (!btn) return btn;
    toggles.push(btn);
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();          // 别把点击冒泡给影片层
      setEnabled(!enabled);
      if (enabled) speak("朗读已开启");
    });
    syncToggles();
    return btn;
  }

  /* ---------------- 首次手势解锁（iOS / 微信必需） ---------------- */
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    pickVoice();
    prime();                        // 同步静音解锁 <audio>（微信/安卓/iOS 通用）
    if (!supported) return;
    try {
      var u = new SpeechSynthesisUtterance(" ");
      u.lang = "zh-CN";
      u.volume = 0;                 // 静默预热，不打扰用户
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }
  ["pointerdown", "touchstart", "keydown"].forEach(function (ev) {
    document.addEventListener(ev, unlock, { once: true, passive: true });
  });

  window.TTS = {
    supported: supported,
    speak: speak,
    hover: hover,
    stop: stop,
    unlock: unlock,
    prime: prime,
    warmAudio: warmAudio,
    readSequence: readSequence,
    setEnabled: setEnabled,
    isEnabled: function () { return enabled; },
    isWeChat: function () { return WECHAT; },
    bindToggle: bindToggle,
    voiceName: function () { return voice ? voice.name : ""; }
  };
})();
