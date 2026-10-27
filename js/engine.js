/* =====================================================================
 * 安全小卫士大闯关 — 交互影游引擎（平台还原版）
 * 纯前端、零依赖。剧情树数据见 js/story-data.js
 * 支持：点击 / 长按 / 四方向滑动 QTE、答题与限时选择、按坐标拖拽交付、
 *       360° 全景拖动环视、节点末尾分支、坏结局自动回跳与结局收集。
 * ===================================================================== */
(function () {
  "use strict";

  var $ = function (s) { return document.querySelector(s); };
  var video = $("#video");
  var stage = $("#stage");
  var overlay = $("#overlay");
  var pano = $("#pano");
  var fx = $("#fx");
  var fxTarget = $("#fx-target");
  var hint = $("#lookaround-hint");
  var toastEl = $("#toast");
  var loadEl = $("#video-loading");
  var loadText = loadEl ? loadEl.querySelector(".vl-text") : null;

  /* ---------------- 视频加载占位（首帧封面 + 转圈） ----------------
     弱网下切节点要等几秒，纯黑屏会被当成"卡死"。
     做法：每个视频配一张首帧 jpg（video/poster/vN.jpg），加载期间铺在 video 上，
     再叠一个延迟 200ms 才淡入的转圈提示，快网下不会闪。 */
  function posterFor(src) {
    var m = /([^/]+)\.mp4$/i.exec(String(src || ""));
    return m ? "video/poster/" + m[1] + ".jpg" : "";
  }
  function setPoster(src) {
    var p = posterFor(src);
    if (p) video.poster = p; else video.removeAttribute("poster");
  }
  function showLoading(text) {
    if (!loadEl) return;
    if (loadText && text) loadText.textContent = text;
    loadEl.classList.remove("vl-idle");
  }
  function hideLoading() {
    if (loadEl) loadEl.classList.add("vl-idle");
  }
  function setLoadProgress() {
    if (!loadText || !video.duration) return;
    var b = video.buffered;
    if (!b || !b.length) return;
    var pct = Math.min(99, Math.round((b.end(b.length - 1) / video.duration) * 100));
    if (pct > 0) loadText.textContent = "视频加载中 " + pct + "%";
  }
  /* 首页空闲时把全部首帧图预热进缓存：进节点立刻有画面，不必等海报请求 */
  function warmPosters() {
    if (!window.STORY) return;
    STORY.chapters.forEach(function (ch) {
      Object.keys(ch.nodes).forEach(function (id) {
        var n = ch.nodes[id];
        var p = n && posterFor(n.video);
        if (p) { var img = new Image(); img.src = p; }
      });
    });
  }

  /* 朗读模块：js/tts.js 未加载或为旧版时降级为空实现，不影响游戏本体。
     （线上出现过旧 tts.js + 新 engine.js 混布导致点击"开始游玩"抛异常无响应，故对可选方法逐一兜底） */
  var TTS = window.TTS || {
    speak: function () {}, hover: function (el) { return el; },
    stop: function () {}, bindToggle: function (el) { return el; },
    unlock: function () {}, warmAudio: function () {}, readSequence: function () {},
    isEnabled: function () { return false; }
  };
  ["unlock", "warmAudio", "readSequence", "speak", "stop"].forEach(function (m) {
    if (typeof TTS[m] !== "function") TTS[m] = function () {};
  });

  /* 网络版埋点：js/track.js 未加载或后端不可用时全部降级为空实现（单机照常玩） */
  var TRK = window.TRK || {};
  ["requireIdentity", "beginSession", "nodeEnter", "choice", "qte",
   "ending", "markEndingRetry", "sessionEnd"].forEach(function (m) {
    if (typeof TRK[m] !== "function") TRK[m] = function () {};
  });

  /* 触屏判定：手机/平板没有 hover，靠"面板弹出自动读题"替代悬停朗读。
     注意只用 (hover: none) 会漏掉 Windows 触摸一体机（希沃白板等）——
     它们系统里有鼠标设备，hover 媒体查询不成立，但实际用手指点按。
     所以只要设备带触摸能力（maxTouchPoints>0）就自动读题；
     带触摸的笔记本会多一个自动朗读，不影响使用，且可随时静音。 */
  var TOUCH_ONLY = window.matchMedia && window.matchMedia("(hover: none)").matches;
  var HAS_TOUCH = (navigator.maxTouchPoints || 0) > 0 || "ontouchstart" in window;
  var AUTO_READ = TOUCH_ONLY || HAS_TOUCH;

  var E = {
    chapter: null,
    nodeId: null,
    node: null,
    fired: [],          // 当前节点交互状态：undefined 未触发 / 'active' 进行中 / 'done' 已完成
    pending: 0,         // 进行中的交互数
    videoEnded: false,
    autoFired: false,   // 片尾 autoNext 是否已结算
    resolved: false,    // 当前节点是否已收尾（防重复跳转）
    lastBranch: null,   // 最近一次玩家主动分支的节点 id
    failCount: 0        // 本节点内 QTE 失败次数（用于平台失败分流）
  };

  var ENDINGS_KEY = "sws-endings-v2";

  /* ==================== 下一节点视频预加载 ====================
   * 切节点才开始 load 会黑屏等待，弱网下要十几秒。
   * 提前把"接下来要看"的视频拉进浏览器媒体缓存（同 URL，playNode 时秒开）：
   *   1. 唯一后继 node.next —— 当前视频播到 40% 后台预载，不抢播放带宽
   *   2. 分支面板（choices）—— 视频已播完、带宽空闲，立即预载全部候选
   *   3. 片尾 autoNext —— 进入节点即预载
   * 服务器响应无 Cache-Control 时，preload 的数据进 Chrome 媒体缓存仍可复用。 */
  var preloaded = {};

  function preloadVideo(nodeId, mode) {
    if (!E.chapter || !nodeId || preloaded[nodeId]) return;
    var n = E.chapter.nodes[nodeId];
    if (!n || !n.video) return;
    preloaded[nodeId] = 1;
    try {
      var v = document.createElement("video");
      v.preload = mode || "auto";
      v.src = encodeURI(n.video);
      v.load();
    } catch (e) {}
  }

  /* ==================== 结局收集 ==================== */
  function loadEndings() {
    try { return JSON.parse(localStorage.getItem(ENDINGS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveEnding(chapterId, nodeId) {
    var all = loadEndings();
    all[chapterId + ":" + nodeId] = 1;
    try { localStorage.setItem(ENDINGS_KEY, JSON.stringify(all)); } catch (e) {}
  }
  function countEndings(chapter) {
    var all = loadEndings(), n = 0, total = 0;
    Object.keys(chapter.nodes).forEach(function (id) {
      if (chapter.nodes[id].ending) { total++; if (all[chapter.id + ":" + id]) n++; }
    });
    return { got: n, total: total };
  }

  /* ==================== 工具 ==================== */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }

  function showHint(text, ms) {
    hint.textContent = text;
    show(hint);
    clearTimeout(showHint._t);
    showHint._t = setTimeout(function () { hide(hint); }, ms || 5000);
  }

  function showToast(text, ms, kind) {
    toastEl.className = "toast" + (kind ? " " + kind : "");
    toastEl.textContent = text;
    show(toastEl);
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { hide(toastEl); }, ms || 2600);
  }

  function flash(kind) {
    var f = document.createElement("div");
    f.className = "flash " + (kind || "red");
    stage.appendChild(f);
    setTimeout(function () { f.remove(); }, 480);
  }

  function shake() {
    stage.classList.remove("shaking");
    void stage.offsetWidth;
    stage.classList.add("shaking");
    setTimeout(function () { stage.classList.remove("shaking"); }, 420);
  }

  /* ==================== 点击音效（平台 /sfx/click.wav） ==================== */
  var clickSfx = null;
  try {
    clickSfx = new Audio("assets/tdream/sfx/click.wav");
    clickSfx.preload = "auto";
  } catch (e) {}
  function playClick() {
    if (!clickSfx) return;
    try {
      clickSfx.currentTime = 0;
      var p = clickSfx.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  /* ==================== 滑动音效（whoosh，滑动 QTE 拖动时播放） ==================== */
  var swipeSfx = null;
  try {
    swipeSfx = new Audio("assets/tdream/sfx/swipe.wav");
    swipeSfx.preload = "auto";
  } catch (e) {}
  function playSwipe() {
    if (!swipeSfx) return;
    try {
      swipeSfx.currentTime = 0;
      var p = swipeSfx.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  /* ==================== 720° 全景（Pano720 WebGL，CSS 拖动为回退） ==================== */
  var panoInst = null, panoUi = [];
  function destroyPano() {
    if (panoInst) { try { panoInst.destroy(); } catch (e) {} panoInst = null; }
    panoUi.forEach(function (n) { try { n.remove(); } catch (e) {} });
    panoUi = [];
    hide(pano);
  }
  function startPano(node, onDone) {
    show(pano);
    // 平台样式：底部「〈 请用鼠标拖动环顾四周 〉」+ 一圈拖动进度条
    var tip = document.createElement("div");
    tip.className = "pano-tip";
    tip.innerHTML = "<span class=\"dash\">〈</span> " + esc(node.pano.hint || "请用鼠标拖动环顾四周") + " <span class=\"dash\">〉</span>";
    var bar = document.createElement("div");
    bar.className = "pano-progress";
    bar.innerHTML = "<b></b><i></i>";
    pano.appendChild(tip); pano.appendChild(bar);
    panoUi = [tip, bar];
    var knob = bar.querySelector("i"), fill = bar.querySelector("b");
    if (window.Pano720) {
      panoInst = window.Pano720(pano, encodeURI(node.pano.img), {});
      if (panoInst) {
        // 鼠标真实拖满一圈（360°）才完成；进度条实时反映
        panoInst.on("progress", function (p) {
          fill.style.width = (p * 100).toFixed(1) + "%";
          knob.style.left = "calc(" + (p * 100).toFixed(1) + "% - 9px)";
        });
        panoInst.on("complete", function () {
          destroyPano();
          if (onDone) onDone();
        });
        panoInst.on("error", function () {
          destroyPano();
          startPanoFallback(node, onDone);
        });
        return;
      }
    }
    startPanoFallback(node, onDone);
  }
  /* 回退方案：等距柱状图横向 CSS 拖动 + 手动继续按钮 */
  function startPanoFallback(node, onDone) {
    show(pano);
    panoX = 50;
    pano.style.backgroundImage = 'url("' + encodeURI(node.pano.img) + '")';
    pano.style.backgroundPosition = "50% 50%";
    showHint(node.pano.hint || "拖动画面环顾四周", 8000);
    if (onDone) {
      var wrap = document.createElement("div");
      wrap.className = "pano-continue";
      var b = document.createElement("button");
      b.className = "choice-btn";
      b.textContent = "看完了，继续 →";
      b.addEventListener("click", function () {
        playClick();
        wrap.remove();
        hide(pano);
        onDone();
      });
      wrap.appendChild(b);
      overlay.appendChild(wrap);
    }
  }

  /* ==================== 首页 ==================== */
  function renderHome() {
    TRK.sessionEnd(false);            // 离开游戏：结算当前会话
    hide($("#screen-player"));
    hide($("#screen-ending"));
    show($("#screen-start"));
    stopVideo();
    destroyPano();
    E.node = null;

    var list = $("#chapter-list");
    list.innerHTML = "";
    STORY.chapters.forEach(function (ch) {
      var c = countEndings(ch);
      var btn = document.createElement("button");
      btn.className = "chapter-btn";
      btn.innerHTML =
        "<span>" + esc(ch.name) + "</span>" +
        '<span class="meta">' + esc(ch.desc || "") + "<br>结局收集 <b>" + c.got + " / " + c.total + "</b></span>";
      btn.addEventListener("click", function () {
        gatedStart(function () { startChapter(ch); });
      });
      TTS.hover(btn, ch.name + "。" + (ch.desc || ""));
      list.appendChild(btn);
    });

    var got = 0, all = 0;
    STORY.chapters.forEach(function (ch) { var c = countEndings(ch); got += c.got; all += c.total; });
    $("#ending-summary").textContent = "🏆 全结局收集进度：" + got + " / " + all;
  }

  function startChapter(ch) {
    E.chapter = ch;
    E.lastBranch = null;
    hide($("#screen-start"));
    hide($("#screen-ending"));
    show($("#screen-player"));
    playNode(ch.start);
  }

  /* ==================== 节点播放 ==================== */
  function playNode(nodeId) {
    var node = E.chapter.nodes[nodeId];
    if (!node) { console.error("未知节点:", nodeId); return; }

    E.node = node;
    E.nodeId = nodeId;
    TRK.nodeEnter(nodeId);          // 埋点：进入节点（含死循环检测）
    E.fired = [];
    E.pending = 0;
    E.videoEnded = false;
    E.autoFired = false;
    E.resolved = false;
    E.failCount = 0;
    E.nextPreloaded = false;
    E.panoDone = !(node.pano && node.pano.when === "end");

    if (node.autoNext) preloadVideo(node.autoNext.next, "auto");

    overlay.innerHTML = "";
    clearDragLayer();
    TTS.stop();                                     // 换节点时掐断上一句朗读
    $("#hud-title").textContent = node.title + "　" + (node.scene || "");

    // 全景层（720° WebGL，失败自动回退 CSS 拖动）
    destroyPano();
    if (node.pano && node.pano.when !== "end") {
      startPano(node, function () { E.panoDone = true; });
    }

    setPoster(node.video);
    showLoading("视频加载中…");
    video.src = encodeURI(node.video);
    video.load();

    video.onloadedmetadata = function () {
      syncVideoBox();
      // Win7 老内核（Chrome<53）play() 返回 undefined，直接 .catch 会 TypeError
      var pp = video.play();
      if (pp && pp.catch) pp.catch(function () { showTapToPlay(); hideLoading(); });
    };
    video.onplaying = hideLoading;                       // 真正出画 → 撤占位
    video.onwaiting = function () { showLoading("缓冲中…"); };
    video.onstalled = function () { showLoading("网络较慢，缓冲中…"); };
    video.onprogress = setLoadProgress;
    video.onerror = hideLoading;
    video.ontimeupdate = onTimeUpdate;
    video.onended = onVideoEnded;
    // timeupdate 只有约 4Hz：互动触发点贴近片尾时会整段漏采（1-7 的 10.8s vs 11s 片长），
    // 导致视频直接播完跳节点。用 60ms 轮询兜底保证触发点必中。
    if (E.trigTimer) clearInterval(E.trigTimer);
    E.trigTimer = setInterval(onTimeUpdate, 60);
  }

  function showTapToPlay() {
    var wrap = document.createElement("div");
    wrap.className = "qte-wrap";
    wrap.innerHTML = '<div class="qte-prompt">点击画面开始播放</div>';
    var btn = document.createElement("button");
    btn.className = "qte-btn";
    btn.textContent = "▶";
    btn.addEventListener("click", function () { wrap.remove(); video.play(); });
    wrap.appendChild(btn);
    overlay.appendChild(wrap);
  }

  function stopVideo() {
    if (E.trigTimer) { clearInterval(E.trigTimer); E.trigTimer = null; }
    video.onloadedmetadata = video.ontimeupdate = video.onended = null;
    video.onplaying = video.onwaiting = video.onstalled = null;
    video.onprogress = video.onerror = null;
    hideLoading();
    try { video.pause(); } catch (e) {}
    video.removeAttribute("src");
    video.removeAttribute("poster");
    video.load();
  }

  function pauseForInteraction() { try { video.pause(); } catch (e) {} }
  function resumeVideo() { var pp = video.play(); if (pp && pp.catch) pp.catch(function () {}); }

  /* 计算视频实际显示区域，让画面坐标(0~1)能精准对齐
     舞台已铺满整个视口，视频按比例居中（contain）；互动层 #overlay 同步收缩到视频显示区，
     保证 QTE 判定点、选择题面板始终贴在画面上而不是黑边上。 */
  function syncVideoBox() {
    var sw = stage.clientWidth, sh = stage.clientHeight;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) {
      fx.style.width = fx.style.height = "0px";
      overlay.style.left = overlay.style.top = "0px";
      overlay.style.width = sw + "px";
      overlay.style.height = sh + "px";
      return;
    }
    var cover = stage.classList.contains("cover");
    var k = cover ? Math.max(sw / vw, sh / vh) : Math.min(sw / vw, sh / vh);
    var w = vw * k, h = vh * k;
    var x = (sw - w) / 2, y = (sh - h) / 2;
    fx.style.left = x + "px"; fx.style.top = y + "px";
    fx.style.width = w + "px"; fx.style.height = h + "px";
    overlay.style.left = x + "px"; overlay.style.top = y + "px";
    overlay.style.width = w + "px"; overlay.style.height = h + "px";
  }
  window.addEventListener("resize", function () { if (E.node) syncVideoBox(); });

  /* ==================== 时间驱动 ==================== */
  function onTimeUpdate() {
    if (!E.node || E.resolved) return;
    var t = video.currentTime;
    var node = E.node;

    // 片尾自动结算（坏结局/一般结局按平台回跳）
    // 平台给的 video_time 有可能正好等于/略超视频时长（如 1-12、1-19），
    // 这里钳到片尾前 0.25s，保证结局卡在播完前平滑弹出；播完事件仍是最终兜底。
    if (node.autoNext && !E.autoFired) {
      var at = node.autoNext.at;
      var dur = video.duration;
      if (isFinite(dur) && dur > 0.5 && at > dur - 0.25) at = dur - 0.25;
      if (t >= at) {
        E.autoFired = true;
        if (node.ending) { pauseForInteraction(); showEnding(node); return; }
        playNode(node.autoNext.next);
        return;
      }
    }

    var its = node.interactions || [];
    for (var i = 0; i < its.length; i++) {
      if (E.fired[i]) continue;
      var it = its[i];
      if (typeof it.at !== "number" || t < it.at) continue;
      E.fired[i] = "active";
      E.pending++;
      runInteraction(it, i);
      break;   // 交互串行：一次只弹一个
    }

    // 唯一后继的节点：播到 40% 后台预载下一节点视频
    if (node.next && !E.nextPreloaded && video.duration > 1 && t > video.duration * 0.4) {
      E.nextPreloaded = true;
      preloadVideo(node.next, "auto");
    }
  }

  function onVideoEnded() {
    E.videoEnded = true;
    // 兜底：若还有未触发的互动（触发点贴近片尾被漏采），在片尾直接补触发，不让视频悄悄跳节点
    var its = (E.node && E.node.interactions) || [];
    for (var i = 0; i < its.length; i++) {
      if (!E.fired[i] && typeof its[i].at === "number") {
        E.fired[i] = "active";
        E.pending++;
        runInteraction(its[i], i);
        return;
      }
    }
    if (E.pending === 0) finishNode();
  }

  function interactionDone(index) {
    if (typeof index === "number") E.fired[index] = "done";
    E.pending = Math.max(0, E.pending - 1);
    if (E.resolved) return;
    if (E.videoEnded && E.pending === 0) finishNode();
    else resumeVideo();
  }

  /* 回到触发点重来（对应平台 rewind trigger_point） */
  function rewindTo(it, index) {
    E.fired[index] = null;
    E.pending = Math.max(0, E.pending - 1);
    if (E.resolved) return;
    try { video.currentTime = Math.max(0, it.at); } catch (e) {}
    resumeVideo();
  }

  function finishNode() {
    if (E.resolved) return;
    var node = E.node;

    // 平台里 1-1 的 360° 环顾是「视频播完后」触发，完成后自动继续剧情
    if (node.pano && !E.panoDone) {
      E.panoDone = true;
      pauseForInteraction();
      startPano(node, function () {
        E.resolved = false;
        finishNode();
      });
      return;
    }

    E.resolved = true;
    if (node.ending) { showEnding(node); return; }
    if (node.choices && node.choices.length) { showBranch(node.choices); return; }
    if (node.next) { playNode(node.next); return; }
    // 兜底：节点只配了 autoNext 但没有 ending 时，也按平台回跳目标继续
    if (node.autoNext && node.autoNext.next) { playNode(node.autoNext.next); return; }
    renderHome();
  }

  function jumpTo(nodeId) {
    if (!nodeId) return;
    E.resolved = true;
    overlay.innerHTML = "";
    clearDragLayer();
    playNode(nodeId);
  }

  /* ==================== 交互分发 ==================== */
  function runInteraction(it, index) {
    if (it.type === "qte") runQTE(it, index);
    else if (it.type === "choice") runChoice(it, index);
    else if (it.type === "timedChoice") runTimedChoice(it, index);
    else if (it.type === "drag") runDrag(it, index);
    else if (it.type === "safezone") runSafezone(it, index);
    else interactionDone(index);
  }

  /* ---------- QTE：点击 / 长按 / 滑动 ---------- */
  var DIR_GLYPH = { up: "↑", down: "↓", left: "←", right: "→" };

  function runQTE(it, index) {
    pauseForInteraction();

    var winMs = (it.window || 10) * 1000;
    var holdMs = it.holdMs || 1500;
    var done = false;
    var myNodeId = E.nodeId;               // 节点已切换时，所有挂起定时器/回调全部作废
    function stale() { return E.nodeId !== myNodeId; }

    var isSwipe = it.kind === "swipe";
    var isHold = it.kind === "hold";
    /* 埋点：QTE 名称 / 类型（点击/长按/滑动）、首次弹出时刻、累计尝试次数 */
    var qteName = (it.prompt || node.title || "QTE");
    var qteType = isHold ? "长按" : (isSwipe ? "滑动" : "点击");
    var qteT0 = performance.now();
    var qteAttempts = 1;

    // 平台长按/滑动点的 prompt 常写着「点击！」，对小朋友容易误解，这里显式改成对应动作
    var promptText = it.prompt || "快速反应！";
    if (isHold && promptText.indexOf("长按") < 0) promptText = "长按！";
    if (isSwipe && promptText.indexOf("滑") < 0) promptText = "滑动！";

    var wrap = document.createElement("div");
    wrap.className = "qte-wrap";
    wrap.innerHTML = '<div class="qte-prompt">' + esc(promptText) + "</div>";

    // 判定点按平台坐标定位（默认居中）；径向聚焦遮罩以判定点为圆心
    var anchor = document.createElement("div");
    anchor.className = "qte-anchor";
    var p = it.pos || { x: 0.5, y: 0.5 };
    anchor.style.left = (p.x * 100) + "%";
    anchor.style.top = (p.y * 100) + "%";
    wrap.style.setProperty("--qx", (p.x * 100) + "%");
    wrap.style.setProperty("--qy", (p.y * 100) + "%");

    // 圆钮 + 呼吸光环 + 头像包在同一个 mover 里：滑动时作为整体位移（光圈跟着按钮一起走）
    var mover = document.createElement("div");
    mover.className = "qte-mover";

    // 平台 trajectory 型：NPC 头像飞过来，点击它 → 用头像图片做判定点的视觉提示
    if (it.avatar) {
      var av = document.createElement("img");
      av.className = "qte-avatar";
      av.src = encodeURI(it.avatar);
      av.alt = "";
      mover.appendChild(av);
    }

    var btn = document.createElement("button");
    btn.className = "qte-btn";
    var hsecEl = null, pctEl = null;
    if (isSwipe) {
      // 平台样式：圆钮内「箭头 + 滑动!」上下排布
      btn.innerHTML = '<span class="qte-glyph">' + DIR_GLYPH[it.dir || "right"] + '</span><span class="qte-tapl">滑动!</span>';
    } else if (isHold) {
      // 平台样式：圆钮内「长按! + 大号百分比 + 秒数」表盘排版
      btn.innerHTML = '<span class="qte-tapl">长按!</span><span class="qte-pct">0%</span><span class="qte-hsec">0.0s</span>';
      pctEl = btn.querySelector(".qte-pct");
      hsecEl = btn.querySelector(".qte-hsec");
    } else {
      btn.textContent = "!";
    }
    if (isSwipe) btn.classList.add("swipe");
    if (isHold) btn.classList.add("hold");
    // 平台 ig-pulse-ring 呼吸光环（铜金主题统一色）
    var ring = document.createElement("div");
    ring.className = "qte-ring";
    mover.appendChild(ring);
    mover.appendChild(btn);
    anchor.appendChild(mover);
    wrap.appendChild(anchor);
    var track = document.createElement("div");
    track.className = "qte-track";
    var bar = document.createElement("div");
    bar.className = "qte-timebar";
    track.appendChild(bar);
    wrap.appendChild(track);
    // 平台样式：按钮正下方 "7.8s" 秒数倒计时（长按型的秒数在按钮表盘内，不再重复）
    var countEl = null;
    if (!isHold) {
      countEl = document.createElement("div");
      countEl.className = "qte-count";
      countEl.style.left = (p.x * 100) + "%";
      countEl.style.top = (p.y * 100) + "%";
      wrap.appendChild(countEl);
    }

    overlay.appendChild(wrap);

    // 需要在收起时解绑的全局监听（避免手势拖到元素外后监听残留）
    var winCleanup = [];
    function onWin(type, fn) {
      window.addEventListener(type, fn, { passive: false });
      winCleanup.push(function () { window.removeEventListener(type, fn); });
    }
    function cleanup() {
      wrap.remove();
      for (var i = 0; i < winCleanup.length; i++) { try { winCleanup[i](); } catch (x) {} }
      winCleanup.length = 0;
    }

    function ok() {
      if (done || stale()) return; done = true;
      TRK.qte(qteName, qteType, true, performance.now() - qteT0, qteAttempts);
      playClick();
      flash("green");
      anchor.classList.add("win");           // 平台 qte-success 弹出动画
      setTimeout(function () { cleanup(); if (!stale()) interactionDone(index); }, 320);
    }
    // 失败统一出口：抖动 → 清 UI → 计数/分流
    function failFlow(reason, isTimeout) {
      TRK.qte(qteName, qteType, false, performance.now() - qteT0, qteAttempts);
      flash("red");
      shake();
      anchor.classList.add("fail");          // 平台 qte-shake 抖动
      setTimeout(function () {
        cleanup();
        if (stale()) return;                 // 节点已切换，旧互动的挂起流程全部作废
        // 平台失败分流：同节点累计失败达到阈值 → 进入失败分支
        E.failCount++;
        if (E.node.failAfter && E.failCount >= E.node.failAfter.count) {
          jumpTo(E.node.failAfter.next);
          return;
        }
        if (it.onFail === "jump" && it.failNext) { jumpTo(it.failNext); return; }
        if (it.onFail === "continue") { interactionDone(index); return; }
        // 设计好的「完全不反应 → 一般结局」分支（如 1-7）
        if (isTimeout && it.timeoutNext) { jumpTo(it.timeoutNext); return; }
        // 默认 retry：视频保持暂停，原地重新弹出同一个 QTE，直到做对为止
        showToast(reason === "wrong" ? "方向不对，再来一次！" : "手再快一点！再试一次", 1500, "warn");
        retrySame(isTimeout ? 800 : 550);
      }, 300);
    }

    // 原地重试：E.fired 保持 active，避免 60ms 触发轮询重复弹出；pending 不做增减
    function retrySame(delay) {
      setTimeout(function () {
        if (stale() || E.resolved || E.fired[index] !== "active") return;
        qteAttempts++;                     // 原地重试：尝试次数 +1
        runInteraction(it, index);
      }, delay);
    }

    function bad(reason) {
      if (done || stale()) return; done = true;
      failFlow(reason, false);
    }
    function timeout() {
      if (done || stale()) return; done = true;
      failFlow("late", true);                // 不再提前置 done 后调 bad（会把失败流程吃掉，视频卡死）
    }

    if (isHold) {
      var holding = false, holdStart = 0;
      bar.classList.add("hold");
      var down = function (e) {
        e.preventDefault();
        if (done || stale()) return;
        holding = true; holdStart = performance.now();
        // 捕获指针：手指/鼠标移出按钮范围也能继续计时与正确结束
        try { wrap.setPointerCapture(e.pointerId); } catch (x) {}
        (function loop() {
          if (done || stale()) return;
          if (!holding) { bar.style.transform = "scaleX(0)"; if (pctEl) pctEl.textContent = "0%"; return; }
          var q = Math.min(1, (performance.now() - holdStart) / holdMs);
          bar.style.transform = "scaleX(" + q + ")";
          if (pctEl) pctEl.textContent = Math.round(q * 100) + "%";
          if (q >= 1) { ok(); return; }
          requestAnimationFrame(loop);
        })();
      };
      var up = function () { if (!done && holding) { holding = false; bar.style.transform = "scaleX(0)"; if (pctEl) pctEl.textContent = "0%"; } };
      wrap.addEventListener("pointerdown", down);
      // 兜底：无论在哪里松手都能结束长按
      onWin("pointerup", up);
      onWin("pointercancel", up);
    } else if (isSwipe) {
      // 滑动 QTE：沿箭头方向把按钮拖出轨道才判定成功（平台 swipe-dodge 交互）
      bar.classList.add("swipe");
      var dir = it.dir || "right";
      var ang = { right: 0, down: 90, left: 180, up: -90 }[dir];
      var rad = ang * Math.PI / 180;
      var ux = Math.cos(rad), uy = Math.sin(rad);   // 方向单位向量
      var LEN = 130, THRESH = 0.6;                  // 轨道长度 / 成功距离阈值

      // 引导轨道（纯金色虚线 + 金色进度填充 + 来回弹动的箭头）
      // 起点从按钮边缘外沿方向偏移，别压在按钮上；下滑时箭头就出现在按钮正下方
      var guide = document.createElement("div");
      guide.className = "swipe-track";
      var edgeOff = btn.offsetWidth / 2 + 6;        // 按钮半径 + 6px 间隙
      guide.style.left = (p.x * wrap.offsetWidth + ux * edgeOff) + "px";
      guide.style.top = (p.y * wrap.offsetHeight + uy * edgeOff) + "px";
      guide.style.transform = "translateY(-50%) rotate(" + ang + "deg)";
      guide.innerHTML = '<div class="swipe-fill"></div><div class="swipe-arrowhead">➤</div>';
      wrap.appendChild(guide);
      // 两个沿方向发散的涟漪，提示「朝箭头方向滑」
      [0, .9].forEach(function (d) {
        var rp = document.createElement("div");
        rp.className = "swipe-ripple";
        rp.style.left = (p.x * 100) + "%";
        rp.style.top = (p.y * 100) + "%";
        rp.style.animationDelay = d + "s";
        rp.style.setProperty("--rip-x", (ux * LEN) + "px");
        rp.style.setProperty("--rip-y", (uy * LEN) + "px");
        wrap.appendChild(rp);
      });

      var fill = guide.querySelector(".swipe-fill");
      // 按钮与光圈一起沿轨道跟手（mover 整体位移，按钮自己的脉冲动画不受影响）
      var sx = 0, sy = 0, tracking = false, proj = 0;
      var setBtn = function (q) {
        mover.style.transform = "translate(" + (ux * q * LEN).toFixed(1) + "px," + (uy * q * LEN).toFixed(1) + "px)";
      };
      var resetSwipe = function () { setBtn(0); fill.style.width = "0%"; fill.classList.remove("wrong"); };
      var sDown = function (e) {
        if (done || stale()) return;
        e.preventDefault();
        tracking = true; sx = e.clientX; sy = e.clientY; proj = 0;
        playSwipe();                                 // 滑动 whoosh 音效
        try { wrap.setPointerCapture(e.pointerId); } catch (x) {}
      };
      var sMove = function (e) {
        if (done || !tracking) return;
        e.preventDefault();
        var dx = e.clientX - sx, dy = e.clientY - sy;
        proj = dx * ux + dy * uy;                    // 沿正确方向的投影
        var q = Math.max(0, Math.min(1, proj / LEN));
        fill.style.width = (q * 100) + "%";
        fill.classList.toggle("wrong", proj < -6);   // 反方向拖 → 填充变红警示
        setBtn(q);
      };
      var sUp = function (e) {
        if (done || !tracking) return;
        tracking = false;
        resetSwipe();
        var dx = e.clientX - sx, dy = e.clientY - sy;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 24) { bad("wrong"); return; }
        var got = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
        if (got === it.dir && proj >= LEN * THRESH) ok(); else bad("wrong");
      };
      wrap.addEventListener("pointerdown", sDown);
      wrap.addEventListener("pointermove", sMove);
      onWin("pointerup", sUp);
      onWin("pointercancel", function () { tracking = false; resetSwipe(); });
    } else {
      bar.classList.add("swipe");
      btn.addEventListener("click", ok);
      wrap.addEventListener("click", function (e) { if (e.target === wrap) ok(); });
    }

    // 判定窗口倒计时：rAF 只驱动进度条动画，超时判定另用 setTimeout 兜底。
    // （页面被后台节流时 rAF 会停摆，只靠 rAF 会出现「超时永不触发」）
    var t0 = performance.now();
    var qteDeadline = setTimeout(function () { if (!done) timeout(); }, winMs);
    winCleanup.push(function () { clearTimeout(qteDeadline); });
    (function tick() {
      if (done || stale()) return;
      var leftMs = winMs - (performance.now() - t0);
      if (countEl) countEl.textContent = Math.max(0, leftMs / 1000).toFixed(1) + "s";
      if (hsecEl) hsecEl.textContent = Math.max(0, leftMs / 1000).toFixed(1) + "s";
      if (!bar.classList.contains("hold")) bar.style.transform = "scaleX(" + Math.max(0, leftMs / winMs) + ")";
      requestAnimationFrame(tick);
    })();
  }

  /* ---------- 答题 / 分支选项 ---------- */
  function runChoice(it, index) {
    pauseForInteraction();
    buildChoice(it, index, null);
  }

  /* ---------- 安全区调整（平台 safe_zone：点两侧箭头把小人挪进安全区，支持 ←/A、→/D） ---------- */
  function runSafezone(it, index) {
    pauseForInteraction();

    var done = false;
    var winMs = (it.window || 10) * 1000;
    var szT0 = performance.now();
    var szName = it.prompt || "安全区调整";

    var wrap = document.createElement("div");
    wrap.className = "qte-wrap";
    wrap.innerHTML = '<div class="qte-prompt">' + esc(it.prompt || "点击箭头，帮同学跑进安全区！") + "</div>";

    // 横向跑道：金色描边墨绿胶囊 + 安全区红药丸 + 小人
    var bar = document.createElement("div");
    bar.className = "sz-bar";
    var zone = document.createElement("div");
    zone.className = "sz-zone";
    zone.textContent = "安全区";
    var avatar = document.createElement("div");
    avatar.className = "sz-avatar";
    avatar.innerHTML = "<span>🧒</span>";
    bar.appendChild(zone);
    bar.appendChild(avatar);
    wrap.appendChild(bar);

    function mkBtn(cls, glyph, label) {
      var holder = document.createElement("div");
      holder.className = "sz-btn-hold " + cls;
      var b = document.createElement("button");
      b.className = "sz-btn";
      b.textContent = glyph;
      var lab = document.createElement("div");
      lab.className = "sz-btn-label";
      lab.textContent = label;
      holder.appendChild(b);
      holder.appendChild(lab);
      wrap.appendChild(holder);
      return b;
    }
    var btnL = mkBtn("sz-l", "‹", "向左调整");
    var btnR = mkBtn("sz-r", "›", "向右调整");

    // 右上角圆形秒数徽章（平台样式）
    var count = document.createElement("div");
    count.className = "sz-count";
    wrap.appendChild(count);

    overlay.appendChild(wrap);

    var winCleanup = [];
    function cleanup() {
      wrap.remove();
      for (var i = 0; i < winCleanup.length; i++) { try { winCleanup[i](); } catch (x) {} }
      winCleanup.length = 0;
    }
    function ok() {
      if (done || stale()) return; done = true;
      TRK.qte(szName, "安全区", true, performance.now() - szT0, 1);
      playClick();
      flash("green");
      wrap.classList.add("sz-win");
      setTimeout(function () { cleanup(); if (!stale()) interactionDone(index); }, 450);
    }
    function fail() {
      if (done || stale()) return; done = true;
      TRK.qte(szName, "安全区", false, performance.now() - szT0, 1);
      flash("red");
      shake();
      wrap.classList.add("sz-fail");
      showToast(it.failTip || "没跑进安全区，慌乱中摔了一跤！", 1800, "warn");
      setTimeout(function () { cleanup(); if (!stale()) interactionDone(index); }, 450);
    }

    // 几何：小人位置 0~1；安全区 it.zone=[z0,z1]；每次点击/按键走 it.step
    var z0 = (it.zone && it.zone[0]) != null ? it.zone[0] : 0.46;
    var z1 = (it.zone && it.zone[1]) != null ? it.zone[1] : 0.62;
    var step = it.step || 0.085;
    var pos = it.start != null ? it.start : 0.04;
    function render() {
      avatar.style.left = "calc(" + (pos * 100).toFixed(2) + "% - 26px)";
    }
    render();
    function inZone() { return pos >= z0 && pos <= z1; }
    function move(dir) {
      if (done) return;
      pos = Math.max(0, Math.min(1, pos + dir * step));
      render();
      playClick();
      if (inZone()) ok();
    }

    // 按钮：点一下走一步，按住连续走（对应平台"点击两边的箭头调整"）
    function bindHold(btn, dir) {
      var timer = null;
      var stop = function () { if (timer) { clearInterval(timer); timer = null; } };
      btn.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        move(dir);
        stop();
        timer = setInterval(function () { move(dir); }, 170);
      });
      btn.addEventListener("pointerup", stop);
      btn.addEventListener("pointerleave", stop);
      winCleanup.push(stop);
    }
    bindHold(btnL, -1);
    bindHold(btnR, +1);

    // 键盘：← / A 左移，→ / D 右移
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var k = e.key;
      if (k === "ArrowLeft" || k === "a" || k === "A") { e.preventDefault(); move(-1); }
      else if (k === "ArrowRight" || k === "d" || k === "D") { e.preventDefault(); move(+1); }
    }
    window.addEventListener("keydown", onKey);
    winCleanup.push(function () { window.removeEventListener("keydown", onKey); });

    // 倒计时：rAF 只刷圆徽章，超时判定用 setTimeout 兜底（后台节流不会卡死）
    var myNodeId = E.nodeId;                 // 节点已切换时挂起定时器作废
    function stale() { return E.nodeId !== myNodeId; }
    var t0 = performance.now();
    var deadline = setTimeout(function () { if (!done && !stale()) fail(); }, winMs);
    winCleanup.push(function () { clearTimeout(deadline); });
    (function tick() {
      if (done || stale()) return;
      var left = Math.max(0, (winMs - (performance.now() - t0)) / 1000);
      count.textContent = left.toFixed(1) + "s";
      count.classList.toggle("urgent", left <= 3);
      requestAnimationFrame(tick);
    })();
  }

  function runTimedChoice(it, index) {
    pauseForInteraction();
    buildChoice(it, index, it.countdown || 10);
  }

  /* 平台风格选择面板：底部渐变 + 黑石板铜边按钮 + 倒计时徽章 + 数字键（对应平台 branches 组件） */
  function buildChoicePanel(cfg) {
    var done = false;
    TTS.stop();                     // 面板弹出时掐断上一句，避免和选项朗读叠音
    var wrap = document.createElement("div");
    wrap.className = "choice-wrap";
    wrap.innerHTML = '<div class="choice-shade"></div>';
    var inner = document.createElement("div");
    inner.className = "choice-inner";

    var title = document.createElement("div");
    title.className = "choice-title";
    title.textContent = cfg.title || "请选择剧情走向";
    inner.appendChild(title);
    TTS.hover(title, title.textContent);

    var deco = document.createElement("div");
    deco.className = "choice-deco";
    function dash() {
      var s = document.createElement("span");
      s.className = "dash";
      s.textContent = "─◇─";
      return s;
    }
    var countEl = null, countNum = null;
    if (cfg.countdown) {
      deco.appendChild(dash());
      countEl = document.createElement("span");
      countEl.className = "choice-count";
      countNum = document.createElement("b");
      countNum.textContent = cfg.countdown;
      countEl.appendChild(document.createTextNode("⏱ "));
      countEl.appendChild(countNum);
      countEl.appendChild(document.createTextNode("s"));
      deco.appendChild(countEl);
      deco.appendChild(dash());
    } else {
      deco.appendChild(dash());
      var sel = document.createElement("span");
      sel.className = "choice-count";
      sel.textContent = "请选择";
      deco.appendChild(sel);
      deco.appendChild(dash());
    }
    inner.appendChild(deco);

    /* 触屏兜底：给一个"点此朗读"按钮。
       微信 / 部分内嵌 WebView 会静默拦截非手势触发的自动播放，此时点一下
       （真实手势）必定出声；也方便小朋友反复听题。 */
    if (AUTO_READ) {
      var readBtn = document.createElement("button");
      readBtn.type = "button";
      readBtn.className = "choice-read";
      readBtn.textContent = "🔊 点此朗读";
      readBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (window.TTS && typeof window.TTS.prime === "function") window.TTS.prime();
        TTS.readSequence([title.textContent].concat(
          cfg.options.map(function (o) { return o.label; })
        ));
      });
      inner.appendChild(readBtn);
    }

    var opts = document.createElement("div");
    opts.className = "choice-options";
    inner.appendChild(opts);

    var timerBar = null;
    if (cfg.countdown) {
      var t = document.createElement("div");
      t.className = "choice-timer";
      t.innerHTML = "<i></i>";
      inner.appendChild(t);
      timerBar = t.querySelector("i");
    }
    wrap.appendChild(inner);
    overlay.appendChild(wrap);

    function close() {
      wrap.remove();
      window.removeEventListener("keydown", onKey);
      while (winCleanup.length) { try { winCleanup.pop()(); } catch (x) {} }
    }
    var winCleanup = [];
    function pick(op, btn) {
      if (done) return; done = true;
      TTS.stop();
      playClick();
      var idx = btn ? Array.prototype.indexOf.call(opts.children, btn) : -1;
      if (btn) {
        btn.classList.add("picked");
        Array.prototype.forEach.call(opts.children, function (x) { if (x !== btn) x.classList.add("dim"); });
      }
      // 平台行为：选中后停一拍播放反馈，再切换剧情
      setTimeout(function () { close(); cfg.onPick(op, idx); }, 420);
    }
    function onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      var n = parseInt(e.key, 10) - 1;
      if (n >= 0 && n < cfg.options.length) pick(cfg.options[n], opts.children[n]);
    }
    window.addEventListener("keydown", onKey);

    cfg.options.forEach(function (op, i) {
      var b = document.createElement("button");
      b.className = "choice-btn";
      var num = document.createElement("span");
      num.className = "num";
      num.textContent = i + 1;
      var lab = document.createElement("span");
      lab.className = "lab";
      lab.textContent = op.label;
      b.appendChild(num);
      b.appendChild(lab);
      b.addEventListener("click", function () { pick(op, b); });
      TTS.hover(b, op.label);
      opts.appendChild(b);
    });

    /* 石板按钮文字自适应：高度锁死为 PNG 固定比例，文字放不下就自动换行并逐级缩小字号 */
    function fitChoiceLabels() {
      Array.prototype.forEach.call(opts.children, function (b) {
        if (!b.classList.contains("choice-btn")) return;
        b.style.height = "";
        b.style.fontSize = "";
        // 用 PNG 原始比例锁高（1354:449），背景图永不变形
        b.style.height = (b.clientWidth * 449 / 1354).toFixed(1) + "px";
        var fs = parseFloat(getComputedStyle(b).fontSize) || 16;
        var min = 10, guard = 30;
        while (guard-- > 0 && b.scrollHeight > b.clientHeight + 1 && fs > min) {
          fs -= 1;
          b.style.fontSize = fs + "px";
        }
      });
    }
    fitChoiceLabels();
    window.addEventListener("resize", fitChoiceLabels);
    winCleanup.push(function () { window.removeEventListener("resize", fitChoiceLabels); });

    /* 触屏：弹出面板自动把题目+选项读一遍（逐条命中预生成音频串行播放）。
       桌面端保留安静的悬停朗读，不自动念，避免打扰。
       旧版 tts.js 无 readSequence 时，合并一段走 speak 兜底（speak 是打断式，
       逐条调会互相掐断只剩最后一条，所以必须合并）。 */
    if (AUTO_READ && cfg.autoRead) {
      var readLines = [title.textContent].concat(
        Array.prototype.map.call(opts.children, function (b) {
          var l = b.querySelector(".lab");
          return l ? l.textContent : "";
        })
      );
      if (window.TTS && typeof window.TTS.readSequence === "function") {
        TTS.readSequence(readLines);
      } else {
        var joined = readLines.filter(Boolean).join("，");
        if (joined) TTS.speak(joined);
      }
    }

    if (cfg.countdown) {
      var t0 = performance.now(), limit = cfg.countdown * 1000, lastSec = cfg.countdown;
      var onTimeUp = function () {
        if (done) return;
        done = true; TTS.stop(); close();
        flash("red"); shake();
        showToast("时间到，再来一次！", 1800, "warn");
        if (cfg.onTimeout) cfg.onTimeout();
      };
      // setTimeout 兜底：rAF 在后台页会停摆
      var chooseDeadline = setTimeout(onTimeUp, limit);
      winCleanup.push(function () { clearTimeout(chooseDeadline); });
      (function tick() {
        if (done) return;
        var left = 1 - (performance.now() - t0) / limit;
        if (timerBar) timerBar.style.transform = "scaleX(" + Math.max(0, left) + ")";
        var sec = Math.max(0, Math.ceil(left * cfg.countdown));
        if (countNum && sec !== lastSec) {
          lastSec = sec;
          countNum.textContent = sec;
          if (sec <= 3) countEl.classList.add("urgent");
        }
        requestAnimationFrame(tick);
      })();
    }
  }

  /* ---------- 答题 / 限时选择 ---------- */
  function buildChoice(it, index, countdown) {
    buildChoicePanel({
      title: it.prompt || "做出你的选择",
      countdown: countdown,
      autoRead: true,
      options: it.options,
      onPick: function (op, idx) {
        var kind = countdown ? "限时选择" : "答题";
        if (op.pass) { TRK.choice(E.nodeId, idx, true, null, op.label); interactionDone(index); return; }
        if (op.correct) {
          TRK.choice(E.nodeId, idx, true, kind, op.label);
          if (op.note) showToast(op.note, 3000, "note");
          flash("green");
          interactionDone(index);
          return;
        }
        // 答错：平台行为是回到触发点重来
        TRK.choice(E.nodeId, idx, false, kind, op.label);
        flash("red"); shake();
        showToast("再想一想，重新选择一次！", 1800, "warn");
        rewindTo(it, index);
      },
      onTimeout: function () {
        TRK.qte(countdown ? "限时选择超时" : "答题超时", countdown ? "限时选择" : "答题", false, 0, 1);
        rewindTo(it, index);
      }
    });
  }

  /* ---------- 节点末尾分支（平台 edges） ---------- */
  function showBranch(choices) {
    pauseForInteraction();
    // 视频已播完、带宽空闲：立即预载所有候选分支的视频，选完秒开
    choices.forEach(function (c) { if (c.next) preloadVideo(c.next, "auto"); });
    buildChoicePanel({
      title: "请选择剧情走向",
      autoRead: true,
      options: choices,
      onPick: function (c, idx) {
        TRK.choice(E.nodeId, idx, true, null, c.label || c.title || "");   // 剧情分支：轨迹记录（不计 QTE）
        E.lastBranch = { chapterId: E.chapter.id, nodeId: E.nodeId };
        jumpTo(c.next);
      }
    });
  }

  /* ---------- 拖拽交付（按平台画面相对坐标） ---------- */
  function clearDragLayer() {
    fxTarget.innerHTML = "";
    fxTarget.classList.add("hidden");
  }

  function runDrag(it, index) {
    pauseForInteraction();
    syncVideoBox();
    show(fxTarget);
    fxTarget.innerHTML = "";

    var tg = it.target;
    var box = document.createElement("div");
    box.className = "drag-zone";
    box.style.left = (tg.x * 100) + "%";
    box.style.top = (tg.y * 100) + "%";
    box.style.width = (tg.w * 100) + "%";
    box.style.height = (tg.h * 100) + "%";
    fxTarget.appendChild(box);

    var el = document.createElement("img");
    el.className = "drag-prop";
    el.src = encodeURI(it.item.img);
    el.alt = it.item.label || "";
    el.style.left = (it.item.at.x * 100) + "%";
    el.style.top = (it.item.at.y * 100) + "%";
    fxTarget.appendChild(el);

    var lab = document.createElement("div");
    lab.className = "drag-zone-label";
    lab.textContent = tg.label || "目标区域";
    box.appendChild(lab);

    showHint(it.prompt || "把道具拖到画面中的正确位置", 4000);

    var done = false, drag = null;
    var dragT0 = performance.now(), dragFails = 0;
    var dragName = it.prompt || "拖拽交付";

    el.addEventListener("pointerdown", function (e) {
      if (done) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
      el.style.transition = "";
      var fr = fxTarget.getBoundingClientRect();
      var er = el.getBoundingClientRect();
      // 记录指针在道具内部的落点，拖动时让道具中心跟随指针
      drag = { fr: fr, w: er.width, h: er.height, px: e.clientX - er.left, py: e.clientY - er.top };
    });
    el.addEventListener("pointermove", function (e) {
      if (!drag || done) return;
      // 道具中心在画面中的相对坐标（#fx 与视频显示区域严格对齐）
      var cx = (e.clientX - drag.px + drag.w / 2 - drag.fr.left) / drag.fr.width;
      var cy = (e.clientY - drag.py + drag.h / 2 - drag.fr.top) / drag.fr.height;
      el.style.left = (Math.max(-0.05, Math.min(1.05, cx)) * 100) + "%";
      el.style.top = (Math.max(-0.05, Math.min(1.05, cy)) * 100) + "%";
    });
    el.addEventListener("pointerup", function () {
      if (!drag || done) return;
      el.classList.remove("dragging");
      var ex = parseFloat(el.style.left) / 100, ey = parseFloat(el.style.top) / 100;
      var inX = ex >= tg.x - 0.08 && ex <= tg.x + tg.w + 0.08;
      var inY = ey >= tg.y - 0.08 && ey <= tg.y + tg.h + 0.08;
      if (inX && inY) {
        done = true;
        TRK.qte(dragName, "拖拽", true, performance.now() - dragT0, dragFails + 1);
        box.classList.add("ok");
        el.style.transition = "transform .2s";
        el.style.transform = "translate(-50%, -50%) scale(.9)";
        flash("green");
        showToast("放对啦！" + (it.item.label || ""), 1600, "note");
        setTimeout(function () {
          clearDragLayer();
          interactionDone(index);
        }, 700);
      } else {
        // 位置不对 → 弹回原位
        drag = null;
        dragFails++;
        TRK.qte(dragName, "拖拽", false, performance.now() - dragT0, dragFails);
        el.style.transition = "left .25s, top .25s";
        el.style.left = (it.item.at.x * 100) + "%";
        el.style.top = (it.item.at.y * 100) + "%";
        setTimeout(function () { el.style.transition = ""; }, 260);
        showToast("这里不是它该在的位置", 1400, "warn");
      }
    });
    el.addEventListener("pointercancel", function () { drag = null; el.classList.remove("dragging"); });
  }

  /* ---------- CSS 拖动回退方案（WebGL 全景不可用时） ---------- */
  var panoX = 50, panoDrag = null;
  stage.addEventListener("pointerdown", function (e) {
    if (!E.node || !E.node.pano || panoInst) return;   // panoInst 存在 = WebGL 模式，画布自己处理
    if (e.target.closest(".qte-wrap, .choice-wrap, .pano-continue, #fx-target, button, .toast")) return;
    panoDrag = { x: e.clientX, base: panoX };
  });
  window.addEventListener("pointermove", function (e) {
    if (!panoDrag || !E.node || !E.node.pano) return;
    var d = (e.clientX - panoDrag.x) / stage.clientWidth * 100;
    panoX = panoDrag.base - d;
    pano.style.backgroundPosition = panoX + "% 50%";
  });
  window.addEventListener("pointerup", function () { panoDrag = null; });

  /* ==================== 结局 ==================== */
  function showEnding(node) {
    saveEnding(E.chapter.id, E.nodeId);
    pauseForInteraction();
    clearDragLayer();
    overlay.innerHTML = "";
    destroyPano();

    var e = node.ending;
    $("#ending-icon").textContent = e.icon || "🎬";
    var kind = $("#ending-kind");
    kind.textContent = e.kind === "good" ? "好结局" : e.kind === "normal" ? "普通结局" : "坏结局";
    kind.className = "ending-kind " + e.kind;
    TRK.ending(E.nodeId, e.kind);     // 埋点：达成结局（good=通关）
    $("#ending-title").textContent = e.title || node.title;
    $("#ending-message").textContent = e.message || "";
    // 结局自动朗读：标题 + 正文（受朗读开关控制）
    TTS.speak(($("#ending-title").textContent || "") + "。" + (e.message || ""), { force: true });
    var c = countEndings(E.chapter);
    $("#ending-count").textContent = "📊 本章结局收集：" + c.got + " / " + c.total;

    // 主按钮：优先回到平台设定的回跳节点，其次回到玩家上次的分歧点
    var btn = $("#btn-retry-branch");
    if (node.autoNext && E.chapter.nodes[node.autoNext.next]) {
      btn.textContent = "↩ 回到「" + E.chapter.nodes[node.autoNext.next].title.split(" ")[0] + "」再试一次";
      btn.dataset.target = node.autoNext.next;
      btn.style.display = "";
    } else if (E.lastBranch) {
      btn.textContent = "↩ 从分歧点重新选择";
      btn.dataset.target = E.lastBranch.nodeId;
      btn.style.display = "";
    } else {
      btn.style.display = "none";
    }

    hide($("#screen-player"));
    show($("#screen-ending"));
  }

  $("#btn-retry-branch").addEventListener("click", function () {
    var target = this.dataset.target;
    if (!target && E.lastBranch) target = E.lastBranch.nodeId;
    if (!target) return;
    TRK.markEndingRetry();            // 结局重试：随后的回跳不计死循环
    hide($("#screen-ending"));
    show($("#screen-player"));
    playNode(target);
  });
  $("#btn-restart").addEventListener("click", function () {
    TRK.markEndingRetry();
    hide($("#screen-ending"));
    show($("#screen-player"));
    playNode(E.chapter.start);
  });
  $("#btn-to-home").addEventListener("click", renderHome);
  /* 网络版：进入游戏正文前强制身份确认（再次进入回填上次信息，可修改） */
  function gatedStart(startFn) {
    TTS.unlock();
    TTS.warmAudio();          // iOS：必须在手势内解锁媒体播放
    playClick();
    TRK.requireIdentity(function () {
      TRK.beginSession();
      startFn();
    });
  }
  $("#btn-play").addEventListener("click", function () {
    gatedStart(function () { startChapter(STORY.chapters[0]); });
  });
  $("#btn-home").addEventListener("click", function () {
    if (confirm("回到首页？当前进度不会保存。")) renderHome();
  });

  /* 首页空闲时预热全部首帧封面：进节点立刻有画面，不用等封面请求 */
  ["load", "visibilitychange"].forEach(function (ev) {
    window.addEventListener(ev, function () {
      if (!document.hidden) setTimeout(warmPosters, 800);
    });
  });

  /* ==================== 全屏 ==================== */
  (function () {
    var playerEl = $("#screen-player");
    var fsBtn = $("#btn-fullscreen");
    if (!playerEl || !fsBtn) return;

    function isFs() {
      return !!(document.fullscreenElement || document.webkitFullscreenElement) ||
             document.body.classList.contains("pseudo-fs");
    }

    // 同步满屏样式 + 按钮文案：进入后画面铺满视口，HUD 浮在视频上方
    function syncFsState() {
      var on = isFs();
      playerEl.classList.toggle("player-fs", on);
      // 横屏全屏时裁切铺满（无黑边）；竖屏保持完整画面
      var cover = on && playerEl.clientWidth > playerEl.clientHeight;
      stage.classList.toggle("cover", cover);
      fsBtn.textContent = on ? "⛶ 退出全屏" : "⛶ 全屏";
      fsBtn.title = on ? "退出全屏（Esc）" : "全屏";
      // 视口变化后重新对齐画面坐标层，避免 QTE/道具位置漂移
      if (typeof syncVideoBox === "function") setTimeout(syncVideoBox, 80);
    }

    fsBtn.addEventListener("click", function () {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        var exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
        return;
      }
      if (document.body.classList.contains("pseudo-fs")) {
        document.body.classList.remove("pseudo-fs");
        syncFsState();
        return;
      }
      // 对页面根节点请求全屏：结局卡/首页等兄弟界面也在全屏层内，
      // 否则播放器单独全屏时，结局界面的跳转链接会被挡在全屏之外
      var rootEl = document.documentElement;
      var req = rootEl.requestFullscreen || rootEl.webkitRequestFullscreen;
      if (!req) {                       // iOS Safari：元素全屏不可用，降级为满屏浮层
        document.body.classList.add("pseudo-fs");
        syncFsState();
        return;
      }
      var p = req.call(rootEl);
      if (p && p.catch) {
        p.catch(function () {
          document.body.classList.add("pseudo-fs");
          syncFsState();
        });
      }
    });

    document.addEventListener("fullscreenchange", syncFsState);
    document.addEventListener("webkitfullscreenchange", syncFsState);
    window.addEventListener("resize", syncFsState);
    syncFsState();
  })();

  /* ==================== 朗读开关初始化 ==================== */
  TTS.bindToggle($("#tts-toggle-home"));
  TTS.bindToggle($("#tts-toggle-hud"));
  ["#btn-play", "#btn-home", "#btn-fullscreen", "#btn-retry-branch", "#btn-restart", "#btn-to-home"]
    .forEach(function (sel) {
      var el = $(sel);
      if (!el) return;
      // 动态取文案：分歧点按钮的文字会随节点变化
      TTS.hover(el, function () {
        return (el.textContent || "").replace(/^[^\u4e00-\u9fa5A-Za-z]+/, "").trim();
      });
    });

  /* 调试钩子：便于自动化测试直接跳到指定节点（不影响正常游玩） */
  window.__SWS = {
    engine: E,
    home: renderHome,
    play: function (id) {
      hide($("#screen-ending"));
      hide($("#screen-start"));
      show($("#screen-player"));
      playNode(id);
    }
  };

  renderHome();
})();
