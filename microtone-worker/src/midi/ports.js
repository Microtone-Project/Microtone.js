// MIDI ports (item 379): the control surface's input and output, and any
// number of master keyboards' inputs, from whichever of two places has them.
//
//   - A browser: Web MIDI (`navigator.requestMIDIAccess`). Chromium asks the
//     person once; Firefox installs a site permission first; Safari has none.
//   - The Qt desktop app: QtWebEngine has Web MIDI compiled in and refuses
//     every request (it has no MIDI permission to grant), so the shell opens
//     the ports itself with RtMidi and hands them over a WebSocket of its own
//     (`__MICROTONE_NATIVE__.midi`, desktop-qt/src/nativemidi.cpp):
//       page → shell  text    {"open": {"input": name|null, "output": name|null,
//                                       "keyboards": [name, ...]}}
//                     binary  one whole MIDI message, for the surface's output
//       shell → page  text    {"ports": {"inputs": [...], "outputs": [...]},
//                              "open": {"input", "output",
//                                       "keyboards": [{"name", "id"}, ...]},
//                              "error"?}
//                     binary  a source byte (0 the surface's input, else the
//                             id of an open keyboard), then one whole message
//
// Ports are named, not numbered: a name is what survives a replug and a
// restart, so it is what the app remembers. Both sides give whole messages,
// SysEx included, so no running status or reassembly is needed here. A port
// is the surface's or a keyboard's, never both: a name asked for as both is
// the surface's.

const NATIVE = globalThis.__MICROTONE_NATIVE__?.midi ?? null;

/** Can this page reach MIDI at all? */
export function midiAvailable() {
  return typeof NATIVE === "string" || typeof globalThis.navigator?.requestMIDIAccess === "function";
}

/** Is the person going to be asked? (A browser asks; the desktop does not.) */
export function midiAsks() { return typeof NATIVE !== "string"; }

/**
 * Has a browser already been given MIDI with SysEx? Lets a reload reconnect
 * without a prompt appearing out of nowhere. False where it cannot say.
 */
export async function midiGranted() {
  if (typeof NATIVE === "string") return true;
  try {
    const st = await navigator.permissions.query({ name: "midi", sysex: true });
    return st.state === "granted";
  } catch {
    return false;
  }
}

/** The keyboards of a wish: names, each once, none of them the surface's input. */
export function keyboardWish(names, surfaceInput) {
  const out = [];
  for (const n of names ?? []) {
    if (typeof n === "string" && n !== "" && n !== surfaceInput && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * The ports, the surface's open pair and the open keyboards.
 * `onSurface(bytes)` hears the surface's input, `onKeyboard(bytes, name)` a
 * keyboard's; `onChange()` fires when the lists or what is open change (a
 * device plugged in or out). `sysex` says whether SysEx may be sent (the
 * scribble strip). `native` is the desktop's socket address, for tests.
 */
export class MidiPorts {
  constructor({ native = NATIVE, access = null } = {}) {
    this.onSurface = null;
    this.onKeyboard = null;
    this.onChange = null;
    this.sysex = false;
    this.inputName = null;   // the surface's
    this.outputName = null;
    /** The keyboards open now, in the order they were asked for. */
    this.keyboardNames = [];
    this._native = typeof native === "string" ? native : null;
    this._requestAccess = access; // tests: a stand-in for requestMIDIAccess
    this._access = null; // Web MIDI
    this._in = null;
    this._out = null;
    this._keyIns = new Map(); // Web MIDI: name → the MIDIInput listened to
    this._ws = null;     // the desktop's
    this._ids = new Map(); // the desktop's: source id → keyboard name
    this._lists = { inputs: [], outputs: [] };
    this._want = { input: null, output: null, keyboards: [] };
    this._closed = false;
  }

  /** Get access (the browser may ask the person). Throws when refused. */
  async start() {
    if (this._native !== null) return this._startNative();
    const request = this._requestAccess ?? ((o) => navigator.requestMIDIAccess(o));
    try {
      this._access = await request({ sysex: true });
      this.sysex = true;
    } catch (err) {
      // Refused SysEx alone still leaves the buttons, the lamps, the faders
      // and every keyboard; only the scribble strip needs it.
      this._access = await request({ sysex: false });
      this.sysex = false;
      if (!this._access) throw err;
    }
    this._access.onstatechange = () => this._webChanged();
    this._webChanged();
  }

  _startNative() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this._native);
      ws.binaryType = "arraybuffer";
      let settled = false;
      ws.onmessage = (e) => {
        if (typeof e.data === "string") {
          let msg;
          try { msg = JSON.parse(e.data); } catch { return; }
          this._nativeState(msg);
          if (!settled) { settled = true; resolve(); }
          this.onChange?.();
        } else {
          this._nativeMessage(new Uint8Array(e.data));
        }
      };
      ws.onopen = () => { this._ws = ws; this.sysex = true; };
      ws.onerror = () => { if (!settled) { settled = true; reject(new Error("the desktop's MIDI is not answering")); } };
      ws.onclose = () => {
        if (this._ws === ws) this._ws = null;
        this.inputName = this.outputName = null;
        this.keyboardNames = [];
        this._ids.clear();
        if (!settled) { settled = true; reject(new Error("the desktop's MIDI is not answering")); }
        this.onChange?.();
      };
    });
  }

  /** The shell's state message (exported for tests through the instance). */
  _nativeState(msg) {
    if (msg.ports) this._lists = { inputs: msg.ports.inputs ?? [], outputs: msg.ports.outputs ?? [] };
    if (msg.open) {
      this.inputName = msg.open.input ?? null;
      this.outputName = msg.open.output ?? null;
      this._ids.clear();
      const names = [];
      for (const k of msg.open.keyboards ?? []) {
        if (typeof k?.name !== "string" || !(k.id > 0)) continue;
        this._ids.set(k.id, k.name);
        names.push(k.name);
      }
      this.keyboardNames = names;
    }
  }

  /** One binary frame from the shell: its source byte, then the message. */
  _nativeMessage(frame) {
    if (frame.length < 2) return;
    const bytes = frame.subarray(1);
    if (frame[0] === 0) {
      if (this.inputName !== null) this.onSurface?.(bytes);
      return;
    }
    const name = this._ids.get(frame[0]);
    if (name !== undefined) this.onKeyboard?.(bytes, name);
  }

  /** Port names, each list in the system's order. */
  inputs() { return this._lists.inputs.slice(); }
  outputs() { return this._lists.outputs.slice(); }

  /** Open the surface's input and output named (null: none) and the keyboards
   *  named. Kept as the WISH: a port that is not there now is opened when it
   *  turns up. */
  open(input, output, keyboards = this._want.keyboards) {
    const surfaceIn = input || null;
    this._want = { input: surfaceIn, output: output || null, keyboards: keyboardWish(keyboards, surfaceIn) };
    if (this._ws) {
      this._ws.send(JSON.stringify({ open: this._want }));
      return;
    }
    this._bindWeb();
    this.onChange?.();
  }

  /** Change the keyboards alone, keeping the surface as it is wished. */
  openKeyboards(keyboards) {
    this.open(this._want.input, this._want.output, keyboards);
  }

  /** What was last asked for. */
  get wish() {
    return { input: this._want.input, output: this._want.output, keyboards: this._want.keyboards.slice() };
  }

  /** Send one message to the surface's output (dropped when there is none,
   *  and a SysEx dropped where it was not allowed). */
  send(bytes) {
    if (bytes[0] === 0xf0 && !this.sysex) return;
    if (this._ws) {
      if (this.outputName) this._ws.send(Uint8Array.from(bytes));
      return;
    }
    try { this._out?.send(bytes); } catch { /* the port went as we wrote */ }
  }

  /** Tell the desktop's shell that everything sent before this is the last
   *  word: it waits for it before it quits (nativemidi.cpp `whenFlushed`).
   *  Web MIDI needs no such thing — a closing tab sends what it was given. */
  flush() {
    if (this._ws) this._ws.send(JSON.stringify({ flush: true }));
  }

  /** Is anything open: the surface, or a keyboard? */
  get connected() { return this.inputName !== null || this.outputName !== null || this.keyboardNames.length > 0; }

  close() {
    this._closed = true;
    this._want = { input: null, output: null, keyboards: [] };
    if (this._ws) { try { this._ws.close(); } catch { /* gone */ } this._ws = null; }
    if (this._in) this._in.onmidimessage = null;
    for (const p of this._keyIns.values()) p.onmidimessage = null;
    this._keyIns.clear();
    if (this._access) this._access.onstatechange = null;
    this._in = this._out = null;
    this.inputName = this.outputName = null;
    this.keyboardNames = [];
  }

  // ── Web MIDI ──

  _webChanged() {
    if (!this._access || this._closed) return;
    const names = (map) => [...map.values()].filter((p) => p.state !== "disconnected").map((p) => p.name);
    this._lists = { inputs: names(this._access.inputs), outputs: names(this._access.outputs) };
    this._bindWeb();
    this.onChange?.();
  }

  _bindWeb() {
    if (!this._access) return;
    const find = (map, name) => name === null ? null
      : [...map.values()].find((p) => p.name === name && p.state !== "disconnected") ?? null;
    const inp = find(this._access.inputs, this._want.input);
    const out = find(this._access.outputs, this._want.output);
    if (inp !== this._in) {
      // (A port is the surface's or a keyboard's: one that changes sides is
      // listened to again below.)
      if (this._in) this._in.onmidimessage = null;
      this._in = inp;
      if (inp) inp.onmidimessage = (e) => this.onSurface?.(e.data);
    }
    this._out = out;
    this.inputName = inp?.name ?? null;
    this.outputName = out?.name ?? null;
    // The keyboards: each wished-for input that is there, listened to under
    // its own name; one that went, or is no longer wished for, let go.
    const next = new Map();
    for (const name of this._want.keyboards) {
      const p = find(this._access.inputs, name);
      if (p && p !== inp) next.set(name, p);
    }
    for (const [name, p] of this._keyIns) {
      if (next.get(name) !== p && p !== inp) p.onmidimessage = null;
    }
    for (const [name, p] of next) {
      if (this._keyIns.get(name) !== p) p.onmidimessage = (e) => this.onKeyboard?.(e.data, name);
    }
    this._keyIns = next;
    this.keyboardNames = [...next.keys()];
  }
}

/**
 * The output that goes with an input: the same name, or failing that the
 * one whose name shares the longest start with it ("X-Touch One MIDI 1" in
 * and out), else null.
 */
export function partnerOutput(input, outputs) {
  if (!input) return null;
  if (outputs.includes(input)) return input;
  let best = null, bestLen = 3; // at least a few characters in common
  for (const o of outputs) {
    let n = 0;
    while (n < o.length && n < input.length && o[n] === input[n]) n++;
    if (n > bestLen) { best = o; bestLen = n; }
  }
  return best;
}

/** Does a port's name look like a Mackie Control surface? Used to offer it
 *  first; any port can be chosen. */
export function looksLikeSurface(name) {
  return /x-?touch|mackie|\bmcu\b|logic control|qcon|platform m|faderport|behringer|icon p1|v1-m|ssl uf/i.test(name ?? "");
}
