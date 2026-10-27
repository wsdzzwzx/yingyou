/* =====================================================================
 * compat.js — Win7 老内核兼容垫片（必须在其它脚本之前加载）
 *
 * 1) Pointer Events 垫片：Chrome < 55 / 360 老内核没有 PointerEvent，
 *    而游戏的点击（tap）、滑动（swipe）、拖拽（drag）、全景环视全部依赖
 *    pointerdown/move/up。这里把 pointer 监听自动映射到 mouse 和 touch 事件，
 *    上层代码不用改一行。
 * 2) 能力检测：flex gap（Chrome 84+）、aspect-ratio（Chrome 88+）不支持时
 *    给 <html> 加 no-flexgap / no-aspect，CSS 里已有对应兜底样式。
 * ===================================================================== */
(function () {
  "use strict";

  /* ---------------- 1. Pointer Events 垫片 ---------------- */
  if (!window.PointerEvent && window.EventTarget && EventTarget.prototype.addEventListener) {
    var MAP = {
      pointerdown: ["mousedown", "touchstart"],
      pointermove: ["mousemove", "touchmove"],
      pointerup: ["mouseup", "touchend"],
      pointercancel: ["touchcancel"]
    };
    var origAdd = EventTarget.prototype.addEventListener;
    var origRemove = EventTarget.prototype.removeEventListener;
    var bound = [];   // 记录映射关系，removeEventListener 时能摘掉

    function firstPoint(e) {
      var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      return t || e;
    }

    EventTarget.prototype.addEventListener = function (type, fn, opt) {
      var targets = MAP[type];
      if (!targets || typeof fn !== "function") return origAdd.call(this, type, fn, opt);
      var self = this;
      targets.forEach(function (nativeType) {
        var wrapper = function (e) {
          var p = firstPoint(e);
          var fake = {
            type: type,
            target: e.target,
            currentTarget: self,
            clientX: p.clientX,
            clientY: p.clientY,
            pageX: p.pageX,
            pageY: p.pageY,
            pointerId: 1,
            pointerType: nativeType.indexOf("touch") === 0 ? "touch" : "mouse",
            isPrimary: true,
            button: e.button || 0,
            buttons: e.buttons == null ? 1 : e.buttons,
            shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey,
            preventDefault: function () { try { e.preventDefault(); } catch (x) {} },
            stopPropagation: function () { try { e.stopPropagation(); } catch (x) {} }
          };
          return fn.call(self, fake);
        };
        bound.push({ el: self, type: type, fn: fn, native: nativeType, wrapper: wrapper });
        origAdd.call(self, nativeType, wrapper, opt);
      });
    };

    EventTarget.prototype.removeEventListener = function (type, fn, opt) {
      var targets = MAP[type];
      if (!targets || typeof fn !== "function") return origRemove.call(this, type, fn, opt);
      var self = this;
      for (var i = bound.length - 1; i >= 0; i--) {
        var b = bound[i];
        if (b.el === self && b.type === type && b.fn === fn) {
          origRemove.call(self, b.native, b.wrapper, opt);
          bound.splice(i, 1);
        }
      }
      return undefined;
    };

    // setPointerCapture / releasePointerCapture 在垫片环境下无意义，补成空函数避免报错
    if (window.Element && Element.prototype) {
      if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = function () {};
      if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = function () {};
    }
  }

  /* ---------------- 2. 能力检测（决定 CSS 兜底分支） ---------------- */
  var html = document.documentElement;
  function addCls(c) { if ((" " + html.className + " ").indexOf(" " + c + " ") < 0) html.className += (html.className ? " " : "") + c; }

  try {
    // flex gap 实测：两个 0 宽子元素之间若有 4px 间隙 → 支持
    var d = document.createElement("div");
    d.style.cssText = "position:absolute;visibility:hidden;display:flex;gap:4px;width:0;height:0";
    d.innerHTML = "<i></i><i></i>";
    html.appendChild(d);
    var gap = d.lastChild.offsetLeft - d.firstChild.offsetWidth;
    if (!(gap >= 3)) addCls("no-flexgap");
    html.removeChild(d);

    // aspect-ratio：Chrome 88+ 才支持 CSS.supports 这条
    if (!(window.CSS && CSS.supports && CSS.supports("aspect-ratio", "1 / 1"))) addCls("no-aspect");
  } catch (e) {}
  /* ---------------- 3. 老内核 / IE 兼容模式 友好提示 ----------------
     IE 没有 CSS 变量 / flex / WebGL；Chrome 49 以下连 CSS 变量都没有 → 白屏。
     与其让学生对着白屏，不如直接提示老师怎么处理。 */
  function showTip(title, detail) {
    var tip = document.createElement("div");
    tip.setAttribute("style",
      "position:fixed;left:0;right:0;top:0;z-index:99999;background:#c9a05a;color:#2b1f06;" +
      "font:16px/1.7 'Microsoft YaHei',sans-serif;padding:14px 20px;text-align:center");
    tip.innerHTML = "<b>" + title + "</b><br>" + detail;
    (document.body || document.documentElement).appendChild(tip);
  }

  if (window.document.documentMode) {
    showTip("当前浏览器使用 IE 兼容模式，游戏无法运行",
      "请点击地址栏右侧的「闪电 / 兼容」图标，切换为 <b>极速模式</b>；或改用 Chrome 浏览器打开本页。");
  } else {
    var m = /Chrome\/(\d+)/.exec(navigator.userAgent);
    if (m && parseInt(m[1], 10) < 49) {
      showTip("浏览器内核过旧（Chrome " + m[1] + "），游戏无法正常运行",
        "请升级浏览器，或在 360 / QQ 浏览器地址栏切换为「极速模式」后刷新。");
    }
  }
})();
