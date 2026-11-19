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
//   Audio        the audio system (API), the device, WASAPI's mode, the sample
//                rate, the buffer (ASIO: the driver's own size, and its
//                settings window; JACK: the server's rate and size, shown)
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

// WASAPI's three ways to play (desktop-qt/src/wasapi.h), in the host's words.
const MODES = ["shared", "lowLatency", "exclusive"];

/** The buffer sizes worth offering where a mode or a driver has limits: the
 *  usual ones inside them, the shortest it allows and the longest. With
 *  `driver` (an ASIO driver, which keeps a size of its own) 0 comes first:
 *  "the driver's", whatever its settings window says. */
export function bufferChoices(limits, driver = false) {
  if (driver) return [0, ...bufferChoices(limits)];
  if (!limits) return BUFFERS;
  const min = limits.min || 0, max = limits.max || Infinity, step = limits.step || 1;
  const fits = (n) => n >= min && n <= max && n % step === 0;
  const out = BUFFERS.filter(fits);
  if (min > 0 && !out.includes(min)) out.unshift(min);
  if (Number.isFinite(max) && !out.includes(max)) out.push(max);
  return out;
}

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
    this._devicesDrawn = null;  // the link's device list the tab last drew
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
    // A fresh device list each time the tab is opened: something may have
    // been plugged in since (the host also pushes one when the system says
    // so, as macOS, Windows, PulseAudio, ALSA and an open JACK do). It lands
    // in link.devices, and frame() draws it.
    this.link?.requestDevices();
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
    // real-time grant arriving after a reopen), or the devices did: draw it
    // as it is now.
    else if (this._link !== null && !this.busy && (this._link.hello !== this._status ||
             (this.category === "audio" && this._link.devices !== this._devicesDrawn))) this.refresh();
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

    const devices = link.devices;
    this._devicesDrawn = devices;
    if (devices === null) {
      // The device list is the host's to probe: asked for, and drawn by
      // frame() once it is in link.devices.
      this.detail.append(section);
      section.append(el("p", "set-note", t("settings.applying")));
      link.requestDevices();
      return;
    }
    const apis = devices.apis.filter((a) => a.devices.length > 0);
    const api = apis.find((a) => a.id === now.apiId) ?? apis[0];

    // The audio system: a few named options, flipped while listening.
    const apiSeg = el("div", "mst-seg");
    for (const a of apis) {
      const b = el("button", a.id === now.apiId ? "active" : "", nativeApiName(a.id, a.name));
      b.type = "button";
      b.disabled = this.busy;
      b.addEventListener("click", () => {
        if (a.id !== now.apiId) {
          // An ASIO driver plays at its own size until told otherwise; JACK
          // at its server's, always.
          const bufferFrames = a.driverBuffer || a.serverBuffer ? 0 : now.bufferFrames;
          this._apply({ api: a.id, device: "", rate: 0, bufferFrames, mode: a.modes ? "lowLatency" : "" });
        }
      });
      apiSeg.append(b);
    }
    section.append(this._row(t("settings.api"), apiSeg));

    // The device: a long list, so a dropdown.
    // What the host has open, as a setting: anything below changes one part.
    const asked = {
      api: now.apiId, device: now.deviceChoice ?? "", mode: now.mode ?? "",
      rate: now.rateChoice ?? 0, bufferFrames: now.bufferChoice ?? now.bufferFrames,
    };
    const devSel = el("select", "set-select");
    const def = api?.devices.find((d) => d.isDefault);
    // ASIO has no system default: RtAudio takes the first driver.
    const defLabel = api?.driverBuffer ? "settings.deviceFirstIs" : "settings.deviceDefaultIs";
    devSel.append(new Option(def ? t(defLabel, { name: def.name }) : t("settings.deviceDefault"), ""));
    for (const d of api?.devices ?? []) devSel.append(new Option(d.name, d.id ?? d.name));
    devSel.value = asked.device;
    devSel.disabled = this.busy;
    devSel.addEventListener("change", () => this._apply({ ...asked, device: devSel.value, rate: 0 }));
    section.append(this._row(t("settings.device"), devSel));

    const device = api?.devices.find((d) => (d.id ?? d.name) === asked.device) ?? def ?? null;
    // WASAPI's mode: three named ways, flipped while listening; one the
    // device does not offer cannot be pressed.
    const modeLimits = api?.modes ? device?.modes?.[asked.mode] ?? null : null;
    if (api?.modes) {
      const modeSeg = el("div", "mst-seg");
      for (const m of MODES) {
        const offered = !!device?.modes?.[m];
        const b = el("button", m === asked.mode ? "active" : "", t(`settings.mode.${m}`));
        b.type = "button";
        b.disabled = this.busy || !offered;
        if (!offered) b.title = t("settings.modeUnavailable");
        b.addEventListener("click", () => {
          if (m !== asked.mode) this._apply({ ...asked, mode: m, rate: m === "exclusive" ? asked.rate : 0 });
        });
        modeSeg.append(b);
      }
      section.append(this._row(t("settings.mode"), modeSeg));
      if (asked.mode) section.append(el("p", "set-note set-indent", t(`settings.modeNote.${asked.mode}`)));
    }

    // The sample rate: the device's, as it lists them — except through a
    // mixer, which runs at its own, and through JACK, whose server sets it.
    const isOpen = api?.id === now.apiId;  // the device shown is the open one
    if (api?.modes && asked.mode !== "exclusive") {
      section.append(this._row(t("settings.rate"), el("span", "set-value", t("settings.mixerRate", { rate: now.rate }))));
    } else if (api?.serverRate) {
      const rate = isOpen ? now.rate : device?.rates?.[0] ?? 0;
      section.append(this._row(t("settings.rate"), el("span", "set-value", t("settings.rateServer", { rate }))));
    } else {
      const rates = (modeLimits?.rates ?? device?.rates ?? []).filter((r) => RATES.includes(r));
      const rateSel = el("select", "set-select");
      // Core Audio: 0 keeps the rate the system has the device at (the open
      // device's is what plays now), and any other changes the device itself.
      const ownRate = api?.keepsDeviceRate ? (api.id === now.apiId ? now.rate : device?.currentRate) : 0;
      rateSel.append(new Option(ownRate ? t("settings.rateDevice", { rate: ownRate }) : t("settings.rateAuto"), "0"));
      for (const r of rates) rateSel.append(new Option(`${r} Hz`, String(r)));
      rateSel.value = String(rates.includes(asked.rate) ? asked.rate : 0);
      rateSel.disabled = this.busy;
      rateSel.addEventListener("change", () => this._apply({ ...asked, rate: Number(rateSel.value) }));
      section.append(this._row(t("settings.rate"), rateSel));
      if (api?.keepsDeviceRate) section.append(el("p", "set-note set-indent", t("settings.rateNoteDevice")));
    }

    // The buffer: the usual sizes, or those the mode (WASAPI) or the open
    // driver (ASIO) allows on this device; the latency each costs is read
    // below. An ASIO driver's own size comes first, and its window beside.
    // JACK's is its server's, shown.
    if (api?.serverBuffer) {
      section.append(this._row(t("settings.buffer"), el("span", "set-value", isOpen
        ? t("settings.bufferServer", { frames: now.bufferFrames }) : t("settings.bufferServerClosed"))));
      section.append(el("p", "set-note set-indent", t("settings.serverNote")));
      this._renderNow(section, now);
      this.detail.append(section);
      return;
    }
    const limits = modeLimits ?? (api?.driverBuffer && isOpen ? now.bufferLimits ?? null : null);
    const bufSeg = el("div", "mst-seg");
    for (const n of bufferChoices(limits, !!api?.driverBuffer)) {
      const b = el("button", n === asked.bufferFrames ? "active" : "", n === 0 ? t("settings.bufferDriver") : String(n));
      b.type = "button";
      b.disabled = this.busy;
      if (n === 0) b.title = t("settings.bufferDriverTitle");
      b.addEventListener("click", () => {
        if (n !== asked.bufferFrames) this._apply({ ...asked, bufferFrames: n });
      });
      bufSeg.append(b);
    }
    const bufCell = el("div", "set-inline");
    bufCell.append(bufSeg, el("span", "set-unit", t("settings.frames")));
    if (api?.driverPanel && isOpen && now.driverPanel) {
      const panel = el("button", "", t("settings.driverPanel"));
      panel.type = "button";
      panel.disabled = this.busy;
      panel.addEventListener("click", () => link.openDriverPanel());
      bufCell.append(panel);
    }
    section.append(this._row(t("settings.buffer"), bufCell));
    if (api?.driverPanel) section.append(el("p", "set-note set-indent", t("settings.driverNote")));
    this._renderNow(section, now);
    this.detail.append(section);
  }

  /** What is open now, in words; and why a setting is not what was asked. */
  _renderNow(section, now) {
    if (this.busy) {
      section.append(el("p", "set-note", t("settings.applying")));
    } else {
      // "WASAPI, exclusive, 24-bit PCM in 32", "ASIO, 32-bit PCM": the mode
      // and the device's own sample format (where nothing mixes before it)
      // are part of what is open.
      const how = [nativeApiName(now.apiId, now.api)];
      if (now.mode) how.push(t(`settings.mode.${now.mode}`).toLocaleLowerCase());
      if (now.format && (now.mode === "exclusive" || !now.mode)) how.push(now.format);
      section.append(el("p", "set-note", t("settings.now", {
        device: now.device, api: how.join(", "), rate: now.rate,
        ms: ms(now.bufferMs, 1), latency: ms(now.latencyMs, 1),
      })));
      section.append(el("p", "set-note", now.rate === now.engineRate
        ? t("settings.unconverted", { rate: now.rate })
        : t("settings.converted", { engine: now.engineRate, rate: now.rate })));
      // A driver that opens at a size of its own (in the shared mode the
      // mixer's period is the rule, and its note says so).
      if (now.bufferChoice && now.bufferChoice !== now.bufferFrames && now.mode !== "shared") {
        section.append(el("p", "set-note", t("settings.bufferGot", { asked: now.bufferChoice, got: now.bufferFrames })));
      }
    }
    // The last run died opening a setting, so this one started on the defaults.
    if (now.recovered) section.append(el("p", "set-note err", t("settings.recovered", { setting: now.recovered })));
    if (this.error) section.append(el("p", "set-note err", t("settings.failed", { error: this.error })));
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
