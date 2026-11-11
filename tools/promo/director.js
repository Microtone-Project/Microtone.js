// The promo director: drives the tracker, loaded in a same-origin <iframe>, through
// a scene (eighth.js) while a screen recorder films the stage — the iframe plus
// an overlay of captions, cards and a drawn cursor.
//
// Nothing here is part of the app. It reaches the app the way the browser
// smokes do: window.__microtone (the store and the views) and ordinary clicks
// on the app's own buttons. Every click is a real `click()` on the element, so
// the app does exactly what it does for a person; the cursor you see is drawn
// in the overlay and travels to that element first.
//
// Time: before the song plays, the clock is seconds since the sync cue; once it
// plays, the scene is keyed to the PLAYHEAD (bars), read from the engine every
// frame, so a slow frame never lets the pictures drift off the music.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const frame = () => new Promise((r) => requestAnimationFrame(r));

/** The localStorage keys a take may change; put back as they were afterwards. */
const STORAGE_PREFIX = "microtone";

export class Director {
  /**
   * @param {object} els   stage, frame (iframe), overlay, shield
   * @param {object} scene the scene module's default export
   * @param {object} hooks onState(state, detail), onLog(line)
   */
  constructor(els, scene, hooks = {}) {
    Object.assign(this, els);
    this.scene = scene;
    this.hooks = hooks;
    this.state = "idle";
    this.aborted = false;
    this.waiters = [];
    this.cap = null; // { el, untilBar, untilMs }
    this.sectionShown = "";
    this.cursor = { x: 0, y: 0, shown: false, lastMove: 0 };
    this.marks = { flash: 0, songStart: 0, songEnd: 0, end: 0 };
    this._buildOverlay();
  }

  // ── logging / state ──────────────────────────────────────────────────────
  log(msg) {
    const t = this.marks.flash ? ((performance.now() - this.marks.flash) / 1000).toFixed(2) + " s" : "—";
    const b = this.pos?.playing ? ` · bar ${this.pos.bar.toFixed(2)}` : "";
    this.hooks.onLog?.(`[${t}${b}] ${msg}`);
  }
  setState(state, detail = "") {
    this.state = state;
    this.hooks.onState?.(state, detail);
  }

  // ── the app ─────────────────────────────────────────────────────────────
  get win() { return this.frame.contentWindow; }
  get doc() { return this.frame.contentDocument; }
  get app() { return this.win?.__microtone; }
  get store() { return this.app?.store; }
  $(sel) { return this.doc?.querySelector(sel) ?? null; }
  $$(sel) { return [...(this.doc?.querySelectorAll(sel) ?? [])]; }

  /** Load the app with the scene's song, wait until it is drawn, and put it in
   *  the state the take starts from. Also remembers the app's saved
   *  preferences, which a take changes (?theme= is saved; so are the
   *  Timeline's cell width and the language), to put them back afterwards. */
  async boot() {
    this.setState("loading", "loading the tracker…");
    this._snapshotStorage();
    try { localStorage.setItem("microtone-lang", this.scene.lang ?? "en"); } catch { /* private mode */ }
    const song = new URL(this.scene.song, this.scene.base).pathname;
    const app = new URL("../../microtone-worker/index.html", import.meta.url);
    app.searchParams.set("load", song);
    app.searchParams.set("theme", this.scene.theme ?? "dark");
    this.frame.src = app.pathname + app.search;
    await new Promise((r) => this.frame.addEventListener("load", r, { once: true }));
    await this.until(() => this.store?.doc && !this.$("#splash"), 30000, "the song to load");
    await this.until(() => this.doc.fonts.status === "loaded", 10000, "the fonts");
    await sleep(300);
    await this.prepare();
    this.setState("ready", this.preflight());
  }

  /** The state every take starts from — whatever a rehearsal left behind. */
  async prepare() {
    const { store } = this;
    store.audio?.stop?.(0);
    this.tabNow("timeline");
    for (let i = 0; i < 4 && store.timelineCells !== 0; i++) this.$("#tbCells")?.click();
    if (store.pitchPlot) this.$("#tbPitchPlot")?.click();
    if (!store.follow) this.$("#follow")?.click();
    if (/off/i.test(this.$("#tbMaster")?.textContent ?? "")) this.$("#tbMaster")?.click();
    const iv = this.app.instrumentsView;
    if (iv?.rowEls?.length) { iv.selected = iv.rowEls[0].slot; iv.tab = "fm"; iv.refresh?.(); }
    const ta = this.$(".motif-text");
    if (ta) ta.scrollTop = 0;
    this.$("#viewHost")?.querySelectorAll("*").forEach((e) => { if (e.scrollTop && e.tagName !== "TEXTAREA") e.scrollTop = 0; });
    this.doc.activeElement?.blur?.();
    // The overlay's own geometry: the scrim of the title card stops below the
    // app's top bar, so the Play button stays in view while the cursor goes to it.
    const top = this.$(".topbar")?.getBoundingClientRect();
    this.overlay.style.setProperty("--chrome-top", `${Math.round(top?.bottom ?? 0)}px`);
    this.showStandby(true);
  }

  /** Things worth fixing before recording, as lines for the control strip. */
  preflight() {
    const out = [];
    const ok = (good, text) => out.push({ good, text });
    ok(true, `Song: ${this.songTitle()}`);
    ok(!this.$("dialog[open], .modal-backdrop:not([hidden]), .modal:not([hidden])"),
      "No dialog open in the app (an autosave-recovery prompt would be one: serve from a fresh port)");
    const zoom = this.$("#zoomDisp")?.textContent?.trim();
    ok(zoom === "100%", `App zoom ${zoom ?? "?"} (100% is what the scene was laid out at)`);
    ok(this.win.crossOriginIsolated, "Cross-origin isolated (the render-worker audio path)");
    return out;
  }

  songTitle() {
    const meta = this.store?.doc?.meta;
    const s = meta?.songMeta?.[0];
    return this.scene.title ?? (meta?.projectName || s?.name || "untitled");
  }

  // ── the take ────────────────────────────────────────────────────────────
  /**
   * Run the take. MUST be called from the Start button's click handler: the
   * two audio contexts (the app's and the sync beep's) are created in the same
   * task as the click, which is what lets them start without a second gesture.
   * @param {{fromBar?: number, sync?: boolean}} opts fromBar > 1 = a rehearsal
   *   from that bar (no intro, no sync cue)
   */
  async run({ fromBar = 1, sync = true } = {}) {
    this.aborted = false;
    this.ended = false;
    this.marks = { flash: 0, songStart: 0, songEnd: 0, end: 0 };
    const beepCtx = sync && fromBar <= 1 ? new AudioContext({ latencyHint: "interactive" }) : null;
    const appAudio = this.win.__microtoneEnsureAudio();
    this.shield.classList.add("on");
    this.setState("running", "starting the audio…");
    try {
      await appAudio;
      if (beepCtx) await beepCtx.resume();
      if (this.needsPrepare) await this.prepare(); // behind the standby slate
      this.needsPrepare = true;
      if (this.store.audio?.context?.state !== "running") {
        this.log(`warning: the app's audio is ${this.store.audio?.context?.state}`);
      }
      this._loop();
      if (fromBar <= 1) {
        await sleep(400);
        if (beepCtx) await this.syncCue(beepCtx);
        else this.marks.flash = performance.now();
        // Under the white frame, swap the slate for the intro's first picture
        // (its card shows at once, no fade), then cut straight to it.
        this.showStandby(false);
        this.log("lead-in");
        const intro = this.scene.intro?.(this);
        if (beepCtx) {
          await sleep(Math.max(0, 120 - (performance.now() - this.flashShownAt)));
          this.flash.classList.remove("on");
        }
        await intro;
      } else {
        this.marks.flash = performance.now();
        this.showStandby(false);
        this.log(`rehearsal from bar ${fromBar}`);
        await this.playFromBar(fromBar);
      }
      if (this.aborted) return;
      await this.until(() => this.pos?.playing, 8000, "the song to start");
      this.marks.songStart = this.marks.songStart || performance.now();
      this.log("playing");
      const events = (this.scene.events ?? []).filter((e) => e.bar >= fromBar).sort((a, b) => a.bar - b.bar);
      for (const ev of events) {
        await this.untilBar(ev.bar);
        if (this.aborted || this.ended) break;
        try { await ev.run(this); } catch (e) {
          if (this.aborted) break;
          this.log(`event at bar ${ev.bar} failed: ${e.message}`);
        }
      }
      await this.until(() => this.ended || this.aborted, 600000, "the song to end");
      if (this.aborted) return;
      this.marks.songEnd = performance.now();
      this.log("song over");
      await this.scene.outro?.(this);
      if (this.aborted) return;
      this.marks.end = performance.now();
      this.log("end card done — stop the recorder");
      this.setState("done", this.cutCommand());
    } catch (e) {
      if (!this.aborted) {
        this.log(`take failed: ${e.message}`);
        this.setState("failed", e.message);
      }
    } finally {
      beepCtx?.close();
      this.shield.classList.remove("on");
      this._restoreStorage();
    }
  }

  abort() {
    if (this.state !== "running") return;
    this.aborted = true;
    this.store?.audio?.stop?.(0);
    this.clearOverlay();
    this.showStandby(true);
    this.log("aborted");
    this.setState("aborted", "");
  }

  /** The cut, measured from the sync flash: what tools/promo/cut.py needs. */
  cutCommand() {
    if (!this.marks.flash || !this.marks.end) return "";
    const to = (this.marks.end - this.marks.flash) / 1000;
    return `python3 tools/promo/cut.py RECORDING.mkv --to ${to.toFixed(2)}`;
  }

  /** Play from the start of bar `bar` — what the app's own play-from-cursor does. */
  async playFromBar(bar) {
    const { cueBars = 4, barRows = 16 } = this.scene;
    const b = Math.max(0, Math.floor(bar) - 1);
    const cue = Math.floor(b / cueBars), row = (b % cueBars) * barRows;
    const { store } = this, song = store.song;
    store.sync.flushPatterns();
    store.audio.setBPM(0, song.bpm);
    store.audio.setTickRate(0, song.tickRate > 0 ? song.tickRate : 6);
    store.audio.setSongGlobalVolume(0, song.globalVolume);
    store.audio.setSongMixingVolume(0, song.mixingVolume);
    store.audio.chaseTrackerRow(0, cue, row);
    store.audio.play(0);
  }

  // ── clocks ──────────────────────────────────────────────────────────────
  /** Seconds since the sync flash. */
  t() { return this.marks.flash ? (performance.now() - this.marks.flash) / 1000 : 0; }

  /** Resolves once `fn()` is truthy (checked every 50 ms). */
  async until(fn, ms = 10000, what = "a condition") {
    const end = performance.now() + ms;
    for (;;) {
      if (this.aborted) throw new Error("aborted");
      let v; try { v = fn(); } catch { v = false; }
      if (v) return v;
      if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(50);
    }
  }
  /** Resolves when the playhead reaches `bar` (1-based, fractional), or the song ends. */
  untilBar(bar) {
    if (this.ended || this.aborted || (this.pos?.playing && this.pos.bar >= bar)) return Promise.resolve();
    return new Promise((res) => this.waiters.push({ bar, res }));
  }
  /** Resolves `s` seconds after the sync flash. */
  async at(s) {
    const ms = s * 1000 - (performance.now() - this.marks.flash);
    if (ms > 0) await sleep(ms);
  }
  wait(ms) { return sleep(ms); }

  /** Per frame: read the playhead, settle waiters, expire the caption, set the section. */
  async _loop() {
    let wasPlaying = false, jumpFrames = 0;
    this.pos = { playing: false, bar: 0 };
    while (!this.aborted && this.state === "running") {
      const a = this.store?.audio;
      const playing = !!a?.isPlaying?.();
      const { cueBars = 4, barRows = 16 } = this.scene;
      let bar = playing ? a.getCuePosition() * cueBars + a.getTrackerRow() / barRows + 1 : this.pos.bar;
      // A forward leap of more than a bar is believed only once it has held
      // for a few frames: the first snapshot after Play can still carry where
      // the last take stopped, and that would fire every event at once.
      if (playing && bar > this.pos.bar + 1 && ++jumpFrames < 6) bar = this.pos.bar;
      else jumpFrames = 0;
      this.pos = { playing, bar };
      if (playing) wasPlaying = true;
      else if (wasPlaying) this.ended = true;
      for (const w of this.waiters.slice()) {
        if (this.ended || (playing && bar >= w.bar)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res(); }
      }
      if (this.cap && ((this.cap.untilBar && playing && bar >= this.cap.untilBar) ||
                       (this.cap.untilMs && performance.now() >= this.cap.untilMs) || this.ended)) {
        this.hideCaption();
      }
      if (playing) this._section(bar);
      if (this.cursor.shown && performance.now() - this.cursor.lastMove > 4000 && !this.cursor.busy) this._cursorShow(false);
      this.hooks.onTick?.(this.pos, this.t());
      await frame();
    }
  }

  // ── sync cue ────────────────────────────────────────────────────────────
  /** A white frame and a 1 kHz beep at the same instant, for lining the two
   *  up in the edit (cut.py finds both). The beep is scheduled ahead on its
   *  own context, and the flash shown on the frame nearest the moment the
   *  beep leaves the speakers (getOutputTimestamp counts the output latency). */
  async syncCue(ctx) {
    const lead = 0.3;
    const when = ctx.currentTime + lead;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.frequency.value = 1000;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.5, when + 0.002);
    g.gain.setValueAtTime(0.5, when + 0.098);
    g.gain.linearRampToValueAtTime(0, when + 0.1);
    osc.connect(g).connect(ctx.destination);
    osc.start(when - 0.01);
    osc.stop(when + 0.12);
    const ts = ctx.getOutputTimestamp?.();
    const heardAt = ts?.performanceTime
      ? ts.performanceTime + (when - ts.contextTime) * 1000
      : performance.now() + (when - ctx.currentTime + (ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
    // The frame being prepared in a rAF callback reaches the screen about one
    // refresh later: show the flash on the callback one refresh before.
    for (;;) {
      const now = await frame();
      if (now + 16.7 >= heardAt - 8) break;
    }
    this.flash.classList.add("on"); // run() takes it off, once the intro is under it
    this.flashShownAt = performance.now();
    this.marks.flash = heardAt;
    this.log("sync cue");
  }

  // ── overlay ─────────────────────────────────────────────────────────────
  _buildOverlay() {
    const o = this.overlay;
    const mk = (cls, parent = o, tag = "div") => {
      const e = document.createElement(tag);
      e.className = cls;
      parent.append(e);
      return e;
    };
    this.ringLayer = mk("ring-layer");
    this.capEl = mk("caption");
    this.sectionEl = mk("section-tag");
    this.cardEl = mk("card");
    this.standbyEl = mk("standby");
    this.standbyEl.innerHTML = `<i class="mark tl"></i><i class="mark tr"></i><i class="mark bl"></i><i class="mark br"></i>` +
      `<div class="standby-in"><b>STANDBY</b><span>${this.stage.clientWidth}×${this.stage.clientHeight}` +
      ` · crop the recorder to the amber frame · then press Start beside it</span></div>`;
    this.flash = mk("flash");
    this.cursorEl = mk("cursor");
    this.cursorEl.innerHTML = `<svg viewBox="0 0 24 24" width="42" height="42" aria-hidden="true">
      <path d="M3 2 L3 19.5 L7.6 15.2 L10.6 22 L13.6 20.7 L10.7 14 L17 14 Z"
            fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    this.rippleEl = mk("ripple");
  }

  clearOverlay() {
    this.hideCaption();
    this.hideCard();
    this.ringLayer.replaceChildren();
    this.sectionEl.classList.remove("on");
    this.sectionShown = "";
    this._cursorShow(false);
  }

  showStandby(on) { this.standbyEl.classList.toggle("on", on); }

  /** A lower-third caption. `bars` = how long, in bars of the song (or `ms`). */
  caption(text, { bars = 0, ms = 0, kind = "" } = {}) {
    const el = this.capEl;
    el.className = `caption ${kind}`;
    el.replaceChildren();
    for (const [i, line] of [].concat(text).entries()) {
      const p = document.createElement(i === 0 ? "p" : "small");
      p.textContent = line;
      el.append(p);
    }
    void el.offsetWidth; // restart the transition
    el.classList.add("on");
    const bar = this.pos?.bar ?? 0;
    this.cap = { untilBar: bars ? bar + bars : 0, untilMs: ms ? performance.now() + ms : 0 };
  }
  hideCaption() {
    this.capEl.classList.remove("on");
    this.cap = null;
  }

  _section(bar) {
    // With no sections, the tag is the site's address alone.
    const s = (this.scene.sections ?? []).find(([, a, b]) => bar >= a && bar < b + 1);
    const key = s ? s[0] : this.scene.site ? "site" : "";
    if (key === this.sectionShown) return;
    this.sectionShown = key;
    if (!key) { this.sectionEl.classList.remove("on"); return; }
    this.sectionEl.replaceChildren();
    if (s) {
      const name = document.createElement("b");
      name.textContent = s[0];
      const range = document.createElement("span");
      range.textContent = `bars ${s[1]}–${s[2]}`;
      this.sectionEl.append(name, range);
    }
    const site = document.createElement("i");
    site.textContent = this.scene.site ?? "";
    if (!s) site.className = "alone";
    this.sectionEl.append(site);
    this.sectionEl.classList.remove("on");
    void this.sectionEl.offsetWidth;
    this.sectionEl.classList.add("on");
  }

  /**
   * A card over the stage. `full` covers everything; otherwise the scrim stops
   * below the app's top bar. `instant` shows it at once instead of fading in.
   * Parts: { kicker, wordmark, title, sub, lines[], foot }.
   */
  card(parts, { full = false, instant = false } = {}) {
    const c = this.cardEl;
    c.className = `card${full ? " full" : ""}${instant ? " instant" : ""}`;
    c.replaceChildren();
    const box = document.createElement("div");
    box.className = "card-in";
    const add = (cls, text, tag = "div") => {
      if (!text) return;
      const e = document.createElement(tag);
      e.className = cls;
      e.textContent = text;
      box.append(e);
    };
    if (parts.wordmark) {
      const w = document.createElement("div");
      w.className = "wordmark";
      w.innerHTML = `<span class="brand brand-red">Micro</span><span class="brand brand-white">tone</span><span class="brand brand-tm"></span>`;
      box.append(w);
    }
    add("kicker", parts.kicker);
    add("title", parts.title);
    add("sub", parts.sub);
    if (parts.lines?.length) {
      const ul = document.createElement("ul");
      for (const l of parts.lines) { const li = document.createElement("li"); li.textContent = l; ul.append(li); }
      box.append(ul);
    }
    add("foot", parts.foot);
    c.append(box);
    void c.offsetWidth;
    c.classList.add("on");
    // Once it is on screen, fading it out works as usual again.
    if (instant) requestAnimationFrame(() => requestAnimationFrame(() => c.classList.remove("instant")));
  }
  hideCard() { this.cardEl.classList.remove("on"); }

  // ── pointing ────────────────────────────────────────────────────────────
  /** An element of the app: a selector, an element, or a function of the director. */
  async resolve(target, ms = 4000) {
    if (typeof target === "string") return this.until(() => this.$(target), ms, target);
    if (typeof target === "function") return this.until(() => target(this), ms, "the target");
    return target;
  }
  /** Where an element sits on the stage (the iframe fills it, unscaled). */
  rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  _cursorShow(on) {
    this.cursor.shown = on;
    this.cursorEl.classList.toggle("on", on);
  }
  _cursorAt(x, y) {
    this.cursor.x = x; this.cursor.y = y;
    this.cursorEl.style.transform = `translate(${x}px, ${y}px)`;
  }

  /** Glide the cursor to (x, y) along a slight arc, ease in-out. */
  async moveTo(x, y, ms) {
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    if (!this.cursor.shown) {
      // Enter from wherever it rested, or from the lower right on first use.
      if (!this.cursor.x && !this.cursor.y) this._cursorAt(W * 0.72, H * 0.86);
      this._cursorShow(true);
    }
    const x0 = this.cursor.x, y0 = this.cursor.y;
    const dist = Math.hypot(x - x0, y - y0);
    ms ??= Math.min(1100, 380 + dist * 0.75);
    // the arc: a control point pushed off the straight line by a tenth of it
    const mx = (x0 + x) / 2 + (y - y0) * 0.1, my = (y0 + y) / 2 - (x - x0) * 0.1;
    this.cursor.busy = true;
    const t0 = performance.now();
    for (;;) {
      const k = Math.min(1, (performance.now() - t0) / ms);
      const e = easeInOut(k), u = 1 - e;
      this._cursorAt(u * u * x0 + 2 * u * e * mx + e * e * x, u * u * y0 + 2 * u * e * my + e * e * y);
      if (k >= 1 || this.aborted) break;
      await frame();
    }
    this.cursor.busy = false;
    this.cursor.lastMove = performance.now();
  }

  /** Move to an element (scrolled into view first, if it is not). */
  async point(target, { ms, dx = 0.5, dy = 0.5 } = {}) {
    const el = await this.resolve(target);
    const r0 = this.rectOf(el);
    const H = this.stage.clientHeight;
    if (r0.y < 0 || r0.y + r0.h > H) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      await sleep(600);
    }
    const r = this.rectOf(el);
    await this.moveTo(r.x + r.w * dx, r.y + r.h * dy, ms);
    return el;
  }

  /** Move to an element and click it — the app's own click handler runs. */
  async click(target, opts = {}) {
    const el = await this.point(target, opts);
    this.cursorEl.classList.add("down");
    const { x, y } = this.cursor;
    this.rippleEl.style.transform = `translate(${x}px, ${y}px)`;
    this.rippleEl.classList.remove("go");
    void this.rippleEl.offsetWidth;
    this.rippleEl.classList.add("go");
    await sleep(90);
    el.click();
    await sleep(70);
    this.cursorEl.classList.remove("down");
    this.cursor.lastMove = performance.now();
    await sleep(opts.after ?? 150);
    return el;
  }

  /** Click one of the app's view tabs. */
  tab(view) { return this.click(`#tabs button[data-view="${view}"]`); }
  /** The same, off camera (no cursor). */
  tabNow(view) { this.$(`#tabs button[data-view="${view}"]`)?.click(); }

  /**
   * Ring an element (or several: the ring goes round all of them), following
   * it as it scrolls, for `ms`. `label` sits on the ring's top edge.
   */
  async ring(target, { ms = 3000, pad = 6, label = "" } = {}) {
    const els = typeof target === "function" ? [].concat(target(this)) : [].concat(await this.resolve(target));
    if (!els.length || !els[0]) return;
    const r = document.createElement("div");
    r.className = "ring";
    if (label) { const l = document.createElement("span"); l.textContent = label; r.append(l); }
    this.ringLayer.append(r);
    const place = () => {
      const rs = els.map((e) => e.getBoundingClientRect());
      const x0 = Math.min(...rs.map((q) => q.left)) - pad, y0 = Math.min(...rs.map((q) => q.top)) - pad;
      const x1 = Math.max(...rs.map((q) => q.right)) + pad, y1 = Math.max(...rs.map((q) => q.bottom)) + pad;
      Object.assign(r.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
    };
    place();
    void r.offsetWidth;
    r.classList.add("on");
    const end = performance.now() + ms;
    (async () => {
      while (performance.now() < end && !this.aborted) { place(); await frame(); }
      r.classList.remove("on");
      await sleep(400);
      r.remove();
    })();
  }

  /** Scroll an element of the app smoothly to `top` (px) over `ms`. */
  async scroll(target, top, ms = 1500) {
    const el = await this.resolve(target);
    const from = el.scrollTop, to = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
    const t0 = performance.now();
    for (;;) {
      const k = Math.min(1, (performance.now() - t0) / ms);
      el.scrollTop = from + (to - from) * easeInOut(k);
      el.dispatchEvent(new Event("scroll"));
      if (k >= 1 || this.aborted) break;
      await frame();
    }
  }

  // ── storage ─────────────────────────────────────────────────────────────
  _snapshotStorage() {
    this.saved = new Map();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith(STORAGE_PREFIX)) this.saved.set(k, localStorage.getItem(k));
      }
    } catch { this.saved = null; }
  }
  /** Put back every app preference the take changed (theme, cells, language…). */
  _restoreStorage() {
    if (!this.saved) return;
    try {
      const now = [];
      for (let i = 0; i < localStorage.length; i++) now.push(localStorage.key(i));
      for (const k of now) if (k.startsWith(STORAGE_PREFIX) && !this.saved.has(k)) localStorage.removeItem(k);
      for (const [k, v] of this.saved) if (localStorage.getItem(k) !== v) localStorage.setItem(k, v);
    } catch { /* private mode */ }
  }
  restoreStorage() { this._restoreStorage(); }
}
