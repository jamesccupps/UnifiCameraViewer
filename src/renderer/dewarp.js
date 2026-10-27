"use strict";

/*
 * Fisheye dewarping for 360° cameras (UniFi AI 360 and similar), done in one WebGL fragment shader.
 *
 * The lens is modeled as equidistant (image radius proportional to the angle off the optical axis),
 * which is what 180°-class surveillance fisheyes use. Every output pixel casts a ray from a virtual
 * pan/tilt/zoom camera, rotates it into the lens frame for the mount (ceiling / wall / desk), and
 * samples the fisheye image where that ray lands. Nothing is decoded twice: the <video> element
 * decodes the one stream and the shader reads its frames as a texture.
 *
 * Layouts: "quad" (2x2 virtual PTZ views, double-click one to enlarge) and "panorama" (ceiling /
 * desk: 360° split into two 180° strips; wall: one 180° strip).
 *
 * Config (all angles in degrees, circle normalized to the video frame):
 *   { mode, mount, lensFov, circle: {x, y, r} | null, views: [{pan, tilt, fov} x4], focus, pano: {pan, tilt} }
 */

window.Dewarper = (() => {
  const DEG = Math.PI / 180;
  const GAP = 2; // device px between quad tiles
  const LOST_GRACE_MS = 5_000; // a lost WebGL context not back by then: show the raw fisheye instead

  const VERT = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() {
      vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);   // y down, like image coordinates
      gl_Position = vec4(aPos, 0.0, 1.0);
    }`;

  const FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    uniform vec2 uTexSize;     // video size, px
    uniform vec3 uCircle;      // image circle center x, y and radius, px
    uniform float uHalfFov;    // half the lens field of view, rad
    uniform mat3 uLens;        // mount frame -> lens frame
    uniform int uKind;         // 0 = perspective view, 1 = cylindrical strip
    uniform vec3 uView;        // perspective: pan, tilt, tan(vfov/2)
    uniform vec4 uStrip;       // strip: panStart, panSpan, tiltTop, tiltSpan (rad)
    uniform float uAspect;     // viewport width / height

    void main() {
      vec3 dir;
      if (uKind == 0) {
        float p = uView.x;
        float t = uView.y;
        // Mount frame: x right, y down, z forward. Positive tilt looks up.
        vec3 F = vec3(sin(p) * cos(t), -sin(t), cos(p) * cos(t));
        vec3 R = vec3(cos(p), 0.0, -sin(p));
        vec3 D = cross(F, R);
        float x = (vUv.x * 2.0 - 1.0) * uView.z * uAspect;
        float y = (vUv.y * 2.0 - 1.0) * uView.z;
        dir = normalize(F + x * R + y * D);
      } else {
        float p = uStrip.x + vUv.x * uStrip.y;
        float t = uStrip.z - vUv.y * uStrip.w;
        dir = vec3(sin(p) * cos(t), -sin(t), cos(p) * cos(t));
      }
      vec3 l = uLens * dir;
      float theta = acos(clamp(l.z, -1.0, 1.0));
      if (theta > uHalfFov) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      float r = theta / uHalfFov * uCircle.z;
      float phi = atan(l.y, l.x);
      vec2 uv = (uCircle.xy + r * vec2(cos(phi), sin(phi))) / uTexSize;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      gl_FragColor = texture2D(uTex, uv);
    }`;

  // Rows of the mount -> lens rotation (lens frame: x right, y down, z = optical axis).
  const LENS = {
    wall: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    ceiling: [[1, 0, 0], [0, 0, -1], [0, 1, 0]],  // looking straight down; image top = pan 0
    desk: [[1, 0, 0], [0, 0, 1], [0, -1, 0]],     // looking straight up
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  class Dewarper {
    constructor(video, canvas, { onChange, onError } = {}) {
      this.video = video;
      this.canvas = canvas;
      this.onChange = onChange ?? (() => {});
      this.onError = onError ?? (() => {});
      this.cfg = null;
      this.active = false;
      this.interactive = true;
      this.hasFrame = false;
      this.software = false;
      this.scale = 1;
      this.autoDetectTries = 0;
      this.detectedCircle = null;
      this.frameCallback = null;
      this.drag = null;
      this.calibrating = false;
      this.glTried = false; // the WebGL context is created only once a 360° view is turned on
      this.glSetups = 0;
      this.glLost = false;   // the GPU process dropped the context (driver update, GPU reset...)
      this.glBroken = false; // ...and Chromium didn't give it back
      this.lostTimer = null;
      this.#bindInput();
      new ResizeObserver(() => this.#resize()).observe(canvas);
      // Once, here: registering these in #initGl, which a restore re-ran, doubled them on every restore.
      canvas.addEventListener("webglcontextlost", (e) => this.#contextLost(e));
      canvas.addEventListener("webglcontextrestored", () => this.#contextRestored());
    }

    get ok() { return !!this.gl; }

    // ------------------------------------------------------------------ setup

    #initGl() {
      const opts = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "low-power" };
      const gl = this.canvas.getContext("webgl", opts);
      if (!gl) return;
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
      this.renderer = renderer;
      // No usable GPU driver: Chromium falls back to CPU rendering. Render at half resolution there.
      this.software = /swiftshader|llvmpipe|software|basic render/i.test(renderer);
      this.scale = this.software ? 0.5 : 1;
      this.#setupGl(gl);
    }

    /** Program, quad and texture: everything a lost context takes with it. */
    #setupGl(gl) {
      this.glSetups++;
      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      try {
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        gl.useProgram(prog);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(prog, "aPos");
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.u = {};
        for (const n of ["uTex", "uTexSize", "uCircle", "uHalfFov", "uLens", "uKind", "uView", "uStrip", "uAspect"]) {
          this.u[n] = gl.getUniformLocation(prog, n);
        }
        gl.uniform1i(this.u.uTex, 0);
        gl.clearColor(0.06, 0.07, 0.08, 1);
        this.gl = gl;
      } catch (err) {
        this.gl = null;
        this.onError(`WebGL setup failed: ${err.message}`);
      }
    }

    // Chromium normally restores a lost context, but not once it has blocked WebGL after repeated GPU
    // crashes. Then the opaque canvas would sit black over the playing video, so after a grace period
    // the window falls back to the raw fisheye picture until the context comes back.
    #contextLost(e) {
      e.preventDefault(); // allows the restore
      this.hasFrame = false;
      this.glLost = true;
      clearTimeout(this.lostTimer);
      this.lostTimer = setTimeout(() => {
        if (!this.glLost) return;
        this.glBroken = true;
        this.setConfig(this.cfg);
        this.onError("The 360° view lost its graphics context. Showing the raw fisheye image until it's back.");
      }, LOST_GRACE_MS);
    }

    #contextRestored() {
      clearTimeout(this.lostTimer);
      this.glLost = false;
      this.glBroken = false;
      const gl = this.canvas.getContext("webgl"); // the same context object, now empty
      if (gl) this.#setupGl(gl);
      this.setConfig(this.cfg);
    }

    // ------------------------------------------------------------------ public

    setConfig(cfg) {
      this.cfg = cfg ? structuredClone(cfg) : null;
      const on = !!this.cfg && this.cfg.mode !== "off";
      if (on && !this.glTried) {
        this.glTried = true;
        this.#initGl();
        this.#resize();
        if (this.gl && this.software) {
          this.onError("No graphics acceleration available - the 360° view is drawn on the CPU at reduced resolution.");
        }
      }
      if (on && !this.gl) {
        this.onError("Dewarping needs WebGL, which isn't available on this PC. Showing the raw fisheye image.");
      }
      this.active = on && !!this.gl && !this.glBroken;
      this.canvas.classList.toggle("hidden", !this.active || this.calibrating);
      if (this.active) this.#startFrames();
      else this.#stopFrames();
      this.#draw();
    }

    setInteractive(on) {
      this.interactive = on;
      this.canvas.classList.toggle("ptz", on && this.active);
    }

    /**
     * Aspect ratio the window should keep in the current mode: null = use the video's own, 0 = any
     * shape. The views fill whatever shape the window has (each quad view is the window's shape, and a
     * panorama strip's tilt span follows from it), so this only sets what the window locks to.
     */
    preferredAspect() {
      if (!this.active) return null;
      const a = this.cfg?.aspect ?? "16:9";
      if (a === "free") return 0;
      const [w, h] = String(a).split(":").map(Number);
      return w > 0 && h > 0 ? w / h : 16 / 9;
    }

    circlePx() {
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      const c = this.cfg?.circle ?? this.detectedCircle ?? { x: 0.5, y: 0.5, r: 0.5 };
      return { x: c.x * vw, y: c.y * vh, r: c.r * vh, vw, vh };
    }

    stats() {
      return { active: this.active, gl: !!this.gl, glSetups: this.glSetups, glLost: this.glLost, glBroken: this.glBroken, renderer: this.renderer, software: this.software, circle: this.cfg?.circle ?? this.detectedCircle, mode: this.cfg?.mode, focus: this.cfg?.focus, aspect: this.cfg?.aspect ?? "16:9" };
    }

    // ------------------------------------------------------------------ frames

    #startFrames() {
      if (this.frameCallback != null) return;
      const v = this.video;
      if (typeof v.requestVideoFrameCallback === "function") {
        const tick = () => {
          this.frameCallback = v.requestVideoFrameCallback(tick);
          this.#upload();
          this.#draw();
        };
        this.frameCallback = v.requestVideoFrameCallback(tick);
      } else {
        // Fallback: poll at ~30 Hz but only upload when the decoded frame count changes.
        let last = -1;
        const tick = () => {
          this.frameCallback = setTimeout(tick, 33);
          const n = v.getVideoPlaybackQuality?.().totalVideoFrames ?? v.currentTime;
          if (n !== last) { last = n; this.#upload(); this.#draw(); }
        };
        this.frameCallback = setTimeout(tick, 33);
      }
    }

    #stopFrames() {
      if (this.frameCallback == null) return;
      if (typeof this.video.cancelVideoFrameCallback === "function") this.video.cancelVideoFrameCallback(this.frameCallback);
      clearTimeout(this.frameCallback);
      this.frameCallback = null;
    }

    #upload() {
      const gl = this.gl;
      const v = this.video;
      if (!gl || this.glLost || v.readyState < 2 || !v.videoWidth) return;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, v);
      this.hasFrame = true;
      this.#maybeAutoDetect();
    }

    #maybeAutoDetect() {
      if (this.cfg?.circle || this.detectedCircle || this.autoDetectTries >= 4) return;
      const now = performance.now();
      if (this.nextDetectAt && now < this.nextDetectAt) return;
      if (!this.nextDetectAt) { this.nextDetectAt = now + 1200; return; } // let exposure settle
      this.nextDetectAt = now + 2000;
      this.autoDetectTries++;
      const found = detectCircle(this.video);
      if (found) {
        this.detectedCircle = found;
        this.onChange({ circle: found });
      }
    }

    autoDetect() {
      const found = detectCircle(this.video);
      if (found) {
        this.detectedCircle = found;
        if (this.cfg) this.cfg.circle = found;
        this.onChange({ circle: found });
        this.#draw();
      }
      return found;
    }

    // ------------------------------------------------------------------ drawing

    #resize() {
      const dpr = (window.devicePixelRatio || 1) * this.scale;
      const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
        this.#draw();
      }
    }

    /** Viewport rectangles in canvas px (y down) for the current layout, with the view each shows. */
    layout() {
      const W = this.canvas.width;
      const H = this.canvas.height;
      const cfg = this.cfg;
      if (!cfg) return [];
      if (cfg.mode === "quad") {
        if (cfg.focus >= 0 && cfg.focus < 4) return [{ x: 0, y: 0, w: W, h: H, index: cfg.focus }];
        const w2 = Math.floor((W - GAP) / 2);
        const h2 = Math.floor((H - GAP) / 2);
        return [
          { x: 0, y: 0, w: w2, h: h2, index: 0 },
          { x: W - w2, y: 0, w: w2, h: h2, index: 1 },
          { x: 0, y: H - h2, w: w2, h: h2, index: 2 },
          { x: W - w2, y: H - h2, w: w2, h: h2, index: 3 },
        ];
      }
      if (cfg.mode === "panorama") {
        if (cfg.mount === "wall") return [{ x: 0, y: 0, w: W, h: H, strip: 0, span: 180 }];
        const h2 = Math.floor((H - GAP) / 2);
        return [
          { x: 0, y: 0, w: W, h: h2, strip: 0, span: 180 },
          { x: 0, y: H - h2, w: W, h: h2, strip: 1, span: 180 },
        ];
      }
      return [];
    }

    #draw() {
      const gl = this.gl;
      if (!gl || !this.active || this.calibrating) return;
      const cfg = this.cfg;
      gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!this.hasFrame) return;

      const c = this.circlePx();
      gl.uniform2f(this.u.uTexSize, c.vw, c.vh);
      gl.uniform3f(this.u.uCircle, c.x, c.y, c.r);
      gl.uniform1f(this.u.uHalfFov, (clamp(cfg.lensFov || 180, 120, 240) / 2) * DEG);
      const m = LENS[cfg.mount] ?? LENS.ceiling;
      // Upload column-major.
      gl.uniformMatrix3fv(this.u.uLens, false, new Float32Array([m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]]));

      gl.enable(gl.SCISSOR_TEST);
      for (const vp of this.layout()) {
        const glY = this.canvas.height - vp.y - vp.h;
        gl.viewport(vp.x, glY, vp.w, vp.h);
        gl.scissor(vp.x, glY, vp.w, vp.h);
        gl.uniform1f(this.u.uAspect, vp.w / vp.h);
        if (vp.index != null) {
          const v = cfg.views[vp.index];
          gl.uniform1i(this.u.uKind, 0);
          gl.uniform3f(this.u.uView, v.pan * DEG, v.tilt * DEG, Math.tan((clamp(v.fov, 10, 120) / 2) * DEG));
        } else {
          const span = vp.span * DEG;
          const tiltSpan = span * (vp.h / vp.w);
          const panStart = (cfg.pano.pan + (cfg.mount === "wall" ? -90 : vp.strip * 180)) * DEG;
          gl.uniform1i(this.u.uKind, 1);
          gl.uniform4f(this.u.uStrip, panStart, span, cfg.pano.tilt * DEG + tiltSpan / 2, tiltSpan);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      gl.disable(gl.SCISSOR_TEST);
    }

    redraw() { this.#draw(); }

    // ------------------------------------------------------------------ PTZ input

    #hit(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      const sx = this.canvas.width / rect.width;
      const sy = this.canvas.height / rect.height;
      const x = (clientX - rect.left) * sx;
      const y = (clientY - rect.top) * sy;
      return this.layout().find((vp) => x >= vp.x && x < vp.x + vp.w && y >= vp.y && y < vp.y + vp.h) ?? null;
    }

    #bindInput() {
      const cv = this.canvas;
      cv.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || !this.active || !this.interactive) return;
        const vp = this.#hit(e.clientX, e.clientY);
        if (!vp) return;
        cv.setPointerCapture(e.pointerId);
        this.drag = { vp, x: e.clientX, y: e.clientY };
      });
      cv.addEventListener("pointermove", (e) => {
        const d = this.drag;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        d.x = e.clientX;
        d.y = e.clientY;
        const rect = cv.getBoundingClientRect();
        const vpCssH = d.vp.h * (rect.height / cv.height);
        const vpCssW = d.vp.w * (rect.width / cv.width);
        if (d.vp.index != null) {
          // "Grab the scene": dragging right swings the view left.
          const v = this.cfg.views[d.vp.index];
          const degPerPx = v.fov / vpCssH;
          v.pan = wrap(v.pan - dx * degPerPx);
          v.tilt = clamp(v.tilt + dy * degPerPx, -90, 90);
        } else {
          this.cfg.pano.pan = wrap(this.cfg.pano.pan - dx * (d.vp.span / vpCssW));
          this.cfg.pano.tilt = clamp(this.cfg.pano.tilt + dy * (d.vp.span / vpCssW), -80, 80);
        }
        this.#draw();
        this.#emitViews();
      });
      const end = () => { this.drag = null; };
      cv.addEventListener("pointerup", end);
      cv.addEventListener("pointercancel", end);
      cv.addEventListener("wheel", (e) => {
        if (!this.active || !this.interactive) return;
        const vp = this.#hit(e.clientX, e.clientY);
        if (!vp || vp.index == null) return;
        e.preventDefault();
        const v = this.cfg.views[vp.index];
        v.fov = clamp(v.fov * Math.exp(e.deltaY * 0.0015), 10, 120);
        this.#draw();
        this.#emitViews();
      }, { passive: false });
      cv.addEventListener("dblclick", (e) => {
        if (!this.active || !this.interactive || this.cfg.mode !== "quad") return;
        const vp = this.#hit(e.clientX, e.clientY);
        if (!vp) return;
        this.cfg.focus = this.cfg.focus >= 0 ? -1 : vp.index;
        this.#draw();
        this.onChange({ focus: this.cfg.focus });
      });
    }

    #emitViews() {
      clearTimeout(this.emitTimer);
      this.emitTimer = setTimeout(() => this.onChange({ views: this.cfg.views, pano: this.cfg.pano }), 400);
    }

    // ------------------------------------------------------------------ calibration

    /**
     * Calibration shows the raw fisheye with the image circle drawn over it. Drag to move the
     * circle, scroll to resize, double-click to auto-detect, Enter or Esc to finish.
     */
    startCalibration(overlay, hint) {
      if (this.calibrating) return;
      this.calibrating = true;
      this.canvas.classList.add("hidden");
      overlay.classList.remove("hidden");
      hint.classList.remove("hidden");
      const ctx = overlay.getContext("2d");
      if (!this.cfg.circle) this.cfg.circle = { ...(this.detectedCircle ?? { x: 0.5, y: 0.5, r: 0.5 }) };
      const c = this.cfg.circle;

      // Map between video pixels and overlay CSS pixels for object-fit: contain.
      const fit = () => {
        const W = overlay.clientWidth;
        const H = overlay.clientHeight;
        const vw = this.video.videoWidth || 1;
        const vh = this.video.videoHeight || 1;
        const s = Math.min(W / vw, H / vh);
        return { s, ox: (W - vw * s) / 2, oy: (H - vh * s) / 2, vw, vh };
      };
      const paint = () => {
        const dpr = window.devicePixelRatio || 1;
        overlay.width = Math.round(overlay.clientWidth * dpr);
        overlay.height = Math.round(overlay.clientHeight * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);
        const f = fit();
        const cx = f.ox + c.x * f.vw * f.s;
        const cy = f.oy + c.y * f.vh * f.s;
        const r = c.r * f.vh * f.s;
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#3ccf7a";
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy); ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10); ctx.stroke();
      };
      let drag = null;
      const onDown = (e) => { if (e.button === 0) { drag = { x: e.clientX, y: e.clientY }; overlay.setPointerCapture(e.pointerId); } };
      const onMove = (e) => {
        if (!drag) return;
        const f = fit();
        c.x = clamp(c.x + (e.clientX - drag.x) / (f.vw * f.s), 0, 1);
        c.y = clamp(c.y + (e.clientY - drag.y) / (f.vh * f.s), 0, 1);
        drag = { x: e.clientX, y: e.clientY };
        paint();
      };
      const onUp = () => { drag = null; };
      const onWheel = (e) => {
        e.preventDefault();
        c.r = clamp(c.r * Math.exp(-e.deltaY * 0.0008), 0.1, 1.2);
        paint();
      };
      const onDbl = () => {
        const found = detectCircle(this.video);
        if (found) Object.assign(c, found);
        paint();
      };
      const onKey = (e) => { if (e.key === "Enter" || e.key === "Escape") finish(); };
      const ro = new ResizeObserver(paint);
      const finish = () => {
        overlay.removeEventListener("pointerdown", onDown);
        overlay.removeEventListener("pointermove", onMove);
        overlay.removeEventListener("pointerup", onUp);
        overlay.removeEventListener("wheel", onWheel);
        overlay.removeEventListener("dblclick", onDbl);
        window.removeEventListener("keydown", onKey);
        hint.querySelector("button")?.removeEventListener("click", finish);
        ro.disconnect();
        overlay.classList.add("hidden");
        hint.classList.add("hidden");
        this.calibrating = false;
        this.calibrationDone = null;
        this.canvas.classList.toggle("hidden", !this.active);
        this.onChange({ circle: { ...c } });
        this.#draw();
      };
      overlay.addEventListener("pointerdown", onDown);
      overlay.addEventListener("pointermove", onMove);
      overlay.addEventListener("pointerup", onUp);
      overlay.addEventListener("wheel", onWheel, { passive: false });
      overlay.addEventListener("dblclick", onDbl);
      window.addEventListener("keydown", onKey);
      hint.querySelector("button")?.addEventListener("click", finish);
      ro.observe(overlay);
      this.calibrationDone = finish;
      paint();
    }
  }

  function wrap(deg) {
    const a = ((deg % 360) + 360) % 360; // (-180, 180]
    return a > 180 ? a - 360 : a;
  }

  // ------------------------------------------------------------------ circle detection

  /**
   * Find the fisheye image circle. Scan outward from the frame center along 120 rays and take the
   * point where the picture turns black *for good* - dark all the way to the frame edge, or for a
   * long stretch (an on-screen timestamp can interrupt it). Dark objects inside the picture end
   * well before that, and RANSAC throws out any that slip through. Null if unsure.
   */
  function detectCircle(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const s = 480 / Math.max(vw, vh);
    const w = Math.round(vw * s);
    const h = Math.round(vh * s);
    const cv = detectCircle.canvas ?? (detectCircle.canvas = document.createElement("canvas"));
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const lum = (x, y) => {
      const i = (y * w + x) * 4;
      return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    };

    const DARK = 20;
    const LONG_RUN = Math.round(Math.min(w, h) * 0.12);
    const cx0 = w / 2;
    const cy0 = h / 2;
    const start = Math.min(w, h) * 0.15;
    const pts = [];
    for (let i = 0; i < 120; i++) {
      const a = (i * 3) * DEG;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      let run = 0;
      let edge = -1;
      let found = -1;
      for (let r = start; ; r += 1) {
        const x = Math.round(cx0 + dx * r);
        const y = Math.round(cy0 + dy * r);
        if (x < 0 || y < 0 || x >= w || y >= h) {
          if (run >= 4) found = edge; // dark right up to the frame edge
          break;
        }
        if (lum(x, y) < DARK) {
          if (run === 0) edge = r;
          if (++run >= LONG_RUN) { found = edge; break; }
        } else {
          run = 0;
        }
      }
      if (found > 0) pts.push([cx0 + dx * found, cy0 + dy * found]);
    }
    if (pts.length < 20) return null;

    // RANSAC: the circle that the most edge points agree on.
    const tol = Math.max(1.5, Math.min(w, h) * 0.01);
    let best = null;
    let bestIn = null;
    let seed = 12345;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let it = 0; it < 300; it++) {
      const a = pts[Math.floor(rand() * pts.length)];
      const b = pts[Math.floor(rand() * pts.length)];
      const c = pts[Math.floor(rand() * pts.length)];
      const cand = fitCircle([a, b, c]);
      if (!cand || cand.r < Math.min(w, h) * 0.25 || cand.r > Math.max(w, h) * 0.75) continue;
      const inl = pts.filter(([x, y]) => Math.abs(Math.hypot(x - cand.x, y - cand.y) - cand.r) < tol);
      if (!bestIn || inl.length > bestIn.length) { best = cand; bestIn = inl; }
    }
    if (!best || bestIn.length < Math.max(16, pts.length * 0.4)) return null;
    const fit = fitCircle(bestIn) ?? best;
    if (fit.r < Math.min(w, h) * 0.25 || fit.r > Math.max(w, h) * 0.75) return null;
    return { x: fit.x / w, y: fit.y / h, r: fit.r / h };
  }

  // Kasa algebraic circle fit: minimize sum (x^2 + y^2 + Dx + Ey + F)^2.
  function fitCircle(pts) {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
    const n = pts.length;
    for (const [x, y] of pts) {
      const z = x * x + y * y;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
    }
    const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
    const b = [-sxz, -syz, -sz];
    const sol = solve3(A, b);
    if (!sol) return null;
    const [D, E, F] = sol;
    const x = -D / 2;
    const y = -E / 2;
    const r2 = x * x + y * y - F;
    return r2 > 0 ? { x, y, r: Math.sqrt(r2) } : null;
  }

  function solve3(A, b) {
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const d = det(A);
    if (Math.abs(d) < 1e-9) return null;
    return [0, 1, 2].map((col) => det(A.map((row, i) => row.map((v, j) => (j === col ? b[i] : v)))) / d);
  }

  Dewarper.detectCircle = detectCircle;
  return Dewarper;
})();
