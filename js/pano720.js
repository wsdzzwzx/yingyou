/* =====================================================================
 * Pano720 — 零依赖 WebGL 真 720° 全景查看器
 * 等距柱状全景图贴到单位球渲染：左右 360° 无限拖动 + 上下 ±85° 自由环视
 * （平台原版把俯仰锁在 ±30°，这里放开到近全天空地，即"720"体验）
 * 支持：鼠标/触摸拖动、惯性、滚轮与双指缩放（fov 50–90）、
 *       左右都转到位后自动回调完成（对应平台 panorama_rotate 判定）。
 * WebGL 不可用时返回 null，由调用方回退到 CSS 拖动方案。
 * ===================================================================== */
(function () {
  "use strict";

  var VERT =
    "attribute vec2 a;" +
    "varying vec2 v;" +
    "void main(){ v=a; gl_Position=vec4(a,0.0,1.0); }";

  var FRAG =
    "precision highp float;" +
    "varying vec2 v;" +
    "uniform sampler2D tex;" +
    "uniform float uYaw,uPitch,uTanF,uAspect;" +
    "const float PI=3.14159265;" +
    "void main(){" +
    "  vec3 d=normalize(vec3(v.x*uTanF*uAspect, v.y*uTanF, -1.0));" +
    "  float cp=cos(uPitch),sp=sin(uPitch);" +
    "  d=vec3(d.x, d.y*cp-d.z*sp, d.y*sp+d.z*cp);" +
    "  float cy=cos(uYaw),sy=sin(uYaw);" +
    "  d=vec3(d.x*cy+d.z*sy, d.y, -d.x*sy+d.z*cy);" +
    "  float lon=atan(d.x,d.z);" +
    "  float lat=asin(clamp(d.y,-1.0,1.0));" +
    "  vec2 uv=vec2(fract(lon/(2.0*PI)+0.5), 0.5-lat/PI);" +
    "  gl_FragColor=texture2D(tex,uv);" +
    "}";

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error("[Pano720] shader:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  function Pano720(container, imgUrl, opts) {
    opts = opts || {};
    // 完成判定：鼠标真实拖动累计满一圈（360°）才完成，惯性不算（平台要求"拖动一圈后再进入下一个场景"）
    var needYaw = (opts.fullCircleYaw || 360) * Math.PI / 180;
    var autoFinishMs = opts.autoFinishMs != null ? opts.autoFinishMs : 400;
    var MIN_FOV = 50, MAX_FOV = 90;
    var PITCH_LIM = 85 * Math.PI / 180;

    var canvas = document.createElement("canvas");
    canvas.className = "pano720-canvas";
    container.appendChild(canvas);

    var gl = canvas.getContext("webgl2", { antialias: true }) ||
             canvas.getContext("webgl", { antialias: true }) ||
             canvas.getContext("experimental-webgl");
    if (!gl) { canvas.remove(); return null; }

    var vs = compile(gl, gl.VERTEX_SHADER, VERT);
    var fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { canvas.remove(); return null; }
    var prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("[Pano720] link:", gl.getProgramInfoLog(prog));
      canvas.remove(); return null;
    }
    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    var aLoc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(aLoc);
    gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);

    var uYaw = gl.getUniformLocation(prog, "uYaw");
    var uPitch = gl.getUniformLocation(prog, "uPitch");
    var uTanF = gl.getUniformLocation(prog, "uTanF");
    var uAspect = gl.getUniformLocation(prog, "uAspect");

    // ---------- 状态 ----------
    // 初始视场角取最大值 = 最小放大倍数（用户要求：全景按最小倍数浏览，避免画面被放大裁切）
    var yaw = 0, pitch = 0, fov = MAX_FOV;
    var vyaw = 0, vpitch = 0;
    var destroyed = false, ready = false, completed = false, completeTimer = null;
    var traveled = 0;                       // 真实拖动累计转过的弧度（惯性不计）
    var listeners = {};

    function emit(ev, arg) {
      (listeners[ev] || []).forEach(function (fn) { try { fn(arg); } catch (e) { console.error(e); } });
    }

    // ---------- 纹理 ----------
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // 加载中先铺 1x1 深色，避免黑屏闪烁
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([12, 12, 18, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    var img = new Image();
    img.onload = function () {
      if (destroyed) return;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      try {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        if (String(gl.getParameter(gl.VERSION)).indexOf("WebGL2") >= 0) {
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        }
      } catch (e) { console.warn("[Pano720] mipmap 不可用，用线性过滤", e); }
      ready = true;
      emit("ready");
    };
    img.onerror = function () { if (!destroyed) emit("error", "全景图加载失败"); };
    img.src = imgUrl;

    // ---------- 尺寸 ----------
    function resize() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    resize();
    var ro = window.ResizeObserver ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(container);
    else window.addEventListener("resize", resize);

    // ---------- 交互 ----------
    var POINTERS = {};   // pointerId -> {x,y}
    var dragging = false, lastX = 0, lastY = 0, pinchD = 0;

    canvas.style.touchAction = "none";

    canvas.addEventListener("pointerdown", function (e) {
      if (completed) return;
      POINTERS[e.pointerId] = { x: e.clientX, y: e.clientY };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      var ids = Object.keys(POINTERS);
      if (ids.length === 1) {
        dragging = true; lastX = e.clientX; lastY = e.clientY;
        vyaw = vpitch = 0;
      } else if (ids.length === 2) {
        dragging = false;
        var a = POINTERS[ids[0]], b = POINTERS[ids[1]];
        pinchD = Math.hypot(a.x - b.x, a.y - b.y);
      }
      e.preventDefault();
    });
    canvas.addEventListener("pointermove", function (e) {
      if (completed || !POINTERS[e.pointerId]) return;
      POINTERS[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(POINTERS);
      if (ids.length === 2) {
        var a = POINTERS[ids[0]], b = POINTERS[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchD > 0) setFov(fov * pinchD / Math.max(1, d));
        pinchD = d;
        return;
      }
      if (!dragging) return;
      var k = fov * Math.PI / 180 / canvas.clientHeight;   // 弧度/像素（视场角换算，修正原灵敏度系数）
      var dx = (e.clientX - lastX) * k;
      var dy = (e.clientY - lastY) * k;
      yaw += dx;   // 内容跟手
      pitch += dy;
      clampAngles();
      traveled += Math.abs(dx);                            // 只有真实拖动才计入一圈
      if (!completed && traveled >= needYaw) {
        completed = true;
        emit("scanned");
        emit("progress", 1);
        completeTimer = setTimeout(function () { emit("complete"); }, autoFinishMs);
        return;
      }
      emit("progress", Math.min(1, traveled / needYaw));
      vyaw = dx; vpitch = dy;
      lastX = e.clientX; lastY = e.clientY;
    });
    function endPointer(e) {
      delete POINTERS[e.pointerId];
      if (Object.keys(POINTERS).length === 0) dragging = false;
      pinchD = 0;
    }
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);

    canvas.addEventListener("wheel", function (e) {
      if (completed) return;
      e.preventDefault();
      setFov(fov + (e.deltaY > 0 ? 4 : -4));
    }, { passive: false });

    function setFov(f) {
      fov = Math.max(MIN_FOV, Math.min(MAX_FOV, f));
    }
    function clampAngles() {
      if (yaw > Math.PI) yaw -= Math.PI * 2;
      if (yaw < -Math.PI) yaw += Math.PI * 2;
      if (pitch > PITCH_LIM) pitch = PITCH_LIM;
      if (pitch < -PITCH_LIM) pitch = -PITCH_LIM;
      // 完成判定移到 pointermove：只有真实拖动计入一圈，惯性不贡献进度
    }

    // ---------- 渲染循环 ----------
    (function loop() {
      if (destroyed) return;
      requestAnimationFrame(loop);
      if (!ready) return;
      // 惯性
      if (!dragging && (Math.abs(vyaw) > 0.0004 || Math.abs(vpitch) > 0.0004)) {
        yaw += vyaw; pitch += vpitch;
        vyaw *= 0.94; vpitch *= 0.94;
        clampAngles();
      }
      var aspect = canvas.width / Math.max(1, canvas.height);
      gl.uniform1f(uYaw, yaw);
      gl.uniform1f(uPitch, pitch);
      gl.uniform1f(uTanF, Math.tan(fov * Math.PI / 360));
      gl.uniform1f(uAspect, aspect);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    })();

    // ---------- API ----------
    return {
      on: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return this; },
      get yawDeg() { return yaw * 180 / Math.PI; },
      /** 当前视场角（度），数值越大 = 放大倍数越小 */
      get fovDeg() { return fov; },
      get ready() { return ready; },
      get completed() { return completed; },
      /** 已真实拖动的比例 0~1（供进度条显示） */
      get progress() { return Math.min(1, traveled / needYaw); },
      /** 主动标记完成（供跳过等场景） */
      finish: function () { if (!completed) { completed = true; emit("complete"); } },
      destroy: function () {
        destroyed = true;
        clearTimeout(completeTimer);
        if (ro) try { ro.disconnect(); } catch (e) {}
        try { gl.getExtension("WEBGL_lose_context") && gl.getExtension("WEBGL_lose_context").loseContext(); } catch (e) {}
        canvas.remove();
      }
    };
  }

  window.Pano720 = Pano720;
})();
