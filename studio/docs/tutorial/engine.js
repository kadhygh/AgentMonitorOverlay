// 教程的演示引擎（plans/tutorial-onboarding.md 第五节，2026-10-30）。一个演示 = 一块用 HTML/CSS 画的简化界面
// （scene.html，元素用 data-k="名字" 标出来）+ 一串步骤（每步一行字幕 say 和几个动作 do）。
//
//   AMO_TUTORIAL.scene({ id, title, ui: ["界面上画出来的按钮文字", …], html, steps: [{ say, do: [[动作, …], …] }] })
//
// 动作：["move", k, fx?, fy?] 光标移到 k（fx / fy 是落点在元素里的比例，默认 0.5）；["click", k] 移过去点一下；
// ["type", k, 文字] 逐字打进 k；["show", k] / ["hide", k]；["hl", k] / ["unhl", k] 高亮框；["on", k, class] /
// ["off", k, class]；["text", k, 文字]；["wait", 毫秒]。
// 跳到第 n 步 = 重画界面、前面的步骤瞬间做完、再动画播第 n 步，所以上一步、点圆点跳步都不用写反向动作。
// 字幕里 [[按钮名]] 画成按钮样子（和正文一样，单测会核对它在源码里还在），`代码`、**粗体** 照常。
(function () {
  const T = (globalThis.AMO_TUTORIAL = globalThis.AMO_TUTORIAL || {});
  T.scenes = new Map();
  /** 演示和共用片段里画出来的界面文字（单测核对用）。 */
  T.terms = new Set();
  T.uses = (...labels) => labels.forEach((l) => T.terms.add(l));
  T.scene = (def) => {
    T.scenes.set(def.id, def);
    (def.ui || []).forEach((l) => T.terms.add(l));
  };

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  /** 字幕的行内格式（和 build-tutorial.mjs 的正文一致）。 */
  T.inline = (s) =>
    String(s)
      .split(/(`[^`]*`)/)
      .map((part) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 1
          ? `<code>${esc(part.slice(1, -1))}</code>`
          : esc(part)
              .replace(/\[\[~?([^\]|]+)(?:\|[^\]]*)?\]\]/g, '<span class="ui">$1</span>')
              .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>"),
      )
      .join("");

  if (typeof document === "undefined") return; // 单测在 Node 里只收集 scene 定义

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CURSOR = '<svg class="cursor" data-cursor viewBox="0 0 20 24" width="20" height="24" aria-hidden="true"><path d="M2 1.5v17.2l4.4-4.1 3 6.7 3-1.4-3-6.6h6.1Z"/></svg>';

  class Demo {
    constructor(fig, def) {
      this.fig = fig;
      this.def = def;
      this.i = -1; // 已经做完的最后一步
      this.gen = 0; // 每次跳步、暂停都加一，正在播的动画看到变了就停
      this.playing = false;
      this.auto = true; // 还没被人点过：进出视口时自动播 / 停
      fig.innerHTML = `
        <figcaption class="demo-title"><span class="demo-kicker">演示</span>${esc(def.title)}</figcaption>
        <div class="stage" role="img" aria-label="${esc(def.title)}（简化的界面示意）" style="--h:${def.height || 340}px;--hn:${def.narrowHeight || def.height || 340}px"></div>
        <div class="demo-cap" aria-live="polite"><span class="demo-n"></span><span class="demo-say"></span></div>
        <div class="demo-ctl">
          <button type="button" data-a="prev">上一步</button>
          <button type="button" data-a="play" class="pri">播放</button>
          <button type="button" data-a="next">下一步</button>
          <button type="button" data-a="replay">重播</button>
          <span class="demo-dots" role="group" aria-label="跳到某一步">${def.steps.map((_, n) => `<button type="button" data-n="${n}" aria-label="第 ${n + 1} 步"></button>`).join("")}</span>
        </div>`;
      this.stage = fig.querySelector(".stage");
      this.say = fig.querySelector(".demo-say");
      this.num = fig.querySelector(".demo-n");
      this.btnPlay = fig.querySelector('[data-a="play"]');
      fig.querySelector(".demo-ctl").addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        this.auto = false;
        if (b.dataset.n !== undefined) return void this.goto(Number(b.dataset.n));
        ({ prev: () => this.goto(Math.max(0, this.i - 1)), next: () => this.goto(Math.min(def.steps.length - 1, this.i + 1)), replay: () => this.replay(), play: () => (this.playing ? this.pause() : this.play()) })[b.dataset.a]();
      });
      this.reset();
      this.caption();
      // 窗口宽度变了：元素位置跟着变，按现在这一步重摆一次（光标落点要重算）。
      let lastW = 0;
      new ResizeObserver(() => {
        const w = this.stage.clientWidth;
        if (Math.abs(w - lastW) < 2) return;
        lastW = w;
        if (this.i >= 0 && !this.playing) this.goto(this.i, { instant: true, keep: true });
      }).observe(this.stage);
    }

    get fast() {
      return reduced.matches;
    }
    el(k) {
      return this.stage.querySelector(`[data-k="${k}"]`);
    }
    reset() {
      this.stage.innerHTML = this.def.html + CURSOR;
      this.cursor = this.stage.querySelector("[data-cursor]");
      this.i = -1;
    }
    caption() {
      const n = this.def.steps.length;
      this.num.textContent = this.i < 0 ? `共 ${n} 步` : `${this.i + 1} / ${n}`;
      this.say.innerHTML = this.i < 0 ? T.inline(this.def.intro || "点「播放」看一遍，或者用「下一步」一步步看。") : T.inline(this.def.steps[this.i].say);
      this.fig.querySelectorAll(".demo-dots button").forEach((b, n) => b.setAttribute("aria-current", n === this.i ? "step" : "false"));
      this.btnPlay.textContent = this.playing ? "暂停" : this.i >= n - 1 ? "重播" : "播放";
      this.fig.classList.toggle("is-playing", this.playing);
    }

    /** 光标停到元素上（相对演示区域的坐标）。 */
    point(k, fx = 0.5, fy = 0.5) {
      const el = this.el(k);
      if (!el) return null;
      const s = this.stage.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: r.left - s.left + r.width * fx, y: r.top - s.top + r.height * fy };
    }
    async act(a, instant, gen) {
      const [kind, k, x, y] = a;
      const el = k !== undefined && kind !== "wait" ? this.el(k) : null;
      const alive = () => gen === this.gen;
      switch (kind) {
        case "move":
        case "click": {
          const p = this.point(k, kind === "move" ? x : 0.5, kind === "move" ? y : 0.55);
          if (!p) return;
          const c = this.cursor;
          c.classList.add("on");
          c.style.transition = instant ? "none" : "";
          const moved = c.style.transform !== `translate(${p.x}px, ${p.y}px)`;
          c.style.transform = `translate(${p.x}px, ${p.y}px)`;
          if (!instant && moved) await sleep(620);
          if (kind === "click" && !instant && alive()) {
            el.classList.add("is-pressed");
            const ring = document.createElement("span");
            ring.className = "ripple";
            ring.style.left = `${p.x}px`;
            ring.style.top = `${p.y}px`;
            this.stage.appendChild(ring);
            await sleep(260);
            el.classList.remove("is-pressed");
            setTimeout(() => ring.remove(), 400);
          }
          return;
        }
        case "type": {
          if (!el) return;
          if (instant) return void (el.textContent = x);
          el.classList.add("typing");
          el.textContent = "";
          for (const ch of x) {
            if (!alive()) return;
            el.textContent += ch;
            await sleep(/[\s，。、]/.test(ch) ? 90 : 55);
          }
          el.classList.remove("typing");
          return;
        }
        case "show":
          if (!el) return;
          el.removeAttribute("data-off");
          if (!instant) {
            el.classList.remove("appear");
            void el.offsetWidth;
            el.classList.add("appear");
          }
          return;
        case "hide":
          return void el?.setAttribute("data-off", "");
        case "hl":
          return void el?.classList.add("is-hl");
        case "unhl":
          return void el?.classList.remove("is-hl");
        case "on":
          return void el?.classList.add(x);
        case "off":
          return void el?.classList.remove(x);
        case "text":
          return void (el && (el.textContent = x));
        case "wait":
          if (!instant) await sleep(k);
          return;
      }
    }
    async runStep(n, instant, gen) {
      for (const a of this.def.steps[n].do || []) {
        if (gen !== this.gen) return false;
        await this.act(a, instant || this.fast, gen);
      }
      return gen === this.gen;
    }

    /** 跳到第 n 步：前面的瞬间做完，这一步动画播（instant 时也瞬间）。 */
    async goto(n, { instant = false, keep = false } = {}) {
      const gen = ++this.gen;
      if (!keep) this.playing = false;
      this.reset();
      for (let k = 0; k < n; k++) await this.runStep(k, true, gen);
      this.i = n;
      this.caption();
      return this.runStep(n, instant, gen);
    }
    async play() {
      if (this.i >= this.def.steps.length - 1) this.reset();
      this.playing = true;
      const gen = ++this.gen;
      this.caption();
      // 从下一步开始，一步一步往下播；每步播完停一会儿，字越多停得越久。
      while (gen === this.gen && this.i < this.def.steps.length - 1) {
        const n = this.i + 1;
        if (n === 0) this.reset();
        this.i = n;
        this.caption();
        if (!(await this.runStep(n, false, gen))) return;
        const len = this.def.steps[n].say.replace(/\[\[~?|\]\]|`|\*\*/g, "").length;
        await sleep(Math.min(5200, 1100 + len * 85));
      }
      if (gen !== this.gen) return;
      this.playing = false;
      this.caption();
    }
    pause() {
      this.gen++;
      this.playing = false;
      // 停在这一步做完的样子，不留半截动画。
      if (this.i >= 0) void this.goto(this.i, { instant: true });
      this.caption();
    }
    replay() {
      this.gen++;
      this.reset();
      this.caption();
      void this.play();
    }
  }

  T.demos = new Map();
  function mount() {
    document.querySelectorAll("figure.demo[data-scene]").forEach((fig) => {
      const def = T.scenes.get(fig.dataset.scene);
      if (!def) {
        fig.innerHTML = `<p class="demo-missing">! 没有找到演示「${esc(fig.dataset.scene)}」</p>`;
        return;
      }
      T.demos.set(def.id, new Demo(fig, def));
    });
    // 进到屏幕里才自动播，离开就停；被人点过的演示交给人控制。减少动态效果时不自动播。
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const d = T.demos.get(e.target.dataset.scene);
          if (!d || !d.auto || reduced.matches) continue;
          if (e.isIntersecting && !d.playing && d.i < d.def.steps.length - 1) void d.play();
          else if (!e.isIntersecting && d.playing) d.pause();
        }
      },
      { threshold: 0.55 },
    );
    T.demos.forEach((d) => io.observe(d.fig));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
