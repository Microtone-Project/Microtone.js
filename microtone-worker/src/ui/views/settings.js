// The desktop app's Settings tab (item 336): the native audio host's output
// and how the audio thread is keeping up. It exists only where the Qt shell
// runs the engine natively (window.__MICROTONE_NATIVE__); the website has no
// such tab, since the browser owns its audio.
//
// Laid out as the Samples and Instruments views are: categories down the left
// (the side list), the chosen one's controls on the right. A change applies at
// once — the host closes the device and opens it again while the engine keeps
// playing — so there is nothing to commit and no Apply button. A setting the
// device refuses puts the previous one back, and the tab says why.
//
//   Audio        the audio system (API), the device, its sample rate, the buffer
//   Performance  the device callback's load, the engine's, dropouts, and the
//                real-time scheduling the thread was granted
//
// A category is an entry in CATEGORIES with a builder: MIDI, updates and the
// rest join as they are made.

import { t } from "../i18n.js";
import { profileVerdict } from "../profileoverlay.js";
import { nativeApiName } from "../../../core/audio/native-engine.js";

const CATEGORY_KEY = "microtone-settings-category";
const BUFFERS = [64, 128, 256, 512, 1024, 2048];
// Rates a device lists that are worth offering (RtAudio probes a long list).
const RATES = [44100, 48000, 88200, 96000, 176400, 192000];

const CATEGORIES = [
  { key: "audio", label: "settings.cat.audio" },
  { key: "performance", label: "settings.cat.performance" },
];

const pct = (f) => `${Math.round(f * 100)}%`;
const ms = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : "–");

/** Text only when it changed (the frame loop visits an open view 60 times a
 *  second: an unconditional write restyles the page). */
function setText(el, s) {
  if (el.textContent !== s) el.textContent = s;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class SettingsView {
  constructor(store, host) {
    this.store = store;
    this.host = host;
    this.visible = false;
    let saved = null;
    try { saved = localStorage.getItem(CATEGORY_KEY); } catch { /* private window */ }
    this.category = CATEGORIES.some((c) => c.key === saved) ? saved : "audio";
    this.devices = null;     // the host's HOST_DEVICES answer
    this.busy = false;       // a HOST_CONFIGURE in flight
    this.error = "";         // why the last setting would not open
    this._link = null;       // the link the tab last drew for
    this._status = null;     // …and the host's status it drew
    this._profilingOurs = false;
    this._perf = null;       // the Performance category's readouts
    this._dropouts = 0;      // xruns since this page opened (or Count again)
    this._lastReport = null;

    this.root = el("div", "split-view settings-view");
    this.list = el("div", "side-list settings-list");
    this.detail = el("div", "side-detail settings-detail");
    this.root.append(this.list, this.detail);
    host.appendChild(this.root);
  }

  /** The native host's link, once audio has started (the first click). */
  get link() { return this.store.audio?.usingNative ? this.store.audio.native : null; }

  // ── the shell's view protocol ──

  show() {
    this.visible = true;
    this.host.hidden = false;
    this.refresh();
  }

  hide() {
    this.visible = false;
    this._setProfiling(false);
  }

  refresh() {
    if (!this.visible) return;
    this._renderList();
    this._renderCategory();
  }

  frame() {
    if (!this.visible) return;
    // Audio starts at the first click or key press, possibly after the tab
    // was drawn: draw it again once the host is there.
    if (this.link !== this._link) this.refresh();
    // The output changed under the tab (another window's Settings, the
    // real-time grant arriving after a reopen): draw it as it is now.
    else if (this._link !== null && this._link.hello !== this._status && !this.busy) this.refresh();
    if (this.category === "performance") this._updatePerformance();
  }

  // ── the side list ──

  _renderList() {
    this.list.replaceChildren();
    for (const c of CATEGORIES) {
      const row = el("div", "side-row" + (c.key === this.category ? " sel" : ""));
      row.append(el("span", "name", t(c.label)));
      row.addEventListener("click", () => this._choose(c.key));
      this.list.append(row);
    }
  }

  _choose(key) {
    if (key === this.category) return;
    this.category = key;
    try { localStorage.setItem(CATEGORY_KEY, key); } catch { /* private window */ }
    this.refresh();
  }

  _renderCategory() {
    this._link = this.link;
    this._status = this._link?.hello ?? null;
    this._perf = null;
    this.detail.replaceChildren();
    this._setProfiling(this.category === "performance" && this._link !== null);
    if (!this.store.audio) {
      this.detail.append(el("p", "set-note", t("profiler.waiting")));
      return;
    }
    if (this._link === null) {
      this.detail.append(el("p", "set-note", t("settings.noNative")));
      return;
    }
    if (this.category === "audio") this._renderAudio();
    else this._renderPerformance();
  }

  // ── Audio ──

  _renderAudio() {
    const link = this._link;
    const now = link.hello;
    const section = el("div", "set-section");
    section.append(el("h3", "set-head", t("settings.output")));

    if (this.devices === null) {
      // The device list is the host's to probe: ask once, draw again.
      this.detail.append(section);
      section.append(el("p", "set-note", t("settings.applying")));
      link.requestDevices().then((d) => {
        this.devices = d;
        if (this.visible && this.category === "audio") this.refresh();
      });
      return;
    }
    const apis = this.devices.apis.filter((a) => a.devices.length > 0);
    const api = apis.find((a) => a.id === now.apiId) ?? apis[0];

    // The audio system: a few named options, flipped while listening.
    const apiSeg = el("div", "mst-seg");
    for (const a of apis) {
      const b = el("button", a.id === now.apiId ? "active" : "", nativeApiName(a.id, a.name));
      b.type = "button";
      b.disabled = this.busy;
      b.addEventListener("click", () => {
        if (a.id !== now.apiId) this._apply({ api: a.id, device: "", rate: 0, bufferFrames: now.bufferFrames });
      });
      apiSeg.append(b);
    }
    section.append(this._row(t("settings.api"), apiSeg));

    // The device: a long list, so a dropdown.
    const devSel = el("select", "set-select");
    const def = api?.devices.find((d) => d.isDefault);
    devSel.append(new Option(def ? t("settings.deviceDefaultIs", { name: def.name }) : t("settings.deviceDefault"), ""));
    for (const d of api?.devices ?? []) devSel.append(new Option(d.name, d.name));
    devSel.value = now.deviceChoice ?? "";
    devSel.disabled = this.busy;
    devSel.addEventListener("change", () => {
      this._apply({ api: now.apiId, device: devSel.value, rate: 0, bufferFrames: now.bufferFrames });
    });
    section.append(this._row(t("settings.device"), devSel));

    // The sample rate: the device's, as it lists them.
    const device = api?.devices.find((d) => d.name === now.deviceChoice) ?? def ?? null;
    const rates = (device?.rates ?? []).filter((r) => RATES.includes(r));
    const rateSel = el("select", "set-select");
    rateSel.append(new Option(t("settings.rateAuto"), "0"));
    for (const r of rates) rateSel.append(new Option(`${r} Hz`, String(r)));
    rateSel.value = String(rates.includes(now.rateChoice) ? now.rateChoice : 0);
    rateSel.disabled = this.busy;
    rateSel.addEventListener("change", () => {
      this._apply({ api: now.apiId, device: now.deviceChoice, rate: Number(rateSel.value), bufferFrames: now.bufferFrames });
    });
    section.append(this._row(t("settings.rate"), rateSel));

    // The buffer: six sizes, the latency each costs read below.
    const bufSeg = el("div", "mst-seg");
    for (const n of BUFFERS) {
      const b = el("button", n === now.bufferFrames ? "active" : "", String(n));
      b.type = "button";
      b.disabled = this.busy;
      b.addEventListener("click", () => {
        if (n !== now.bufferFrames) {
          this._apply({ api: now.apiId, device: now.deviceChoice, rate: now.rateChoice, bufferFrames: n });
        }
      });
      bufSeg.append(b);
    }
    const bufCell = el("div", "set-inline");
    bufCell.append(bufSeg, el("span", "set-unit", t("settings.frames")));
    section.append(this._row(t("settings.buffer"), bufCell));

    // What is open now, in words.
    if (this.busy) {
      section.append(el("p", "set-note", t("settings.applying")));
    } else {
      section.append(el("p", "set-note", t("settings.now", {
        device: now.device, api: nativeApiName(now.apiId, now.api), rate: now.rate,
        ms: ms(now.bufferMs, 1), latency: ms(now.latencyMs, 1),
      })));
      section.append(el("p", "set-note", now.rate === now.engineRate
        ? t("settings.unconverted", { rate: now.rate })
        : t("settings.converted", { engine: now.engineRate, rate: now.rate })));
    }
    if (this.error) section.append(el("p", "set-note err", t("settings.failed", { error: this.error })));
    this.detail.append(section);
  }

  _row(label, control) {
    const row = el("div", "set-row");
    row.append(el("span", "set-label", label), control);
    return row;
  }

  async _apply(config) {
    const link = this._link;
    if (!link || this.busy) return;
    this.busy = true;
    this.error = "";
    this.refresh();
    const status = await link.configure(config);
    this.busy = false;
    this.error = status?.error ?? "";
    this.refresh();
  }

  // ── Performance ──

  _renderPerformance() {
    const section = el("div", "set-section");
    section.append(el("h3", "set-head", t("settings.cat.performance")));
    section.append(el("p", "set-note", t("settings.perfNote")));
    const value = () => el("span", "set-value");
    const p = {
      verdict: el("p", "set-verdict"),
      detail: el("p", "set-note"),
      callback: value(),
      engine: value(),
      dropouts: value(),
      realtime: value(),
    };
    section.append(p.verdict, p.detail);
    section.append(this._row(t("settings.callback"), p.callback));
    section.append(this._row(t("settings.engine"), p.engine));
    section.append(this._row(t("profiler.dropouts"), p.dropouts));
    section.append(this._row(t("settings.realtime"), p.realtime));
    const again = el("button", "", t("settings.resetCounts"));
    again.type = "button";
    again.addEventListener("click", () => { this._dropouts = 0; this._updatePerformance(true); });
    section.append(again);
    this.detail.append(section);
    this._perf = p;
    this._lastReport = null;
    this._updatePerformance(true);
  }

  /** The figures, from the host's report (a second at a time); written only
   *  when they moved. */
  _updatePerformance(force = false) {
    const p = this._perf;
    const audio = this.store.audio;
    if (p === null || !audio) return;
    const r = audio.profile;
    if (r !== this._lastReport && r !== null) {
      this._lastReport = r;
      this._dropouts += r.xruns ?? 0;
      force = true;
    }
    if (!force) return;
    const status = this._link?.hello;
    setText(p.realtime, status?.realtime || t("settings.realtimeNone"));
    p.realtime.classList.toggle("warn", !status?.realtime);
    setText(p.dropouts, this._dropouts > 0 ? t("settings.dropoutsValue", { n: this._dropouts }) : t("profiler.none"));
    p.dropouts.classList.toggle("warn", this._dropouts > 0);
    if (!r) return;
    setText(p.callback, t("profiler.audioThreadValue", {
      pct: pct(r.cpuFrac ?? 0), mean: ms(r.procMeanMs), max: ms(r.procMaxMs), budget: `${ms(r.quantumMs)} ms`,
    }));
    setText(p.engine, t("settings.engineValue", { pct: pct(r.renderFrac ?? 0), max: ms(r.renderMaxMs) }));
    const v = profileVerdict(r);
    setText(p.verdict, t(`profiler.verdict.${v.key}`));
    p.verdict.dataset.tone = v.tone;
    setText(p.detail, t(`profiler.detail.${v.key}`));
  }

  /** The host reports only while someone is looking: on while the
   *  Performance category is shown, off when it goes — unless the profiler
   *  panel had it on already. */
  _setProfiling(on) {
    const audio = this.store.audio;
    if (!audio) return;
    if (on && !audio.profiling) {
      audio.setProfiling(true);
      this._profilingOurs = true;
    } else if (!on && this._profilingOurs) {
      audio.setProfiling(false);
      this._profilingOurs = false;
    }
  }
}
