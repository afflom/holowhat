/* regl-stars.js — lightweight animated SVG star background */

(function () {
  const DEFAULTS = {
    canvas: { el: null, w: 0, h: 0, pxratio: 1 },
    particles: {
      number: { value: 200, density: { enable: true, value_area: 800 } },
      color: { value: "#ffffff" },
      opacity: {
        value: 1,
        random: true,
      },
      size: {
        value: 2,
        random: true,
      },
      line_linked: { enable: false },
      move: { enable: false },
      array: [],
    },
    interactivity: {
      detect_on: "canvas",
      events: {
        onhover: { enable: false },
        onclick: { enable: false },
        resize: true,
      },
      modes: {},
      mouse: {},
    },
    retina_detect: true,
    fn: { interact: {}, modes: {}, vendors: {} },
    tmp: {},
  };

  const SVG_NS = "http://www.w3.org/2000/svg";

  function hexToRgb(hex) {
    const s = hex.replace(/^#/, "");
    const n =
      s.length === 3
        ? s
            .split("")
            .map((c) => c + c)
            .join("")
        : s;
    const m = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(n);
    if (!m) return { r: 255, g: 255, b: 255 };
    return {
      r: parseInt(m[1], 16),
      g: parseInt(m[2], 16),
      b: parseInt(m[3], 16),
    };
  }

  function deepExtend(dst, src) {
    for (const k in src) {
      const v = src[k];
      if (v && v.constructor === Object) {
        if (!dst[k]) dst[k] = {};
        deepExtend(dst[k], v);
      } else {
        dst[k] = v;
      }
    }
    return dst;
  }

  function clamp(x, a, b) {
    return Math.min(Math.max(x, a), b);
  }

  function pJS(tag_id, params) {
    const root = this?.getRootNode?.() ?? document;
    const container = root.getElementById(tag_id);
    if (!container)
      throw new Error(`particlesJS: container with id "${tag_id}" not found`);

    const prev = container.querySelector(".particles-js-svg-el");
    if (prev) prev.remove();

    const state = deepExtend(
      JSON.parse(JSON.stringify(DEFAULTS)),
      params || {}
    );

    const computedPosition = getComputedStyle(container).position;
    const forcedPosition = computedPosition === "static";
    if (forcedPosition) container.style.position = "relative";

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("particles-js-svg-el");
    Object.assign(svg.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      display: "block",
      pointerEvents: "none",
      overflow: "visible",
      zIndex: "-1",
    });
    svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
    svg.setAttribute("role", "presentation");
    container.appendChild(svg);
    state.canvas.el = svg;
    const cometTimers = new Set();

    function retinaInit() {
      const rect = container.getBoundingClientRect();
      const cssW =
        rect.width || container.clientWidth || container.offsetWidth || 1;
      const cssH =
        rect.height || container.clientHeight || container.offsetHeight || 1;
      state.canvas.pxratio =
        state.retina_detect && window.devicePixelRatio > 1
          ? window.devicePixelRatio
          : 1;
      state.canvas.w = Math.max(1, Math.round(cssW * state.canvas.pxratio));
      state.canvas.h = Math.max(1, Math.round(cssH * state.canvas.pxratio));
      svg.setAttribute("viewBox", `0 0 ${state.canvas.w} ${state.canvas.h}`);
    }

    function computeTargetCount() {
      const particles = state.particles;
      if (!particles.number.density.enable)
        return Math.max(0, particles.number.value | 0);
      let area = (state.canvas.w * state.canvas.h) / 1000;
      if (state.canvas.pxratio > 1) area /= state.canvas.pxratio * 2;
      const desired = particles.number.value | 0;
      return Math.max(
        0,
        Math.round((area * desired) / particles.number.density.value_area)
      );
    }

    function rebuildStars(count) {
      cometTimers.forEach((id) => clearTimeout(id));
      cometTimers.clear();
      const col = hexToRgb(state.particles.color.value || "#ffffff");
      const color = `rgb(${col.r}, ${col.g}, ${col.b})`;
      const sizeBase = (state.particles.size.value * state.canvas.pxratio) / 2;
      const allowRandomSize = !!state.particles.size.random;
      const allowRandomOpacity = !!state.particles.opacity.random;
      const opacityBase = clamp(state.particles.opacity.value, 0, 1);
      const opacityAnim = state.particles.opacity.anim || {};
      const sizeAnim = state.particles.size.anim || {};
      const move = state.particles.move || {};
      const fallEnabled =
        !!move.enable &&
        (move.direction === "bottom" ||
          move.direction === "bottom-right" ||
          move.direction === "bottom-left");
      const fallSpeed = Math.max(0.1, move.speed || 1);
      const fallDurationBase = 160 / fallSpeed; // slower baseline for gentler snowfall
      const stillMode =
        !fallEnabled &&
        (!move.enable ||
          (move.enable && (move.speed || 0) <= 1 && move.random !== false));
      const driftBias =
        move.direction === "bottom-left"
          ? -1
          : move.direction === "bottom-right"
          ? 1
          : 0;

      const frag = document.createDocumentFragment();
      for (let i = 0; i < count; i++) {
        const cx = Math.random() * state.canvas.w;
        const cy = Math.random() * state.canvas.h;
        const sizeMul = allowRandomSize ? 0.5 + Math.random() : 1;
        const radius = Math.max(0.2, sizeBase * sizeMul);
        const op =
          clamp(allowRandomOpacity ? Math.random() : 1, 0, 1) * opacityBase;

        const circle = document.createElementNS(SVG_NS, "circle");
        circle.setAttribute("cx", cx.toFixed(2));
        circle.setAttribute("cy", cy.toFixed(2));
        circle.setAttribute("r", radius.toFixed(2));
        circle.setAttribute("fill", color);
        circle.setAttribute("opacity", op.toFixed(3));

        const animTwinkle = document.createElementNS(SVG_NS, "animate");
        animTwinkle.setAttribute("attributeName", "opacity");
        const low = (
          opacityAnim.enable
            ? opacityAnim.opacity_min ?? 0.1
            : 0.2 + Math.random() * 0.4
        ).toFixed(3);
        const high = op.toFixed(3);
        animTwinkle.setAttribute("values", `${low};${high};${low}`);
        const durBase = opacityAnim.enable
          ? Math.max(0.5, 10 / Math.max(0.1, opacityAnim.speed || 1))
          : 2 + Math.random() * 3;
        animTwinkle.setAttribute("dur", `${durBase.toFixed(2)}s`);
        animTwinkle.setAttribute("repeatCount", "indefinite");
        animTwinkle.setAttribute(
          "begin",
          `${(Math.random() * durBase).toFixed(2)}s`
        );
        //circle.appendChild(animTwinkle);

        if (sizeAnim.enable && fallEnabled) {
          const animSize = document.createElementNS(SVG_NS, "animate");
          animSize.setAttribute("attributeName", "r");
          const minR = Math.max(1, sizeAnim.size_min || radius * 0.5);
          const values = `${minR.toFixed(2)};${radius.toFixed(
            2
          )};${minR.toFixed(2)}`;
          animSize.setAttribute("values", values);
          const sizeDur = Math.max(1, 8 / Math.max(0.1, sizeAnim.speed || 1));
          animSize.setAttribute("dur", `${sizeDur.toFixed(2)}s`);
          animSize.setAttribute("repeatCount", "indefinite");
          animSize.setAttribute(
            "begin",
            `${(Math.random() * sizeDur).toFixed(2)}s`
          );
          animSize.setAttribute("keyTimes", "0;0.5;1");
          animSize.setAttribute("calcMode", "linear");
          //circle.appendChild(animSize);
        }

        if (!fallEnabled && move.enable && !stillMode) {
          const driftDuration = Math.max(
            6,
            120 / Math.max(0.1, move.speed || 1)
          );
          const steps = 5;
          const cxValues = [cx];
          const cyValues = [cy];
          const clampX = (val) =>
            Math.min(
              Math.max(val, radius),
              Math.max(radius, state.canvas.w - radius)
            );
          const clampY = (val) =>
            Math.min(
              Math.max(val, radius),
              Math.max(radius, state.canvas.h - radius)
            );
          let currentX = cx;
          let currentY = cy;
          const moveRangeX = Math.max(state.canvas.w * 0.2, radius * 8);
          const moveRangeY = Math.max(state.canvas.h * 0.2, radius * 6);
          for (let s = 1; s < steps - 1; s++) {
            currentX = clampX(
              currentX + (Math.random() * 2 - 1) * (moveRangeX * 0.5)
            );
            currentY = clampY(
              currentY + (Math.random() * 2 - 1) * (moveRangeY * 0.5)
            );
            cxValues.push(currentX);
            cyValues.push(currentY);
          }
          cxValues.push(cx);
          cyValues.push(cy);

          const segmentCount = cxValues.length - 1;
          const keyTimes = Array.from({ length: segmentCount + 1 }, (_, idx) =>
            (idx / segmentCount).toFixed(3)
          );
          const splineSegments = Array.from(
            { length: segmentCount },
            () => "0.42 0 0.58 1"
          );
          const beginOffset = -(Math.random() * driftDuration);

          const animCX = document.createElementNS(SVG_NS, "animate");
          animCX.setAttribute("attributeName", "cx");
          animCX.setAttribute(
            "values",
            cxValues.map((v) => v.toFixed(2)).join(";")
          );
          animCX.setAttribute("dur", `${driftDuration.toFixed(2)}s`);
          animCX.setAttribute("repeatCount", "indefinite");
          animCX.setAttribute("begin", `${beginOffset.toFixed(2)}s`);
          animCX.setAttribute("keyTimes", keyTimes.join(";"));
          if (splineSegments.length > 0) {
            animCX.setAttribute("calcMode", "spline");
            animCX.setAttribute("keySplines", splineSegments.join(";"));
          } else {
            animCX.setAttribute("calcMode", "linear");
          }
          //circle.appendChild(animCX);

          const animCY = document.createElementNS(SVG_NS, "animate");
          animCY.setAttribute("attributeName", "cy");
          animCY.setAttribute(
            "values",
            cyValues.map((v) => v.toFixed(2)).join(";")
          );
          animCY.setAttribute("dur", `${driftDuration.toFixed(2)}s`);
          animCY.setAttribute("repeatCount", "indefinite");
          animCY.setAttribute("begin", `${beginOffset.toFixed(2)}s`);
          animCY.setAttribute("keyTimes", keyTimes.join(";"));
          if (splineSegments.length > 0) {
            animCY.setAttribute("calcMode", "spline");
            animCY.setAttribute("keySplines", splineSegments.join(";"));
          } else {
            animCY.setAttribute("calcMode", "linear");
          }
          //circle.appendChild(animCY);
        }

        if (fallEnabled) {
          const fallDistance = state.canvas.h + radius * 4;
          const phaseOffset = Math.random() * fallDistance;
          const startY = -radius * 2 + phaseOffset;
          const endY = state.canvas.h + radius * 2;
          circle.setAttribute("cy", startY.toFixed(2));

          const dur = Math.max(
            4,
            fallDurationBase + Math.random() * (fallDurationBase * 0.6)
          );
          const animFall = document.createElementNS(SVG_NS, "animate");
          animFall.setAttribute("attributeName", "cy");
          animFall.setAttribute(
            "values",
            `${(-radius * 2).toFixed(2)};${endY.toFixed(2)}`
          );
          animFall.setAttribute("dur", `${dur.toFixed(2)}s`);
          animFall.setAttribute("repeatCount", "indefinite");
          const beginOffset = -((phaseOffset / fallDistance) * dur);
          animFall.setAttribute("begin", `${beginOffset.toFixed(2)}s`);
          animFall.setAttribute("keyTimes", "0;1");
          animFall.setAttribute("calcMode", "linear");
          //circle.appendChild(animFall);

          const driftRangeBase = Math.max(2, radius * 6);
          const driftRandom = (Math.random() * 2 - 1) * driftRangeBase;
          const driftRange = driftRandom + driftBias * driftRangeBase;
          if (Math.abs(driftRange) > 0.5) {
            const animDrift = document.createElementNS(SVG_NS, "animate");
            animDrift.setAttribute("attributeName", "cx");
            animDrift.setAttribute(
              "values",
              `${(cx - driftRange).toFixed(2)};${(cx + driftRange).toFixed(
                2
              )};${(cx - driftRange).toFixed(2)}`
            );
            animDrift.setAttribute("dur", `${(dur * 1.1).toFixed(2)}s`);
            animDrift.setAttribute("repeatCount", "indefinite");
            animDrift.setAttribute("begin", `${beginOffset.toFixed(2)}s`);
            animDrift.setAttribute("keyTimes", "0;0.5;1");
            animDrift.setAttribute("calcMode", "linear");
            //circle.appendChild(animDrift);
          }
        }

        frag.appendChild(circle);
      }

      if (stillMode) {
        const cometCount = Math.max(
          1,
          Math.min(4, Math.round(count * 0.1) || 1)
        );
        for (let i = 0; i < cometCount; i++) {
          const cometGroup = document.createElementNS(SVG_NS, "g");
          cometGroup.setAttribute("opacity", "0");

          const tail = document.createElementNS(SVG_NS, "line");
          tail.setAttribute("x1", "0");
          tail.setAttribute("y1", "0");
          tail.setAttribute("stroke", `rgba(255,255,255,0.6)`);
          tail.setAttribute("stroke-linecap", "round");
          tail.setAttribute("stroke-opacity", "0.75");
          cometGroup.appendChild(tail);

          const head = document.createElementNS(SVG_NS, "circle");
          head.setAttribute("fill", "rgba(255,255,255,0.9)");
          cometGroup.appendChild(head);

          const opacityAnim = document.createElementNS(SVG_NS, "animate");
          opacityAnim.setAttribute("attributeName", "opacity");
          opacityAnim.setAttribute("values", "0;0;1;0;0");
          opacityAnim.setAttribute("keyTimes", "0;0.78;0.82;0.9;1");
          opacityAnim.setAttribute("repeatCount", "1");
          opacityAnim.setAttribute("begin", "indefinite");
          cometGroup.appendChild(opacityAnim);

          const motion = document.createElementNS(SVG_NS, "animateMotion");
          motion.setAttribute("repeatCount", "1");
          motion.setAttribute("rotate", "auto");
          motion.setAttribute("begin", "indefinite");
          cometGroup.appendChild(motion);

          function randomizeComet() {
            const span = Math.max(state.canvas.w, state.canvas.h);
            const tailLength = (Math.random() * 0.25 + 0.12) * span;
            const headRadius = Math.max(1.5, sizeBase * 0.4);
            const dur = 10 + Math.random() * 20;

            tail.setAttribute("x2", tailLength.toFixed(2));
            tail.setAttribute(
              "y2",
              (Math.random() * headRadius * 0.3).toFixed(2)
            );
            tail.setAttribute(
              "stroke-width",
              Math.max(1.5, headRadius * 0.6).toFixed(2)
            );

            head.setAttribute("cx", tailLength.toFixed(2));
            head.setAttribute("cy", "0");
            head.setAttribute("r", headRadius.toFixed(2));

            const margin = tailLength * 0.3;
            const startX =
              Math.random() * (state.canvas.w + margin * 2) - margin;
            const startY =
              Math.random() * (state.canvas.h + margin * 2) - margin;

            const baseAngle = Math.random() * Math.PI * 2;
            const speedScale = 0.6 + Math.random() * 0.4;
            const dx = Math.cos(baseAngle) * span * speedScale;
            const dy = Math.sin(baseAngle) * span * speedScale;

            const endX = startX + dx;
            const endY = startY + dy;

            const path = `M ${startX.toFixed(2)} ${startY.toFixed(
              2
            )} L ${endX.toFixed(2)} ${endY.toFixed(2)}`;
            opacityAnim.setAttribute("dur", `${dur.toFixed(2)}s`);
            motion.setAttribute("dur", `${dur.toFixed(2)}s`);
            motion.setAttribute("path", path);
            return dur;
          }

          function scheduleLaunch(initialDelay) {
            const duration = randomizeComet();
            const delay = Math.max(0, initialDelay);
            const startTimer = setTimeout(() => {
              cometTimers.delete(startTimer);
              opacityAnim.beginElement();
              motion.beginElement();
            }, delay * 1000);
            cometTimers.add(startTimer);
            const pause = 2 + Math.random() * 6;
            const nextTimer = setTimeout(() => {
              cometTimers.delete(nextTimer);
              scheduleLaunch(0);
            }, (delay + duration + pause) * 1000);
            cometTimers.add(nextTimer);
          }

          scheduleLaunch(Math.random() * 6);
          frag.appendChild(cometGroup);
        }
      }

      svg.replaceChildren(frag);
    }

    function refresh() {
      retinaInit();
      rebuildStars(computeTargetCount());
    }

    refresh();

    let resizeHandler = null;
    if (state.interactivity.events.resize) {
      resizeHandler = () => refresh();
      window.addEventListener("resize", resizeHandler, { passive: true });
    }

    return {
      destroy() {
        if (resizeHandler) {
          window.removeEventListener("resize", resizeHandler);
        }
        cometTimers.forEach((id) => clearTimeout(id));
        cometTimers.clear();
        svg.remove();
        if (forcedPosition) container.style.position = "";
      },
      refresh,
      exportImg() {
        const serializer = new XMLSerializer();
        const clone = svg.cloneNode(true);
        const xml = serializer.serializeToString(clone);
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
      },
    };
  }

  window.pJSDom = window.pJSDom || [];
  window.particlesJS = function (tag_id, params) {
    if (typeof tag_id !== "string") {
      params = tag_id;
      tag_id = "particles-js";
    }
    if (!tag_id) tag_id = "particles-js";
    const inst = pJS.call(this, tag_id, params);
    window.pJSDom.push(inst);
    return inst;
  };
  window.particlesJS.clear = function (tag_id) {
    const root = this?.getRootNode?.() ?? document;
    const container = root.getElementById(tag_id);
    if (!container)
      throw new Error(`particlesJS: container with id "${tag_id}" not found`);

    const prev = container.querySelector(".particles-js-svg-el");
    if (prev) prev.remove();
  };
  window.particlesJS.load = function (tag_id, url, cb) {
    fetch(url)
      .then((r) => r.json())
      .then((cfg) => {
        const inst = window.particlesJS.call(this, tag_id, cfg);
        if (cb) cb(inst);
      });
  };
})();
