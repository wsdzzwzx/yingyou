/* 安全教育互动影游网络版 — 前端埋点与身份模块
 * 依赖：无（零依赖，引擎在 TTS 之后、story-data 之后加载均可）
 * 设计依据：《网络版系统设计文档》3.1 身份录入 / 3.2 行为埋点 / 6 非功能容错
 *
 * 对引擎暴露 window.TRK：
 *   requireIdentity(cb)  强制身份确认后回调（进入游戏正文前调用）
 *   beginSession()       开始一次游戏会话（对应 /api/game/start）
 *   nodeEnter(nodeId)    进入节点；内部做死循环检测并上报
 *   choice(nodeId, idx, ok, kind, label)   分支/答题选择（label 为选项原文，用于后台轨迹展示）
 *   qte(name, type, ok, costMs, attempt)  QTE 判定
 *   ending(nodeId, kind) 抵达结局
 *   markEndingRetry()    结局页"再试一次"，随后的回跳不计死循环
 *   sessionEnd()         会话结束（回首页时调用；关页自动 sendBeacon）
 *
 * 容错：所有上报进本地队列（localStorage），失败保留、每 30s 重试，
 *       不阻塞游戏；接口不可用时游戏照常玩（单机降级）。
 */
window.TRK = (function () {
  "use strict";

  var LS_STUDENT = "sws-student-v1";
  var LS_QUEUE = "sws-track-queue-v1";
  var FLUSH_MS = 30000;

  var enabled = true;                 // 接口连续失败时自动降级为单机模式
  var failCount = 0;
  var student = null;                 // {student_id, class_name, student_name, phone}
  var recordId = null;
  var sessionStart = 0;
  var visited = {};                   // 本会话已访问节点（死循环检测）
  var pendingNode = null;             // 最近一次进入的节点（算死循环用）
  var retryUntil = 0;                 // 结局重试豁免截止时刻
  var lastEnding = null;              // {id, kind, isComplete}
  var pending = [];                   // 会话建立前暂存的上报（start 返回后补发）
  var sessionActive = false;
  var lastEndAt = 0;
  var flushing = false;
  var flushTimer = null;

  /* ---------------- 基础工具 ---------------- */
  function $(sel) { return document.querySelector(sel); }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  /** 节点 "1-5" → 5（story-data 全部节点为 1-1..1-19，后缀即编号） */
  function nodeNum(nodeId) {
    var n = parseInt(String(nodeId).split("-").pop(), 10);
    return isNaN(n) ? 0 : n;
  }

  /** 节点编号 → 中文名称（去掉 "1-6 " 这类编号前缀），用于后台轨迹可读化 */
  var titleMap = null;
  function nodeTitle(nodeId) {
    if (!titleMap && window.STORY && STORY.chapters && STORY.chapters[0]) {
      titleMap = {};
      var nodes = STORY.chapters[0].nodes;
      Object.keys(nodes).forEach(function (id) {
        var t = (nodes[id] && nodes[id].title) || "";
        titleMap[nodeNum(id)] = String(t).replace(/^\d+-\d+\s*/, "");
      });
    }
    return (titleMap && titleMap[nodeNum(nodeId)]) || "";
  }

  /** 结局编号映射：按节点号排序的结局节点 → 1..8 */
  var endingMap = null;  function endingNum(nodeId) {
    if (!endingMap && window.STORY && STORY.chapters[0]) {
      endingMap = {};
      var ends = Object.keys(STORY.chapters[0].nodes).filter(function (id) {
        return STORY.chapters[0].nodes[id].ending;
      }).map(function (id) { return [nodeNum(id), id]; })
        .sort(function (a, b) { return a[0] - b[0]; });
      ends.forEach(function (p, i) { endingMap[p[1]] = i + 1; });
    }
    return (endingMap && endingMap[nodeId]) || 0;
  }

  function post(url, data, beacon) {
    if (!enabled) return Promise.resolve();
    var body = JSON.stringify(data);
    if (beacon && navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))) return Promise.resolve();
      } catch (e) {}
    }
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body,
      keepalive: beacon === true
    }).then(function (r) {
      if (!r.ok) {
        var err = new Error("HTTP " + r.status);
        // 4xx 属于请求本身有问题（路径错/会话失效），重试也不会成功 → 丢弃该条
        err.permanent = r.status >= 400 && r.status < 500 && r.status !== 429;
        throw err;
      }
      failCount = 0;
      return r.json().catch(function () { return {}; });
    }).catch(function (e) {
      if (e && e.permanent) throw e;
      failCount++;
      if (failCount >= 8) enabled = false;   // 连续失败 → 单机降级，不再打扰游戏
      var ne = new Error("network");
      ne.network = true;
      throw ne;
    });
  }

  /* ---------------- 上报队列（localStorage 容错） ---------------- */
  function enqueue(url, data) {
    var q = lsGet(LS_QUEUE, []);
    q.push({ u: url, d: data, t: Date.now() });
    while (q.length > 500) q.shift();      // 防爆仓
    lsSet(LS_QUEUE, q);
    scheduleFlush(800);
  }

  function scheduleFlush(delay) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, delay || 0);
  }

  function flush() {
    if (flushing || !enabled) return;
    var q = lsGet(LS_QUEUE, []);
    if (!q.length) return;
    flushing = true;
    var item = q[0];
    post(item.u, item.d).then(function () {
      q.shift();
      lsSet(LS_QUEUE, q);
      flushing = false;
      if (q.length) flush();               // 串行补发，避免乱序
    }).catch(function (e) {
      if (e && e.permanent) {              // 坏条目直接丢，不能堵住后面的轨迹
        q.shift();
        lsSet(LS_QUEUE, q);
        flushing = false;
        if (q.length) flush();
        return;
      }
      flushing = false;
      scheduleFlush(FLUSH_MS);             // 网络恢复后重试补发
    });
  }

  /** 埋点统一出口：会话尚未建立时先缓冲，start 返回后按序补发 */
  function report(path, data) {
    if (!enabled) return;
    if (!recordId) {
      if (sessionActive && pending.length < 200) pending.push({ p: path, d: data });
      return;
    }
    data.record_id = recordId;
    enqueue("api/" + path, data);
  }

  /* ---------------- 身份录入弹窗 ---------------- */
  function isPhoneEnv() {
    return window.matchMedia && window.matchMedia("(hover: none)").matches;
  }

  function requireIdentity(onReady) {
    var saved = lsGet(LS_STUDENT, null);
    var ov = document.createElement("div");
    ov.className = "id-overlay";
    ov.innerHTML =
      '<div class="id-panel">' +
      '  <div class="id-deco">─◇─ 安全教育互动影游 ─◇─</div>' +
      '  <div class="id-title">🎮 进入游戏前，先登记身份</div>' +
      '  <div class="id-sub">老师需要知道是谁在闯关，才能给你记录成绩哦</div>' +
      '  <label class="id-row"><span>班级 <i>*</i></span>' +
      '    <input id="id-class" maxlength="50" placeholder="例如：三年级2班" autocomplete="off"></label>' +
      '  <label class="id-row"><span>姓名 <i>*</i></span>' +
      '    <input id="id-name" maxlength="50" placeholder="你的名字" autocomplete="off"></label>' +
      (isPhoneEnv()
        ? '<label class="id-row"><span>手机号</span>' +
          '<input id="id-phone" maxlength="11" inputmode="numeric" placeholder="选填，11 位数字" autocomplete="off"></label>'
        : '') +
      '  <div class="id-err" id="id-err"></div>' +
      '  <button class="id-btn" id="id-go">确 认 进 入</button>' +
      '</div>';
    document.body.appendChild(ov);

    var eClass = ov.querySelector("#id-class"),
        eName = ov.querySelector("#id-name"),
        ePhone = ov.querySelector("#id-phone"),
        eErr = ov.querySelector("#id-err");
    if (saved) {                            // 再次进入：回填上次信息，允许修改
      eClass.value = saved.class_name || "";
      eName.value = saved.student_name || "";
      if (ePhone) ePhone.value = saved.phone || "";   // 桌面端无手机号输入框
    }

    function submit() {
      var c = eClass.value.trim(), n = eName.value.trim(), p = (ePhone ? ePhone.value.trim() : "");
      if (!c) { eErr.textContent = "请填写班级"; return; }
      if (!n) { eErr.textContent = "请填写姓名"; return; }
      if (p && !/^1\d{10}$/.test(p)) { eErr.textContent = "手机号格式不对（11 位数字）"; return; }
      eErr.textContent = "";
      var btn = ov.querySelector("#id-go");
      btn.disabled = true; btn.textContent = "正在登记…";
      post("api/student/saveInfo", { class_name: c, name: n, phone: p }).then(function (res) {
        student = {
          student_id: res.student_id,
          class_name: c, student_name: n, phone: p
        };
        lsSet(LS_STUDENT, student);
        ov.remove();
        onReady();
      }).catch(function () {
        // 接口不可用：单机降级放行，游戏照常，埋点暂存本地
        student = { student_id: "", class_name: c, student_name: n, phone: p };
        lsSet(LS_STUDENT, student);
        ov.remove();
        onReady();
      });
    }
    ov.querySelector("#id-go").addEventListener("click", submit);
    [eClass, eName, ePhone].forEach(function (el) {
      if (el) el.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    });
    setTimeout(function () { (saved ? eName : eClass).focus(); }, 50);
  }

  /* ---------------- 会话 ---------------- */
  function beginSession() {
    recordId = null;
    pending = [];
    visited = {};
    lastEnding = null;
    sessionStart = Date.now();
    retryUntil = 0;
    sessionActive = !!enabled;
    if (!enabled || !student || !student.student_id) { sessionActive = false; return; }
    post("api/game/start", { student_id: student.student_id }).then(function (res) {
      recordId = res.record_id;
      // 会话建立前的节点/选择上报按原顺序补发，保证轨迹从第一个节点开始完整
      var buffered = pending; pending = [];
      buffered.forEach(function (it) { it.d.record_id = recordId; enqueue("api/" + it.p, it.d); });
      flush();
    }).catch(function () {
      sessionActive = false;            // 会话创建失败：本次不记录，游戏照常
      pending = [];
    });
  }

  function nodeEnter(nodeId) {
    var num = nodeNum(nodeId);
    if (!num) return;
    // 死循环检测：跳回本会话已访问过的节点（结局页"再试一次"的回跳豁免）
    if (visited[num] && Date.now() > retryUntil) {
      report("game/reportLoop", { loop_node_id: num });
    }
    visited[num] = true;
    pendingNode = num;
    report("game/reportTrace", { node_id: num, node_title: nodeTitle(nodeId) });
  }

  function choice(nodeId, idx, ok, kind, label) {
    var payload = {
      node_id: nodeNum(nodeId),
      choice_id: (idx || 0) + 1,
      node_title: nodeTitle(nodeId)
    };
    if (label) payload.choice_text = String(label).slice(0, 150);
    report("game/reportTrace", payload);
    if (kind) {
      report("game/reportQte", {
        qte_name: "选择：" + kind,
        qte_type: kind,
        is_success: ok ? 1 : 0,
        cost_ms: 0,
        attempt_count: 1
      });
    }
  }

  function qte(name, type, ok, costMs, attempt) {
    report("game/reportQte", {
      qte_name: String(name || "").slice(0, 50),
      qte_type: type,
      is_success: ok ? 1 : 0,
      cost_ms: Math.max(0, Math.round(costMs || 0)),
      attempt_count: Math.max(1, attempt || 1)
    });
  }

  function ending(nodeId, kind) {
    var id = endingNum(nodeId);
    lastEnding = { id: id, kind: kind, isComplete: kind === "good" };
    report("game/reportEnding", { ending_id: id, ending_type: kind });
  }

  function markEndingRetry() {
    retryUntil = Date.now() + 60000;       // 豁免之后 1 分钟内的回跳
  }

  function sessionEnd(beacon) {
    if (!recordId) { sessionActive = false; pending = []; return; }
    // visibilitychange 与 pagehide 会前后脚触发，2 秒内只发一次
    if (Date.now() - lastEndAt < 2000) return;
    lastEndAt = Date.now();
    var payload = {
      record_id: recordId,
      is_complete: lastEnding && lastEnding.isComplete ? 1 : 0,
      ending_id: lastEnding ? lastEnding.id : null,
      total_cost_sec: Math.round((Date.now() - sessionStart) / 1000)
    };
    if (beacon) {
      post("api/game/end", payload, true);          // 关页：sendBeacon
    } else {
      enqueue("api/game/end", payload);
      recordId = null;
      sessionActive = false;
    }
  }

  /* ---------------- 全局兜底 ---------------- */
  window.addEventListener("pagehide", function () { sessionEnd(true); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") sessionEnd(true);
  });

  return {
    requireIdentity: requireIdentity,
    beginSession: beginSession,
    nodeEnter: nodeEnter,
    choice: choice,
    qte: qte,
    ending: ending,
    markEndingRetry: markEndingRetry,
    sessionEnd: sessionEnd,
    get student() { return student; },
    get recordId() { return recordId; }
  };
})();
